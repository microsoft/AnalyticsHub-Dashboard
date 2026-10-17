//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ManagedDiagnosticsPanel } from "@/components/managed-diagnostics-panel";
import type { ConnectorCandidate } from "@/lib/managed/connector-operations";
import {
    getDiagnostics,
    recordCall,
    resetDiagnostics,
    setConnectorState,
    setIdentityCheck,
    setViewer,
    startManagedDiagnostics,
    type CallRecord,
} from "@/lib/managed/diagnostics";
import type { HostMetric, ManagedContext, ManagedSdk } from "@/lib/managed/host";

const runtime = vi.hoisted(() => ({
    assumptions: undefined as { launchCredits: number; creditPerCall: number; throttleLimit: number } | undefined,
    storage: true,
}));

const actions = vi.hoisted(() => ({
    recheckConnector: vi.fn(),
    runIdentityCheck: vi.fn(),
}));

vi.mock("@/lib/runtime-config", () => ({
    MANAGED_DIAGNOSTICS_DEFAULTS: { launchCredits: 0.1, creditPerCall: 0.1, throttleLimit: 100 },
    runtimeConfig: () => ({
        host: "managed",
        rayfin: {},
        semanticModels: {},
        ...(runtime.assumptions ? { managed: { diagnostics: runtime.assumptions, connector: {} } } : {}),
    }),
}));

vi.mock("@/lib/managed/managed-runtime-proxy", () => ({ recheckConnector: actions.recheckConnector }));
vi.mock("@/lib/managed/rls-check", () => ({ runIdentityCheck: actions.runIdentityCheck }));
vi.mock("@/lib/managed/browser-storage", () => ({ canUseBrowserStorage: () => runtime.storage }));

const candidate: ConnectorCandidate = { dataSource: "powerbi", operation: "ExecuteDatasetQueriesJson", shape: "rest" };

