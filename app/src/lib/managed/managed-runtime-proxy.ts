//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import {
    FabricApiProxyError,
    FabricGenericProxyError,
    FabricNetworkProxyError,
    type DaxJsonProxyResponse,
    type IFabricApiProxy,
} from "@microsoft/fabric-app-data";
import { errorCode, reportAccessDenied } from "@/lib/access";
import { isConnectionConfigured } from "@/lib/connections";
import { MANAGED_CONFIG_PATH, MANAGED_DIAGNOSTICS_DEFAULTS, runtimeConfig } from "@/lib/runtime-config";
import {
    buildParameters,
    classifyResult,
    connectorCandidates,
    hasRows,
    type CallOutcome,
    type ConnectorCandidate,
} from "./connector-operations";
import {
    errorMessage,
    getDiagnostics,
    recordCall,
    setConnectorState,
    startManagedDiagnostics,
    type ConnectorAttempt,
    type ConnectorState,
} from "./diagnostics";
import { loadManagedSdk, type ManagedSdk } from "./host";

/** The query that proves an operation answers before a page relies on it. */
export const PROBE_QUERY = 'EVALUATE ROW("ok", 1)';

/** How long a failed discovery stands before a query looks again. */
export const DISCOVERY_RETRY_MS = 30_000;

const MESSAGE_LIMIT = 500;

type Failure = Exclude<CallOutcome, { kind: "ok" }>;

interface Discovery {
    promise: Promise<ConnectorCandidate>;
    failedAt?: number;
}

let discovery: Discovery | undefined;
let generation = 0;
let sessionId: string | undefined;

/** Fabric SDK proxy that runs DAX through the app's Power BI connector, as the viewer. */
export class ManagedRuntimeProxy implements IFabricApiProxy {
    readonly semanticModel = {
        executeDax: async (): Promise<never> => {
            throw new FabricGenericProxyError({ message: "Arrow DAX is not supported on the Managed Runtime.", sessionId: session() });
        },
        executeDaxJson: async (workspaceId: string, itemId: string, query: string): Promise<DaxJsonProxyResponse> => {
            const requestId = crypto.randomUUID();
            const sdk = await managedSdk(requestId);
            const candidate = await discoverConnector(sdk, workspaceId, itemId);
            const outcome = await callConnector(sdk, candidate, workspaceId, itemId, query, false);
            if (outcome.kind !== "ok")
                throw failure(outcome, requestId);

            const { response } = outcome;
            // Hand a Power BI error in a success to the SDK as the 400 it would have been, so its message shows.
            if (isRecord(response.error) && isRecord(response.error["pbi.error"]))
                throw new FabricApiProxyError({ status: 400, requestId, sessionId: session(), body: JSON.stringify(response) });
            return { data: response, requestId };
        },
    };

    readonly lakehouse = {
        executeSql: async (): Promise<never> => {
            throw new FabricGenericProxyError({ message: "Lakehouse queries are not supported on the Managed Runtime.", sessionId: session() });
        },
    };

    readonly warehouse = {
        executeSql: async (): Promise<never> => {
            throw new FabricGenericProxyError({ message: "Warehouse queries are not supported on the Managed Runtime.", sessionId: session() });
        },
    };
}

/** Forgets the operation that works, so the next query looks again. */
export function resetConnectorDiscovery(): void {
    generation++;
    discovery = undefined;
    setConnectorState({ status: "unknown", attempts: [] });
}

/** Looks for the operation that works again, against the first semantic model that's set up. */
export async function recheckConnector(): Promise<void> {
    resetConnectorDiscovery();
    const models = runtimeConfig().semanticModels;
    const alias = Object.keys(models).find((key) => isConnectionConfigured(models, key));
    const model = alias ? models[alias] : undefined;
    if (!model?.workspaceId || !model.itemId) {
        setConnectorState({ status: "failed", attempts: [], error: `No semantic model is set up to check against. Add one to ${MANAGED_CONFIG_PATH}.` });
        return;
    }
    let sdk: ManagedSdk;
    try {
        sdk = await managedSdk(crypto.randomUUID());
    } catch (error) {
        setConnectorState({ status: "failed", attempts: [], error: errorMessage(error) });
        return;
    }
    await discoverConnector(sdk, model.workspaceId, model.itemId).catch(() => undefined);
}

