//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------
import { useEffect, useId, useLayoutEffect, useMemo, useState, type FocusEvent, type ReactNode } from "react";
import { Activity, Check, Copy, RefreshCw, UserCheck } from "lucide-react";
import { canUseBrowserStorage } from "@/lib/managed/browser-storage";
import {
    diagnosticsResults,
    setDiagnosticsPage,
    summarizeDiagnostics,
    THROTTLE_WARNING,
    useManagedDiagnostics,
    type ConnectorAttempt,
    type ConnectorState,
    type DiagnosticsState,
    type DiagnosticsSummary,
} from "@/lib/managed/diagnostics";
import { recheckConnector } from "@/lib/managed/managed-runtime-proxy";
import { runIdentityCheck } from "@/lib/managed/rls-check";
import { MANAGED_DIAGNOSTICS_DEFAULTS, runtimeConfig, type ManagedDiagnosticsConfig } from "@/lib/runtime-config";
import { cn } from "@/lib/utils";

const TEXT = "text-[length:var(--text-200)] leading-200";
// A plain string, not cn(): other builds can only drop module-level code they know is pure.
const BUTTON = `${TEXT} flex items-center justify-center gap-200 rounded-md border border-border px-300 py-100 transition-colors hover:bg-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-60`;
const TICK_MS = 5_000;

const OUTCOMES: Record<ConnectorAttempt["outcome"], string> = {
    ok: "worked",
    unreadable: "answered in a shape the app can't read",
    throttled: "was throttled",
    denied: "was denied",
    blocked: "was blocked by a data policy",
    rejected: "rejected the request",
    failed: "failed",
    unreachable: "couldn't be reached",
};

/**
 * What the Copilot Managed App measures: whether DAX runs through the Power BI
 * connector, who the model thinks the viewer is, what the session would cost
 * in Copilot Credits, and how close it came to the connector's throttle. Only
 * the managed build shows it.
 *
 * `page` names the page that later connector calls count against. It's set in
 * a layout effect, before the page's queries start in their effects.
 */
export function ManagedDiagnosticsPanel({ page }: { page?: string }) {
    const [open, setOpen] = useState(false);
    const panelId = useId();

    useLayoutEffect(() => {
        if (page)
            setDiagnosticsPage(page);
    }, [page]);

    return (
        <div className="flex flex-col gap-200">
            <button
                type="button"
                onClick={() => setOpen((value) => !value)}
                aria-expanded={open}
                aria-controls={panelId}
                className="flex items-center gap-300 rounded-md border border-border px-300 py-200 text-[length:var(--text-300)] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
                <Activity className="icon-size-200" aria-hidden="true" />
                Diagnostics
            </button>
            {open && <Diagnostics id={panelId} />}
        </div>
    );
}

function Diagnostics({ id }: { id: string }) {
    const diagnostics = useManagedDiagnostics();
    const tick = useTick(TICK_MS);
    // A call recorded since the last tick still counts as this minute's.
    const now = Math.max(tick, diagnostics.calls[diagnostics.calls.length - 1]?.at ?? 0);
    const assumptions = runtimeConfig().managed?.diagnostics ?? MANAGED_DIAGNOSTICS_DEFAULTS;
    const summary = summarizeDiagnostics(diagnostics, assumptions, now);

    return (
        <section
            id={id}
            aria-label="Copilot Managed App diagnostics"
            className={cn(TEXT, "flex flex-col gap-400 rounded-md border border-border p-300 text-left")}
        >
            <ConnectorGroup connector={diagnostics.connector} />
            <IdentityGroup diagnostics={diagnostics} />
            <UsageGroup summary={summary} assumptions={assumptions} />
            <HostGroup diagnostics={diagnostics} />
            <CopyResults diagnostics={diagnostics} assumptions={assumptions} now={now} />
        </section>
    );
}

function ConnectorGroup({ connector }: { connector: ConnectorState }) {
    const [rechecking, setRechecking] = useState(false);
    const checking = rechecking || connector.status === "checking";
    const recheck = async () => {
        setRechecking(true);
        try {
            await recheckConnector();
        } finally {
            setRechecking(false);
        }
    };

    return (
        <Group title="Power BI connector">
            <p aria-live="polite" className={connector.status === "failed" ? "text-destructive" : "text-muted-foreground"}>
                {connectorStatus(connector)}
            </p>
            {connector.attempts.length > 0 && (
                <ul aria-label="Operations tried" className="flex flex-col gap-100 pl-400 text-muted-foreground">
                    {connector.attempts.map((attempt, index) => (
                        <li key={index} className="[overflow-wrap:anywhere]">{attemptText(attempt)}</li>
                    ))}
                </ul>
            )}
            <button type="button" onClick={recheck} disabled={checking} className={BUTTON}>
                <RefreshCw className="icon-size-200" aria-hidden="true" />
                {checking ? "Checking…" : "Re-check connector"}
            </button>
        </Group>
    );
}

function IdentityGroup({ diagnostics }: { diagnostics: DiagnosticsState }) {
    const { viewer, viewerError, identity } = diagnostics;
    const running = identity?.status === "running";

    return (
        <Group title="Row-level security">
            <div aria-live="polite" className="flex flex-col gap-100">
                <dl className="flex flex-col gap-100">
                    <Row label="Signed in as">{viewer?.fullName || "Unknown"}</Row>
                    {identity?.status === "done" && <Row label="The model sees">{identity.upn ?? identity.user ?? "Blank"}</Row>}
                    {identity?.status === "done" && identity.user && identity.user !== identity.upn && (
                        <Row label="USERNAME()">{identity.user}</Row>
                    )}
                </dl>
                {viewerError && <p className="text-destructive">{viewerError}</p>}
                {identity?.status === "failed" && <p className="text-destructive">{identity.error}</p>}
            </div>
            <p className="text-muted-foreground">
                Each viewer should see their own sign-in here. If the model sees the app's owner or a service account,
                row-level security isn't applying per viewer. The check is one connector call.
            </p>
            <button type="button" onClick={() => void runIdentityCheck()} disabled={running} className={BUTTON}>
                <UserCheck className="icon-size-200" aria-hidden="true" />
                {running ? "Checking…" : identity ? "Check again" : "Check who the model sees"}
            </button>
        </Group>
    );
}

