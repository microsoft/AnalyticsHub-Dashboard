//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { applyDaxFilters } from "@/lib/dax-filters";
import { isGroupRow } from "@/lib/rollup-tree";
import { toDataTable, type ColumnMetadataMap } from "@/lib/to-data-table";
import {
    answerArchetypes,
    conversationsSummary,
    evaluationFilters,
    evaluationOptions,
    evaluationOrgAttributes,
    evaluationOrgGroupOptions,
    feedbackComments,
    GROUP_BY_COLUMNS,
    groupByChoices,
    hasEvaluationData,
    knowledgeSources,
    NO_SELECTION,
    performanceByGroup,
    performanceErrors,
    performanceSummary,
    performanceWeekly,
    readableArchetypes,
    readableErrors,
    readableGroups,
    readEvaluationOptions,
    readEvaluationOrgAttributes,
    selectionRange,
    themeOutcomes,
    TOPIC_LABEL_COLUMN,
    topicHealth,
    toTopicTree,
} from "./index";
import { liveColumns } from "./live-columns.fixture";
import topicRows from "./__fixtures__/topic-health.rows.json";

const agent = GROUP_BY_COLUMNS.find((column) => column.id === "agent")!;

const modules = [
    { name: "evaluationOptions", factory: () => evaluationOptions(), columns: liveColumns.evaluationOptions },
    { name: "performanceSummary", factory: () => performanceSummary(), columns: liveColumns.performanceSummary },
    { name: "performanceWeekly", factory: () => performanceWeekly(), columns: liveColumns.performanceWeekly },
    { name: "performanceByGroup", factory: () => performanceByGroup(agent), columns: liveColumns.performanceByGroup },
    { name: "performanceErrors", factory: () => performanceErrors(), columns: liveColumns.performanceErrors },
    { name: "conversationsSummary", factory: () => conversationsSummary(), columns: liveColumns.conversationsSummary },
    { name: "themeOutcomes", factory: () => themeOutcomes(), columns: liveColumns.themeOutcomes },
    { name: "topicHealth", factory: () => topicHealth(), columns: liveColumns.topicHealth },
    { name: "knowledgeSources", factory: () => knowledgeSources(), columns: liveColumns.knowledgeSources },
    { name: "answerArchetypes", factory: () => answerArchetypes(), columns: liveColumns.answerArchetypes },
    { name: "feedbackComments", factory: () => feedbackComments(), columns: liveColumns.feedbackComments },
];

type SpecFactory = () => { columnMetadata: ColumnMetadataMap; vegaLiteSpec: unknown };

const specModules: { name: string; factory: SpecFactory }[] = modules.filter(
    (module): module is (typeof modules)[number] & { factory: SpecFactory } => "vegaLiteSpec" in module.factory(),
);

