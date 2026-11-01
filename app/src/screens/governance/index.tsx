//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useStageFilter } from "@/hooks/stage-filter.context";
import { stageAnchor } from "@/components/destinations";
import { AdminSteps, ModelUpdateRequired, QueryEmpty, QueryLoading } from "@/components/query-states";
import { Section } from "@/components/section";
import { useSourceAvailability } from "@/hooks/source-availability.context";
import { useModelRequirementState } from "@/hooks/use-model-requirements";
import { useSummaryQuery } from "@/hooks/use-table-query";
import { isAbsent, type SourceAvailability } from "@/lib/optional-sources";
import { governanceSummary, type GovernanceMode } from "@/queries/governance";
import { AccountabilityStage } from "./accountability-stage";
import { EstateHealthStage } from "./estate-health-stage";
import { ExposureStage } from "./exposure-stage";
import { ReviewQueueStage } from "./review-queue-stage";
import { ShadowAiStage } from "./shadow-ai-stage";

const SUMMARY: Record<GovernanceMode, ReturnType<typeof governanceSummary>> = {
    registry: governanceSummary("registry"),
    registryOwnerFallback: governanceSummary("registryOwnerFallback"),
    resourceGraph: governanceSummary("resourceGraph"),
};
const REGISTRY_STAGES = ["estate-health", "exposure", "accountability", "review-queue"] as const;
const DESCRIPTION = "Who owns your agents, who can reach them, and what needs a review.";

/**
 * Your agents read as an estate to look after: how big it is and how much of
 * it needs a review, who can reach each agent against what it can read,
 * whether someone is still accountable for it, and the agents to sort out
 * first. These are catalogues rather than activity, so only the agent filter
 * applies.
 *
 * The four stages read the Agent 365 registry when it's connected. Without
 * it they read the Copilot Studio agents Azure Resource Graph loads, so
 * Governance works with no Agent 365 licence; each stage then says what it
 * leaves out. With neither, the page says how to connect one instead of
 * running four sets of empty queries. Shadow AI reads the optional Defender
 * source, so it sits below them on its own whatever the other sources say.
 */
export function GovernanceScreen() {
    const sources = useSourceAvailability();
    const { show } = useStageFilter();
    const registryStages = REGISTRY_STAGES.some(show);
    return (
        <div className="flex flex-col gap-800">
            {registryStages && <GovernanceSource sources={sources} />}
            {show("shadow-ai") && <ShadowAiStage source={sources.defender} />}
        </div>
    );
}

function GovernanceSource({ sources }: { sources: SourceAvailability }) {
    if (!isAbsent(sources, "agentRegistry")) return <RegistryGovernance />;
    if (!isAbsent(sources, "resourceGraph")) return <ResourceGraphGovernance />;
    return <ConnectSource configured={sources.resourceGraph !== "notConfigured"} />;
}

function RegistryGovernance() {
    const requirements = useModelRequirementState("governance");
    // Optional: a model with Resource Graph's owner check fills the registry's unchecked owners from it.
    const ownerFallback = useModelRequirementState("governanceOwnerFallback");
    if (requirements.status === "outdated") return <GovernanceUpdate missing={requirements.missing} />;
    if (requirements.status === "checking" || ownerFallback.status === "checking") return <GovernanceLoading />;
    return <GovernanceStages mode={ownerFallback.status === "ok" ? "registryOwnerFallback" : "registry"} />;
}

function ResourceGraphGovernance() {
    const requirements = useModelRequirementState("governanceResourceGraph");
    if (requirements.status === "outdated") return <GovernanceUpdate missing={requirements.missing} />;
    if (requirements.status === "checking") return <GovernanceLoading />;
    return <GovernanceStages mode="resourceGraph" />;
}

function GovernanceStages({ mode }: { mode: GovernanceMode }) {
    const summary = useSummaryQuery(SUMMARY[mode]);
    const { show } = useStageFilter();

    return (
        <div className="flex flex-col gap-800">
            {show("estate-health") && <EstateHealthStage summary={summary} mode={mode} />}
            {show("exposure") && <ExposureStage mode={mode} />}
            {show("accountability") && <AccountabilityStage summary={summary} mode={mode} />}
            {show("review-queue") && <ReviewQueueStage mode={mode} />}
        </div>
    );
}

function GovernanceLoading() {
    return (
        <Section id={stageAnchor("estate-health")} title="Governance" description={DESCRIPTION}>
            <QueryLoading />
        </Section>
    );
}

/** Neither source is connected. Resource Graph comes first: it needs no Agent 365 licence. */
function ConnectSource({ configured }: { configured: boolean }) {
    return (
        <Section id={stageAnchor("estate-health")} title="Governance" description={DESCRIPTION}>
            <QueryEmpty
                title={configured ? "No agent data yet" : "Turn on Azure Resource Graph"}
                description={
                    <>
                        <p>
                            Governance reads your Copilot Studio agents from Azure Resource Graph, which needs no Agent 365
                            licence. The Agent 365 registry is optional: it adds Microsoft and partner agents.
                        </p>
                        <AdminSteps>
                            <p>
                                {configured
                                    ? "Azure Resource Graph is turned on, but no agents have loaded yet. Run the load, let the model refresh, then reopen the app."
                                    : "Run the installer again and tick Azure Resource Graph. Governance fills in after the next load and model refresh. To add Microsoft and partner agents too, tick Agent 365 registry as well."}
                            </p>
                        </AdminSteps>
                    </>
                }
            />
        </Section>
    );
}

function GovernanceUpdate({ missing }: { missing: readonly string[] }) {
    return (
        <Section id={stageAnchor("estate-health")} title="Governance" description={DESCRIPTION}>
            <ModelUpdateRequired missing={missing} />
        </Section>
    );
}