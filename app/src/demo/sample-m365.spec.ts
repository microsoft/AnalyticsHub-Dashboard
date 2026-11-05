// @vitest-environment node
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compile, type TopLevelSpec } from "vega-lite";
import { parse, View, type Scene, type SceneItem } from "vega";
import "@/test/vega-formats";
import { applyDaxFilters, dateBetween, treatAs } from "@/lib/dax-filters";
import { describeOrgAttribute, orgValueFilter, withOrgAttribute } from "@/lib/org-attribute";
import type { ColumnMetadataMap } from "@/lib/to-data-table";
import {
    m365Apps, m365ByOrg, m365CopilotIndex, m365CopilotSummary, m365Platforms, m365Status,
    m365SuiteDepth, m365Summary, m365WorkloadReach, m365WorkloadTrend, readM365Coverage, readM365Status,
} from "@/queries/work-patterns";
import { m365ActivityFreshness } from "@/queries/freshness/m365-activity-freshness";
import { licenseCandidatesM365 } from "@/queries/licensing/license-candidates-m365";
import { createM365Adapter, sampleM365Rows, type M365Activity, type M365Payload } from "./sample-m365";
import { groups, samples, selectedActivity, sessions, sum, unique } from "./sample-data";

// Generate in memory: tests exercise the actual Python source rules and do not
// create the parent-owned generated JSON or require a variant build first.
const script = fileURLToPath(new URL("../../scripts/demo_sources/m365.py", import.meta.url));
const payload: M365Payload = JSON.parse(execFileSync("python", ["-c", [
    "import importlib.util,json,sys",
    "spec=importlib.util.spec_from_file_location('m365',sys.argv[1])",
    "module=importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    "print(json.dumps(module.build(json.load(sys.stdin),[],[])))",
].join(";"), script], {
    input: JSON.stringify(samples.people), encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
}));
const adapter = createM365Adapter(payload);
type Source = { query: string; columnMetadata: ColumnMetadataMap };
const objects = (source: Source, filters: string[] = [], run = adapter) => {
    const columns = Object.keys(source.columnMetadata);
    const rows = run(applyDaxFilters(source.query, filters), columns);
    expect(rows).toBeDefined();
    return rows!.map(row => Object.fromEntries(columns.map((column, i) => [column.slice(1, -1), row[i]])));
};
const between = (from: string, to: string) => dateBetween("'Calendar'[Date]", from, to);
const active = (rows: M365Activity[]) => rows.filter(row => row.WorkloadsActive > 0);
const people = (rows: M365Activity[]) => unique(active(rows), row => row.UPN_Normalized);
const factories = [
    m365Status, m365Summary, m365WorkloadTrend, m365WorkloadReach, m365Apps, m365SuiteDepth,
    m365Platforms, m365CopilotSummary, m365CopilotIndex, m365ByOrg, m365ActivityFreshness, licenseCandidatesM365,
];

