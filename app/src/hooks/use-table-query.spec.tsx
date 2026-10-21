//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { QueryTable } from "@microsoft/fabric-app-data";
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CREDIT_PARTS, executiveCredits } from "@/queries/executive";
import creditRows from "@/queries/executive/__fixtures__/executive-credits.rows.json";
import { useTablePartsQuery, useTableQuery } from "./use-table-query";

const state = vi.hoisted(() => ({ answers: new Map<string, unknown>(), refetch: () => {} }));

vi.mock("./use-filtered-query", () => ({
    useFilteredQuery: (config: { query: string }) => ({
        data: state.answers.get(config.query),
        refetch: state.refetch,
        notFilteredBy: [],
    }),
}));

const COLUMNS = [
    { name: "[Month Start]", dataType: "DateTime" },
    { name: "[Studio Credits]", dataType: "Double" },
    { name: "[Cowork Credits]", dataType: "Double" },
];
const toRow = (row: Record<string, unknown>) => COLUMNS.map((column) => row[column.name]);
const TREND_ROWS = creditRows.map(toRow);
const RANGE_ROWS = creditRows.slice(-2).map(toRow);
const success = (table: QueryTable) => ({ status: "success", table });
const source = (query: string) => ({ ...executiveCredits(), query });

/** The page's two credits queries, each on its own, beside the one query that asks both. */
function render() {
    return renderHook(() => ({
        trend: useTableQuery(source("TREND")),
        range: useTableQuery(source("RANGE")),
        parts: useTablePartsQuery(source("PARTS"), CREDIT_PARTS),
    })).result.current;
}

describe("useTablePartsQuery", () => {
    beforeEach(() => state.answers.clear());

    it("reads each part as its own query read it", () => {
        state.answers.set("TREND", success({ columns: COLUMNS, rows: TREND_ROWS }));
        state.answers.set("RANGE", success({ columns: COLUMNS, rows: RANGE_ROWS }));
        state.answers.set(
            "PARTS",
            success({
                columns: [...COLUMNS, { name: "[Part]", dataType: "String" }],
                rows: [...RANGE_ROWS.map((row) => [...row, "range"]), ...TREND_ROWS.map((row) => [...row, "trend"])],
            }),
        );

        const { trend, range, parts } = render();
        expect(trend.table?.rows.length).toBe(creditRows.length);
        expect(parts.trend.table).toEqual(trend.table);
        expect(parts.range.table).toEqual(range.table);
        expect(parts.trend.isLoading || parts.range.isLoading).toBe(false);
    });

    it("gives a part with no rows an empty table, as its own query's empty answer", () => {
        state.answers.set("RANGE", success({ columns: COLUMNS, rows: [] }));
        state.answers.set(
            "PARTS",
            success({ columns: [...COLUMNS, { name: "[Part]", dataType: "String" }], rows: TREND_ROWS.map((row) => [...row, "trend"]) }),
        );

        const { range, parts } = render();
        expect(parts.range.table).toEqual(range.table);
        expect(parts.range.table?.rows).toEqual([]);
    });

    it("loads and fails every part together", () => {
        expect(render().parts).toMatchObject({
            trend: { table: undefined, error: undefined, isLoading: true },
            range: { table: undefined, error: undefined, isLoading: true },
        });

        state.answers.set("PARTS", { status: "error", error: { message: "Too busy" } });
        const { parts } = render();
        expect(parts).toMatchObject({
            trend: { table: undefined, error: "Too busy", isLoading: false },
            range: { table: undefined, error: "Too busy", isLoading: false },
        });
        expect(parts.trend.refetch).toBe(state.refetch);
        expect(parts.range.refetch).toBe(state.refetch);
    });
});
