//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { activationByOrg } from "@/queries/adoption/activation-by-org";
import { trendHeatmap } from "@/queries/adoption/trend-heatmap";
import { modelFitByOrganization } from "@/queries/efficiency/model-fit-by-organization";
import { executiveDepartments } from "@/queries/executive/executive-departments";
import { withTaskTimes } from "@/queries/assumptions/task-times";
import { licensePriorityByOrg } from "@/queries/licensing/license-priority-by-org";
import { describeOrgAttribute, isOrgAttribute, orgColumnRef, orgValueFilter, pickOrgAttributes, withIndefiniteArticle, withOrgAttribute } from "./org-attribute";

describe("describeOrgAttribute", () => {
    it.each([
        ["Organization", "Organization", "organization", "organizations"],
        ["officeLocation", "Office location", "office location", "office locations"],
        ["cost_centre", "Cost centre", "cost centre", "cost centres"],
        ["Country", "Country", "country", "countries"],
        ["Business Unit", "Business unit", "business unit", "business units"],
        ["BU", "BU", "BU", "BUs"],
    ])("names %s for display", (column, label, noun, plural) => {
        expect(describeOrgAttribute(column)).toEqual({ column, label, noun, plural });
    });
});

describe("withIndefiniteArticle", () => {
    it.each([
        ["organization", "an organization"],
        ["office location", "an office location"],
        ["department", "a department"],
        ["cost centre", "a cost centre"],
        ["business unit", "a business unit"],
        ["unit", "a unit"],
        ["user group", "a user group"],
        ["HR team", "an HR team"],
        ["BU", "a BU"],
        ["SBU", "an SBU"],
        ["UK region", "a UK region"],
        ["hourly band", "an hourly band"],
    ])("reads %s as %s", (phrase, expected) => {
        expect(withIndefiniteArticle(phrase)).toBe(expected);
    });
});

describe("pickOrgAttributes", () => {
    // The live demo model's org table, as COLUMNSTATISTICS reports it.
    const live = [
        { column: "RowNumber-2662979B-1795-4F74-8F37-6A1BA8059B61", cardinality: 260, maxLength: undefined },
        { column: "Organization", cardinality: 6, maxLength: 9 },
        { column: "PersonId", cardinality: 260, maxLength: 24 },
        { column: "PersonId_Normalized", cardinality: 260, maxLength: 24 },
        { column: "officeLocation", cardinality: 5, maxLength: 9 },
        { column: "Function", cardinality: 6, maxLength: 20 },
        { column: "Location", cardinality: 5, maxLength: 9 },
    ];

    it("keeps groupings, drops identifiers, and leads with Organization", () => {
        expect(pickOrgAttributes(live)).toEqual(["Organization", "Function", "Location", "officeLocation"]);
    });

    it("keeps high-cardinality and non-text business attributes, but drops constants", () => {
        const stats = [
            { column: "Country", cardinality: 1, maxLength: 2 },
            { column: "JobTitle", cardinality: 9000, maxLength: 40 },
            { column: "Region", cardinality: 4, maxLength: 6 },
            { column: "Headcount", cardinality: 3, maxLength: undefined },
        ];
        expect(pickOrgAttributes(stats)).toEqual(["Headcount", "JobTitle", "Region"]);
    });

    it("recognises identifiers without catching ordinary words", () => {
        const stats = ["ManagerId", "manager_id", "UserPrincipalName", "mail", "Paid", "Grid"].map((column) => ({
            column,
            cardinality: 5,
            maxLength: 10,
        }));
        expect(pickOrgAttributes(stats)).toEqual(["Grid", "Paid"]);
    });

    it("does not mistake business IDs or name fragments for person identifiers", () => {
        const columns = ["CostCenterId", "BusinessUnitID", "PrincipalOffice", "EmailPolicy", "NormalizedRegion", "UPNRegion"];
        const stats = columns.map((column) => ({ column, cardinality: 20000, maxLength: 30 }));
        expect(new Set(pickOrgAttributes(stats))).toEqual(new Set(columns));
    });

    it.each(["PersonId", "User Key", "managerUPN", "Org Join Key", "Hierarchy Path", "OrgPath", "displayName", "TotalEmployees", "Level5_User Key"])(
        "excludes person/internal field %s", (column) => expect(isOrgAttribute(column)).toBe(false),
    );

    it.each(["IsManager", "DirectReports", "OrgLevel", "Level2_Name", "TopOfChain_Name", "StartDate"])(
        "keeps meaningful typed/hierarchy field %s", (column) => expect(isOrgAttribute(column)).toBe(true),
    );

    it("compares the model's serialized values, including zero, false and dates, with escaped literals", () => {
        expect(orgValueFilter("Team ]", ['A"B', "0", "FALSE", "2026-01-01"])).toBe(
            `TREATAS(CALCULATETABLE(VALUES('Org Attribute Source'[PersonId_Normalized]), 'Org Attribute Source'[Attribute] = "Team ]", 'Org Attribute Source'[Value] IN {"A""B", "0", "FALSE", "2026-01-01"}), 'Chat + Agent Org Data'[PersonId_Normalized])`,
        );
    });

    it("supports the Evaluator join key without changing the bridge key", () => {
        expect(orgValueFilter("IsManager", ["FALSE"], "Org Join Key")).toBe(
            `TREATAS(CALCULATETABLE(VALUES('Org Attribute Source'[PersonId_Normalized]), 'Org Attribute Source'[Attribute] = "IsManager", 'Org Attribute Source'[Value] IN {"FALSE"}), 'Chat + Agent Org Data'[Org Join Key])`,
        );
        expect(orgValueFilter("Organization", [])).toContain("'Org Attribute Source'[Value] IN {}");
        expect(orgValueFilter("Organization", ["Sales"], "Key ]")).toContain("'Chat + Agent Org Data'[Key ]]]");
    });
});

