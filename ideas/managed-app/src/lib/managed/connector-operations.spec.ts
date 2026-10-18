//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
    ADD_DATA_SOURCE_COMMAND,
    buildParameters,
    classifyResult,
    connectorCandidates,
    hasRows,
    normalizeResponse,
} from "./connector-operations";
import type { ApiDefinition } from "./host";

const bodyApi: ApiDefinition = {
    path: "/v1.0/myorg/groups/{groupId}/datasets/{datasetId}/executeQueries",
    method: "POST",
    parameters: [
        { name: "groupId", in: "path", required: true },
        { name: "datasetId", in: "path", required: true },
        { name: "requestBody", in: "body", required: true },
    ],
};

const paramsApi: ApiDefinition = {
    path: "/v1.0/myorg/groups/{group_id}/datasets/{dataset-id}/executeQuery",
    method: "POST",
    parameters: [
        { name: "group_id", in: "path" },
        { name: "dataset-id", in: "path" },
        { name: "query", in: "body" },
        { name: "includeNulls", in: "query" },
        { name: "impersonatedUserName", in: "query" },
    ],
};

const table = (rows: unknown[]) => ({ results: [{ tables: [{ rows }] }] });

describe("connectorCandidates", () => {
    it("says how to add the connector when the app has no data sources", () => {
        expect(connectorCandidates({})).toEqual({
            candidates: [],
            problem: `The app has no data sources yet. Run \`${ADD_DATA_SOURCE_COMMAND}\`, then build and deploy again.`,
        });
    });

    it("tries the JSON operation first, with the REST body before the flat one", () => {
        const { candidates, problem } = connectorCandidates({
            powerbi: { apis: { ExecuteDatasetQuery: bodyApi, ListDatasets: bodyApi, ExecuteDatasetQueriesJson: bodyApi } },
        });

        expect(problem).toBeUndefined();
        expect(candidates).toEqual([
            { dataSource: "powerbi", operation: "ExecuteDatasetQueriesJson", shape: "rest" },
            { dataSource: "powerbi", operation: "ExecuteDatasetQueriesJson", shape: "flat" },
            { dataSource: "powerbi", operation: "ExecuteDatasetQuery", shape: "flat" },
            { dataSource: "powerbi", operation: "ExecuteDatasetQuery", shape: "rest" },
        ]);
    });

    it("passes values one by one to an operation without a body parameter", () => {
        expect(connectorCandidates({ powerbi: { apis: { ExecuteDatasetQuery: paramsApi } } }).candidates)
            .toEqual([{ dataSource: "powerbi", operation: "ExecuteDatasetQuery", shape: "params" }]);
    });

    it("finds other query operations by name, after the known ones", () => {
        const { candidates } = connectorCandidates({
            powerbi: { apis: { ExecuteQueriesV2: paramsApi, ExecuteDatasetQueriesJson: bodyApi } },
        });

        expect(candidates.map((candidate) => candidate.operation))
            .toEqual(["ExecuteDatasetQueriesJson", "ExecuteDatasetQueriesJson", "ExecuteQueriesV2"]);
    });

    it("tries Power BI data sources before others", () => {
        const { candidates } = connectorCandidates({
            sql: { apis: { ExecuteDatasetQuery: paramsApi } },
            "Power BI": { apis: { ExecuteDatasetQuery: paramsApi } },
        });

        expect(candidates.map((candidate) => candidate.dataSource)).toEqual(["Power BI", "sql"]);
    });

    it("keeps to the pinned data source and operations, whatever their case", () => {
        const { candidates } = connectorCandidates(
            {
                PowerBI: { apis: { ExecuteDatasetQueriesJson: bodyApi, ExecuteDatasetQuery: bodyApi } },
                other: { apis: { ExecuteDatasetQuery: bodyApi } },
            },
            { dataSource: "powerbi", operations: ["executedatasetquery"] },
        );

        expect(candidates).toEqual([
            { dataSource: "PowerBI", operation: "ExecuteDatasetQuery", shape: "flat" },
            { dataSource: "PowerBI", operation: "ExecuteDatasetQuery", shape: "rest" },
        ]);
    });

    it("names the data sources there are when the pinned one is missing", () => {
        expect(connectorCandidates({ powerbi: { apis: {} }, sql: { apis: {} } }, { dataSource: "Fabric" })).toEqual({
            candidates: [],
            problem: 'The config pins the data source "Fabric", but the app only has powerbi, sql.',
        });
    });

    it("says which operation it needs when no data source has one", () => {
        expect(connectorCandidates({ powerbi: { apis: { GetDatasets: bodyApi } } }).problem).toBe(
            "No data source has the ExecuteDatasetQueriesJson or ExecuteDatasetQuery operation. `ms app add data-source` leaves out " +
            `actions the connector policy blocks, so an admin may need to turn them on. Then run \`${ADD_DATA_SOURCE_COMMAND}\`, and build and deploy again.`,
        );
        expect(connectorCandidates({ powerbi: { apis: { GetDatasets: bodyApi } } }, { operations: ["RunQuery", "RunQueries"] }).problem)
            .toMatch(/^No data source has the RunQuery or RunQueries operation\./);
    });
});