function cleanColumnName(original: string): string {
    return original.replace(/[.[\]\\"']/g, "");
}

/** Every `field` a spec reads, and every field its transforms create. */
function collectFields(node: unknown, found = { read: new Set<string>(), made: new Set<string>() }) {
    if (Array.isArray(node)) {
        node.forEach((item) => collectFields(item, found));
    } else if (node && typeof node === "object") {
        for (const [key, value] of Object.entries(node)) {
            if (key === "field" && typeof value === "string") found.read.add(value);
            else if (key === "as") [value].flat().forEach((name) => typeof name === "string" && found.made.add(name));
            else collectFields(value, found);
        }
    }
    return found;
}

function table(columns: string[], rows: unknown[][]) {
    return { columns: columns.map((name) => ({ name })), rows } as never;
}

describe("agent evaluation query contract", () => {
    it.each(modules)("$name covers exactly the columns the model returns", ({ factory, columns }) => {
        expect(Object.keys(factory().columnMetadata).sort()).toEqual([...columns].sort());
    });

    it.each(modules)("$name derives ColumnDef names by the documented rule", ({ factory }) => {
        for (const [original, def] of Object.entries(factory().columnMetadata)) {
            expect(def.name).toBe(cleanColumnName(original));
        }
    });

    it.each(modules)("$name reads the Agent Evaluator connection", ({ factory }) => {
        expect(factory().connection).toBe("ae");
    });

    it.each(modules)("$name ships a complete DAX query without a byte-order mark", ({ factory }) => {
        const raw = factory().query;
        expect(raw.charCodeAt(0)).not.toBe(0xfeff);
        expect(raw.replace(/^(\s*\/\/.*\r?\n)+/, "").trim()).toMatch(/^(EVALUATE|DEFINE)\b/);
        expect(raw).not.toMatch(/__[A-Z_]+__/);
    });

    it.each(modules)("$name still parses once the page's slicers wrap it", ({ factory }) => {
        const wrapped = applyDaxFilters(factory().query, ["TREATAS({\"HR Leave Agent\"}, 'Agent Performance'[BotFriendlyName])"]);
        expect(wrapped).toContain("CALCULATETABLE(");
    });

    it("bounds non-org group eligibility without eager per-org conversation scans", () => {
        const query = evaluationOptions().query;
        for (const { id, column } of GROUP_BY_COLUMNS) {
            expect(query).toContain(`"Value", "${id}"`);
            expect(query).toContain(`SUMMARIZECOLUMNS(${column},`);
        }
        expect(query.match(/TOPN\(/g)).toHaveLength(3);
        expect(query).not.toContain(`"Value", "job-title"`);
        expect(query).not.toContain(`"Value", "department"`);
    });

    describe("Evaluator org grouping discovery", () => {
        function inventory(rows: unknown[][]) {
            return readEvaluationOrgAttributes(table(["[Column]"], rows));
        }

        it("discovers all types and cardinalities only from its own viewer-readable model", () => {
            const source = evaluationOrgAttributes();
            expect(source.connection).toBe("ae");
            expect(source.query).toContain("VALUES('Org Attribute Source'[Attribute])");
            expect(source.query).not.toMatch(/COLUMNSTATISTICS|INFO\.|TMSCHEMA|MAX.?LENGTH/i);
            const columns = inventory([
                ["Organization", 5], ["CostCenterId", 100000], ["accountEnabled", 2],
                ["StartDate", 5000], ["Budget", 10000], ["PersonId", 100000],
                ["displayName", 100000], ["Hierarchy Path", 100000],
            ]);
            expect(columns.map((column) => column.id)).toEqual([
                "department", "org:accountEnabled", "org:Budget", "org:CostCenterId", "org:StartDate",
            ]);
        });

        it("retains existing IDs and labels without assuming their columns are present", () => {
            const columns = inventory([
                ["Organization", 5], ["JobTitle", 4], ["officeLocation", 3], ["country", 2],
                ["usageLocation", 2], ["companyName", 2], ["Function", 2], ["Location", 2],
            ]);
            expect(Object.fromEntries(columns.map(({ id, label }) => [id, label]))).toEqual({
                department: "Department", "job-title": "Job title", office: "Office", country: "Country",
                "usage-location": "Usage location", company: "Company", function: "Function", location: "Location",
            });
            expect(inventory([["Custom region"]]).map(({ column, attribute }) => ({ column, attribute }))).toEqual([
                { column: "'Org Attribute Source'[Value]", attribute: "Custom region" },
            ]);
        });

        it("escapes discovered identifiers and DAX strings and bounds conversation eligibility", () => {
            const columns = inventory([['Cost ] "Band"', 10000], ["Zero or false", 3]]);
            const source = evaluationOrgGroupOptions(columns);
            expect(source.connection).toBe("ae");
            expect(source.query).toContain("SUMMARIZECOLUMNS('Org Attribute Source'[Value],");
            expect(source.query).toContain('TREATAS({"Cost ] ""Band"""}, \'Org Attribute Source\'[Attribute])');
            expect(source.query).toContain('"org:Cost ] ""Band"""');
            expect(source.query.match(/TOPN\(/g)).toHaveLength(2);
            expect(source.query).toContain("[@Conversations] > 0");
            expect(source.query).toContain("NOT ISBLANK(");
            expect(source.query).toContain("LEN(TRIM(CONVERT(");
            expect(source.query).not.toMatch(/__[A-Z_]+__/);
            expect(evaluationOrgGroupOptions([]).query).toBe("");
        });

        it("preserves replacement sequences and literal template tokens in custom names", () => {
            const name = "Cost $& $' $` __COLUMN__ __ID__ __GROUP__";
            const [column] = inventory([[name, 2]]);
            const reference = "'Org Attribute Source'[Value]";
            const filter = `TREATAS({"${name}"}, 'Org Attribute Source'[Attribute])`;
            expect(column.column).toBe(reference);
            const eligibility = evaluationOrgGroupOptions([column]).query;
            expect(eligibility).toContain(`"Value", "org:${name}"`);
            expect(eligibility).toContain(filter);
            expect(eligibility.split(reference)).toHaveLength(5);
            const performance = performanceByGroup(column).query;
            expect(performance.split(reference)).toHaveLength(3);
            expect(performance).toContain(`"Group", ${reference}`);
            expect(performance).toContain(filter);
            expect(performance).not.toContain("'Chat + Agent Org Data'[Cost");
        });

        it("scopes every grouping measure to one bridge attribute without mixing equal values across attributes", () => {
            const columns = inventory([["Region"], ["CostCenterId"]]);
            for (const column of columns) {
                const query = performanceByGroup(column).query;
                expect(query).toContain("CALCULATETABLE(");
                expect(query).toContain(`TREATAS({"${column.attribute}"}, 'Org Attribute Source'[Attribute])`);
                expect(query).toContain('"@Conversations", [Total Conversations]');
                expect(query).toContain('"@People", [Unique Users]');
                expect(query).not.toContain("'Chat + Agent Org Data'[");
            }
        });

        it("requires two populated groups with conversations rather than two inventory values", () => {
            const columns = inventory([["Organization", 5], ["CostCenterId", 10000], ["Sparse", 2]]);
            const counts = { agent: 2, theme: 2, topic: 2, department: 2, "org:CostCenterId": 2, "org:Sparse": 1 };
            expect(groupByChoices(counts, columns).map(({ id }) => id)).toEqual([
                "agent", "department", "theme", "topic", "org:CostCenterId",
            ]);
        });

        it("does not mistake populated zero, false or dates for missing group labels", () => {
            const [column] = inventory([["Budget", 3]]);
            const result = readableGroups(table(["Group"], [[0], [false], ["2026-01-01"], [null], ["  "]]), column);
            expect(result.rows.map((row) => row[0])).toEqual(["0", "false", "2026-01-01", "(Not recorded)", "(Not recorded)"]);
        });
    });

    it("groups by the chosen column and nothing else", () => {
        for (const column of GROUP_BY_COLUMNS) {
            const query = performanceByGroup(column).query;
            expect(query.split(column.column)).toHaveLength(3);
        }
    });

    it("never asks the model for a conversation transcript", () => {
        for (const { factory } of modules) {
            expect(factory().query).not.toMatch(/transcript|\[content\]|message_text|bot_text|user_text/i);
        }
    });
});

describe("agent evaluation spec field references", () => {
    it.each(specModules)("$name only reads columns the query returns or its transforms make", ({ factory }) => {
        const { columnMetadata, vegaLiteSpec } = factory();
        const { read, made } = collectFields(vegaLiteSpec);
        const available = new Set([...Object.values(columnMetadata).map((def) => def.name), ...made]);
        for (const field of read) {
            expect(available, `unknown field "${field}"`).toContain(field);
        }
    });

    it.each(specModules)("$name never relies on timeUnit to parse dates", ({ factory }) => {
        expect(JSON.stringify(factory().vegaLiteSpec)).not.toMatch(/"timeUnit"/);
    });
});

describe("agent evaluation slicers", () => {
    const options = readEvaluationOptions(
        table(
            ["Kind", "Value", "Sort"],
            [
                ["Agent", "IT Support Agent", 469],
                ["Agent", "HR Leave Agent", 420],
                ["Department", "Finance", 310],
                ["Department", "  ", 12],
                ["First date", "2026-05-18", 0],
                ["Group by", "agent", 8],
                ["Group by", "company", 1],
                ["Group by", "function", 0],
                ["Group by", "topic", 37],
                ["Last date", "2026-08-15", 0],
            ],
        ),
    );

    it("sorts the options into dates, departments, agents and group counts", () => {
        expect(options.firstDate).toBe("2026-05-18");
        expect(options.lastDate).toBe("2026-08-15");
        expect(options.agents.map((choice) => choice.value)).toEqual(["IT Support Agent", "HR Leave Agent"]);
        expect(options.departments).toEqual([{ value: "Finance", label: "Finance", count: 310 }]);
        expect(options.groupCounts).toEqual({ agent: 8, company: 1, function: 0, topic: 37 });
    });

    it("offers only Group by columns with at least two groups, in the fixed order", () => {
        expect(groupByChoices(options.groupCounts).map((column) => column.id)).toEqual(["agent", "topic"]);
    });

    it("tells a model with conversations from an empty one", () => {
        // An empty model still answers: blank dates, and every Group by column at zero.
        const empty = readEvaluationOptions(
            table(
                ["Kind", "Value", "Sort"],
                [
                    ["First date", "", 0],
                    ["Group by", "agent", 0],
                    ["Last date", "", 0],
                ],
            ),
        );
        expect(hasEvaluationData(options)).toBe(true);
        expect(hasEvaluationData(empty)).toBe(false);
    });

    it("filters nothing until a slicer is set", () => {
        expect(evaluationFilters(NO_SELECTION, options)).toEqual([]);
        expect(selectionRange("all", options)).toBeUndefined();
    });

    it("counts preset weeks back from the last date with data", () => {
        expect(selectionRange("4w", options)).toEqual({ preset: "4w", from: "2026-07-19", to: "2026-08-15" });
        expect(selectionRange("4w", undefined)).toBeUndefined();
    });

    it("filters dates, departments and agents on the model's own columns", () => {
        expect(evaluationFilters({ preset: "4w", department: "Finance", agent: "HR Leave Agent" }, options)).toEqual([
            "FILTER(ALL('Calendar'[Date]), 'Calendar'[Date] >= DATE(2026, 7, 19) && 'Calendar'[Date] <= DATE(2026, 8, 15))",
            "TREATAS({\"Finance\"}, 'Chat + Agent Org Data'[Organization])",
            "TREATAS({\"HR Leave Agent\"}, 'Agent Performance'[BotFriendlyName])",
        ]);
    });
});

describe("agent evaluation labels", () => {
    it("writes error codes as words and drops the cause's emoji", () => {
        const readable = readableErrors(
            table(["Error Code", "Source", "Errors"], [["KnowledgeSearchFailed", "🤖 System fault", 31]]),
        );
        expect(readable.rows[0]).toEqual(["Knowledge search failed", "System fault", 31]);
    });

    it("drops the emoji from answer archetypes", () => {
        const readable = readableArchetypes(table(["Archetype", "Conversations"], [["⚠️ Hit an error", 227]]));
        expect(readable.rows[0]).toEqual(["Hit an error", 227]);
    });

    it("names blank groups and writes topics as words", () => {
        const topic = GROUP_BY_COLUMNS.find((column) => column.id === "topic")!;
        const source = table(["Group", "Conversations"], [["PolicyLookup", 102], [null, 4], ["", 2]]);
        expect(readableGroups(source, topic).rows.map((row) => row[0])).toEqual([
            "Policy lookup",
            "(Not recorded)",
            "(Not recorded)",
        ]);
        expect(readableGroups(table(["Group"], [["FinanceOps"]]), agent).rows[0][0]).toBe("FinanceOps");
    });
});

describe("topic health tree", () => {
    const columns = liveColumns.topicHealth;
    const rows = (topicRows as Record<string, unknown>[]).map((row) => columns.map((name) => row[name]));
    const tree = toTopicTree(toDataTable(table([...columns], rows), topicHealth().columnMetadata));

    it("nests each theme's topics under it, most failing theme first", () => {
        expect(tree.rows.every(isGroupRow)).toBe(true);
        expect(tree.rows[0][TOPIC_LABEL_COLUMN]).toBe("Pay & Expenses");
        expect(tree.total?.Conversations).toBe(2400);
    });

    it("writes topic identifiers as words", () => {
        const policy = tree.rows.find((row) => row[TOPIC_LABEL_COLUMN] === "Policy")!;
        const topics = (policy._children as Record<string, unknown>[]).map((row) => row[TOPIC_LABEL_COLUMN]);
        expect(topics[0]).toBe("Policy lookup");
        expect(topics).toContain("Benefits overview");
    });
});