describe("withOrgAttribute", () => {
    const location = describeOrgAttribute("officeLocation");

    it("leaves Organization queries untouched", () => {
        const config = activationByOrg();
        expect(withOrgAttribute(config, describeOrgAttribute("Organization"))).toBe(config);
    });

    it("rebinds the DAX, the result key and every Organization label", () => {
        const rebound = withOrgAttribute(activationByOrg(), location);

        expect(rebound.query).not.toContain("[Organization]");
        expect(rebound.query).toContain("'Org Attribute Source'[Value]");
        expect(rebound.query).toContain(`'Org Attribute Source'[Attribute] = "officeLocation"`);
        expect(rebound.query).toMatch(/EVALUATE\s+CALCULATETABLE\(/);
        expect(rebound.columnMetadata["Org Attribute Source[Value]"]).toEqual({
            name: "Chat + Agent Org DataOrganization",
            displayName: "Office location",
        });
        expect(JSON.stringify(rebound.vegaLiteSpec)).not.toContain('"title":"Organization"');
    });

    it.each([
        ["trendHeatmap", () => trendHeatmap()],
        ["licensePriorityByOrg", () => licensePriorityByOrg()],
    ])("rebinds %s completely", (_name, factory) => {
        const rebound = withOrgAttribute(factory(), location);
        expect(rebound.query).not.toContain("'Chat + Agent Org Data'[Organization]");
    });

    it("escapes a closing bracket in a column name", () => {
        expect(orgColumnRef("Team [EMEA]")).toBe("'Chat + Agent Org Data'[Team [EMEA]]]");
    });

    it("does not interpret dollar sequences in discovered column names as replacement patterns", () => {
        const rebound = withOrgAttribute(activationByOrg(), describeOrgAttribute("Team $& $' $`"));
        expect(rebound.query).toContain(`'Org Attribute Source'[Attribute] = "Team $& $' $\`"`);
    });

    it("groups Model Fit by the chosen attribute", () => {
        const { query } = modelFitByOrganization(location);
        expect(query).toContain("'Org Attribute Source'[Value]");
        expect(query).toContain(`'Org Attribute Source'[Attribute] = "officeLocation"`);
        expect(query).toContain("Unassigned office location");
    });

    it.each(["IsManager", "DirectReports", "StartDate", 'Team ] "code"', "__COLUMN__", "__BLANK_LABEL__", "ORDER BY\nEVALUATE"])(
        "uses invariant bridge text for loaded source attribute %s", (column) => {
            const rebound = withOrgAttribute(activationByOrg(), describeOrgAttribute(column));
            expect(rebound.query).toContain("'Org Attribute Source'[Value]");
            expect(rebound.query).toContain(`'Org Attribute Source'[Attribute] = "${column.replaceAll('"', '""')}"`);
            expect(rebound.query).not.toContain(orgColumnRef(column));
        },
    );

    it("preserves DEFINE measures and ORDER BY outside the filtered EVALUATE expression", () => {
        const source = `DEFINE MEASURE 'Metrics'[Count] = COUNTROWS('Chat + Agent Org Data')
EVALUATE
VAR Groups = VALUES('Chat + Agent Org Data'[Organization])
RETURN ADDCOLUMNS(Groups, "People", [Count])
ORDER BY 'Chat + Agent Org Data'[Organization] ASC`;
        const { query } = withOrgAttribute({ query: source }, location);
        expect(query).toMatch(/^DEFINE MEASURE[\s\S]*EVALUATE\s+CALCULATETABLE\(\s+VAR Groups/);
        expect(query).toMatch(/'Org Attribute Source'\[Attribute\] = "officeLocation"\s+\)\s+ORDER BY 'Org Attribute Source'\[Value\] ASC$/);
    });

    it("wraps every EVALUATE and ignores delimiters inside literals, comments and identifiers", () => {
        const source = `EVALUATE
// ORDER BY is not a query delimiter
VAR Example = "EVALUATE
ORDER BY"
RETURN ROW("Text", Example, "Count", [EVALUATE])
ORDER BY [Text]
EVALUATE ROW("Text", "START AT", "Count", COUNTROWS('Chat + Agent Org Data'))`;
        const { query } = withOrgAttribute({ query: source }, location);
        expect(query.match(/CALCULATETABLE\(/g)).toHaveLength(2);
        expect(query.match(/'Org Attribute Source'\[Attribute\] = "officeLocation"/g)).toHaveLength(2);
        expect(query).toContain('VAR Example = "EVALUATE\nORDER BY"');
        expect(query).toContain('ORDER BY [Text]\nEVALUATE\nCALCULATETABLE(');
    });

    it("does not replace tokens inserted in Model Fit labels", () => {
        const column = "Team __GROUPING_COLUMN__ __BLANK_LABEL__ $&";
        const { query } = modelFitByOrganization(describeOrgAttribute(column));
        expect(query).toContain(`'Org Attribute Source'[Attribute] = "${column}"`);
        expect(query).toContain("Unassigned team GROUPING COLUMN BLANK LABEL $&");
    });

    it("clears bridge groups alongside raw org table removal but retains the attribute selector", () => {
        const source = `EVALUATE ROW("Days",
CALCULATE([Days], REMOVEFILTERS('Chat + Agent Org Data')),
"Share", CALCULATE([People], REMOVEFILTERS('Chat + Agent Org Data'[Organization])))`;
        const { query } = withOrgAttribute({ query: source }, location);
        expect(query).toContain("REMOVEFILTERS('Chat + Agent Org Data'), REMOVEFILTERS('Org Attribute Source'[Value])");
        expect(query).toContain('"Share", CALCULATE([People], REMOVEFILTERS(\'Org Attribute Source\'[Value]))');
        expect(query).toContain(`'Org Attribute Source'[Attribute] = "officeLocation"`);
        expect(query).not.toContain("REMOVEFILTERS('Org Attribute Source')");
    });

    it("preserves expanded-table denominator clearing in executive query-scoped measures", () => {
        const { query } = withOrgAttribute(executiveDepartments(), location);
        expect(query.match(/ALLEXCEPT\([^\r\n]+, REMOVEFILTERS\('Org Attribute Source'\[Value\]\)/g)).toHaveLength(2);
        expect(query).toMatch(/^DEFINE/);
        expect(query).toContain(`'Org Attribute Source'[Attribute] = "officeLocation"`);
    });

    it("does not rewrite expressions inside string literals or comments", () => {
        const source = `EVALUATE
// REMOVEFILTERS('Chat + Agent Org Data')
ROW("Text", "'Chat + Agent Org Data'[Organization]", "Note", "REMOVEFILTERS('Chat + Agent Org Data')")`;
        const { query } = withOrgAttribute({ query: source }, location);
        expect(query).toContain(source.slice(source.indexOf("//")));
    });

    it("also rebinds task-time definitions injected after the query was bound", () => {
        const source = `EVALUATE ROW("Hours", [Expert Equivalent Hours Per Week],
"Efficiency", [Efficiency - Hours Per User Per Week], "Headline", [Heatmap Headline])`;
        const overrides = [{ task: "Draft", low: 1, typical: 2, high: 3 }];
        const { query } = withOrgAttribute({ query: source }, location);
        const timed = withTaskTimes(query, overrides);
        expect(timed).not.toContain("'Chat + Agent Org Data'[Organization]");
        expect(timed).toContain("VALUES('Org Attribute Source'[Value])");
        expect(timed.match(/ALLEXCEPT\([^\r\n]+, REMOVEFILTERS\('Org Attribute Source'\[Value\]\)/g)).toHaveLength(2);
        const canonical = withTaskTimes(source, overrides);
        expect(canonical).toContain("'Chat + Agent Org Data'[Organization]");
        expect(canonical).not.toContain("'Org Attribute Source'");
    });
});
