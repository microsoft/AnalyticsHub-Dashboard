//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------
import type { QueryTable } from "@microsoft/fabric-app-data";
import { describe, expect, it } from "vitest";
import { PEOPLE_WITH_ACTIVITY } from "@/lib/filters";
import { describeOrgAttribute } from "@/lib/org-attribute";
import { filterOptions, orgAttributeOptions, orgValueOptions, toFilterOptions, toOrgAttributes, toOrgValues } from "./filter-options";

const column = (name: string) => ({ name, dataType: "String" });

function options(rows: [string, string][]) {
    const table: QueryTable = { columns: [column("[Kind]"), column("[Value]")], rows };
    return toFilterOptions(table);
}

describe("filter options' tenant size", () => {
    it("counts people as each query does to decide the tenant's default dates", () => {
        expect(filterOptions().query).toContain(`FORMAT(${PEOPLE_WITH_ACTIVITY}, "0")`);
    });

    describe("org attributes", () => {
        it("discovers every business type and cardinality without requiring headcount", () => {
            expect(toOrgAttributes({
                columns: ["[Column]", "[Cardinality]", "[Max Length]"].map(column),
                rows: [
                    ["Organization", 4, 20], ["CostCenterId", 18000, 50], ["OrgLevel", 8, null],
                    ["HireDate", 9000, null], ["IsManager", 2, null], ["PersonId", 20000, 40],
                    ["Constant", 1, 8],
                ],
            })).toEqual(["Organization", "CostCenterId", "HireDate", "IsManager", "OrgLevel"]);
        });

        it("checks two populated values per attribute without activity scans or fixed schema discovery", () => {
            const { query, connection } = orgAttributeOptions();
            expect(connection).toBe("vl");
            expect(query).toContain("'Org Attribute Source'[Attribute]");
            expect(query).toMatch(/TOPN\(\s*2,/);
            expect(query).toContain("LEN(TRIM('Org Attribute Source'[Value])) > 0");
            expect(query).not.toContain("Audit Logs");
            expect(query).not.toContain("COLUMNSTATISTICS");
            expect(query).not.toMatch(/__[A-Z_]+__/);
        });

        it("keeps arbitrary source names and excludes blank-plus-single-value attributes", () => {
            expect(toOrgAttributes({
                columns: ["[Column]", "[Cardinality]"].map(column),
                rows: [["Team $&", 2], ["__COLUMN__", 2], ["Constant", 1], ["Empty", 0]],
            })).toEqual(["__COLUMN__", "Team $&"]);
        });

        it("round-trips model-serialized typed values without dropping zero or false", () => {
            const query = orgValueOptions(describeOrgAttribute("IsManager")).query;
            expect(query).toContain(`"Value", CONVERT('Org Attribute Source'[Value], STRING)`);
            expect(toOrgValues({ columns: [column("[Value]")], rows: [["0"], ["FALSE"], ["2026-01-01"], [" "]] })).toEqual(["0", "FALSE", "2026-01-01"]);
        });
    });

    it("says a tenant is large above the threshold, and small at or below it", () => {
        expect(options([["people", "20000"]]).largeTenant).toBe(true);
        expect(options([["people", "10000"]]).largeTenant).toBe(false);
        expect(options([["people", "12"]]).largeTenant).toBe(false);
    });

    it("says nothing about the size when the count didn't come back", () => {
        expect(options([["lastDate", "2026-10-04"]]).largeTenant).toBeUndefined();
        expect(options([["people", "n/a"]]).largeTenant).toBeUndefined();
    });
});