describe("synthetic M365 source adapter", () => {
    it.each(factories)("derives populated typed outputs for %s", factory => {
        const result = objects(factory());
        expect(result.length).toBeGreaterThan(0);
        for (const row of result) {
            expect(Object.values(row).every(value => value !== null && value !== undefined)).toBe(true);
            for (const value of Object.values(row)) if (typeof value === "number") expect(Number.isFinite(value)).toBe(true);
        }
    });

    it("reconciles daily records, published identities, unshifted dates, summary and status readers", () => {
        expect(payload.activity).toHaveLength(170 * 92);
        expect(new Set(payload.activity.map(row => row.UPN_Normalized))).toEqual(new Set(samples.people.map(person => person.user)));
        const summary = objects(m365Summary())[0];
        const personWeeks = people(payload.activity) * 92 / 7;
        expect(summary["People Active"]).toBe(170);
        expect(summary["Days Loaded"]).toBe(92);
        expect([summary["First Date"], summary["Last Date"]]).toEqual(["2026-06-01", "2026-08-31"]);
        expect(summary["Active Days Per Week"]).toBeCloseTo(active(payload.activity).length / personWeeks);
        expect(summary["Meetings Per Week"]).toBeCloseTo(sum(payload.activity, row => row.TeamsMeetings) / personWeeks);
        expect(summary["Call Hours Per Week"]).toBeCloseTo(sum(payload.activity, row => row.TeamsAudioSeconds) / 3600 / personWeeks);
        expect(summary["Emails Sent Per Week"]).toBeCloseTo(sum(payload.activity, row => row.EmailSent) / personWeeks);
        expect(summary["Chats Per Week"]).toBeCloseTo(sum(payload.activity, row => row.TeamsChatMessages + row.TeamsPrivateChatMessages) / personWeeks);
        expect(summary["Workloads Per Active Day"]).toBeCloseTo(
            sum(payload.activity, row => row.WorkloadsActive) / active(payload.activity).length,
        );
        const bracketed = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).map(([key, value]) => [`[${key}]`, value]));
        expect(readM365Coverage(bracketed(summary))).toEqual({
            firstDate: "2026-06-01", lastDate: "2026-08-31", spanDays: 92, daysLoaded: 92, missingDays: 0,
        });
        const status = objects(m365Status())[0];
        expect(status.Rows).toBe(payload.activity.length);
        expect(readM365Status({ row: bracketed(status), loaded: true })).toMatchObject({ state: "ready", people: 170, concealed: false });
        expect(adapter('EVALUATE ROW("Rows", COUNTROWS(\'M365 Activity\'))', ["[Rows]"])).toEqual([[170 * 92]]);
        expect(objects(m365ActivityFreshness())).toEqual([{ "Last Date": "2026-08-31" }]);
    });

    it("reconciles workload reach, app union, suite depth, platform person-days and complete weeks", () => {
        const flags: Record<string, keyof M365Activity> = {
            Teams: "TeamsActive", Email: "EmailActive", SharePoint: "SharePointActive",
            OneDrive: "OneDriveActive", "Office apps": "AppsActive", "Viva Engage": "VivaEngageActive",
        };
        for (const row of objects(m365WorkloadReach())) {
            const values = payload.activity.filter(value => value[flags[String(row.Workload)]] === 1);
            expect(row.People).toBe(people(values));
            expect(row.Reach).toBeCloseTo(people(values) / 170);
            expect(row["Days Per Week"]).toBeCloseTo(values.length / (people(values) * 92 / 7));
        }
        for (const row of objects(m365Apps())) {
            const field = `App${row.App}` as keyof M365Activity;
            const expected = new Set(payload.activity.filter(value => value[field] === 1).map(value => value.UPN_Normalized)).size;
            expect(row.People).toBe(expected);
            expect(row.Reach).toBeCloseTo(expected / 170);
        }
        const depth = objects(m365SuiteDepth());
        expect(depth).toHaveLength(7);
        expect(sum(depth, row => Number(row.People))).toBe(170);
        expect(sum(depth, row => Number(row.Share))).toBeCloseTo(1);
        expect(depth.every(row => Number(row.People) > 0)).toBe(true);
        for (const row of objects(m365Platforms())) {
            const field = `Platform${row.Platform}` as keyof M365Activity;
            const values = payload.activity.filter(value => value[field] === 1);
            expect(row.People).toBe(people(values));
            expect(row["Days Per Week"]).toBeCloseTo(values.length / (people(values) * 92 / 7));
        }
        const trend = objects(m365WorkloadTrend());
        expect(new Set(trend.map(row => row["Week Start"])).size).toBe(13);
        expect(trend).toHaveLength(13 * 6);
        expect(trend.some(row => row["Week Start"] === "2026-08-31")).toBe(false);
        for (const row of trend) {
            const week = payload.activity.filter(value => value.WeekStart === row["Week Start"]);
            const count = people(week.filter(value => value[flags[String(row.Workload)]] === 1));
            expect(row.People).toBe(count);
            expect(row.Share).toBeCloseTo(count / people(week));
        }
        expect(objects(m365WorkloadTrend(), [between("2026-06-02", "2026-06-06")])).toEqual([]);
    });

    it("compares genuine Copilot and other cohorts and pools the existing three-person group", () => {
        const summary = objects(m365CopilotSummary())[0];
        const copilot = new Set(samples.activity.map(row => row.user));
        expect(summary["M365 People"]).toBe(170);
        expect(summary["Copilot People"]).toBe(copilot.size);
        expect(summary["Not Using"]).toBe(170 - copilot.size);
        expect(summary["Licensed People"]).toBe(samples.people.filter(person => person.licensed).length);
        expect(summary["Licensed Not Using"]).toBe(samples.people.filter(person => person.licensed && !copilot.has(person.user)).length);
        const index = objects(m365CopilotIndex());
        expect(index).toHaveLength(6);
        for (const row of index) expect(row.Index).toBeCloseTo(Number(row["Copilot Users"]) / Number(row.Others));
        expect(new Set(index.map(row => Number(row.Index).toFixed(3))).size).toBeGreaterThan(2);
        const orgs = objects(m365ByOrg());
        expect(sum(orgs, row => Number(row["People Active"]))).toBe(170);
        expect(orgs.find(row => row.Organization === "Smaller groups")).toMatchObject({ "People Active": 3, "Pooled Groups": 1 });
        expect(orgs.some(row => row.Organization === "Executive Office")).toBe(false);
    });

    it("applies dates, org bridge, country/job rebinding and direct source identity selections", () => {
        const june = objects(m365Summary(), [between("2026-06-01", "2026-06-30")])[0];
        const source = payload.activity.filter(row => row.ActivityDate <= "2026-06-30");
        expect(june["Days Loaded"]).toBe(30);
        expect(june["Active Days Per Week"]).toBeCloseTo(active(source).length / (people(source) * 30 / 7));
        const finance = samples.people.filter(person => person.org === "Finance");
        const financeIds = new Set(finance.map(person => person.user));
        const selected = payload.activity.filter(row => financeIds.has(row.UPN_Normalized));
        const financeSummary = objects(m365Summary(), [orgValueFilter("Organization", ["Finance"])])[0];
        expect(financeSummary["People Active"]).toBe(finance.length);
        expect(financeSummary["Days Loaded"]).toBe(92);
        expect(financeSummary["Meetings Per Week"]).toBeCloseTo(sum(selected, row => row.TeamsMeetings) / (finance.length * 92 / 7));
        const country = samples.people[0].country;
        const byCountry = withOrgAttribute(m365ByOrg(), describeOrgAttribute("country"));
        const countryRows = objects(byCountry, [orgValueFilter("country", [country])]);
        expect(countryRows).toHaveLength(1);
        expect(countryRows[0].Organization).toBe(country);
        expect(countryRows[0]["People Active"]).toBe(samples.people.filter(person => person.country === country).length);
        const byJob = withOrgAttribute(m365ByOrg(), describeOrgAttribute("JobTitle"));
        const job = samples.people[0].job;
        expect(objects(byJob, [orgValueFilter("JobTitle", [job])])[0]["People Active"])
            .toBe(samples.people.filter(person => person.job === job).length);
        const user = samples.people[0].user;
        expect(objects(m365Summary(), [treatAs("'M365 Activity'[UPN_Normalized]", [user])])[0]["People Active"]).toBe(1);
    });

    it("filters only the Copilot cohort for audit slicers, preserving M365's independent workload denominator", () => {
        const filters = [
            treatAs("'Chat + Agent Interactions (Audit Logs)'[Agent Filter (Normalized)]", ["Agents"]),
            treatAs("'Chat + Agent Interactions (Audit Logs)'[Environment]", ["Unlicensed"]),
        ];
        const selected = new Set(selectedActivity(filters.join("\n")).map(row => row.user));
        const summary = objects(m365CopilotSummary(), filters)[0];
        expect(summary["Copilot People"]).toBe(selected.size);
        expect(summary["M365 People"]).toBe(170);
        expect(objects(m365Summary(), filters)).toEqual(objects(m365Summary()));
        const agent = samples.activity.find(row => row.agent)!.agent;
        const agentFilter = treatAs("'Chat + Agent Interactions (Audit Logs)'[AgentName]", [agent]);
        expect(objects(m365CopilotSummary(), [agentFilter])[0]["Copilot People"])
            .toBe(new Set(selectedActivity(agentFilter).map(row => row.user)).size);
        expect(objects(m365CopilotIndex(), [treatAs("'Chat + Agent Interactions (Audit Logs)'[AgentName]", ["nonexistent"])]))
            .toEqual([]);
    });

    it("preserves empty filtered outcomes, unrelated queries and comment invariance", () => {
        const empty = orgValueFilter("Organization", ["not-a-demo-organization"]);
        for (const factory of [m365Apps, m365Platforms, m365SuiteDepth, m365WorkloadTrend, m365WorkloadReach, m365ByOrg, m365CopilotIndex, licenseCandidatesM365]) {
            expect(objects(factory(), [empty])).toEqual([]);
        }
        expect(objects(m365Summary(), [between("2027-01-01", "2027-01-31")])[0])
            .toMatchObject({ "People Active": 0, "Days Loaded": 0, "First Date": null, "Active Days Per Week": null });
        expect(adapter('EVALUATE ROW("People", COUNTROWS(\'Other Table\'))', ["[People]"])).toBeUndefined();
        expect(adapter('EVALUATE ROW("Last Date", MAX(\'ProductFeedback\'[CreatedDate]))', ["[Last Date]"])).toBeUndefined();
        expect(adapter('EVALUATE ROW("Unknown", COUNTROWS(\'M365 Activity\'))', ["[Unknown]"])).toBeUndefined();
        expect(adapter('EVALUATE ROW("Last Date", MAX(\'M365 Activity\'[ActivityDate]), "Other", MAX(\'Agents 365\'[CreatedDate]))', ["[Last Date]"])).toBeUndefined();
        const base = m365Summary();
        expect(objects({ ...base, query: `${base.query}\n// benign commentary` })).toEqual(objects(base));
    });

    it("derives enriched readiness scores, dense ranks and the no-M365 fallback from source formulas", () => {
        const candidates = objects(licenseCandidatesM365());
        expect(candidates.length).toBeGreaterThan(10);
        const scores = [...new Set(candidates.map(row => Number(row["Priority Score"])))].sort((a, b) => b - a);
        for (const candidate of candidates) {
            const activity = samples.activity.filter(row => row.user === candidate.User && !row.licensed);
            const prompts = activity.filter(row => row.prompt);
            const weeks = unique(prompts, row => row.week);
            const tasks = prompts.length / weeks;
            const days = unique(prompts, row => row.date) / weeks;
            const reports = active(payload.activity.filter(row => row.UPN_Normalized === candidate.User));
            const breadth = sum(reports, row => row.WorkloadsActive) / reports.length;
            expect(candidate["Workloads Per Day"]).toBeCloseTo(breadth);
            expect(candidate["Active Days Per Week"]).toBeCloseTo(days);
            const weekly = groups(activity, row => row.week);
            expect(candidate["Sessions Per Week"]).toBeCloseTo(sum(weekly, ([, rows]) => sessions(rows).length) / weekly.length);
            expect(candidate["Priority Score"]).toBe(Math.round(50 * Math.min(tasks / 30, 1) + 30 * Math.min(days / 5, 1) + 20 * Math.min(breadth / 4, 1)));
            expect(candidate.Rank).toBe(scores.indexOf(Number(candidate["Priority Score"])) + 1);
            expect(candidate.Total).toBe(candidates.length);
        }
        const fallback = objects(licenseCandidatesM365(), [], createM365Adapter({ ...payload, activity: [] }));
        const first = fallback[0];
        const rows = samples.activity.filter(row => row.user === first.User && row.prompt && !row.licensed);
        const weeks = unique(rows, row => row.week);
        expect(first["Workloads Per Day"]).toBeNull();
        expect(first["Priority Score"]).toBe(Math.round(60 * Math.min(rows.length / weeks / 30, 1) + 40 * Math.min(unique(rows, row => row.date) / weeks / 5, 1)));
        expect(objects(licenseCandidatesM365(), [orgValueFilter("Organization", ["Finance"])])
            .every(row => row.Organization === "Finance")).toBe(true);
    });

    it("uses the optional generated payload without requiring it in core samples", () => {
        const loaded = sampleM365Rows(m365Status().query, Object.keys(m365Status().columnMetadata));
        // Parent creates this file during the variant build; no placeholder data
        // should be invented if only the ordinary demo input is present.
        if (loaded) expect(loaded[0][0]).toBe(170 * 92);
        expect(sampleM365Rows("EVALUATE ROW(\"People\", 1)", ["[People]"])).toBeUndefined();
    });
});

