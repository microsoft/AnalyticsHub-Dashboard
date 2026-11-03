//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useMemo } from "react";
import { stageAnchor } from "@/components/destinations";
import { ChartPanel, NoteCard } from "@/components/report-panels";
import { Section } from "@/components/section";
import { useThemeContext } from "@/hooks/theme.context";
import { useSourceAvailability } from "@/hooks/source-availability.context";
import { useTableQuery } from "@/hooks/use-table-query";
import {
    applyExposureTheme,
    completeExposureGrid,
    EXPOSURE_ACCESS_WITH_WEB,
    governanceExposure,
    governancePublicWeb,
    PUBLIC_WEB,
    soleExposureAccess,
    withPublicWeb,
    type GovernanceMode,
} from "@/queries/governance";
import { WithoutAgent365Note } from "./without-agent-365-note";

const QUERIES = {
    registry: { exposure: governanceExposure("registry"), publicWeb: governancePublicWeb("registry") },
    registryOwnerFallback: {
        exposure: governanceExposure("registryOwnerFallback"),
        publicWeb: governancePublicWeb("registryOwnerFallback"),
    },
    resourceGraph: { exposure: governanceExposure("resourceGraph"), publicWeb: governancePublicWeb("resourceGraph") },
} satisfies Record<GovernanceMode, unknown>;
const NO_PUBLIC_WEB = { ...QUERIES.registry.publicWeb, query: "" };

/** Said when every agent sits in one data access column, so the empty columns read as a finding, not a fault. */
function soleAccessNote(access: string, standalone: boolean): string {
    if (access === "Not reported") {
        return standalone
            ? "Azure Resource Graph gave no knowledge sources for these agents, so what they can read is unknown"
            : "The registry gave no capability details for these agents, so what they can read is unknown";
    }
    if (access === "None declared") return "None of these agents declares any data it can read";
    return `Every one of these agents can read ${access.toLowerCase()}`;
}

const NOTES = [
    {
        term: "The corner to watch",
        text: "Top left: agents anyone in the organisation can use that also read organisation content. Each is worth a check that it only surfaces what its audience should see.",
    },
    {
        term: "Shared with",
        text: "Who the registry says can use the agent. Not stated means the registry or its export didn't say.",
    },
    {
        term: "What it can read",
        text: "Organisation content means SharePoint sites, OneDrive files or Graph connectors. Not reported means the registry gave no capability details for the agent.",
    },
];

/** The map's notes when it reads Resource Graph, as Agent 365 isn't connected. */
const RESOURCE_GRAPH_NOTES = [
    NOTES[0],
    {
        term: "Shared with",
        text: "Who Azure Resource Graph says the agent is shared with: the whole organisation, specific people or groups, or nobody else.",
    },
    {
        term: "What it can read",
        text: "Organisation content means SharePoint sites, OneDrive files or Graph connectors. Not reported means Azure Resource Graph listed no knowledge sources for the agent.",
    },
];

const PUBLIC_WEB_NOTE = {
    term: PUBLIC_WEB,
    text: "Agents with web search turned on as a knowledge source, from Azure Resource Graph. They also appear under whatever else they can read.",
};

/**
 * How widely each tenant-built agent is shared against what it can read,
 * so the agents that could surface organisation content to everyone stand
 * out. Blocked agents are left out, since nobody can reach them. Without
 * Agent 365 (`resourceGraph`), the Copilot Studio agents Resource Graph
 * loads, leaving out quarantined ones.
 */
export function ExposureStage({ mode = "registry" }: { mode?: GovernanceMode }) {
    const { theme } = useThemeContext();
    const standalone = mode === "resourceGraph";
    const queries = QUERIES[mode];
    const exposure = useTableQuery(queries.exposure);
    const resourceGraph = useSourceAvailability().resourceGraph === "present" || standalone;
    const publicWeb = useTableQuery(resourceGraph ? queries.publicWeb : NO_PUBLIC_WEB).table;
    const gridTable = useMemo(() => {
        if (!exposure.table) return undefined;
        if (!resourceGraph || !publicWeb) return completeExposureGrid(exposure.table);
        return completeExposureGrid(withPublicWeb(exposure.table, publicWeb), EXPOSURE_ACCESS_WITH_WEB);
    }, [exposure.table, publicWeb, resourceGraph]);
    const sole = soleExposureAccess(exposure.table);

    const spec = useMemo(
        () =>
            // Every mode shares one spec.
            applyExposureTheme(QUERIES.registry.exposure.vegaLiteSpec, {
                quiet: theme.backgroundHover || theme.backgroundSecondary,
                strong: theme.brandBackground,
                quietText: theme.foreground,
                strongText: theme.background,
            }),
        [theme],
    );

    return (
        <Section
            id={stageAnchor("exposure")}
            title="Exposure"
            description="Who can reach the agents built here, against what they can read."
        >
            {standalone && <WithoutAgent365Note />}
            <div className="grid grid-cols-1 gap-500 xl:grid-cols-[minmax(0,1fr)_320px]">
                <ChartPanel
                    result={{ ...exposure, table: gridTable }}
                    spec={spec}
                    height={340}
                    title="Sharing against data access"
                    subtitle={
                        sole
                            ? soleAccessNote(sole, standalone)
                            : `${standalone ? "Copilot Studio" : "Tenant-built"} agents in each pairing; hover for how many have no recorded use`
                    }
                    emptyTitle={standalone ? "No Copilot Studio agents" : "No tenant-built agents"}
                    emptyDescription={
                        standalone
                            ? "Azure Resource Graph holds no Copilot Studio agents for these filters."
                            : "The registry holds no agents built in this tenant for these filters."
                    }
                />
                <div className="self-start">
                    <NoteCard
                        title="Reading the map"
                        notes={[...(standalone ? RESOURCE_GRAPH_NOTES : NOTES), ...(resourceGraph ? [PUBLIC_WEB_NOTE] : [])]}
                    />
                </div>
            </div>
        </Section>
    );
}
