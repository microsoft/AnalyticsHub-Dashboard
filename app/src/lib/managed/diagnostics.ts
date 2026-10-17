//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useSyncExternalStore } from "react";
import type { ManagedDiagnosticsConfig } from "@/lib/runtime-config";
import type { CallOutcome, ConnectorCandidate } from "./connector-operations";
import { HOST_TIMEOUT_MS, withHostTimeout, type HostMetric, type ManagedContext, type ManagedSdk, type ManagedUser } from "./host";

/** One Power BI connector call. */
export interface CallRecord {
    /** When it started, in epoch milliseconds. */
    at: number;
    /** The page showing when it started. */
    page: string;
    operation: string;
    ok: boolean;
    status?: number;
    durationMs: number;
    error?: string;
    /** Made while finding the operation that works, not for a page. */
    probe?: boolean;
}

export interface ConnectorAttempt {
    candidate: ConnectorCandidate;
    outcome: CallOutcome["kind"];
    status?: number;
    message?: string;
}

export interface ConnectorState {
    status: "unknown" | "checking" | "ready" | "failed";
    /** The data source, operation and body shape that work. */
    candidate?: ConnectorCandidate;
    attempts: readonly ConnectorAttempt[];
    error?: string;
}

/** Who the semantic model thinks the viewer is. */
export interface IdentityCheck {
    status: "running" | "done" | "failed";
    model?: string;
    /** `USERPRINCIPALNAME()`. */
    upn?: string;
    /** `USERNAME()`. */
    user?: string;
    error?: string;
    checkedAt: number;
}

export interface CallTotals {
    calls: number;
    failed: number;
    probes: number;
    throttled: number;
    durationMs: number;
    byPage: Readonly<Record<string, number>>;
}

export interface DiagnosticsState {
    page: string;
    /** The latest calls, oldest first. */
    calls: readonly CallRecord[];
    totals: CallTotals;
    connector: ConnectorState;
    viewer?: ManagedUser;
    viewerError?: string;
    context?: ManagedContext;
    contextError?: string;
    /** The latest host metric of each type, and how many have arrived. */
    metrics: Readonly<Record<string, { latest: HostMetric; count: number }>>;
    identity?: IdentityCheck;
}

export interface DiagnosticsSummary {
    calls: number;
    failed: number;
    probes: number;
    throttled: number;
    averageMs?: number;
    /** Calls that started in the last 60 seconds. */
    lastMinute: number;
    /** The most calls that started within any 60 seconds. */
    peakMinute: number;
    /** Whether the peak reached 80% of the throttle limit. */
    nearLimit: boolean;
    /** Copilot Credits for a viewer without Power Apps Premium: the launch and every call. */
    credits: number;
    byPage: ReadonlyArray<{ page: string; calls: number }>;
}

/** The share of the throttle limit that earns a warning. */
export const THROTTLE_WARNING = 0.8;

const CALL_HISTORY = 1_000;
const MINUTE_MS = 60_000;

const INITIAL: DiagnosticsState = {
    page: "start",
    calls: [],
    totals: { calls: 0, failed: 0, probes: 0, throttled: 0, durationMs: 0, byPage: {} },
    connector: { status: "unknown", attempts: [] },
    metrics: {},
};

let state = INITIAL;
let started = false;
let stopMetrics: (() => void) | undefined;
const listeners = new Set<() => void>();

export function getDiagnostics(): DiagnosticsState {
    return state;
}

export function subscribeDiagnostics(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/** What the Diagnostics panel measures on the Copilot Managed Runtime, kept for the session. */
export function useManagedDiagnostics(): DiagnosticsState {
    return useSyncExternalStore(subscribeDiagnostics, getDiagnostics, getDiagnostics);
}

/** Streams host metrics and reads the app context, once a session. */
export function startManagedDiagnostics(sdk: ManagedSdk): void {
    if (started)
        return;
    started = true;
    stopMetrics = sdk.onMetric(recordHostMetric);
    withHostTimeout(sdk.getContext(), HOST_TIMEOUT_MS, "The app host")
        .then((context) => update({ context, contextError: undefined }))
        .catch((error: unknown) => update({ contextError: errorMessage(error) }));
}

/** Names the page that later calls count against. */
export function setDiagnosticsPage(page: string): void {
    if (page && page !== state.page)
        update({ page });
}

export function recordCall(call: CallRecord): void {
    const { totals } = state;
    update({
        calls: [...state.calls, call].slice(-CALL_HISTORY),
        totals: {
            calls: totals.calls + 1,
            failed: totals.failed + (call.ok ? 0 : 1),
            probes: totals.probes + (call.probe ? 1 : 0),
            throttled: totals.throttled + (call.status === 429 ? 1 : 0),
            durationMs: totals.durationMs + call.durationMs,
            byPage: { ...totals.byPage, [call.page]: (totals.byPage[call.page] ?? 0) + 1 },
        },
    });
}

export function recordHostMetric(metric: HostMetric): void {
    const type = typeof metric?.type === "string" && metric.type ? metric.type : "unknown";
    update({ metrics: { ...state.metrics, [type]: { latest: metric, count: (state.metrics[type]?.count ?? 0) + 1 } } });
}

export function setConnectorState(connector: ConnectorState): void {
    update({ connector });
}

export function setViewer(viewer: ManagedUser | undefined, error?: string): void {
    update({ viewer, viewerError: error });
}

export function setIdentityCheck(identity: IdentityCheck): void {
    update({ identity });
}

/** Clears every measurement and stops the metric stream. For tests. */
export function resetDiagnostics(): void {
    stopMetrics?.();
    stopMetrics = undefined;
    started = false;
    state = INITIAL;
    notify();
}

/** What the measurements add up to, under the configured cost and throttle assumptions. */
export function summarizeDiagnostics(
    diagnostics: DiagnosticsState,
    assumptions: ManagedDiagnosticsConfig,
    now = Date.now(),
): DiagnosticsSummary {
    const { totals } = diagnostics;
    const starts = diagnostics.calls.map((call) => call.at);
    const lastMinute = starts.filter((at) => at > now - MINUTE_MS && at <= now).length;
    const peakMinute = Math.max(lastMinute, peakCalls(starts));
    return {
        calls: totals.calls,
        failed: totals.failed,
        probes: totals.probes,
        throttled: totals.throttled,
        ...(totals.calls ? { averageMs: Math.round(totals.durationMs / totals.calls) } : {}),
        lastMinute,
        peakMinute,
        nearLimit: peakMinute >= assumptions.throttleLimit * THROTTLE_WARNING,
        credits: Math.round((assumptions.launchCredits + assumptions.creditPerCall * totals.calls) * 10_000) / 10_000,
        byPage: Object.entries(totals.byPage)
            .map(([page, calls]) => ({ page, calls }))
            .sort((a, b) => b.calls - a.calls || a.page.localeCompare(b.page)),
    };
}

/** The most start times that fall within any 60 seconds. */
export function peakCalls(starts: readonly number[]): number {
    const sorted = [...starts].sort((a, b) => a - b);
    let peak = 0;
    let first = 0;
    for (let last = 0; last < sorted.length; last++) {
        while (sorted[last] - sorted[first] >= MINUTE_MS)
            first++;
        peak = Math.max(peak, last - first + 1);
    }
    return peak;
}

export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function update(change: Partial<DiagnosticsState>): void {
    state = { ...state, ...change };
    notify();
}

function notify(): void {
    for (const listener of listeners)
        listener();
}