describe("synthetic M365 visual output", () => {
    const charts = [m365Apps, m365Platforms, m365SuiteDepth, m365CopilotIndex, m365WorkloadReach, m365WorkloadTrend];
    it.each(charts)("renders populated finite geometry for %s", async factory => {
        const source = factory();
        const rows = objects(source);
        const view = new View(parse(compile({
            ...(source.vegaLiteSpec as object), width: 620, height: 400, data: { values: rows },
        } as TopLevelSpec).spec), { renderer: "none" });
        try {
            await view.runAsync();
            const marks: SceneItem[] = [];
            const walk = (node: Scene | SceneItem) => {
                const scene = node as Scene;
                if (scene.marktype === (factory === m365WorkloadTrend ? "symbol" : "rect")) {
                    marks.push(...(scene.items as SceneItem[]).filter(item => item.datum && ("People" in item.datum || "Metric" in item.datum)));
                }
                for (const item of (scene.items ?? []) as (Scene | SceneItem)[]) {
                    if ((item as Scene).marktype || (item as { items?: unknown }).items) walk(item);
                }
            };
            walk((view.scenegraph() as unknown as { root: Scene }).root);
            expect(marks).toHaveLength(rows.length);
            for (const mark of marks) {
                for (const edge of [mark.bounds.x1, mark.bounds.x2, mark.bounds.y1, mark.bounds.y2]) {
                    expect(Number.isFinite(edge)).toBe(true);
                }
                expect(mark.bounds.x2).toBeGreaterThan(mark.bounds.x1);
                expect(mark.bounds.y2).toBeGreaterThan(mark.bounds.y1);
            }
        } finally {
            view.finalize();
        }
    });
});
