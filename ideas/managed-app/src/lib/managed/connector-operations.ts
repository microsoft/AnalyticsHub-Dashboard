//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { ApiDefinition, ApiParameter, DataSources, ManagedOperationResult } from "./host";

/**
 * How an operation takes its DAX: `rest` is the REST API's executeQueries
 * body, `flat` is the connector's one-query `{ query, serializerSettings }`,
 * and `params` passes each value as its own parameter.
 */
export type BodyShape = "rest" | "flat" | "params";

/** A data source, operation and body shape to try. */
export interface ConnectorCandidate {
    dataSource: string;
    operation: string;
    shape: BodyShape;
}

export interface ConnectorCandidates {
    candidates: ConnectorCandidate[];
    /** Why there are none. */
    problem?: string;
}

/** The executeQueries JSON the Fabric SDK parses. */
export interface ExecuteQueriesJson {
    results?: unknown[];
    error?: unknown;
    [field: string]: unknown;
}

/** What a connector call came to. */
export type CallOutcome =
    | { kind: "ok"; response: ExecuteQueriesJson }
    | {
        kind: "unreadable" | "throttled" | "denied" | "blocked" | "rejected" | "failed" | "unreachable";
        message: string;
        status?: number;
        code?: string;
        requestId?: string;
    };

/** The command that adds the Power BI connector to the app. */
export const ADD_DATA_SOURCE_COMMAND = "ms app add data-source --connector shared_powerbi --as action";

/** The connector's query operations, best first: "Run a json query against a dataset", then "Run a query against a dataset". */
export const QUERY_OPERATIONS: readonly string[] = ["ExecuteDatasetQueriesJson", "ExecuteDatasetQuery"];

const POWER_BI = /power ?bi/i;
const QUERY_OPERATION = /execute.*quer/i;
const JSON_OPERATION = /json/i;
const POLICY_CODE = /dlp|polic/i;
const POLICY_MESSAGE = /\bDLP\b|data loss prevention|blocked by .*polic/i;
const RESPONSE_DEPTH = 4;

const WORKSPACE_KEYS = new Set(["groupid", "workspaceid"]);
const ITEM_KEYS = new Set(["datasetid", "semanticmodelid", "itemid"]);
const QUERY_KEYS = new Set(["query", "daxquery", "querytext"]);
const NULLS_KEY = "includenulls";

/**
 * Lists what to try, best first: the pinned data source, or every one with
 * Power BI names first; and the pinned operations, or the connector's query
 * operations, in each.
 */
export function connectorCandidates(
    dataSources: DataSources,
    pin: { dataSource?: string; operations?: string[] } = {},
): ConnectorCandidates {
    const names = Object.keys(dataSources);
    if (names.length === 0)
        return { candidates: [], problem: `The app has no data sources yet. Run \`${ADD_DATA_SOURCE_COMMAND}\`, then build and deploy again.` };

    let sources: string[];
    if (pin.dataSource) {
        const pinned = pin.dataSource.toLowerCase();
        const match = names.find((name) => name.toLowerCase() === pinned);
        if (!match)
            return { candidates: [], problem: `The config pins the data source "${pin.dataSource}", but the app only has ${names.join(", ")}.` };
        sources = [match];
    } else {
        sources = [...names].sort((a, b) => Number(POWER_BI.test(b)) - Number(POWER_BI.test(a)));
    }

    const candidates: ConnectorCandidate[] = [];
    for (const dataSource of sources) {
        const apis = dataSources[dataSource]?.apis ?? {};
        for (const operation of queryOperations(apis, pin.operations)) {
            for (const shape of bodyShapes(operation, apis[operation]))
                candidates.push({ dataSource, operation, shape });
        }
    }
    if (candidates.length === 0) {
        const wanted = (pin.operations?.length ? pin.operations : QUERY_OPERATIONS).join(" or ");
        return {
            candidates,
            problem: `No data source has the ${wanted} operation. \`ms app add data-source\` leaves out actions the connector policy blocks, so an admin may need to turn them on. Then run \`${ADD_DATA_SOURCE_COMMAND}\`, and build and deploy again.`,
        };
    }
    return { candidates };
}

/** The operation's parameters for one DAX query. Never sets `impersonatedUserName`: RLS must apply to the viewer. */
export function buildParameters(
    api: ApiDefinition,
    shape: BodyShape,
    workspaceId: string,
    itemId: string,
    query: string,
): Record<string, unknown> {
    const body = bodyParameter(api);
    const parameters: Record<string, unknown> = {};
    for (const parameter of api.parameters) {
        if (parameter === body) {
            parameters[parameter.name] = requestBody(shape, query);
            continue;
        }
        const key = parameterKey(parameter);
        if (WORKSPACE_KEYS.has(key))
            parameters[parameter.name] = workspaceId;
        else if (ITEM_KEYS.has(key))
            parameters[parameter.name] = itemId;
        else if (QUERY_KEYS.has(key))
            parameters[parameter.name] = query;
        else if (key === NULLS_KEY)
            parameters[parameter.name] = true;
    }
    return parameters;
}

