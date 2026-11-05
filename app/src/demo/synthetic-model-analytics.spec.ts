import { describe, expect, it, vi } from "vitest";
import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { applyDaxFilters, dateBetween, treatAs } from "@/lib/dax-filters";
import { MODEL_REQUIREMENTS, requirementProbeDax } from "@/lib/model-requirements";
import { OPTIONAL_SOURCES, SOURCE_PROBES, mergedSourceProbe } from "@/lib/optional-sources";
import { availableDestinations } from "@/components/destinations";
import { samples } from "./sample-data";
import { syntheticQueryResult } from "./synthetic-model-analytics";
import { syntheticQueryResult as legacyResult } from "./synthetic-model";
import { executiveSummary } from "@/queries/executive/executive-summary";

type Query = { query: string; columnMetadata?: ColumnMetadataMap };
const modules = import.meta.glob<Record<string, unknown>>([
    "../queries/{adoption,agents,efficiency,value,work,feedback,consumption,executive,appendix,filters,assumptions,licensing,freshness,governance,work-patterns,agent-evaluation}/*.ts",
    "!../queries/**/*.spec.ts", "!../queries/**/*.fixture.ts",
], { eager: true });
const queries: [string, Query][] = [];
for (const [path, module] of Object.entries(modules)) {
    for (const [name, factory] of Object.entries(module)) {
        if (typeof factory !== "function" || factory.length !== 0) continue;
        const source: unknown = factory();
        if (!source || typeof source !== "object" || !("query" in source) || typeof source.query !== "string" || !source.query) continue;
        const query = source as Query;
        if (!queries.some(([, previous]) => previous.query === query.query)) queries.push([`${path}: ${name}`, query]);
    }
}

describe("DataHub App-only offline query coverage", () => {
    it("includes the optional sources and metadata omitted from legacy coverage", () => {
        expect(queries.length).toBeGreaterThan(110);
        for (const domain of ["governance", "work-patterns", "agent-evaluation", "licensing"]) {
            expect(queries.some(([path]) => path.includes(`/${domain}/`))).toBe(true);
        }
    });
    it.each(queries)("answers %s with meaningful native-schema data", (_path, source) => {
        const result = syntheticQueryResult(source.query, source.columnMetadata);
        expect(result.status, JSON.stringify(result)).toBe("success");
        if (result.status !== "success") return;
        expect(result.table.columns.length).toBeGreaterThan(0);
        expect(result.table.rows.length).toBeGreaterThan(0);
        expect(result.table.rows.every(row => row.length === result.table.columns.length)).toBe(true);
        expect(result.table.rows.flat().every(value => typeof value !== "number" || Number.isFinite(value))).toBe(true);
        expect(result.table.rows.flat().some(value => value !== null && value !== undefined)).toBe(true);
        if (source.columnMetadata) expect(result.table.columns.map(column => column.name)).toEqual(Object.keys(source.columnMetadata));
    });
    it("answers actual source and schema probes from the generated sources", () => {
        for (const query of [mergedSourceProbe(OPTIONAL_SOURCES), ...Object.values(SOURCE_PROBES)]) {
            const result = syntheticQueryResult(query);
            expect(result.status, JSON.stringify(result)).toBe("success");
            if (result.status === "success") expect(result.table.rows[0].every(value => typeof value === "number" && value > 0)).toBe(true);
        }
        for (const requirement of Object.values(MODEL_REQUIREMENTS).flat()) {
            expect(syntheticQueryResult(requirementProbeDax(requirement))).toMatchObject({ status: "success", table: { rows: [] } });
        }
    });
    it("preserves published totals and date/org/license filters", () => {
        const source = executiveSummary();
        for (const filters of [[], [dateBetween("'Calendar'[Date]", "2026-06-01", "2026-06-30")],
            [treatAs("'Chat + Agent Org Data'[Organization]", [samples.people[0].org])],
            [treatAs("'Chat + Agent Interactions (Audit Logs)'[Environment]", ["Unlicensed"])]]) {
            const query = applyDaxFilters(source.query, filters);
            expect(syntheticQueryResult(query, source.columnMetadata)).toEqual(legacyResult(query, source.columnMetadata));
        }
    });
    it("keeps all 14 remaining destinations reachable and excludes comparison navigation", () => {
        vi.stubEnv("VITE_CROSS_VENDOR_DEMO", "false");
        const model = { workspaceId: "00000000-0000-4000-8000-000000000001", itemId: "00000000-0000-4000-8000-000000000002" };
        expect(availableDestinations({ vl: model, cc: model, ae: model }).map(destination => destination.id))
            .toHaveLength(14);
        expect(availableDestinations({ vl: model, cc: model, ae: model }).some(destination => destination.id === "cross-vendor")).toBe(false);
        vi.stubEnv("VITE_CROSS_VENDOR_DEMO", "true");
        expect(availableDestinations({ vl: model, cc: model, ae: model }).some(destination => destination.id === "cross-vendor")).toBe(true);
        vi.unstubAllEnvs();
    });
    it("does not turn unsupported queries into invented observations", () => {
        expect(syntheticQueryResult('EVALUATE ROW("Unsupported synthetic query", BLANK())')).toMatchObject({ status: "error" });
    });
});
