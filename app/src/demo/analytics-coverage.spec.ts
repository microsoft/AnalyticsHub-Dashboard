import { describe, expect, it } from "vitest";
import { destinations } from "@/components/destinations";
import coverage from "./analytics-coverage.json";

describe("DataHub App-only visual coverage map", () => {
    it("accounts for every retained stage and every DAX source, including metadata and variants", () => {
        const stages = destinations.filter(destination => destination.id !== "cross-vendor")
            .flatMap(destination => destination.stages.map(stage => stage.id));
        expect(Object.keys(coverage.stages).sort()).toEqual(stages.sort());
        const files = Object.keys(import.meta.glob("../queries/**/*.dax"))
            .map(path => path.replace("../queries/", "").replace(/\.dax$/, ""));
        const mapped = new Set([...Object.values(coverage.stages).flatMap(stage => stage.queries), ...coverage.supportingQueries]);
        expect([...mapped].sort()).toEqual(files.sort());
        for (const stage of Object.values(coverage.stages)) {
            expect(stage.sources.length).toBeGreaterThan(0);
            for (const source of stage.sources) expect(Object.keys(coverage.sources)).toContain(source);
        }
    });
});