describe("buildParameters", () => {
    it("puts the REST API's executeQueries body in the body parameter", () => {
        expect(buildParameters(bodyApi, "rest", "ws-1", "item-1", "EVALUATE A")).toEqual({
            groupId: "ws-1",
            datasetId: "item-1",
            requestBody: { queries: [{ query: "EVALUATE A" }], serializerSettings: { includeNulls: true } },
        });
    });

    it("sends the connector's one-query body when asked", () => {
        expect(buildParameters(bodyApi, "flat", "ws-1", "item-1", "EVALUATE A").requestBody)
            .toEqual({ query: "EVALUATE A", serializerSettings: { includeNulls: true } });
    });

    it("matches parameter names loosely, and never impersonates anyone", () => {
        const parameters = buildParameters(paramsApi, "params", "ws-1", "item-1", "EVALUATE A");

        expect(parameters).toEqual({ group_id: "ws-1", "dataset-id": "item-1", query: "EVALUATE A", includeNulls: true });
        expect(parameters).not.toHaveProperty("impersonatedUserName");
    });
});

describe("normalizeResponse", () => {
    it("reads executeQueries JSON, as an object or as text", () => {
        expect(normalizeResponse(table([{ "[ok]": 1 }]))).toEqual(table([{ "[ok]": 1 }]));
        expect(normalizeResponse(JSON.stringify(table([{ "[ok]": 1 }])))).toEqual(table([{ "[ok]": 1 }]));
    });

    it("unwraps response and body wrappers", () => {
        expect(normalizeResponse({ response: { body: JSON.stringify(table([])) } })).toEqual(table([]));
    });

    it("keeps an error for the SDK to read", () => {
        const error = { error: { code: "DatasetExecuteQueriesError", "pbi.error": { code: "x" } } };
        expect(normalizeResponse(error)).toBe(error);
    });

    it("wraps bare rows", () => {
        expect(normalizeResponse({ firstTableRows: [{ "[ok]": 1 }] })).toEqual(table([{ "[ok]": 1 }]));
        expect(normalizeResponse({ value: [{ "[ok]": 1 }] })).toEqual(table([{ "[ok]": 1 }]));
        expect(normalizeResponse([{ "[ok]": 1 }])).toEqual(table([{ "[ok]": 1 }]));
    });

    it("gives up on anything else", () => {
        expect(normalizeResponse("not json")).toBeUndefined();
        expect(normalizeResponse([1, 2])).toBeUndefined();
        expect(normalizeResponse({ other: 1 })).toBeUndefined();
        expect(normalizeResponse(42)).toBeUndefined();
        expect(normalizeResponse(undefined)).toBeUndefined();

        let deep: unknown = table([]);
        for (let level = 0; level < 10; level++)
            deep = { response: deep };
        expect(normalizeResponse(deep)).toBeUndefined();
    });
});

describe("hasRows", () => {
    it("is true only for a first table with rows", () => {
        expect(hasRows(table([]))).toBe(true);
        expect(hasRows({ results: [] })).toBe(false);
        expect(hasRows({ results: [{ tables: [{}] }] })).toBe(false);
        expect(hasRows({ error: { code: "x" } })).toBe(false);
    });
});

describe("classifyResult", () => {
    const failed = (error: { message: string; status?: number; code?: string; requestId?: string }) =>
        classifyResult({ success: false, error });

    it("reads a success", () => {
        expect(classifyResult({ success: true, data: table([]) })).toEqual({ kind: "ok", response: table([]) });
        expect(classifyResult({ success: true, data: "<html>" }))
            .toEqual({ kind: "unreadable", message: "The connector answered, but not with query results." });
    });

    it("sorts failures by what the proxy does next", () => {
        expect(failed({ message: "Slow down", status: 429 })).toEqual({ kind: "throttled", message: "Slow down", status: 429 });
        expect(failed({ message: "No", status: 401 }).kind).toBe("denied");
        expect(failed({ message: "No", status: 403 }).kind).toBe("denied");
        expect(failed({ message: "Bad DAX", status: 400, code: "BadRequest", requestId: "r-1" }))
            .toEqual({ kind: "rejected", message: "Bad DAX", status: 400, code: "BadRequest", requestId: "r-1" });
        expect(failed({ message: "Boom", status: 500 }).kind).toBe("failed");
        expect(failed({ message: "Offline" })).toEqual({ kind: "unreachable", message: "Offline" });
    });

    it("spots a data policy by its code or its message, before a refusal", () => {
        expect(failed({ message: "No", status: 403, code: "DlpPolicyViolation" }).kind).toBe("blocked");
        expect(failed({ message: "Blocked by your organization's data loss prevention policy.", status: 403 }).kind).toBe("blocked");
        expect(failed({ message: "The DLP rules stop this connector." }).kind).toBe("blocked");
    });

    it("words a failure that has no message", () => {
        expect(classifyResult({ success: false })).toEqual({ kind: "unreachable", message: "The connector call failed." });
        expect(failed({ message: "  ", status: 502 })).toEqual({ kind: "failed", message: "The connector call failed.", status: 502 });
    });
});
