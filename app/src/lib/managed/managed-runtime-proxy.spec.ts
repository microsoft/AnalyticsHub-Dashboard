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
} from "@microsoft/fabric-app-data";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACCESS_DENIED_EVENT } from "@/lib/access";
import { getDiagnostics, resetDiagnostics, setDiagnosticsPage } from "./diagnostics";
import { setManagedSdk, type ApiDefinition, type DataSources, type ManagedOperationResult, type ManagedSdk } from "./host";
import {
    DISCOVERY_RETRY_MS,
    ManagedRuntimeProxy,
    PROBE_QUERY,
    queryErrorBody,
    recheckConnector,
    resetConnectorDiscovery,
} from "./managed-runtime-proxy";

const WS = "11111111-1111-4111-8111-111111111111";
const ITEM = "22222222-2222-4222-8222-222222222222";
const OTHER_ITEM = "33333333-3333-4333-8333-333333333333";
const PLACEHOLDER = { workspaceId: "<workspace-id>", itemId: "<item-id>" };

const runtime = vi.hoisted(() => ({
    semanticModels: {} as Record<string, { workspaceId: string; itemId: string }>,
    connector: undefined as { dataSource?: string; operations?: string[] } | undefined,
}));

vi.mock("@/lib/runtime-config", () => ({
    MANAGED_CONFIG_PATH: "managed-app.config.json",
    MANAGED_DIAGNOSTICS_DEFAULTS: { launchCredits: 0.1, creditPerCall: 0.1, throttleLimit: 100 },
    runtimeConfig: () => ({
        host: "managed",
        rayfin: {},
        semanticModels: runtime.semanticModels,
        managed: { diagnostics: { launchCredits: 0.1, creditPerCall: 0.1, throttleLimit: 100 }, connector: runtime.connector },
    }),
}));

const queriesApi: ApiDefinition = {
    path: "/v1.0/myorg/groups/{groupId}/datasets/{datasetId}/executeQueries",
    method: "POST",
    parameters: [
        { name: "groupId", in: "path" },
        { name: "datasetId", in: "path" },
        { name: "body", in: "body" },
    ],
};

const powerBi: DataSources = { powerbi: { apis: { ExecuteDatasetQueriesJson: queriesApi } } };

type Execute = ManagedSdk["execute"];

function useSdk(execute: Execute, dataSources: DataSources = powerBi): ManagedSdk {
    const sdk: ManagedSdk = {
        dataSources,
        execute: vi.fn(execute),
        getUser: vi.fn(),
        getContext: vi.fn().mockResolvedValue({ appId: "app-1", environmentId: "env-1", sessionId: "session-1" }),
        onMetric: vi.fn(() => () => undefined),
    };
    setManagedSdk(sdk);
    return sdk;
}

function rows(values: Record<string, unknown>[]): ManagedOperationResult {
    return { success: true, data: { results: [{ tables: [{ rows: values }] }] } };
}

function fail(error: NonNullable<ManagedOperationResult["error"]>): ManagedOperationResult {
    return { success: false, error };
}

/** The DAX in a call's parameters, whatever the body shape. */
function daxOf(parameters: Record<string, unknown>): string | undefined {
    const body = parameters.body as { query?: string; queries?: { query: string }[] } | undefined;
    return body?.queries?.[0]?.query ?? body?.query;
}

/** Answers the probe, then each query with `answer`. */
function answering(answer: (dax: string) => ManagedOperationResult): Execute {
    return async (_dataSource, _operation, parameters) => {
        const dax = daxOf(parameters) ?? "";
        return dax === PROBE_QUERY ? rows([{ "[ok]": 1 }]) : answer(dax);
    };
}

function probes(sdk: ManagedSdk): number {
    return vi.mocked(sdk.execute).mock.calls.filter(([, , parameters]) => daxOf(parameters) === PROBE_QUERY).length;
}

function run(query = "EVALUATE A") {
    return new ManagedRuntimeProxy().semanticModel.executeDaxJson(WS, ITEM, query);
}

async function failureOf(promise: Promise<unknown>): Promise<Error> {
    const error = await promise.then(() => undefined, (caught: unknown) => caught);
    if (!(error instanceof Error))
        throw new Error("Expected the query to fail.");
    return error;
}

beforeEach(() => {
    resetConnectorDiscovery();
    resetDiagnostics();
    runtime.semanticModels = { vl: { workspaceId: WS, itemId: ITEM } };
    runtime.connector = undefined;
});