async function managedSdk(requestId: string): Promise<ManagedSdk> {
    try {
        const sdk = await loadManagedSdk();
        startManagedDiagnostics(sdk);
        return sdk;
    } catch (error) {
        throw new FabricGenericProxyError({ message: "The Managed Runtime SDK didn't load.", requestId, sessionId: session(), cause: error });
    }
}

/** The operation that works, found once and shared by every query. */
function discoverConnector(sdk: ManagedSdk, workspaceId: string, itemId: string): Promise<ConnectorCandidate> {
    if (discovery && (discovery.failedAt === undefined || Date.now() - discovery.failedAt < DISCOVERY_RETRY_MS))
        return discovery.promise;

    const current: Discovery = { promise: probeCandidates(sdk, workspaceId, itemId) };
    current.promise.catch(() => {
        current.failedAt = Date.now();
    });
    discovery = current;
    return current.promise;
}

async function probeCandidates(sdk: ManagedSdk, workspaceId: string, itemId: string): Promise<ConnectorCandidate> {
    const mine = generation;
    const report = (connector: ConnectorState) => {
        if (mine === generation)
            setConnectorState(connector);
    };

    const { candidates, problem } = connectorCandidates(sdk.dataSources, runtimeConfig().managed?.connector);
    if (problem) {
        report({ status: "failed", attempts: [], error: problem });
        throw new FabricGenericProxyError({ message: problem, sessionId: session() });
    }

    const attempts: ConnectorAttempt[] = [];
    report({ status: "checking", attempts: [] });
    for (const candidate of candidates) {
        const outcome = await callConnector(sdk, candidate, workspaceId, itemId, PROBE_QUERY, true);
        if (outcome.kind === "ok" && hasRows(outcome.response)) {
            report({ status: "ready", candidate, attempts: [...attempts, { candidate, outcome: "ok" }] });
            return candidate;
        }

        const missed: Failure = outcome.kind === "ok" ? { kind: "unreadable", message: "No rows came back." } : outcome;
        attempts.push({
            candidate,
            outcome: missed.kind,
            ...(missed.status !== undefined ? { status: missed.status } : {}),
            message: missed.message,
        });
        // The connection is throttled or refused, so another operation won't fare better.
        if (missed.kind === "throttled" || missed.kind === "denied") {
            const error = failure(missed, missed.requestId ?? crypto.randomUUID());
            report({ status: "failed", attempts: [...attempts], error: error.message });
            throw error;
        }
        report({ status: "checking", attempts: [...attempts] });
    }

    const error = discoveryFailure(attempts);
    report({ status: "failed", attempts: [...attempts], error });
    throw new FabricGenericProxyError({ message: error, sessionId: session() });
}

async function callConnector(
    sdk: ManagedSdk,
    candidate: ConnectorCandidate,
    workspaceId: string,
    itemId: string,
    query: string,
    probe: boolean,
): Promise<CallOutcome> {
    const api = sdk.dataSources[candidate.dataSource]?.apis[candidate.operation];
    const parameters = api ? buildParameters(api, candidate.shape, workspaceId, itemId, query) : {};
    const page = getDiagnostics().page;
    const at = Date.now();
    const started = performance.now();

    let outcome: CallOutcome;
    try {
        outcome = classifyResult(await sdk.execute(candidate.dataSource, candidate.operation, parameters));
    } catch (error) {
        outcome = { kind: "unreachable", message: errorMessage(error) || "The connector call didn't complete." };
    }

    const status = outcome.kind === "ok" ? 200 : outcome.status;
    recordCall({
        at,
        page,
        operation: candidate.operation,
        ok: outcome.kind === "ok",
        ...(status !== undefined ? { status } : {}),
        durationMs: Math.round(performance.now() - started),
        ...(outcome.kind !== "ok" ? { error: outcome.message } : {}),
        ...(probe ? { probe } : {}),
    });
    return outcome;
}

