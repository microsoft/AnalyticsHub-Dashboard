//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { REGISTRY, RESOURCE_GRAPH_AGENTS, type FilterProfile } from "@/lib/filter-profiles";

/**
 * Where the Governance tabs read their agents from.
 *
 * - `registry`: the Agent 365 registry.
 * - `registryOwnerFallback`: the registry, with Resource Graph's owner check
 *   for agents the registry didn't check. Needs a model with
 *   `'Agents 365'[Owner account (Resource Graph)]`.
 * - `resourceGraph`: Copilot Studio agents from Azure Resource Graph, for
 *   tenants without Agent 365.
 */
export type GovernanceMode = "registry" | "registryOwnerFallback" | "resourceGraph";

/** What the Governance tabs leave out without Agent 365, said on each tab. */
export const WITHOUT_AGENT_365 =
    "Without Agent 365, this view covers Copilot Studio agents from Azure Resource Graph. Microsoft and partner agents, descriptions, publisher, sensitivity labels and where agents are available aren't included.";

const REGISTRY_OWNER = "'Agents 365'[Owner account]";

/** The registry's owner check, or Resource Graph's when the registry's is blank, as the model's Governance Flags reads it. */
export const REGISTRY_OWNER_WITH_FALLBACK = `IF(TRIM(COALESCE(${REGISTRY_OWNER}, "")) = "", 'Agents 365'[Owner account (Resource Graph)], ${REGISTRY_OWNER})`;

/** A registry query, reading Resource Graph's owner check where the registry has none when `mode` says the model has it. */
export function registryQuery(query: string, mode: GovernanceMode): string {
    return mode === "registryOwnerFallback" ? query.split(REGISTRY_OWNER).join(REGISTRY_OWNER_WITH_FALLBACK) : query;
}

/** The filters a Governance query takes in `mode`. */
export function governanceFilters(mode: GovernanceMode): FilterProfile {
    return mode === "resourceGraph" ? RESOURCE_GRAPH_AGENTS : REGISTRY;
}
