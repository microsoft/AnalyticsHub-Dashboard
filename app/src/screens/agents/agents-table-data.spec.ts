//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import type { AgentEntry } from "@/queries/agents";
import { agentsCsvTable, matchesAgent } from "./agents-table-data";

const used: AgentEntry = {
    key: "r1",
    agentKey: "registry:r1",
    name: "Expense Helper",
    registryId: "r1",
    inRegistry: true,
    type: "Copilot Studio",
    creator: "Finance Team",
    users: 12,
    sessions: 40,
    orgsReached: 3,
    sessionsPerUser: 3.33,
    lastActivity: "2026-10-20",
    lifecycle: "In use",
};

const unused: AgentEntry = {
    key: "r2",
    agentKey: "registry:r2",
    name: "Travel Desk",
    registryId: "r2",
    inRegistry: true,
    users: 0,
    sessions: 0,
    orgsReached: 0,
    sessionsPerUser: 0,
    lastActivity: "2026-01-02",
};

describe("matchesAgent", () => {
    it("matches everything on a blank search", () => {
        expect(matchesAgent(used, "   ")).toBe(true);
    });

    it("needs every word, in any of name, type, owner or registry ID, ignoring case", () => {
        expect(matchesAgent(used, "expense finance")).toBe(true);
        expect(matchesAgent(used, "STUDIO r1")).toBe(true);
        expect(matchesAgent(used, "expense travel")).toBe(false);
    });
});

describe("agentsCsvTable", () => {
    it("writes one row per agent, in the order given", () => {
        const table = agentsCsvTable([used, unused]);
        expect(table.columns.map((column) => column.name)).toEqual([
            "Agent",
            "Type",
            "Status",
            "Lifecycle stage",
            "Owner",
            "People",
            "Sessions",
            "Sessions per person",
            "Organizations reached",
            "Last active",
            "Registry ID",
        ]);
        expect(table.rows[0]).toEqual([
            "Expense Helper", "Copilot Studio", "Registered", "In use", "Finance Team", 12, 40, 3.33, 3, "2026-10-20", "r1",
        ]);
    });

    it("leaves usage blank for an agent nobody used", () => {
        expect(agentsCsvTable([unused]).rows[0]).toEqual([
            "Travel Desk", null, "Registered", null, null, 0, 0, null, null, null, "r2",
        ]);
    });
});
