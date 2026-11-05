import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { applyDaxFilters, dateBetween, treatAs } from "@/lib/dax-filters";
import { orgValueFilter } from "@/lib/org-attribute";
import { parseVerdict } from "@/lib/model-text";
import { toDataTable } from "@/lib/to-data-table";
import {
    answerArchetypes, conversationsSummary, evaluationFilters, evaluationOptions, evaluationOrgAttributes,
    evaluationOrgGroupOptions, evaluatorStatus, feedbackComments, GROUP_BY_COLUMNS, groupByChoices,
    knowledgeSources, performanceByGroup, performanceErrors, performanceSummary, performanceWeekly,
    readEvaluationOptions, readEvaluationOrgAttributes, readEvaluatorStatus, themeOutcomes, toTopicTree, topicHealth,
} from "@/queries/agent-evaluation";
import { evaluatorFreshness } from "@/queries/freshness/evaluator-freshness";
import { createEvaluatorRows, type EvaluatorPayload } from "./sample-evaluator";

// Generate in memory from the published identity/name inventory, not chart
// fixtures or a tenant export. No generated payload file is written by tests.
const script = `
import json,sys
sys.path.insert(0, 'scripts/demo_sources')
from test_evaluator import published_inventory
from evaluator import build
people,agents=published_inventory()
print(json.dumps(build(people,agents,[])))
`;
const data = JSON.parse(execFileSync("python", ["-c", script], {
    encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
})) as EvaluatorPayload;
const adapter = createEvaluatorRows(data);
type Query = { query: string; columnMetadata?: Record<string, unknown> };
const columns = (factory: Query) => Object.keys(factory.columnMetadata ?? {});
function rows(factory: Query, filters: string[] = []) {
    return adapter(applyDaxFilters(factory.query, filters), columns(factory))!;
}
function records(factory: Query, filters: string[] = []) {
    return rows(factory, filters).map(row => Object.fromEntries(columns(factory).map((key, index) => [key, row[index]])));
}
const summary = (filters: string[] = []) => records(performanceSummary(), filters)[0];
const count = (filters: string[] = []) => Number(summary(filters)?.["[Conversations]"] ?? 0);
const total = (values: unknown[][], index: number) => values.reduce<number>((sum, row) => sum + Number(row[index]), 0);
const allFactories = [
    evaluationOptions(), evaluatorStatus(), performanceSummary(), performanceWeekly(), performanceByGroup(GROUP_BY_COLUMNS[0]),
    performanceErrors(), conversationsSummary(), themeOutcomes(), topicHealth(), knowledgeSources(), answerArchetypes(), feedbackComments(),
];