afterEach(() => {
    setManagedSdk(undefined);
    vi.restoreAllMocks();
});

describe("ManagedRuntimeProxy", () => {
    it("probes the connector once, then runs each query through it as the viewer", async () => {
        const sdk = useSdk(answering(() => rows([{ "[Users]": 42 }])));
        const proxy = new ManagedRuntimeProxy();

        const first = await proxy.semanticModel.executeDaxJson(WS, ITEM, "EVALUATE A");
        await proxy.semanticModel.executeDaxJson(WS, ITEM, "EVALUATE B");

        expect(first).toEqual({ data: { results: [{ tables: [{ rows: [{ "[Users]": 42 }] }] }] }, requestId: expect.any(String) });
        expect(vi.mocked(sdk.execute).mock.calls.map(([, , parameters]) => daxOf(parameters))).toEqual([PROBE_QUERY, "EVALUATE A", "EVALUATE B"]);
        expect(sdk.execute).toHaveBeenNthCalledWith(2, "powerbi", "ExecuteDatasetQueriesJson", {
            groupId: WS,
            datasetId: ITEM,
            body: { queries: [{ query: "EVALUATE A" }], serializerSettings: { includeNulls: true } },
        });
        const candidate = { dataSource: "powerbi", operation: "ExecuteDatasetQueriesJson", shape: "rest" };
        expect(getDiagnostics().connector).toEqual({ status: "ready", candidate, attempts: [{ candidate, outcome: "ok" }] });
        expect(getDiagnostics().totals).toMatchObject({ calls: 3, probes: 1, failed: 0 });
        expect(sdk.onMetric).toHaveBeenCalledTimes(1);
    });

    it("counts each call against the page showing", async () => {
        useSdk(answering(() => rows([])));
        setDiagnosticsPage("adoption");

        await run();

        expect(getDiagnostics().totals.byPage).toEqual({ adoption: 2 });
    });

    it("tries the next body shape when the connector rejects one", async () => {
        const sdk = useSdk(async (_dataSource, _operation, parameters) =>
            (parameters.body as { queries?: unknown }).queries
                ? fail({ message: "Bad request body", status: 400 })
                : rows([{ "[ok]": 1 }]));

        await run();

        expect(getDiagnostics().connector).toMatchObject({
            status: "ready",
            candidate: { shape: "flat" },
            attempts: [
                { candidate: { shape: "rest" }, outcome: "rejected", status: 400, message: "Bad request body" },
                { candidate: { shape: "flat" }, outcome: "ok" },
            ],
        });
        expect(sdk.execute).toHaveBeenLastCalledWith("powerbi", "ExecuteDatasetQueriesJson", {
            groupId: WS,
            datasetId: ITEM,
            body: { query: "EVALUATE A", serializerSettings: { includeNulls: true } },
        });
        expect(getDiagnostics().totals).toMatchObject({ calls: 3, probes: 2, failed: 1 });
    });

    it("shares one discovery between queries that start together", async () => {
        const sdk = useSdk(answering(() => rows([])));

        await Promise.all([run("EVALUATE A"), run("EVALUATE B")]);

        expect(probes(sdk)).toBe(1);
        expect(sdk.execute).toHaveBeenCalledTimes(3);
    });

    it("hands a Power BI error in a success to the SDK as the 400 it would have been", async () => {
        const response = { error: { code: "DatasetExecuteQueriesError", "pbi.error": { code: "DatasetExecuteQueriesError", details: [] } } };
        useSdk(answering(() => ({ success: true, data: response })));

        const error = await failureOf(run());

        expect(error).toBeInstanceOf(FabricApiProxyError);
        expect((error as FabricApiProxyError).status).toBe(400);
        expect(JSON.parse((error as FabricApiProxyError).body)).toEqual(response);
    });

    it("words a rejected query the way the REST API does, so the SDK shows the DAX error", async () => {
        const message = "Query (1, 10) The syntax for 'x' is incorrect.";
        useSdk(answering(() => fail({ message, status: 400, code: "BadRequest", requestId: "r-1" })));

        const error = await failureOf(run());

        expect(error).toBeInstanceOf(FabricApiProxyError);
        expect(error).toMatchObject({ status: 400, requestId: "r-1", body: queryErrorBody(message, "BadRequest") });
    });

    it("stops looking, and says to wait, when the connection is throttled", async () => {
        const sdk = useSdk(async () => fail({ message: "Rate limit is exceeded.", status: 429 }));

        const error = await failureOf(run());

        expect(error).toBeInstanceOf(FabricApiProxyError);
        expect((error as FabricApiProxyError).status).toBe(429);
        expect(error.message).toBe("The Power BI connector allows 100 calls a minute per connection, and this went over. Wait a minute, then open the page again.");
        expect(sdk.execute).toHaveBeenCalledTimes(1);
        expect(getDiagnostics().connector).toMatchObject({ status: "failed", error: error.message, attempts: [{ outcome: "throttled", status: 429 }] });
        expect(getDiagnostics().totals.throttled).toBe(1);
    });

    it("tells the auth gate when Power BI refuses the viewer", async () => {
        const sdk = useSdk(async () => fail({ message: "Forbidden", status: 403 }));
        const denied = vi.fn();
        window.addEventListener(ACCESS_DENIED_EVENT, denied);

        const error = await failureOf(run());
        window.removeEventListener(ACCESS_DENIED_EVENT, denied);

        expect(error).toMatchObject({ status: 403, message: "Power BI refused the query (403). Forbidden" });
        expect(sdk.execute).toHaveBeenCalledTimes(1);
        expect(denied).toHaveBeenCalledTimes(1);
        expect((denied.mock.calls[0][0] as CustomEvent).detail).toEqual({ reason: "PowerBIAccessDenied" });
    });

    it("says which operations it tried when none answers", async () => {
        useSdk(async () => fail({ message: "Internal error", status: 500 }));
        const message = "The Power BI connector didn't answer a test query. Tried powerbi/ExecuteDatasetQueriesJson (rest): 500; "
            + "powerbi/ExecuteDatasetQueriesJson (flat): 500. Last error: Internal error";

        const error = await failureOf(run());

        expect(error).toBeInstanceOf(FabricGenericProxyError);
        expect(error.message).toBe(message);
        expect(getDiagnostics().connector).toMatchObject({ status: "failed", error: message });
    });

    it("counts an answer without rows as a miss", async () => {
        useSdk(async () => ({ success: true, data: { results: [] } }));

        const error = await failureOf(run());

        expect(error.message).toContain("(rest): unreadable; powerbi/ExecuteDatasetQueriesJson (flat): unreadable. Last error: No rows came back.");
    });

    it("blames a data policy when one blocks the connector", async () => {
        const sdk = useSdk(async () => fail({ message: "Blocked", status: 403, code: "DlpPolicyViolation" }));
        const denied = vi.fn();
        window.addEventListener(ACCESS_DENIED_EVENT, denied);

        const error = await failureOf(run());
        window.removeEventListener(ACCESS_DENIED_EVENT, denied);

        expect(error.message).toBe("A data policy blocks the Power BI connector in this environment. Ask a Power Platform admin to allow it, then re-check.");
        expect(sdk.execute).toHaveBeenCalledTimes(2);
        expect(denied).not.toHaveBeenCalled();
    });

    it("says how to add the connector when the app has none", async () => {
        const sdk = useSdk(async () => rows([]), {});

        const error = await failureOf(run());

        expect(error).toBeInstanceOf(FabricGenericProxyError);
        expect(error.message).toMatch(/^The app has no data sources yet\./);
        expect(sdk.execute).not.toHaveBeenCalled();
        expect(getDiagnostics().connector).toMatchObject({ status: "failed", attempts: [], error: error.message });
    });

    it("keeps to the data source the config pins", async () => {
        runtime.connector = { dataSource: "missing" };
        useSdk(async () => rows([]));

        const error = await failureOf(run());

        expect(error.message).toBe('The config pins the data source "missing", but the app only has powerbi.');
    });

    it("reports a call that doesn't complete as a network error", async () => {
        useSdk(answering(() => {
            throw new Error("Socket closed");
        }));

        const error = await failureOf(run());

        expect(error).toBeInstanceOf(FabricNetworkProxyError);
        expect(error.message).toBe("Socket closed");
    });

    it("waits 30 seconds after a failed discovery before looking again", async () => {
        const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
        const sdk = useSdk(async () => fail({ message: "Internal error", status: 500 }));

        await expect(run()).rejects.toThrow("didn't answer a test query");
        expect(sdk.execute).toHaveBeenCalledTimes(2);

        now.mockReturnValue(1_000_000 + DISCOVERY_RETRY_MS - 1);
        await expect(run()).rejects.toThrow("didn't answer a test query");
        expect(sdk.execute).toHaveBeenCalledTimes(2);

        now.mockReturnValue(1_000_000 + DISCOVERY_RETRY_MS);
        await expect(run()).rejects.toThrow("didn't answer a test query");
        expect(sdk.execute).toHaveBeenCalledTimes(4);
    });

    it("ignores what a discovery finds after a reset", async () => {
        const answers: Array<(result: ManagedOperationResult) => void> = [];
        useSdk(() => new Promise((resolve) => {
            answers.push(resolve);
        }));

        const pending = run();
        await vi.waitFor(() => expect(answers).toHaveLength(1));
        resetConnectorDiscovery();
        answers[0](rows([{ "[ok]": 1 }]));
        await vi.waitFor(() => expect(answers).toHaveLength(2));
        answers[1](rows([]));
        await pending;

        expect(getDiagnostics().connector).toEqual({ status: "unknown", attempts: [] });
    });

    it("turns down Arrow DAX, lakehouse and warehouse queries", async () => {
        const proxy = new ManagedRuntimeProxy();

        await expect(proxy.semanticModel.executeDax()).rejects.toThrow("Arrow DAX is not supported on the Managed Runtime.");
        await expect(proxy.lakehouse.executeSql()).rejects.toThrow("Lakehouse queries are not supported on the Managed Runtime.");
        await expect(proxy.warehouse.executeSql()).rejects.toThrow("Warehouse queries are not supported on the Managed Runtime.");
    });
});

