//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { VisualizationSpec } from "@microsoft/fabric-visuals";
import { treatAs } from "@/lib/dax-filters";
import {
    DEFAULT_ORG_ATTRIBUTE,
    describeOrgAttribute,
    withOrgAttribute,
    type OrgAttribute,
} from "@/lib/org-attribute";
import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection, FORMAT_WHOLE } from "../shared";
import orgsTemplate from "./agent-orgs.dax?raw";
import trendTemplate from "./agent-trend.dax?raw";
import trendSpec from "./agent-trend.json";

const TITLE_ID = "'Agents 365'[Title ID]";
const AGENT_NAME = "'Chat + Agent Interactions (Audit Logs)'[AgentName]";
const NOT_IN_REGISTRY = `FILTER(ALL(${TITLE_ID}), ISBLANK(${TITLE_ID}))`;

/**
 * The DAX filter that picks out one agent, read from the agents table's
 * `Agent Key`: `registry:<id>` for a registered agent, `audit:text:<name>`
 * for an audit-log name with no registry entry, and `audit:blank` for
 * sessions with no agent name. Undefined for a key it doesn't recognise.
 */
export function agentFilter(agentKey: string): string | undefined {
    if (agentKey.startsWith("registry:")) {
        const id = agentKey.slice("registry:".length);
        return id ? treatAs(TITLE_ID, [id]) : undefined;
    }
    if (agentKey === "audit:blank") return `FILTER(ALL(${AGENT_NAME}), ISBLANK(${AGENT_NAME})), ${NOT_IN_REGISTRY}`;
    if (agentKey.startsWith("audit:text:")) {
        return `${treatAs(AGENT_NAME, [agentKey.slice("audit:text:".length)])}, ${NOT_IN_REGISTRY}`;
    }
    return undefined;
}

const trendColumns: ColumnMetadataMap = {
    "Chat + Agent Interactions (Audit Logs)[WeekStart]": {
        name: "Chat + Agent Interactions (Audit Logs)WeekStart",
        displayName: "Week starting",
        format: "dd mmm yyyy",
    },
    "[Users]": { name: "Users", displayName: "People", format: FORMAT_WHOLE },
    "[Sessions]": { name: "Sessions", displayName: "Sessions", format: FORMAT_WHOLE },
};

const orgColumns: ColumnMetadataMap = {
    "Chat + Agent Org Data[Organization]": {
        name: "Chat + Agent Org DataOrganization",
        displayName: "Organization",
    },
    "[Users]": { name: "Users", displayName: "People", format: FORMAT_WHOLE },
    "[Sessions]": { name: "Sessions", displayName: "Sessions", format: FORMAT_WHOLE },
};

/** One agent's people and sessions, week by week. `filter` comes from {@link agentFilter}. */
export function agentTrend(filter: string) {
    return {
        connection,
        query: trendTemplate.replace("__AGENT__", () => filter),
        columnMetadata: trendColumns,
        vegaLiteSpec: trendSpec as VisualizationSpec,
    };
}

/** The five organizations, or other org column, using one agent most. `filter` comes from {@link agentFilter}. */
export function agentOrgs(
    filter: string,
    attribute: OrgAttribute = describeOrgAttribute(DEFAULT_ORG_ATTRIBUTE),
) {
    return withOrgAttribute(
        { connection, query: orgsTemplate.replace("__AGENT__", () => filter), columnMetadata: orgColumns },
        attribute,
    );
}