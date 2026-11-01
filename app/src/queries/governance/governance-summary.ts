//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection, FORMAT_WHOLE } from "../shared";
import { governanceFilters, registryQuery, type GovernanceMode } from "./governance-mode";
import query from "./governance-summary.dax?raw";
import resourceGraphQuery from "./governance-summary-resource-graph.dax?raw";

const columnMetadata: ColumnMetadataMap = {
    "[Tenant Agents]": { name: "Tenant Agents", displayName: "Built in this tenant", format: FORMAT_WHOLE },
    "[Needs Review]": { name: "Needs Review", displayName: "Need a review", format: FORMAT_WHOLE },
    "[No Sign In]": { name: "No Sign In", displayName: "No sign-in required", format: FORMAT_WHOLE },
    "[Owner Left]": { name: "Owner Left", displayName: "Owner has left", format: FORMAT_WHOLE },
    "[No Owner]": { name: "No Owner", displayName: "No owner on record", format: FORMAT_WHOLE },
    "[Org Wide Org Data]": {
        name: "Org Wide Org Data",
        displayName: "Org-wide with org data",
        format: FORMAT_WHOLE,
    },
    "[Shared Unused]": { name: "Shared Unused", displayName: "Shared, no recorded use", format: FORMAT_WHOLE },
    "[Org Wide]": { name: "Org Wide", displayName: "Shared org-wide", format: FORMAT_WHOLE },
    "[Owners Checked]": { name: "Owners Checked", displayName: "Owners checked", format: FORMAT_WHOLE },
};

/**
 * Without Agent 365 the summary counts Copilot Studio agents from Resource
 * Graph, and adds how many anyone has used, as there is no lifecycle chart.
 */
const resourceGraphColumnMetadata: ColumnMetadataMap = {
    ...columnMetadata,
    "[Tenant Agents]": { name: "Tenant Agents", displayName: "Copilot Studio agents", format: FORMAT_WHOLE },
    "[Seen In Use]": { name: "Seen In Use", displayName: "Seen in use", format: FORMAT_WHOLE },
};

/**
 * The tenant-built agents and how many carry each governance flag.
 *
 * The flags themselves are the model's `Governance Flags` column, which only
 * marks tenant-built agents an admin hasn't blocked; the counts here read
 * that one column so the page and the report can never disagree on what a
 * flag means. `Owners Checked` is zero when the ingester's owner-account
 * check is off or the registry came from a CSV, so the page can say the
 * owner figures are missing rather than reporting that nobody has left.
 *
 * `mode` picks the source: the registry, the registry with Resource Graph's
 * owner check filling its gaps, or Resource Graph alone.
 */
export function governanceSummary(mode: GovernanceMode = "registry") {
    if (mode === "resourceGraph") {
        return {
            connection,
            query: resourceGraphQuery,
            columnMetadata: resourceGraphColumnMetadata,
            filters: governanceFilters(mode),
        };
    }
    return { connection, query: registryQuery(query, mode), columnMetadata, filters: governanceFilters(mode) };
}