describe("recheckConnector", () => {
    it("forgets the operation it found and looks again", async () => {
        const sdk = useSdk(answering(() => rows([])));
        await run();

        await recheckConnector();

        expect(probes(sdk)).toBe(2);
        expect(getDiagnostics().connector.status).toBe("ready");
    });

    it("checks against the first semantic model that's set up", async () => {
        runtime.semanticModels = { vl: PLACEHOLDER, cc: { workspaceId: WS, itemId: OTHER_ITEM } };
        const sdk = useSdk(async () => rows([{ "[ok]": 1 }]));

        await recheckConnector();

        expect(sdk.execute).toHaveBeenCalledWith("powerbi", "ExecuteDatasetQueriesJson", expect.objectContaining({ groupId: WS, datasetId: OTHER_ITEM }));
        expect(getDiagnostics().connector.status).toBe("ready");
    });

    it("says when no semantic model is set up", async () => {
        runtime.semanticModels = { vl: PLACEHOLDER };
        const sdk = useSdk(async () => rows([]));

        await recheckConnector();

        expect(getDiagnostics().connector).toEqual({
            status: "failed",
            attempts: [],
            error: "No semantic model is set up to check against. Add one to managed-app.config.json.",
        });
        expect(sdk.execute).not.toHaveBeenCalled();
    });

    it("says when the SDK won't load", async () => {
        await recheckConnector();

        expect(getDiagnostics().connector).toEqual({ status: "failed", attempts: [], error: "The Managed Runtime SDK didn't load." });
    });

    it("records a failed check without throwing", async () => {
        useSdk(async () => fail({ message: "Internal error", status: 500 }));

        await expect(recheckConnector()).resolves.toBeUndefined();
        expect(getDiagnostics().connector.status).toBe("failed");
    });
});

