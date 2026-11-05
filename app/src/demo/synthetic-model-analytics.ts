import type { CachedQueryResult } from "@microsoft/fabric-app-data";
import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { MODEL_REQUIREMENTS, requirementProbeDax } from "@/lib/model-requirements";
import { OPTIONAL_SOURCES, SOURCE_PROBES, mergedSourceProbe } from "@/lib/optional-sources";
import { samples, project } from "./sample-data";
import { syntheticQueryResult as baseResult } from "./synthetic-model";
import { sampleM365Rows } from "./sample-m365";
import { sampleEvaluatorRows } from "./sample-evaluator";
import { governanceData, sampleGovernanceRows } from "./sample-governance";
import { sampleGeneratedConsumptionRows } from "./sample-analytics-consumption";

const requirementQueries = new Set(Object.values(MODEL_REQUIREMENTS).flat()
    .map(requirementProbeDax));
const probeQueries = new Set([mergedSourceProbe(OPTIONAL_SOURCES), ...Object.values(SOURCE_PROBES)]);

/** Only this build loads the generated optional-source scenarios. */
export function syntheticQueryResult(query: string, metadata?: ColumnMetadataMap): CachedQueryResult {
    return baseResult(query, metadata, (dax, columns) => {
        if (requirementQueries.has(dax)) return [];
        if (probeQueries.has(dax)) {
            const m365 = sampleM365Rows(SOURCE_PROBES.m365Activity, ["[Rows]"])?.[0]?.[0];
            if (typeof m365 !== "number") throw new Error("The generated M365 source did not answer its row-count probe.");
            const counts = {
                m365Activity: m365,
                productFeedback: samples.feedback.length, agentRegistry: samples.agents.length,
                defender: 4, resourceGraph: governanceData.config.length + governanceData.foundry.length,
            };
            const own = OPTIONAL_SOURCES.find(source => SOURCE_PROBES[source] === dax);
            return project(columns, [own ? { Rows: counts[own] } : counts]);
        }
        return sampleEvaluatorRows(dax, columns) ?? sampleM365Rows(dax, columns)
            ?? sampleGeneratedConsumptionRows(dax, columns) ?? sampleGovernanceRows(dax, columns);
    });
}