describe("synthetic Evaluator contracts", () => {
    it.each(allFactories.map(factory => [columns(factory).join(", "), factory] as const))(
        "populates every declared cell for %s", (_label, factory) => {
            const result = rows(factory);
            expect(result.length).toBeGreaterThan(0);
            for (const row of result) expect(row).toHaveLength(columns(factory).length);
            // Only subtotal labels may be blank in the default populated dataset.
            if (factory !== allFactories[8]) expect(result.flat()).not.toContain(null);
            expect(result.flat().some(value => typeof value === "number" && !Number.isFinite(value))).toBe(false);
        },
    );

    it("matches exact options Kinds, period bounds, selectors and all group eligibility", () => {
        const factory = evaluationOptions();
        const result = rows(factory);
        expect(new Set(result.map(row => row[0]))).toEqual(new Set(["First date", "Last date", "Agent", "Department", "Group by"]));
        const options = readEvaluationOptions(toDataTable({
            columns: columns(factory).map(name => ({ name, dataType: "string" })), rows: result,
        }, factory.columnMetadata));
        expect(options.firstDate).toBe("2026-06-01");
        expect(options.lastDate).toBe("2026-08-31");
        expect(options.agents.length).toBe(data.catalog.length);
        expect(options.departments.length).toBeGreaterThan(2);
        expect(options.agents.reduce((sum, item) => sum + item.count, 0)).toBe(data.sessions.length);
        expect(options.departments.reduce((sum, item) => sum + item.count, 0)).toBe(data.sessions.length);
        expect(options.groupCounts).toEqual({ agent: 2, theme: 2, topic: 2 });
        const orgFactory = evaluationOrgAttributes();
        const orgColumns = ["[Column]"];
        const orgRows = adapter(orgFactory.query, orgColumns)!;
        const org = readEvaluationOrgAttributes({ columns: orgColumns.map(name => ({ name, dataType: "string" })), rows: orgRows });
        expect(org.map(item => item.attribute)).toEqual(["Organization", "country", "JobTitle"]);
        const eligibility = evaluationOrgGroupOptions(org);
        const orgOptions = readEvaluationOptions(toDataTable({
            columns: columns(eligibility).map(name => ({ name, dataType: "string" })), rows: rows(eligibility),
        }, eligibility.columnMetadata));
        expect(orgOptions.groupCounts).toEqual({ department: 2, country: 2, "job-title": 2 });
        expect(groupByChoices({ ...options.groupCounts, ...orgOptions.groupCounts }, org)).toHaveLength(6);
    });

    it("implements every available period and inclusive, intersecting date filters", () => {
        const options = { firstDate: "2026-06-01", lastDate: "2026-08-31", agents: [], departments: [], groupCounts: {} };
        for (const preset of ["all", "4w", "8w", "12w"] as const) {
            // Presets are applied by the real factory, not independently guessed here.
            const filters = evaluationFilters({ preset, department: undefined, agent: undefined }, options);
            const start = new Date("2026-08-31T00:00:00Z");
            if (preset !== "all") start.setUTCDate(start.getUTCDate() - Number(preset.slice(0, -1)) * 7 + 1);
            const from = preset === "all" ? "2026-06-01" : start.toISOString().slice(0, 10);
            expect(count(filters)).toBe(data.sessions.filter(row => row.date >= from).length);
        }
        const june = dateBetween("'Calendar'[Date]", "2026-06-01", "2026-06-30");
        const lastJuneDay = dateBetween("'Calendar'[Date]", "2026-06-30", "2026-08-31");
        const expected = data.sessions.filter(row => row.date === "2026-06-30").length;
        expect(count([june, lastJuneDay])).toBe(expected);
        expect(count([dateBetween("'Calendar'[Date]", "2026-08-31", "2026-08-31")]))
            .toBe(data.sessions.filter(row => row.date === "2026-08-31").length);
        expect(rows(performanceSummary(), [dateBetween("'Calendar'[Date]", "2026-09-01", "2026-09-30")])).toEqual([]);
    });

    it("filters all agent and department selectors against the raw source", () => {
        const people = new Map(data.people.map(person => [person.user, person]));
        for (const agent of data.catalog) {
            const filter = treatAs("'Agent Performance'[BotFriendlyName]", [agent.agent]);
            expect(count([filter])).toBe(data.sessions.filter(row => row.agent === agent.agent).length);
        }
        for (const department of new Set(data.people.map(person => person.org))) {
            const filter = treatAs("'Chat + Agent Org Data'[Organization]", [department]);
            expect(count([filter])).toBe(data.sessions.filter(row => people.get(row.user)?.org === department).length);
        }
        const sample = data.sessions[0];
        const dept = people.get(sample.user)!.org;
        const filters = [treatAs("'Agent Performance'[BotFriendlyName]", [sample.agent]),
            treatAs("'Chat + Agent Org Data'[Organization]", [dept])];
        expect(count(filters)).toBe(data.sessions.filter(row => row.agent === sample.agent && people.get(row.user)?.org === dept).length);
    });

    it("handles all known org bridge attributes, multi-select and grouping independently", () => {
        const person = data.people.find(person => data.sessions.some(session => session.user === person.user))!;
        for (const [attribute, key] of [["Organization", "org"], ["country", "country"], ["JobTitle", "job"]] as const) {
            const filter = orgValueFilter(attribute, [person[key]], "Org Join Key");
            const identities = new Set(data.people.filter(row => row[key] === person[key]).map(row => row.user));
            const expected = data.sessions.filter(row => identities.has(row.user));
            expect(count([filter])).toBe(expected.length);
            // Grouping by another attribute must not replace the global selection attribute.
            const group = { id: "job-title", label: "Job title", column: "'Org Attribute Source'[Value]", attribute: "JobTitle" };
            const grouped = records(performanceByGroup(group), [filter]);
            expect(grouped.reduce((sum, row) => sum + Number(row["[Conversations]"]), 0)).toBe(expected.length);
            expect(new Set(grouped.map(row => row["[Group]"])))
                .toEqual(new Set(data.people.filter(row => expected.some(session => session.user === row.user)).map(row => row.job)));
        }
        const countries = [...new Set(data.people.map(person => person.country))].slice(0, 2);
        const selectedPeople = new Set(data.people.filter(person => countries.includes(person.country)).map(person => person.user));
        expect(count([orgValueFilter("country", countries, "Org Join Key")]))
            .toBe(data.sessions.filter(row => selectedPeople.has(row.user)).length);
    });

    it("keeps all filtered fact-query empties empty rather than reusing defaults", () => {
        const factFactories = allFactories.slice(2);
        for (const factory of factFactories) {
            for (const filter of [
                treatAs("'Agent Performance'[BotFriendlyName]", ["Missing agent"]),
                treatAs("'Chat + Agent Org Data'[Organization]", ["Missing department"]),
                orgValueFilter("country", ["Missing country"], "Org Join Key"),
                orgValueFilter("JobTitle", [], "Org Join Key"),
                dateBetween("'Calendar'[Date]", "2026-07-20", "2026-07-01"),
            ]) expect(rows(factory, [filter])).toEqual([]);
        }
    });

    it("applies combined date, agent, department and org-bridge filters to every fact contract", () => {
        const people = new Map(data.people.map(person => [person.user, person]));
        const sample = data.sessions.find(row => row.date.startsWith("2026-07"))!;
        const person = people.get(sample.user)!;
        const cases = [
            {
                filters: [dateBetween("'Calendar'[Date]", "2026-07-01", "2026-07-31")],
                expected: data.sessions.filter(row => row.date.startsWith("2026-07")),
            },
            {
                filters: [treatAs("'Agent Performance'[BotFriendlyName]", [sample.agent]),
                    orgValueFilter("country", [person.country], "Org Join Key")],
                expected: data.sessions.filter(row => row.agent === sample.agent && people.get(row.user)?.country === person.country),
            },
            {
                filters: [dateBetween("'Calendar'[Date]", "2026-07-01", "2026-08-31"),
                    treatAs("'Chat + Agent Org Data'[Organization]", [person.org]),
                    treatAs("'Agent Performance'[BotFriendlyName]", [sample.agent])],
                expected: data.sessions.filter(row => row.date >= "2026-07-01" && row.agent === sample.agent && people.get(row.user)?.org === person.org),
            },
            {
                filters: [orgValueFilter("JobTitle", [person.job], "Org Join Key"),
                    treatAs("'Chat + Agent Org Data'[Organization]", [person.org])],
                expected: data.sessions.filter(row => people.get(row.user)?.job === person.job && people.get(row.user)?.org === person.org),
            },
        ];
        for (const { filters, expected } of cases) {
            expect(expected.length).toBeGreaterThan(0);
            const scopedAdapter = createEvaluatorRows({ ...data, sessions: expected });
            for (const factory of allFactories.slice(2)) {
                expect(rows(factory, filters)).toEqual(scopedAdapter(factory.query, columns(factory)));
            }
        }
    });

    it("never intercepts legacy queries on column-only collisions", () => {
        for (const query of [
            'EVALUATE ROW("Conversations", 99)',
            'EVALUATE ROW("Last Date", MAX(\'M365 Activity\'[ActivityDate]))',
            'EVALUATE ROW("Last Date", MAX(\'Chat + Agent Interactions (Audit Logs)\'[ActivityDate]))',
            'EVALUATE SELECTCOLUMNS(\'Org Attribute Source\', "Column", \'Org Attribute Source\'[Attribute])',
            'EVALUATE ROW("Source", "Other", "Citations", 2)',
        ]) expect(adapter(query, ["[Conversations]", "[Last Date]", "[Column]", "[Source]", "[Citations]"])).toBeUndefined();
        expect(adapter("", ["[Conversations]"])).toBeUndefined();
    });

    it("reports actual generated source status and freshness", () => {
        const status = evaluatorStatus();
        const environments = readEvaluatorStatus({ columns: columns(status).map(name => ({ name, dataType: "string" })), rows: rows(status) });
        expect(environments).toEqual([{ environment: "Synthetic offline Evaluator", days: 92, transcripts: data.sessions.length, status: "ok" }]);
        const fresh = evaluatorFreshness();
        expect(rows(fresh)).toEqual([["2026-08-31"]]);
        expect(rows(fresh, [dateBetween("'Calendar'[Date]", "2026-06-01", "2026-06-30")])).toEqual([["2026-06-30"]]);
    });
});

