//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { DataTable } from "@microsoft/fabric-visuals-core";
import type { AgentEntry } from "@/queries/agents";

/** Whether an agent's name, type, owner or registry ID holds every word searched for. */
export function matchesAgent(entry: AgentEntry, search: string): boolean {
    const words = search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return true;
    const text = [entry.name, entry.type, entry.creator, entry.registryId].filter(Boolean).join(" ").toLocaleLowerCase();
    return words.every((word) => text.includes(word));
}

/** The agents a search matches, as the CSV Export writes them. */
export function agentsCsvTable(entries: readonly AgentEntry[]): DataTable {
    return {
        columns: [
            { name: "Agent" },
            { name: "Type" },
            { name: "Status" },
            { name: "Lifecycle stage" },
            { name: "Owner" },
            { name: "People" },
            { name: "Sessions" },
            { name: "Sessions per person" },
            { name: "Organizations reached" },
            { name: "Last active" },
            { name: "Registry ID" },
        ],
        rows: entries.map((entry) => {
            const used = entry.users > 0;
            return [
                entry.name,
                entry.type ?? null,
                entry.inRegistry ? "Registered" : "Unregistered",
                entry.lifecycle ?? null,
                entry.creator ?? null,
                entry.users,
                entry.sessions,
                used ? (entry.sessionsPerUser ?? null) : null,
                used ? entry.orgsReached : null,
                used ? (entry.lastActivity ?? null) : null,
                entry.registryId ?? null,
            ];
        }),
    };
}
