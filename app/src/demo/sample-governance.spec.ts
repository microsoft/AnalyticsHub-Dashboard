import { describe, expect, it } from "vitest";
import { governanceData, sampleGovernanceRows } from "./sample-governance";
import { samples, unique } from "./sample-data";
import { governanceSummary, governanceExposure, governanceOwners, governanceReviewQueue, governancePublicWeb,
    governanceResourceGraph, shadowAiSummary, shadowAiTools, shadowAiStatus } from "@/queries/governance";

describe("generated synthetic governance", () => {
    it("uses only published people and registry agents with bounded synthetic dates", () => {
        const people = new Set(samples.people.map(person => person.user));
        const ids = new Set(samples.agents.map(agent => agent["Title ID"]));
        expect(governanceData.events.length).toBeGreaterThan(100);
        expect(governanceData.events.every(row => people.has(row.user) && row.date >= "2026-06-01" && row.date <= "2026-08-31")).toBe(true);
        expect(governanceData.config.every(row => ids.has(row.id) && (!row.owner || people.has(row.owner)))).toBe(true);
    });
    for (const mode of ["registry", "registryOwnerFallback", "resourceGraph"] as const) {
        for (const factory of [governanceSummary, governanceExposure, governanceOwners, governanceReviewQueue, governancePublicWeb]) {
            it(`populates ${factory.name} (${mode}) from generated records`, () => {
                const source = factory(mode);
                const rows = sampleGovernanceRows(source.query, Object.keys(source.columnMetadata));
                expect(rows?.length).toBeGreaterThan(0);
                expect(rows?.flat().every(value => value !== undefined)).toBe(true);
            });
        }
    }
    it("reconciles the review queue, no-sign-in summary and web-search cells", () => {
        const read = (source: ReturnType<typeof governanceSummary>) =>
            Object.fromEntries(Object.keys(source.columnMetadata).map((column, i) =>
                [column, sampleGovernanceRows(source.query, Object.keys(source.columnMetadata))![0][i]]));
        const summary = read(governanceSummary());
        const queue = governanceReviewQueue();
        const rows = sampleGovernanceRows(queue.query, Object.keys(queue.columnMetadata))!;
        expect(rows.length).toBe(summary["[Needs Review]"]);
        const graph = governanceResourceGraph();
        const graphRows = sampleGovernanceRows(graph.query, Object.keys(graph.columnMetadata))!;
        expect(graphRows[0][Object.keys(graph.columnMetadata).indexOf("[No Sign In]")]).toBe(summary["[No Sign In]"]);
        const web = governancePublicWeb();
        const webRows = sampleGovernanceRows(web.query, Object.keys(web.columnMetadata))!;
        expect(webRows.every(row => row[Object.keys(web.columnMetadata).indexOf("[Data Access]")] === "Public web")).toBe(true);
    });
    it("populates every Defender layer and derives counts from the same recent findings", () => {
        for (const source of [shadowAiSummary(), shadowAiTools(), shadowAiStatus()]) {
            expect(sampleGovernanceRows(source.query, Object.keys(source.columnMetadata))?.length).toBeGreaterThan(0);
        }
        const source = shadowAiTools();
        const columns = Object.keys(source.columnMetadata);
        const rows = sampleGovernanceRows(source.query, columns)!;
        expect(new Set(rows.map(row => row[columns.indexOf("[Layer]")]))).toEqual(new Set(["Ran", "Network", "Installed", "Cloud Discovery"]));
        const summary = shadowAiSummary();
        const count = sampleGovernanceRows(summary.query, Object.keys(summary.columnMetadata))![0];
        const tools = governanceData.events.filter(row => row.date >= "2026-08-02"
            && governanceData.watchlist.some(tool => tool.tool === row.tool && tool.posture !== "Sanctioned"));
        expect(count[Object.keys(summary.columnMetadata).indexOf("[Tools Found]")]).toBe(unique(tools, row => row.tool));
    });
    it("does not claim unrelated queries", () => {
        expect(sampleGovernanceRows("EVALUATE ROW(\"Unknown\", 1)", ["[Unknown]"])).toBeUndefined();
    });
});