describe("queryErrorBody", () => {
    const body = (value: string, code = "DatasetExecuteQueriesError") => JSON.stringify({
        error: {
            code: "DatasetExecuteQueriesError",
            "pbi.error": { code, details: [{ code: "DetailsMessage", detail: { type: 1, value } }] },
        },
    });

    it("passes on a body that already has a Power BI error", () => {
        const json = { error: { code: "DatasetExecuteQueriesError", "pbi.error": { code: "QueryUserError" } } };

        expect(queryErrorBody(`Bad request: ${JSON.stringify(json)}`)).toBe(JSON.stringify(json));
    });

    it("reads the message out of JSON the connector wrapped", () => {
        expect(queryErrorBody('{"error":{"message":" The column x doesn\'t exist. "}}', "BadRequest"))
            .toBe(body("The column x doesn't exist.", "BadRequest"));
        expect(queryErrorBody('{"message":"Top-level message"}')).toBe(body("Top-level message"));
    });

    it("words plain text, cut to 500 characters", () => {
        expect(queryErrorBody(" Syntax error ")).toBe(body("Syntax error"));
        expect(queryErrorBody("")).toBe(body("The query failed."));

        const value: unknown = JSON.parse(queryErrorBody("x".repeat(600))).error["pbi.error"].details[0].detail.value;
        expect(value).toHaveLength(500);
        expect(String(value).endsWith("…")).toBe(true);
    });
});