function UsageGroup({ summary, assumptions }: { summary: DiagnosticsSummary; assumptions: ManagedDiagnosticsConfig }) {
    return (
        <Group title="Cost and throttling">
            <dl className="flex flex-col gap-100">
                <Row label="Connector calls">{summary.calls}</Row>
                {summary.probes > 0 && <Row label="Connector checks">{summary.probes}</Row>}
                {summary.failed > 0 && <Row label="Failed calls">{summary.failed}</Row>}
                <Row label="Copilot Credits">{formatNumber(summary.credits)}</Row>
                <Row label="Calls in the last minute">{`${summary.lastMinute} of ${assumptions.throttleLimit}`}</Row>
                <Row label="Busiest minute">{summary.peakMinute}</Row>
                {summary.throttled > 0 && <Row label="Throttled calls">{summary.throttled}</Row>}
                {summary.averageMs !== undefined && <Row label="Average call">{`${formatNumber(summary.averageMs)} ms`}</Row>}
            </dl>
            {summary.nearLimit && (
                <p className="text-destructive">
                    The busiest minute reached {Math.round(THROTTLE_WARNING * 100)}% of the connector's limit of{" "}
                    {assumptions.throttleLimit} calls a minute.
                </p>
            )}
            <p className="text-muted-foreground">
                Credits are an estimate for a viewer without Power Apps Premium: {formatNumber(assumptions.launchCredits)} to
                open the app and {formatNumber(assumptions.creditPerCall)} a call. Viewers with Premium aren't charged.
            </p>
            {summary.byPage.length > 0 && (
                <dl aria-label="Calls by page" className="flex flex-col gap-100">
                    {summary.byPage.map(({ page, calls }) => (
                        <Row key={page} label={page}>{calls}</Row>
                    ))}
                </dl>
            )}
        </Group>
    );
}

function HostGroup({ diagnostics }: { diagnostics: DiagnosticsState }) {
    const { context, contextError, metrics } = diagnostics;
    const storage = useMemo(() => canUseBrowserStorage(), []);

    return (
        <Group title="Host">
            <dl className="flex flex-col gap-100">
                {context && <Row label="App">{context.appId}</Row>}
                {context && <Row label="Environment">{context.environmentId}</Row>}
                {context && <Row label="Session">{context.sessionId}</Row>}
                <Row label="Settings">{storage ? "Saved in this browser" : "Kept until the app closes"}</Row>
                {Object.entries(metrics).map(([type, { count }]) => (
                    <Row key={type} label={`${type} metrics`}>{count}</Row>
                ))}
            </dl>
            {contextError && <p className="text-destructive">{contextError}</p>}
        </Group>
    );
}

function CopyResults({ diagnostics, assumptions, now }: {
    diagnostics: DiagnosticsState;
    assumptions: ManagedDiagnosticsConfig;
    now: number;
}) {
    const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
    const report = () => JSON.stringify(diagnosticsResults(diagnostics, assumptions, canUseBrowserStorage(), now), null, 2);
    const copy = async () => {
        try {
            await navigator.clipboard.writeText(report());
            setState("copied");
        } catch {
            setState("failed");
        }
    };

    return (
        <div className="flex flex-col gap-100">
            <button type="button" onClick={copy} className={BUTTON}>
                {state === "copied" ? <Check className="icon-size-200" aria-hidden="true" /> : <Copy className="icon-size-200" aria-hidden="true" />}
                {state === "copied" ? "Results copied" : "Copy results"}
            </button>
            {state === "failed" && (
                <textarea
                    readOnly
                    rows={6}
                    value={report()}
                    aria-label="Diagnostics results"
                    onFocus={(event: FocusEvent<HTMLTextAreaElement>) => event.currentTarget.select()}
                    className={cn(TEXT, "w-full rounded-md border border-border bg-background px-200 py-100 font-mono")}
                />
            )}
        </div>
    );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
    return (
        <div className="flex flex-col gap-200">
            <h3 className="font-semibold text-foreground">{title}</h3>
            {children}
        </div>
    );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="flex flex-wrap justify-between gap-x-200">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="text-right font-medium text-foreground [overflow-wrap:anywhere]">{children}</dd>
        </div>
    );
}

function connectorStatus(connector: ConnectorState): string {
    switch (connector.status) {
        case "ready":
            return connector.candidate
                ? `DAX runs through ${connector.candidate.operation} on ${connector.candidate.dataSource}.`
                : "DAX runs through the connector.";
        case "checking":
            return "Finding the operation that runs DAX…";
        case "failed":
            return connector.error ?? "No operation ran DAX.";
        default:
            return "Not checked yet. The first query checks it.";
    }
}

function attemptText({ candidate, outcome, status, message }: ConnectorAttempt): string {
    const code = status ? ` (${status})` : "";
    const detail = outcome !== "ok" && message ? `: ${message}` : "";
    return `${candidate.operation} with a ${candidate.shape} body ${OUTCOMES[outcome]}${code}${detail}`;
}

function formatNumber(value: number): string {
    return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function useTick(intervalMs: number): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), intervalMs);
        return () => clearInterval(timer);
    }, [intervalMs]);
    return now;
}