function openPanel(): HTMLElement {
    render(<ManagedDiagnosticsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Diagnostics" }));
    return screen.getByRole("region", { name: "Copilot Managed App diagnostics" });
}

/** The value beside a label in one of the panel's lists. */
function row(label: string): string | null | undefined {
    return screen.getByText(label, { selector: "dt" }).nextElementSibling?.textContent;
}

function call(overrides: Partial<CallRecord> = {}): CallRecord {
    return { at: Date.now(), page: "adoption", operation: candidate.operation, ok: true, durationMs: 120, ...overrides };
}

function hostSdk(context: Promise<ManagedContext>, metrics: HostMetric[] = []): ManagedSdk {
    return {
        onMetric: (listener: (metric: HostMetric) => void) => {
            metrics.forEach(listener);
            return () => undefined;
        },
        getContext: () => context,
    } as unknown as ManagedSdk;
}

function stubClipboard(writeText: (text: string) => Promise<void>) {
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
}

describe("ManagedDiagnosticsPanel", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetDiagnostics();
        runtime.assumptions = undefined;
        runtime.storage = true;
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("opens from its toggle and closes again", () => {
        render(<ManagedDiagnosticsPanel />);
        const toggle = screen.getByRole("button", { name: "Diagnostics" });
        expect(toggle).toHaveAttribute("aria-expanded", "false");
        expect(screen.queryByRole("region", { name: "Copilot Managed App diagnostics" })).not.toBeInTheDocument();

        fireEvent.click(toggle);
        const panel = screen.getByRole("region", { name: "Copilot Managed App diagnostics" });
        expect(toggle).toHaveAttribute("aria-expanded", "true");
        expect(toggle).toHaveAttribute("aria-controls", panel.id);
        expect(within(panel).getAllByRole("heading").map((heading) => heading.textContent))
            .toEqual(["Power BI connector", "Row-level security", "Cost and throttling", "Host"]);

        fireEvent.click(toggle);
        expect(screen.queryByRole("region", { name: "Copilot Managed App diagnostics" })).not.toBeInTheDocument();
    });

    it("counts later calls against the page it's given, even while closed", () => {
        const { rerender } = render(<ManagedDiagnosticsPanel page="adoption" />);
        expect(getDiagnostics().page).toBe("adoption");

        rerender(<ManagedDiagnosticsPanel page="pack:p-1" />);
        expect(getDiagnostics().page).toBe("pack:p-1");

        rerender(<ManagedDiagnosticsPanel />);
        expect(getDiagnostics().page).toBe("pack:p-1");
    });

    describe("the connector", () => {
        it("says it isn't checked yet, then which operation runs DAX and what was tried", () => {
            openPanel();
            expect(screen.getByText("Not checked yet. The first query checks it.")).toBeInTheDocument();
            expect(screen.queryByRole("list", { name: "Operations tried" })).not.toBeInTheDocument();

            act(() => setConnectorState({ status: "checking", attempts: [] }));
            expect(screen.getByText("Finding the operation that runs DAX…")).toBeInTheDocument();
            expect(screen.getByRole("button", { name: "Checking…" })).toBeDisabled();

            act(() => setConnectorState({
                status: "ready",
                candidate,
                attempts: [
                    { candidate: { ...candidate, operation: "ExecuteDatasetQuery", shape: "flat" }, outcome: "rejected", status: 400, message: "The body isn't valid." },
                    { candidate, outcome: "ok", status: 200, message: "ignored" },
                ],
            }));
            expect(screen.getByText("DAX runs through ExecuteDatasetQueriesJson on powerbi.")).toBeInTheDocument();
            const tried = screen.getByRole("list", { name: "Operations tried" });
            expect(within(tried).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
                "ExecuteDatasetQuery with a flat body rejected the request (400): The body isn't valid.",
                "ExecuteDatasetQueriesJson with a rest body worked (200)",
            ]);
            expect(screen.getByRole("button", { name: "Re-check connector" })).toBeEnabled();
        });

        it("says why no operation ran DAX", () => {
            openPanel();

            act(() => setConnectorState({
                status: "failed",
                attempts: [{ candidate, outcome: "blocked", status: 403, message: "A data policy blocks Power BI." }],
                error: "No operation ran DAX. Check the data policy for this environment.",
            }));
            expect(screen.getByText("No operation ran DAX. Check the data policy for this environment.")).toHaveClass("text-destructive");
            expect(screen.getByText("ExecuteDatasetQueriesJson with a rest body was blocked by a data policy (403): A data policy blocks Power BI."))
                .toBeInTheDocument();

            act(() => setConnectorState({ status: "failed", attempts: [] }));
            expect(screen.getByText("No operation ran DAX.")).toBeInTheDocument();
        });

        it("re-checks, and can't be pressed again until the check finishes", async () => {
            let finish!: () => void;
            actions.recheckConnector.mockImplementation(() => new Promise<void>((resolve) => {
                finish = resolve;
            }));
            openPanel();

            fireEvent.click(screen.getByRole("button", { name: "Re-check connector" }));
            expect(actions.recheckConnector).toHaveBeenCalledTimes(1);
            const busy = screen.getByRole("button", { name: "Checking…" });
            expect(busy).toBeDisabled();
            fireEvent.click(busy);
            expect(actions.recheckConnector).toHaveBeenCalledTimes(1);

            await act(async () => finish());
            expect(screen.getByRole("button", { name: "Re-check connector" })).toBeEnabled();
        });
    });

    describe("row-level security", () => {
        it("shows who is signed in and who the model sees", () => {
            setViewer({ fullName: "Ada Lovelace", objectId: "o-1", tenantId: "t-1" });
            openPanel();
            expect(row("Signed in as")).toBe("Ada Lovelace");
            expect(screen.queryByText("The model sees")).not.toBeInTheDocument();

            fireEvent.click(screen.getByRole("button", { name: "Check who the model sees" }));
            expect(actions.runIdentityCheck).toHaveBeenCalledTimes(1);

            act(() => setIdentityCheck({ status: "running", model: "vl", checkedAt: 1 }));
            expect(screen.getByRole("button", { name: "Checking…" })).toBeDisabled();

            act(() => setIdentityCheck({ status: "done", model: "vl", upn: "ada@contoso.com", user: "CONTOSO\\ada", checkedAt: 2 }));
            expect(row("The model sees")).toBe("ada@contoso.com");
            expect(row("USERNAME()")).toBe("CONTOSO\\ada");
            expect(screen.getByRole("button", { name: "Check again" })).toBeEnabled();
        });

        it("hides USERNAME() when it matches, and says when the model sees no one", () => {
            openPanel();

            act(() => setIdentityCheck({ status: "done", upn: "ada@contoso.com", user: "ada@contoso.com", checkedAt: 1 }));
            expect(row("The model sees")).toBe("ada@contoso.com");
            expect(screen.queryByText("USERNAME()")).not.toBeInTheDocument();

            act(() => setIdentityCheck({ status: "done", checkedAt: 2 }));
            expect(row("The model sees")).toBe("Blank");
        });

        it("shows why the viewer or the check couldn't be read", () => {
            setViewer(undefined, "The app host didn't answer within 10 seconds.");
            openPanel();
            expect(row("Signed in as")).toBe("Unknown");
            expect(screen.getByText("The app host didn't answer within 10 seconds.")).toHaveClass("text-destructive");

            act(() => setIdentityCheck({ status: "failed", model: "vl", error: "You don't have access to the Analytics Hub model.", checkedAt: 1 }));
            expect(screen.getByText("You don't have access to the Analytics Hub model.")).toHaveClass("text-destructive");
            expect(screen.queryByText("The model sees")).not.toBeInTheDocument();
            expect(screen.getByRole("button", { name: "Check again" })).toBeEnabled();
        });
    });

    describe("cost and throttling", () => {
        it("starts at the launch cost, and counts each call as it's made", () => {
            openPanel();
            expect(row("Connector calls")).toBe("0");
            expect(row("Copilot Credits")).toBe("0.1");
            expect(row("Calls in the last minute")).toBe("0 of 100");
            expect(row("Busiest minute")).toBe("0");
            for (const label of ["Connector checks", "Failed calls", "Throttled calls", "Average call"])
                expect(screen.queryByText(label)).not.toBeInTheDocument();
            expect(screen.queryByLabelText("Calls by page")).not.toBeInTheDocument();
            expect(screen.getByText(/0\.1 to open the app and 0\.1 a call/)).toBeInTheDocument();

            act(() => recordCall(call({ durationMs: 80 })));
            expect(row("Connector calls")).toBe("1");
            expect(row("Copilot Credits")).toBe("0.2");
            expect(row("Calls in the last minute")).toBe("1 of 100");
            expect(row("Average call")).toBe("80 ms");
            expect(screen.queryByText(/busiest minute reached/)).not.toBeInTheDocument();
        });

        it("adds up checks, failures and pages, and warns near the throttle", () => {
            runtime.assumptions = { launchCredits: 0.5, creditPerCall: 0.25, throttleLimit: 5 };
            recordCall(call({ durationMs: 100 }));
            recordCall(call({ durationMs: 200 }));
            recordCall(call({ page: "executive", ok: false, status: 429, durationMs: 300, error: "Too many requests." }));
            recordCall(call({ page: "start", probe: true, durationMs: 400 }));
            openPanel();

            expect(row("Connector calls")).toBe("4");
            expect(row("Connector checks")).toBe("1");
            expect(row("Failed calls")).toBe("1");
            expect(row("Throttled calls")).toBe("1");
            expect(row("Copilot Credits")).toBe("1.5");
            expect(row("Calls in the last minute")).toBe("4 of 5");
            expect(row("Busiest minute")).toBe("4");
            expect(row("Average call")).toBe("250 ms");
            expect(screen.getByText("The busiest minute reached 80% of the connector's limit of 5 calls a minute."))
                .toHaveClass("text-destructive");
            expect(screen.getByText(/0\.5 to open the app and 0\.25 a call/)).toBeInTheDocument();

            const byPage = screen.getByLabelText("Calls by page");
            expect(Array.from(byPage.querySelectorAll("dt"), (label) => `${label.textContent} ${label.nextElementSibling?.textContent}`))
                .toEqual(["adoption 2", "executive 1", "start 1"]);
        });

        it("keeps the busiest minute after its calls leave the last minute", () => {
            vi.useFakeTimers();
            recordCall(call());
            recordCall(call());
            openPanel();
            expect(row("Calls in the last minute")).toBe("2 of 100");

            act(() => {
                vi.advanceTimersByTime(60_000);
            });
            expect(row("Calls in the last minute")).toBe("0 of 100");
            expect(row("Busiest minute")).toBe("2");
            expect(row("Connector calls")).toBe("2");
        });
    });

    describe("the host", () => {
        it("shows the app context, the host's metrics and where settings are kept", async () => {
            openPanel();
            expect(row("Settings")).toBe("Saved in this browser");
            expect(screen.queryByText("App", { selector: "dt" })).not.toBeInTheDocument();

            act(() => startManagedDiagnostics(hostSdk(
                Promise.resolve({ appId: "app-1", environmentId: "env-1", sessionId: "session-1" }),
                [{ type: "sessionLoadSummary", loadMs: 900 }, { type: "networkRequest" }, { type: "networkRequest" }],
            )));

            expect(await screen.findByText("app-1")).toBeInTheDocument();
            expect(row("App")).toBe("app-1");
            expect(row("Environment")).toBe("env-1");
            expect(row("Session")).toBe("session-1");
            expect(row("sessionLoadSummary metrics")).toBe("1");
            expect(row("networkRequest metrics")).toBe("2");
        });

        it("says when settings last only until the app closes, and when the host gave no context", async () => {
            runtime.storage = false;
            openPanel();
            expect(row("Settings")).toBe("Kept until the app closes");

            act(() => startManagedDiagnostics(hostSdk(Promise.reject(new Error("The app host didn't share its context.")))));

            expect(await screen.findByText("The app host didn't share its context.")).toHaveClass("text-destructive");
            expect(screen.queryByText("App", { selector: "dt" })).not.toBeInTheDocument();
        });
    });

    describe("copying the results", () => {
        it("copies the assumptions, the summary and everything measured as JSON", async () => {
            const writeText = vi.fn().mockResolvedValue(undefined);
            stubClipboard(writeText);
            setViewer({ fullName: "Ada Lovelace", objectId: "o-1", tenantId: "t-1" });
            recordCall(call());
            openPanel();

            fireEvent.click(screen.getByRole("button", { name: "Copy results" }));

            expect(await screen.findByRole("button", { name: "Results copied" })).toBeInTheDocument();
            const report = JSON.parse(writeText.mock.calls[0][0] as string);
            expect(report).toMatchObject({
                assumptions: { launchCredits: 0.1, creditPerCall: 0.1, throttleLimit: 100 },
                summary: { calls: 1, credits: 0.2, lastMinute: 1, nearLimit: false },
                settingsInBrowser: true,
                diagnostics: { viewer: { fullName: "Ada Lovelace" }, totals: { calls: 1 }, connector: { status: "unknown" } },
            });
            expect(Number.isNaN(Date.parse(report.capturedAt))).toBe(false);
            expect(screen.queryByLabelText("Diagnostics results")).not.toBeInTheDocument();
        });

        it("shows the results to copy by hand when the clipboard is blocked", async () => {
            stubClipboard(vi.fn().mockRejectedValue(new Error("Blocked.")));
            runtime.storage = false;
            openPanel();

            fireEvent.click(screen.getByRole("button", { name: "Copy results" }));

            const results = await screen.findByLabelText("Diagnostics results");
            expect(JSON.parse((results as HTMLTextAreaElement).value)).toMatchObject({ summary: { calls: 0 }, settingsInBrowser: false });
            expect(screen.getByRole("button", { name: "Copy results" })).toBeInTheDocument();
        });
    });
});
