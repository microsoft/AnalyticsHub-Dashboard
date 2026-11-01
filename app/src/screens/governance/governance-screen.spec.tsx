//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { render, screen } from "@testing-library/react";
import type { VisualTheme } from "@microsoft/fabric-visuals-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SourceAvailabilityContext } from "@/hooks/source-availability.context";
import { ThemeContext } from "@/hooks/theme.context";
import type { ModelRequirementScope } from "@/lib/model-requirements";
import { ALL_UNKNOWN, type SourceAvailability } from "@/lib/optional-sources";
import { WITHOUT_AGENT_365 } from "@/queries/governance";

type RequirementState = { status: "ok" | "checking" | "unknown" } | { status: "outdated"; missing: string[] };

const mocked = vi.hoisted(() => ({
    requirements: {} as Partial<Record<string, unknown>>,
    asked: [] as string[],
    queries: [] as string[],
}));

vi.mock("@/hooks/use-model-requirements", () => ({
    useModelRequirementState: (scope: string) => {
        mocked.asked.push(scope);
        return mocked.requirements[scope] ?? { status: "ok" };
    },
}));

// Every query stays loading; the tests only look at which ones the page asks for.
vi.mock("@/hooks/use-table-query", () => ({
    useSummaryQuery: (source: { query: string }) => {
        mocked.queries.push(source.query);
        return {
            row: undefined,
            loaded: false,
            error: undefined,
            refetch: () => undefined,
        };
    },
    useTableQuery: (source: { query: string }) => {
        mocked.queries.push(source.query);
        return {
            table: undefined,
            error: undefined,
            isLoading: true,
            refetch: () => undefined,
        };
    },
}));

import { GovernanceScreen } from ".";

function renderScreen(sources: SourceAvailability) {
    return render(
        <ThemeContext.Provider
            value={{
                isDark: false,
                toggleTheme: () => undefined,
                theme: {} as VisualTheme,
            }}
        >
            <SourceAvailabilityContext.Provider value={sources}>
                <GovernanceScreen />
            </SourceAvailabilityContext.Provider>
        </ThemeContext.Provider>,
    );
}

function requirements(states: Partial<Record<ModelRequirementScope, RequirementState>>) {
    mocked.requirements = states;
}

beforeEach(() => {
    mocked.requirements = {};
    mocked.asked = [];
    mocked.queries = [];
});

describe("GovernanceScreen", () => {
    it("shows update guidance before running Governance queries when the model is older than the app", () => {
        requirements({
            governance: {
                status: "outdated",
                missing: ["Agents 365[Owner account]", "Agents 365[Governance Flags]"],
            },
        });
        renderScreen({
            ...ALL_UNKNOWN,
            agentRegistry: "present",
            defender: "notConfigured",
        });

        expect(screen.getByRole("heading", { name: "Governance" })).toBeTruthy();
        expect(screen.getByText("Needs an update")).toBeTruthy();
        expect(screen.getByText(/Agents 365\[Owner account\]/)).toBeTruthy();
        expect(screen.queryByText("Turn on Azure Resource Graph")).toBeNull();
        expect(screen.getByText("Defender isn't turned on")).toBeTruthy();
    });

    it("asks for Azure Resource Graph first, not Agent 365, when neither source is connected, and still shows Shadow AI", () => {
        renderScreen({
            ...ALL_UNKNOWN,
            agentRegistry: "absent",
            resourceGraph: "notConfigured",
            defender: "absent",
        });

        expect(screen.getByText("Turn on Azure Resource Graph")).toBeTruthy();
        expect(screen.getByText(/needs no Agent 365 licence/)).toBeTruthy();
        expect(screen.queryByText("Connect the Agent 365 registry")).toBeNull();
        expect(screen.getByRole("heading", { name: "Shadow AI" })).toBeTruthy();
        expect(screen.getByText("Connect Microsoft Defender")).toBeTruthy();
    });

    it("says no agents have loaded when Resource Graph is on but empty", () => {
        renderScreen({
            ...ALL_UNKNOWN,
            agentRegistry: "notConfigured",
            resourceGraph: "absent",
            defender: "absent",
        });

        expect(screen.getByText("No agent data yet")).toBeTruthy();
    });

    it("reads Resource Graph, and says what it leaves out, when Agent 365 isn't connected", () => {
        renderScreen({
            ...ALL_UNKNOWN,
            agentRegistry: "notConfigured",
            resourceGraph: "present",
            defender: "notConfigured",
        });

        expect(mocked.asked).toContain("governanceResourceGraph");
        expect(mocked.asked).not.toContain("governance");
        for (const title of ["Estate health", "Exposure", "Accountability", "Review queue"]) {
            expect(screen.getByRole("heading", { name: title })).toBeTruthy();
        }
        expect(screen.getAllByText(WITHOUT_AGENT_365)).toHaveLength(4);
        const governance = mocked.queries.filter((query) => query.includes("'Agent") && !query.includes("Foundry"));
        expect(governance.length).toBeGreaterThan(0);
        expect(governance.join("\n")).not.toContain("'Agents 365'");
    });

    it("asks for a model update when Resource Graph lacks the Governance columns", () => {
        requirements({
            governanceResourceGraph: {
                status: "outdated",
                missing: ["Agent Configuration[Governance Flags]"],
            },
        });
        renderScreen({
            ...ALL_UNKNOWN,
            agentRegistry: "absent",
            resourceGraph: "present",
            defender: "notConfigured",
        });

        expect(screen.getByText("Needs an update")).toBeTruthy();
        expect(screen.getByText(/Agent Configuration\[Governance Flags\]/)).toBeTruthy();
    });

    it("fills the registry's unchecked owners from Resource Graph only when the model has the column", () => {
        const fallback = "'Agents 365'[Owner account (Resource Graph)]";
        const sources = {
            ...ALL_UNKNOWN,
            agentRegistry: "present" as const,
            resourceGraph: "present" as const,
            defender: "notConfigured" as const,
        };

        requirements({
            governanceOwnerFallback: {
                status: "outdated",
                missing: ["Agents 365[Owner account (Resource Graph)]"],
            },
        });
        const { unmount } = renderScreen(sources);
        expect(screen.queryByText("Needs an update")).toBeNull();
        expect(screen.queryByText(WITHOUT_AGENT_365)).toBeNull();
        expect(mocked.queries.some((query) => query.includes(fallback))).toBe(false);
        unmount();

        mocked.queries = [];
        requirements({ governanceOwnerFallback: { status: "ok" } });
        renderScreen(sources);
        expect(mocked.queries.some((query) => query.includes(fallback))).toBe(true);
    });
});
