//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    getDiagnostics,
    peakCalls,
    recordCall,
    recordHostMetric,
    resetDiagnostics,
    setDiagnosticsPage,
    startManagedDiagnostics,
    subscribeDiagnostics,
    summarizeDiagnostics,
    type CallRecord,
} from "./diagnostics";
import type { HostMetric, ManagedSdk } from "./host";

const assumptions = { launchCredits: 0.1, creditPerCall: 0.1, throttleLimit: 10 };

function call(overrides: Partial<CallRecord> = {}): CallRecord {
    return { at: 0, page: "start", operation: "ExecuteDatasetQueriesJson", ok: true, status: 200, durationMs: 10, ...overrides };
}

function fakeSdk(overrides: Partial<ManagedSdk> = {}): ManagedSdk {
    return {
        dataSources: {},
        execute: vi.fn(),
        getUser: vi.fn(),
        getContext: vi.fn().mockResolvedValue({ appId: "app-1", environmentId: "env-1", sessionId: "session-1" }),
        onMetric: vi.fn(() => () => undefined),
        ...overrides,
    };
}

beforeEach(() => resetDiagnostics());

afterEach(() => {
    vi.useRealTimers();
    resetDiagnostics();
});

describe("recordCall", () => {
    it("counts calls, failures, probes and throttling, by page", () => {
        recordCall(call({ page: "adoption", durationMs: 100 }));
        recordCall(call({ page: "adoption", ok: false, status: 429, durationMs: 50, error: "Slow down" }));
        recordCall(call({ probe: true, durationMs: 30 }));

        expect(getDiagnostics().totals).toEqual({
            calls: 3,
            failed: 1,
            probes: 1,
            throttled: 1,
            durationMs: 180,
            byPage: { adoption: 2, start: 1 },
        });
        expect(getDiagnostics().calls.map((record) => record.page)).toEqual(["adoption", "adoption", "start"]);
    });

    it("keeps the latest 1,000 calls but counts every one", () => {
        for (let at = 0; at < 1_005; at++)
            recordCall(call({ at }));

        expect(getDiagnostics().calls).toHaveLength(1_000);
        expect(getDiagnostics().calls[0].at).toBe(5);
        expect(getDiagnostics().totals.calls).toBe(1_005);
    });
});

describe("setDiagnosticsPage", () => {
    it("tells subscribers only when the page changes", () => {
        const listener = vi.fn();
        const unsubscribe = subscribeDiagnostics(listener);

        setDiagnosticsPage("adoption");
        setDiagnosticsPage("adoption");
        setDiagnosticsPage("");
        expect(getDiagnostics().page).toBe("adoption");
        expect(listener).toHaveBeenCalledTimes(1);

        unsubscribe();
        setDiagnosticsPage("agents");
        expect(listener).toHaveBeenCalledTimes(1);
    });
});

describe("recordHostMetric", () => {
    it("keeps the latest metric of each type and counts them", () => {
        recordHostMetric({ type: "networkRequest", url: "a" });
        recordHostMetric({ type: "networkRequest", url: "b" });
        recordHostMetric({ type: "" });
        recordHostMetric(undefined as unknown as HostMetric);

        expect(getDiagnostics().metrics.networkRequest).toEqual({ latest: { type: "networkRequest", url: "b" }, count: 2 });
        expect(getDiagnostics().metrics.unknown.count).toBe(2);
    });
});

