import { describe, expect, it } from "vitest";
import { applyDaxFilters, dateBetween, treatAs } from "@/lib/dax-filters";
import { foundryResourceSpend, studioAzureBilling, studioAzureDaily } from "@/queries/consumption";
import { governanceData } from "./sample-governance";
import { sampleGeneratedConsumptionRows } from "./sample-analytics-consumption";
import { samples, sum } from "./sample-data";

describe("synthetic supplemental consumption evidence", () => {
    it("reconciles daily billing with summary without changing published credits", () => {
        const source = studioAzureBilling();
        const columns = Object.keys(source.columnMetadata);
        const summary = sampleGeneratedConsumptionRows(source.query, columns)![0];
        const daily = studioAzureDaily();
        const dayColumns = Object.keys(daily.columnMetadata);
        const rows = sampleGeneratedConsumptionRows(daily.query, dayColumns)!;
        const cost = dayColumns.indexOf("[Cost]");
        expect(sum(rows, row => Number(row[cost]))).toBeCloseTo(Number(summary[columns.indexOf("[Total Cost]")]), 8);
        expect(sum(governanceData.billing, row => row.cost)).toBeCloseTo(Number(summary[columns.indexOf("[Total Cost]")]), 8);
        expect(samples.activity).toHaveLength(13337);
        expect(samples.people).toHaveLength(170);
    });
    it("respects billing periods and actual versus amortized cost", () => {
        const daily = studioAzureDaily();
        const narrowed = sampleGeneratedConsumptionRows(applyDaxFilters(daily.query, [
            treatAs("'Studio Period'[Period]", ["Last 7 days"]),
        ]), Object.keys(daily.columnMetadata))!;
        expect(narrowed).toHaveLength(21);
        const source = foundryResourceSpend();
        const columns = Object.keys(source.columnMetadata);
        const query = applyDaxFilters(source.query, [
            dateBetween("'Reporting Date'[Date]", "2026-06-01", "2026-06-30"),
            treatAs("'Azure Cost Basis'[Cost Basis]", ["Amortized"]),
        ]);
        const rows = sampleGeneratedConsumptionRows(query, columns)!;
        const expected = sum(samples.consumption.AzureSolutionSpend.filter(row => row.UsageDate >= "2026-06-01"
            && row.UsageDate <= "2026-06-30" && /microsoft\.(cognitiveservices|machinelearningservices)/i.test(row.ResourceId)),
        row => Number(row.AmortizedCost));
        expect(sum(rows, row => Number(row[columns.indexOf("[Cost]")]))).toBeCloseTo(expected, 8);
        expect(rows.every(row => Number(row[columns.indexOf("[Projects]")]) > 0)).toBe(true);
    });
});