describe("raw Evaluator evidence reconciliation", () => {
    it("derives summary counts, medians, rates, hours, and narratives from sessions and turns", () => {
        const row = summary();
        const sessions = data.sessions;
        const count = sessions.length;
        const resolved = sessions.filter(row => row.outcome === "Resolved");
        const failing = sessions.filter(row => ["Escalated - Unintended", "Abandoned"].includes(row.outcome));
        const sortedReplies = data.turns.map(turn => turn.responseSeconds).sort((a, b) => a - b);
        const index = Math.floor(sortedReplies.length / 2);
        const median = sortedReplies.length % 2 ? sortedReplies[index] : (sortedReplies[index - 1] + sortedReplies[index]) / 2;
        const up = data.turns.filter(turn => turn.feedbackVerdict === "Positive").length;
        const down = data.turns.filter(turn => turn.feedbackVerdict === "Negative").length;
        expect(row["[Conversations]"]).toBe(count);
        expect(row["[People]"]).toBe(new Set(sessions.map(session => session.user)).size);
        expect(row["[Resolution Rate]"]).toBe(resolved.length / count);
        expect(row["[Implied Success]"]).toBe(sessions.filter(row => row.impliedSuccess).length / count);
        expect(row["[True Failure Rate]"]).toBe(failing.length / count);
        expect(row["[Failing Conversations]"]).toBe(failing.length);
        expect(row["[Hours Lost]"]).toBe(failing.reduce((sum, session) =>
            sum + data.catalog.find(agent => agent.agent === session.agent)!.deflectionMinutes, 0) / 60);
        expect(row["[CSAT]"]).toBe(up / (up + down));
        expect(row["[Thumbs Up]"]).toBe(up);
        expect(row["[Thumbs Down]"]).toBe(down);
        expect(row["[Median Response]"]).toBe(median);
        expect(row["[Slow Replies]"]).toBe(data.turns.filter(turn => turn.responseSeconds > 10).length / data.turns.length);
        expect(row["[Error Rate]"]).toBe(new Set(data.errors.map(error => error.session)).size / count);
        for (const key of ["[Verdict Performance]", "[Verdict Quality]", "[Verdict Adoption]"])
            expect(parseVerdict(String(row[key]))).toBeDefined();
        expect(row["[Reporting Window]"]).toContain(String(count));
        const selectedAgent = data.catalog[0].agent;
        const filtered = summary([treatAs("'Agent Performance'[BotFriendlyName]", [selectedAgent])]);
        expect(filtered["[Reporting Window]"]).not.toEqual(row["[Reporting Window]"]);
        expect(filtered["[Focus Agent]"]).toContain(selectedAgent);
        expect(filtered["[Error Story]"]).not.toEqual(row["[Error Story]"]);
    });

    it("reconciles all groupings, weekly outcomes and theme totals with the summary", () => {
        const org = [
            { id: "department", label: "Department", column: "'Org Attribute Source'[Value]", attribute: "Organization" },
            { id: "country", label: "Country", column: "'Org Attribute Source'[Value]", attribute: "country" },
            { id: "job-title", label: "Job title", column: "'Org Attribute Source'[Value]", attribute: "JobTitle" },
        ];
        const filters = [dateBetween("'Calendar'[Date]", "2026-07-01", "2026-07-31")];
        const expected = count(filters);
        for (const group of [...GROUP_BY_COLUMNS, ...org]) {
            const grouped = records(performanceByGroup(group), filters);
            expect(grouped.reduce((sum, row) => sum + Number(row["[Conversations]"]), 0)).toBe(expected);
            const weightedResolved = grouped.reduce((sum, row) => sum + Number(row["[Conversations]"]) * Number(row["[Resolution Rate]"]), 0);
            expect(weightedResolved).toBeCloseTo(data.sessions.filter(row => row.date.startsWith("2026-07") && row.outcome === "Resolved").length);
            expect(grouped.length).toBeGreaterThan(1);
        }
        expect(total(rows(performanceWeekly(), filters), 3)).toBe(expected);
        expect(total(rows(themeOutcomes(), filters), 3)).toBe(expected);
        expect(total(rows(answerArchetypes(), filters), 1)).toBe(expected);
        for (const row of rows(performanceWeekly())) expect(new Date(`${row[0]}T00:00:00Z`).getUTCDay()).toBe(1);
    });

    it("reconciles conversation metrics, topic leaves/subtotals/grand total, citations and comments", () => {
        const row = records(conversationsSummary())[0];
        const sessions = data.sessions;
        const searched = sessions.filter(row => row.knowledgeSearched);
        const gaps = searched.filter(row => !row.knowledgeAnswered);
        const turnsById = new Map<string, number>();
        for (const turn of data.turns) turnsById.set(turn.session, (turnsById.get(turn.session) ?? 0) + 1);
        const resolved = sessions.filter(row => row.outcome === "Resolved");
        expect(row["[Topics]"]).toBe(new Set(sessions.map(row => row.topic)).size);
        expect(row["[Grounded Rate]"]).toBe(sessions.filter(row => row.grounding === "Internal").length / sessions.length);
        expect(row["[Answered From Knowledge]"]).toBe(sessions.filter(row => row.knowledgeAnswered).length);
        expect(row["[Knowledge Gap Rate]"]).toBe(gaps.length / searched.length);
        expect(row["[Knowledge Gap Conversations]"]).toBe(gaps.length);
        expect(row["[Turns Per Conversation]"]).toBe(data.turns.length / sessions.length);
        expect(row["[Single Turn Rate]"]).toBe(sessions.filter(row => turnsById.get(row.id) === 1).length / sessions.length);
        expect(row["[Turns To Resolve]"]).toBe(resolved.reduce((sum, session) => sum + turnsById.get(session.id)!, 0) / resolved.length);
        const topic = topicHealth();
        const topics = records(topic);
        const grand = topics.find(row => row["[Is Grand Total]"]);
        expect(grand?.["[Conversations]"]).toBe(sessions.length);
        expect(topics.filter(row => !row["[Is Grand Total]"] && row["[Is Group Total]"])
            .reduce((sum, row) => sum + Number(row["[Conversations]"]), 0)).toBe(sessions.length);
        expect(topics.filter(row => !row["[Is Group Total]"])
            .reduce((sum, row) => sum + Number(row["[Conversations]"]), 0)).toBe(sessions.length);
        const tree = toTopicTree(toDataTable({
            columns: columns(topic).map(name => ({ name, dataType: "string" })), rows: rows(topic),
        }, topic.columnMetadata));
        expect(tree.rows.length).toBe(6);
        expect(row["[Citations]"]).toBe(data.citations.length);
        const citedLabels = new Set(data.catalog.flatMap(agent => agent.sources).map(source => source.label));
        const citationRows = rows(knowledgeSources());
        expect(citationRows.length).toBe(Math.min(10, citedLabels.size));
        expect(total(citationRows, 1)).toBeLessThanOrEqual(data.citations.length);
        expect(total(rows(performanceErrors()), 2)).toBe(data.errors.length);
        expect(total(rows(feedbackComments()), 2)).toBe(data.turns.filter(turn => turn.feedbackComment).length);
        expect(row["[Knowledge Story]"]).toContain(String(data.citations.length));
        expect(row["[Feedback Insight]"]).toContain(String(data.turns.filter(turn => turn.feedbackComment).length));
    });

    it("uses changed source evidence, handles even medians, missing feedback, and one populated group", () => {
        const original = data.sessions[0];
        const custom: EvaluatorPayload = {
            ...data, sessions: [{ ...original, outcome: "Resolved", knowledgeSearched: true, knowledgeAnswered: false, grounding: "None" }],
            turns: [{ id: "one", session: original.id, responseSeconds: 2, feedbackVerdict: "", feedbackComment: "" },
                { id: "two", session: original.id, responseSeconds: 12, feedbackVerdict: "", feedbackComment: "" }],
            errors: [], citations: [],
        };
        const one = createEvaluatorRows(custom);
        const factory = performanceSummary();
        const result = one(factory.query, ["[Conversations]", "[Median Response]", "[CSAT]", "[Slow Replies]", "[Resolution Rate]"]);
        expect(result).toEqual([[1, 7, null, 0.5, 1]]);
        const opts = one(evaluationOptions().query, ["[Kind]", "[Value]", "[Sort]"])!;
        expect(opts.filter(row => row[0] === "Group by").every(row => row[2] === 1)).toBe(true);
        expect(one(knowledgeSources().query, columns(knowledgeSources()))).toEqual([]);
        expect(one(feedbackComments().query, columns(feedbackComments()))).toEqual([]);
        expect(one(conversationsSummary().query, ["[Knowledge Gap Rate]", "[Citations]", "[Turns To Resolve]"])).toEqual([[1, 0, 2]]);
    });

    it("preserves escaped org values, multi-select and truly empty nested selections", () => {
        const session = data.sessions[0];
        const person = data.people.find(person => person.user === session.user)!;
        const quoted = createEvaluatorRows({
            ...data, people: [{ ...person, org: 'Demo "quoted" department' }], sessions: [session],
        });
        const factory = performanceSummary();
        const query = applyDaxFilters(factory.query, [
            orgValueFilter("Organization", ['Demo "quoted" department'], "Org Join Key"),
            treatAs("'Agent Performance'[BotFriendlyName]", ["Missing agent", session.agent]),
        ]);
        expect(quoted(query, ["[Conversations]"])).toEqual([[1]]);
        expect(quoted(applyDaxFilters(factory.query, [
            orgValueFilter("Organization", [], "Org Join Key"),
        ]), ["[Conversations]"])).toEqual([]);
    });
});