describe("startManagedDiagnostics", () => {
    it("streams host metrics and reads the app context, once", async () => {
        let send: ((metric: HostMetric) => void) | undefined;
        const stop = vi.fn();
        const sdk = fakeSdk({
            onMetric: vi.fn((listener: (metric: HostMetric) => void) => {
                send = listener;
                return stop;
            }),
        });

        startManagedDiagnostics(sdk);
        startManagedDiagnostics(sdk);
        expect(sdk.onMetric).toHaveBeenCalledTimes(1);
        expect(sdk.getContext).toHaveBeenCalledTimes(1);

        send?.({ type: "sessionLoadSummary", durationMs: 900 });
        expect(getDiagnostics().metrics.sessionLoadSummary.count).toBe(1);
        await vi.waitFor(() => expect(getDiagnostics().context).toEqual({ appId: "app-1", environmentId: "env-1", sessionId: "session-1" }));

        resetDiagnostics();
        expect(stop).toHaveBeenCalledTimes(1);
        expect(getDiagnostics().metrics).toEqual({});
    });

    it("says why the context didn't come", async () => {
        startManagedDiagnostics(fakeSdk({ getContext: vi.fn().mockRejectedValue(new Error("No host")) }));

        await vi.waitFor(() => expect(getDiagnostics().contextError).toBe("No host"));
    });

    it("stops waiting for the context after 8 seconds", async () => {
        vi.useFakeTimers();
        startManagedDiagnostics(fakeSdk({ getContext: () => new Promise<never>(() => undefined) }));

        await vi.advanceTimersByTimeAsync(8_000);
        await vi.waitFor(() => expect(getDiagnostics().contextError).toBe("The app host didn't answer within 8 seconds."));
    });
});

describe("summarizeDiagnostics", () => {
    const now = 1_000_000;

    it("adds up calls, the busiest minute and the credits a viewer without Premium would use", () => {
        recordCall(call({ at: now - 120_000 }));
        for (let i = 0; i < 8; i++)
            recordCall(call({ at: now - 50_000 + i * 1_000, page: i < 5 ? "adoption" : "agents", durationMs: 20 }));

        expect(summarizeDiagnostics(getDiagnostics(), assumptions, now)).toEqual({
            calls: 9,
            failed: 0,
            probes: 0,
            throttled: 0,
            averageMs: 19,
            lastMinute: 8,
            peakMinute: 8,
            nearLimit: true,
            credits: 1,
            byPage: [
                { page: "adoption", calls: 5 },
                { page: "agents", calls: 3 },
                { page: "start", calls: 1 },
            ],
        });
    });

    it("counts only the launch before any call", () => {
        const summary = summarizeDiagnostics(getDiagnostics(), assumptions, now);

        expect(summary).toMatchObject({ calls: 0, lastMinute: 0, peakMinute: 0, nearLimit: false, credits: 0.1, byPage: [] });
        expect(summary).not.toHaveProperty("averageMs");
    });

    it("leaves calls a minute old, or not yet made, out of the last minute", () => {
        recordCall(call({ at: now - 60_000 }));
        recordCall(call({ at: now - 59_999 }));
        recordCall(call({ at: now + 1 }));

        expect(summarizeDiagnostics(getDiagnostics(), assumptions, now).lastMinute).toBe(1);
    });

    it("warns below the limit only from 80% of it", () => {
        for (let i = 0; i < 7; i++)
            recordCall(call({ at: now - i }));

        expect(summarizeDiagnostics(getDiagnostics(), assumptions, now).nearLimit).toBe(false);
        recordCall(call({ at: now }));
        expect(summarizeDiagnostics(getDiagnostics(), assumptions, now).nearLimit).toBe(true);
    });

    it("lists pages with the same count by name", () => {
        recordCall(call({ page: "b" }));
        recordCall(call({ page: "a" }));

        expect(summarizeDiagnostics(getDiagnostics(), assumptions, now).byPage.map(({ page }) => page)).toEqual(["a", "b"]);
    });
});

describe("peakCalls", () => {
    it("finds the most calls that started within any 60 seconds", () => {
        expect(peakCalls([])).toBe(0);
        expect(peakCalls([0, 59_999, 60_000, 61_000])).toBe(3);
        expect(peakCalls([30_000, 0, 10_000])).toBe(3);
        expect(peakCalls([0, 60_000, 120_000])).toBe(1);
    });
});