/** The error the Fabric SDK expects for a failed call. Reports a refusal to the auth gate. */
function failure(outcome: Failure, requestId: string): Error {
    const ids = { requestId: outcome.requestId ?? requestId, sessionId: session() };
    switch (outcome.kind) {
        case "throttled": {
            const limit = runtimeConfig().managed?.diagnostics.throttleLimit ?? MANAGED_DIAGNOSTICS_DEFAULTS.throttleLimit;
            return new FabricApiProxyError({
                ...ids,
                status: 429,
                body: outcome.message,
                message: `The Power BI connector allows ${limit} calls a minute per connection, and this went over. Wait a minute, then open the page again.`,
            });
        }
        case "denied":
            reportAccessDenied(errorCode(outcome.message) ?? "PowerBIAccessDenied");
            return new FabricApiProxyError({
                ...ids,
                status: outcome.status ?? 403,
                body: outcome.message,
                message: `Power BI refused the query (${outcome.status ?? 403}). ${outcome.message}`,
            });
        case "blocked":
            return new FabricApiProxyError({
                ...ids,
                status: 403,
                body: outcome.message,
                message: `A data policy blocks the Power BI connector here. ${outcome.message}`,
            });
        case "rejected":
            return new FabricApiProxyError({ ...ids, status: 400, body: queryErrorBody(outcome.message, outcome.code) });
        case "failed":
            return new FabricApiProxyError({
                ...ids,
                status: outcome.status ?? 500,
                body: outcome.message,
                message: `The Power BI connector failed (${outcome.status ?? 500}). ${outcome.message}`,
            });
        case "unreachable":
            return new FabricNetworkProxyError({ ...ids, message: outcome.message });
        case "unreadable":
            return new FabricGenericProxyError({ ...ids, message: outcome.message });
    }
}

/**
 * A 400's body as the REST API words it, so the SDK reads the DAX error out
 * of `pbi.error`. A body that already has one passes through.
 */
export function queryErrorBody(message: string, code?: string): string {
    const json = embeddedJson(message);
    if (json && isRecord(json.error) && isRecord(json.error["pbi.error"]))
        return JSON.stringify(json);

    const inner = json && (isRecord(json.error) ? json.error.message : json.message);
    let text = typeof inner === "string" && inner.trim() ? inner.trim() : message.trim();
    if (text.length > MESSAGE_LIMIT)
        text = `${text.slice(0, MESSAGE_LIMIT - 1)}…`;
    return JSON.stringify({
        error: {
            code: "DatasetExecuteQueriesError",
            "pbi.error": {
                code: code ?? "DatasetExecuteQueriesError",
                details: [{ code: "DetailsMessage", detail: { type: 1, value: text || "The query failed." } }],
            },
        },
    });
}

function discoveryFailure(attempts: readonly ConnectorAttempt[]): string {
    if (attempts.some((attempt) => attempt.outcome === "blocked"))
        return "A data policy blocks the Power BI connector in this environment. Ask a Power Platform admin to allow it, then re-check.";
    const tried = attempts
        .map(({ candidate, status, outcome }) => `${candidate.dataSource}/${candidate.operation} (${candidate.shape}): ${status ?? outcome}`)
        .join("; ");
    const last = attempts.at(-1)?.message ?? "";
    const reason = last.length > MESSAGE_LIMIT ? `${last.slice(0, MESSAGE_LIMIT - 1)}…` : last;
    return `The Power BI connector didn't answer a test query. Tried ${tried}.${reason ? ` Last error: ${reason}` : ""}`;
}

/** The JSON object in a message, which may have text around it. */
function embeddedJson(message: string): Record<string, unknown> | undefined {
    const start = message.indexOf("{");
    const end = message.lastIndexOf("}");
    if (start < 0 || end <= start)
        return undefined;
    try {
        const parsed: unknown = JSON.parse(message.slice(start, end + 1));
        return isRecord(parsed) ? parsed : undefined;
    } catch {
        return undefined;
    }
}

function session(): string {
    sessionId ??= crypto.randomUUID();
    return sessionId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
