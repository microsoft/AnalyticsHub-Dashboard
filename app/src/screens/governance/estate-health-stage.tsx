//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { Unlink } from "lucide-react";
import { stageAnchor } from "@/components/destinations";
import { KpiCard, KpiStat } from "@/components/kpi-card";
import { ChartPanel, KpiRowState, NoteCard } from "@/components/report-panels";
import { Section } from "@/components/section";
import { useSummaryQuery, useTableQuery, type SummaryResult } from "@/hooks/use-table-query";
import { formatKpi } from "@/lib/format-kpi";
import { readNumber } from "@/lib/summary-row";
import { BODY } from "@/lib/type-scale";
import { agentEstateSummary, agentLifecycle, describeRegistryLinkage, type RegistryLinkage } from "@/queries/agents";
import type { GovernanceMode } from "@/queries/governance";
import { ResourceGraphPanel } from "./resource-graph-panel";
import { useResourceGraphSummary } from "./resource-graph-summary";
import { WithoutAgent365Note } from "./without-agent-365-note";

const ESTATE = agentEstateSummary();
const LIFECYCLE = agentLifecycle();

const KPI_GRID = "grid gap-300 md:grid-cols-2 xl:grid-cols-4";

/** The one sentence explaining how far usage could be tied back to the registry, if any is needed. */
function linkageMessage(linkage: RegistryLinkage): string | undefined {
    switch (linkage.kind) {
        case "none":
            return (
                `None of the ${formatKpi(linkage.unmatchedSessions, "whole")} agent sessions in the audit log ` +
                `match an agent in the registry, so no registered agent shows any use and every shared agent ` +
                `reads as unused. Leaderboards lists the agents people did use by their audit-log names.`
            );
        case "partial":
            return (
                `${formatKpi(linkage.unmatchedSessions, "whole")} agent sessions match no agent in the registry, ` +
                `so some agents here may be in use under another name. ` +
                `${formatKpi(linkage.seenInUse, "whole")} of ${formatKpi(linkage.registryAgents, "whole")} ` +
                `registered agents are seen in use.`
            );
        default:
            return undefined;
    }
}

/** What each governance flag means, in the order the review queue weighs them. */
const FLAG_NOTES = [
    {
        term: "No sign-in required",
        text: "The agent answers anyone who reaches it without asking them to sign in, so nothing ties a conversation to a person. Needs Azure Resource Graph or the optional Defender source; Resource Graph wins where both know the agent.",
    },
    {
        term: "Owner has left",
        text: "The creator's Entra account is disabled or no longer exists, so nobody is accountable for the agent.",
    },
    {
        term: "Org-wide with org data",
        text: "Anyone in the organisation can use the agent, and it can read SharePoint sites, OneDrive files or Graph connectors.",
    },
    {
        term: "No owner on record",
        text: "The registry names no creator for a tenant-built agent.",
    },
    {
        term: "Shared, no recorded use",
        text: "The agent is shared with others, but the audit log records nobody using it. A candidate to retire.",
    },
] as const;

/** The same flags as Resource Graph raises them, without Agent 365. */
const RESOURCE_GRAPH_FLAG_NOTES = [
    {
        term: "No sign-in required",
        text: "The agent answers anyone who reaches it without asking them to sign in, so nothing ties a conversation to a person.",
    },
    {
        term: "Owner has left",
        text: "The owner's Entra account is disabled or no longer exists, so nobody is accountable for the agent.",
    },
    FLAG_NOTES[2],
    {
        term: "No owner on record",
        text: "Azure Resource Graph names no owner for the agent.",
    },
    FLAG_NOTES[4],
] as const;

interface EstateHealthStageProps {
    summary: SummaryResult;
    mode?: GovernanceMode;
}

/**
 * How big the estate is, how much of what was built here needs a review,
 * and, with the Agent 365 registry, where every registered agent sits in its
 * lifecycle. Without the registry it counts the Copilot Studio agents Azure
 * Resource Graph loads instead.
 */
export function EstateHealthStage({ summary, mode = "registry" }: EstateHealthStageProps) {
    return mode === "resourceGraph" ? <ResourceGraphEstateHealth summary={summary} /> : <RegistryEstateHealth summary={summary} />;
}

/**
 * The report's Agent Health page, with the registry linkage note that used
 * to sit on Leaderboards.
 */
