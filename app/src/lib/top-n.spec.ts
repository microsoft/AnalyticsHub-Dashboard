//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import type { DataTable } from "@microsoft/fabric-visuals-core";
import { topNote, topRows, topWithOther } from "./top-n";

const orgs = (count: number): DataTable => ({
    columns: [{ name: "Org" }, { name: "Active" }, { name: "Inactive" }],
    rows: Array.from({ length: count }, (_, index) => [`Org ${index + 1}`, count - index, index]),
});

const other = (count: number) => `Other (${count} orgs)`;

describe("topWithOther", () => {
    it("keeps the largest categories and folds the rest into one Other row", () => {
        const top = topWithOther(orgs(20), { label: "Org", by: "Active", n: 3, sum: ["Active", "Inactive"], other });

        expect(top.table.rows).toEqual([
            ["Org 1", 20, 0],
            ["Org 2", 19, 1],
            ["Org 3", 18, 2],
            ["Other (17 orgs)", 153, 187],
        ]);
        expect(top).toMatchObject({ shown: 3, of: 20 });
    });

    it("keeps every total whole", () => {
        const table = orgs(120);
        const sumOf = (rows: unknown[][], index: number) => rows.reduce((total, row) => total + (row[index] as number), 0);
        const top = topWithOther(table, { label: "Org", by: "Active", sum: ["Active", "Inactive"], other });

        expect(top.table.rows).toHaveLength(16);
        expect(sumOf(top.table.rows, 1)).toBe(sumOf(table.rows, 1));
        expect(sumOf(top.table.rows, 2)).toBe(sumOf(table.rows, 2));
    });

    it("ranks by the largest first, whatever order the rows came in", () => {
        const table: DataTable = { columns: orgs(0).columns, rows: [["Small", 1, 0], ["Big", 9, 0], ["Mid", 5, 0]] };

        expect(topWithOther(table, { label: "Org", by: "Active", sum: ["Active"], other }).table.rows.map((row) => row[0])).toEqual([
            "Big",
            "Mid",
            "Small",
        ]);
    });

    it("folds one Other row per key, such as a week", () => {
        const table: DataTable = {
            columns: [{ name: "Org" }, { name: "Week" }, { name: "People" }],
            rows: [
                ["A", "w1", 10],
                ["A", "w2", 12],
                ["B", "w1", 3],
                ["B", "w2", null],
                ["C", "w1", 2],
                ["C", "w2", 4],
            ],
        };

        expect(topWithOther(table, { label: "Org", by: "People", n: 1, sum: ["People"], other }).table.rows).toEqual([
            ["A", "w1", 10],
            ["A", "w2", 12],
            ["Other (2 orgs)", "w1", 5],
            ["Other (2 orgs)", "w2", 4],
        ]);
    });

    it("adds no Other row when everything fits", () => {
        const top = topWithOther(orgs(4), { label: "Org", by: "Active", sum: ["Active"], other });

        expect(top.table.rows).toHaveLength(4);
        expect(top).toMatchObject({ shown: 4, of: 4 });
    });
});

describe("topRows", () => {
    it("keeps the largest categories by one measure and drops the rest", () => {
        const top = topRows(orgs(40), { label: "Org", by: "Active", n: 15 });

        expect(top.table.rows).toHaveLength(15);
        expect(top.table.rows[0][0]).toBe("Org 1");
        expect(top).toMatchObject({ shown: 15, of: 40 });
    });
});

describe("topNote", () => {
    it("says when a chart shows only the top of the list", () => {
        expect(topNote({ shown: 15, of: 1_204 }, "organizations", "active users")).toBe(
            "Top 15 of 1,204 organizations by active users",
        );
        expect(topNote({ shown: 6, of: 6 }, "organizations", "active users")).toBeUndefined();
    });
});