/**
 * Turns what the connector returned into executeQueries JSON. Unwraps JSON
 * text and `response` or `body` wrappers, and wraps bare rows. Undefined
 * when it isn't readable.
 */
export function normalizeResponse(data: unknown): ExecuteQueriesJson | undefined {
    let value = data;
    for (let depth = 0; depth <= RESPONSE_DEPTH; depth++) {
        if (typeof value === "string") {
            try {
                value = JSON.parse(value);
            } catch {
                return undefined;
            }
            continue;
        }
        if (Array.isArray(value))
            return rowsResponse(value);
        if (!isRecord(value))
            return undefined;
        if (Array.isArray(value.results) || isRecord(value.error))
            return value;
        if (Array.isArray(value.firstTableRows))
            return rowsResponse(value.firstTableRows);
        if (Array.isArray(value.value))
            return rowsResponse(value.value);
        if ("response" in value)
            value = value.response;
        else if ("body" in value)
            value = value.body;
        else
            return undefined;
    }
    return undefined;
}

/** Whether executeQueries JSON holds a table of rows. */
export function hasRows(response: ExecuteQueriesJson): boolean {
    const result = response.results?.[0];
    const table = isRecord(result) && Array.isArray(result.tables) ? result.tables[0] : undefined;
    return isRecord(table) && Array.isArray(table.rows);
}

/** Sorts a connector result into what the proxy does next. */
export function classifyResult(result: ManagedOperationResult): CallOutcome {
    if (result.success) {
        const response = normalizeResponse(result.data);
        return response
            ? { kind: "ok", response }
            : { kind: "unreadable", message: "The connector answered, but not with query results." };
    }

    const { message, status, code, requestId }: NonNullable<ManagedOperationResult["error"]> = result.error ?? { message: "" };
    const detail = {
        message: message.trim() || "The connector call failed.",
        ...(status !== undefined ? { status } : {}),
        ...(code ? { code } : {}),
        ...(requestId ? { requestId } : {}),
    };
    if (status === 429)
        return { kind: "throttled", ...detail };
    if ((code && POLICY_CODE.test(code)) || POLICY_MESSAGE.test(message))
        return { kind: "blocked", ...detail };
    if (status === 401 || status === 403)
        return { kind: "denied", ...detail };
    if (status === 400)
        return { kind: "rejected", ...detail };
    if (status === undefined)
        return { kind: "unreachable", ...detail };
    return { kind: "failed", ...detail };
}

function queryOperations(apis: Readonly<Record<string, ApiDefinition>>, pinned?: string[]): string[] {
    const keys = Object.keys(apis);
    const wanted = pinned?.length ? pinned : [...QUERY_OPERATIONS, ...keys.filter((key) => QUERY_OPERATION.test(key))];
    const found = wanted
        .map((name) => keys.find((key) => key.toLowerCase() === name.toLowerCase()))
        .filter((key): key is string => key !== undefined);
    return [...new Set(found)];
}

function bodyShapes(operation: string, api: ApiDefinition | undefined): BodyShape[] {
    if (api && !bodyParameter(api))
        return ["params"];
    return JSON_OPERATION.test(operation) ? ["rest", "flat"] : ["flat", "rest"];
}

/** The parameter that takes the whole request body, when the operation has one. */
function bodyParameter(api: ApiDefinition): ApiParameter | undefined {
    return api.parameters.find((parameter) => {
        if (parameter.in !== "body")
            return false;
        const key = parameterKey(parameter);
        return !WORKSPACE_KEYS.has(key) && !ITEM_KEYS.has(key) && !QUERY_KEYS.has(key) && key !== NULLS_KEY;
    });
}

function requestBody(shape: BodyShape, query: string): Record<string, unknown> {
    return shape === "rest"
        ? { queries: [{ query }], serializerSettings: { includeNulls: true } }
        : { query, serializerSettings: { includeNulls: true } };
}

function parameterKey(parameter: ApiParameter): string {
    return parameter.name.toLowerCase().replace(/[-_]/g, "");
}

function rowsResponse(rows: unknown[]): ExecuteQueriesJson | undefined {
    return rows.every(isRecord) ? { results: [{ tables: [{ rows }] }] } : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