function RegistryEstateHealth({ summary }: { summary: SummaryResult }) {
    const estate = useSummaryQuery(ESTATE);
    const lifecycle = useTableQuery(LIFECYCLE);
    const resourceGraph = useResourceGraphSummary();
    const row = summary.row;
    const message = linkageMessage(describeRegistryLinkage(estate.row));

    const combined: SummaryResult = {
        row: summary.row && estate.row ? summary.row : undefined,
        loaded: summary.loaded && estate.loaded,
        error: summary.error ?? estate.error,
        refetch: () => {
            summary.refetch();
            estate.refetch();
        },
    };
    const registryEmpty = estate.loaded && (readNumber(estate.row, "[Registry Agents]") ?? 0) === 0;

    return (
        <Section
            id={stageAnchor("estate-health")}
            title="Estate health"
            description="How many agents are registered, how many of those built here need a review, and where each one sits in its lifecycle."
        >
            <KpiRowState
                summary={registryEmpty ? { ...combined, row: undefined } : combined}
                count={4}
                className={KPI_GRID}
                emptyTitle="No agents in the registry"
                emptyDescription="Run the Agent 365 registry ingester, or load a registry export, and refresh the model. Governance reads the registry, not the audit log."
            >
                <KpiCard
                    label="Registered agents"
                    value={readNumber(estate.row, "[Registry Agents]")}
                    detail={
                        <div className="flex flex-col gap-100">
                            <KpiStat label="Built in this tenant" value={readNumber(estate.row, "[Tenant Built]")} />
                            <KpiStat label="Seen in use" value={readNumber(estate.row, "[Seen In Use]")} />
                        </div>
                    }
                />
                <KpiCard
                    label="Need a review"
                    value={readNumber(row, "[Needs Review]")}
                    emphasis
                    detail={
                        <div className="flex flex-col gap-100">
                            <KpiStat label="Of those built here" value={readNumber(row, "[Tenant Agents]")} />
                            <KpiStat label="No sign-in required" value={readNumber(row, "[No Sign In]")} />
                        </div>
                    }
                />
                <KpiCard
                    label="Shared org-wide"
                    value={readNumber(row, "[Org Wide]")}
                    detail={<KpiStat label="Reading org content" value={readNumber(row, "[Org Wide Org Data]")} />}
                />
                <KpiCard
                    label="Owner has left"
                    value={readNumber(row, "[Owner Left]")}
                    detail={<KpiStat label="No owner on record" value={readNumber(row, "[No Owner]")} />}
                />
            </KpiRowState>

            <ResourceGraphPanel summary={resourceGraph} className="grid gap-300 md:grid-cols-3" />

            {message && (
                <p className={`flex max-w-[80ch] items-start gap-200 ${BODY} text-muted-foreground`}>
                    <Unlink className="icon-size-200 mt-[2px] shrink-0" aria-hidden="true" />
                    {message}
                </p>
            )}

            <div className="grid grid-cols-1 gap-500 xl:grid-cols-[minmax(0,1fr)_320px]">
                <ChartPanel
                    result={lifecycle}
                    spec={LIFECYCLE.vegaLiteSpec}
                    capabilities={LIFECYCLE.capabilities}
                    height={420}
                    title="Registry by lifecycle"
                    subtitle="Registered agents at each stage, by who built them"
                    emptyTitle="The registry is empty"
                    emptyDescription="No agents were loaded from the Agent 365 registry. Check that the registry ingestion has run."
                />
                <div className="self-start">
                    <NoteCard title="Why an agent needs a review" notes={FLAG_NOTES} />
                </div>
            </div>
        </Section>
    );
}

/** Estate health from Resource Graph: Copilot Studio agents and their flags, with no lifecycle chart. */
function ResourceGraphEstateHealth({ summary }: { summary: SummaryResult }) {
    const resourceGraph = useResourceGraphSummary();
    const row = summary.row;
    const empty = summary.loaded && (readNumber(row, "[Tenant Agents]") ?? 0) === 0;

    return (
        <Section
            id={stageAnchor("estate-health")}
            title="Estate health"
            description="How many Copilot Studio agents there are, and how many of them need a review."
        >
            <WithoutAgent365Note />
            <KpiRowState
                summary={empty ? { ...summary, row: undefined } : summary}
                count={4}
                className={KPI_GRID}
                emptyTitle="No Copilot Studio agents yet"
                emptyDescription="Azure Resource Graph hasn't loaded any Copilot Studio agents. Run the load, refresh the model, then reopen the app."
            >
                <KpiCard
                    label="Copilot Studio agents"
                    value={readNumber(row, "[Tenant Agents]")}
                    detail={<KpiStat label="Seen in use" value={readNumber(row, "[Seen In Use]")} />}
                />
                <KpiCard
                    label="Need a review"
                    value={readNumber(row, "[Needs Review]")}
                    emphasis
                    detail={<KpiStat label="No sign-in required" value={readNumber(row, "[No Sign In]")} />}
                />
                <KpiCard
                    label="Shared org-wide"
                    value={readNumber(row, "[Org Wide]")}
                    detail={<KpiStat label="Reading org content" value={readNumber(row, "[Org Wide Org Data]")} />}
                />
                <KpiCard
                    label="Owner has left"
                    value={readNumber(row, "[Owner Left]")}
                    detail={<KpiStat label="No owner on record" value={readNumber(row, "[No Owner]")} />}
                />
            </KpiRowState>

            <ResourceGraphPanel summary={resourceGraph} mode="resourceGraph" className="grid gap-300 md:grid-cols-3" />

            <div className="max-w-[80ch]">
                <NoteCard title="Why an agent needs a review" notes={RESOURCE_GRAPH_FLAG_NOTES} />
            </div>
        </Section>
    );
}