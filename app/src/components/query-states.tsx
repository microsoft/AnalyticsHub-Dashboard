//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import {
    createContext,
    useContext,
    useId,
    useLayoutEffect,
    useMemo,
    useSyncExternalStore,
    type ReactNode,
} from "react";
import { cn } from "@/lib/utils";
import { isMissingFromModelError, isModelNotRefreshedError, parseMissingModelObject } from "@/lib/model-errors";
import { BUSY_MESSAGE, isBusyMessage } from "@/lib/query-scheduler";

interface QueryStateProps {
    className?: string;
}

/** Placeholder shown while a query is in flight. */
export function QueryLoading({ className }: QueryStateProps) {
    return (
        <div
            role="status"
            aria-live="polite"
            data-query-loading=""
            className={cn("flex min-h-[160px] flex-col justify-end gap-300 rounded-xl border border-border bg-card p-500", className)}
        >
            <span className="sr-only">Loading</span>
            <div className="h-200 w-1/3 animate-pulse rounded-sm bg-muted" aria-hidden="true" />
            <div className="h-600 w-2/3 animate-pulse rounded-sm bg-muted" aria-hidden="true" />
            <div className="h-100 w-full animate-pulse rounded-sm bg-muted" aria-hidden="true" />
        </div>
    );
}

interface QueryEmptyProps extends QueryStateProps {
    title: string;
    /** Why there is nothing to show, and what would make data appear. */
    description: ReactNode;
}

const EMPTY_TEXT = "max-w-[60ch] text-[length:var(--text-300)] leading-300 text-muted-foreground";

/** Shown when a query succeeds but the tenant has no data for it. */
export function QueryEmpty({ title, description, className }: QueryEmptyProps) {
    return (
        <div
            className={cn(
                "flex min-h-[160px] flex-col justify-center gap-200 rounded-xl border border-dashed border-border bg-card p-500",
                className,
            )}
        >
            <span className="text-[length:var(--text-400)] leading-400 font-semibold text-foreground">{title}</span>
            {typeof description === "string" ? (
                <p className={EMPTY_TEXT}>{description}</p>
            ) : (
                <div className={cn(EMPTY_TEXT, "flex flex-col gap-200")}>{description}</div>
            )}
        </div>
    );
}

interface QueryErrorProps extends QueryStateProps {
    /** The message returned by the semantic model. */
    message: string;
    onRetry?: () => void;
}

/**
 * Every error card mounted in one view, so that when several parts of a page
 * fail for the same reason the first says so in full and the rest say only
 * that they didn't load either.
 */
class ErrorRegister {
    private readonly owners = new Map<string, string[]>();
    private readonly listeners = new Set<() => void>();

    add(reason: string, id: string) {
        this.owners.set(reason, [...(this.owners.get(reason) ?? []), id]);
        this.notify();
    }

    remove(reason: string, id: string) {
        const left = (this.owners.get(reason) ?? []).filter((owner) => owner !== id);
        if (left.length > 0) this.owners.set(reason, left);
        else this.owners.delete(reason);
        this.notify();
    }

    isFirst(reason: string, id: string) {
        const owners = this.owners.get(reason);
        return !owners || owners[0] === id;
    }

    subscribe = (listener: () => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    private notify() {
        this.listeners.forEach((listener) => listener());
    }
}

const ErrorRegisterContext = createContext<ErrorRegister | undefined>(undefined);

/** Groups the error cards of one view; see `ErrorRegister`. Remount it (with a `key`) for each view. */
export function ErrorGroup({ children }: { children: ReactNode }) {
    const register = useMemo(() => new ErrorRegister(), []);
    return <ErrorRegisterContext.Provider value={register}>{children}</ErrorRegisterContext.Provider>;
}

/** Whether this card is the first in its view to fail for `reason`; true outside an `ErrorGroup`. */
function useFirstForReason(reason: string): boolean {
    const register = useContext(ErrorRegisterContext);
    const id = useId();
    useLayoutEffect(() => {
        if (!register) return;
        register.add(reason, id);
        return () => register.remove(reason, id);
    }, [register, reason, id]);
    return useSyncExternalStore(
        register?.subscribe ?? noSubscribe,
        () => register?.isFirst(reason, id) ?? true,
        () => true,
    );
}

const noSubscribe = () => () => {};

const RETRY_BUTTON =
    "self-start rounded-md border border-border px-300 py-200-nudge text-[length:var(--text-300)] font-semibold text-foreground transition-colors hover:bg-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
const DISCLOSURE = "text-[length:var(--text-200)] leading-300 text-muted-foreground";
const SUMMARY =
    "cursor-pointer rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/** Setup or repair steps only an admin can take, closed by default so everyone else reads past them. */
export function AdminSteps({ children }: { children: ReactNode }) {
    return (
        <details className={DISCLOSURE}>
            <summary className={SUMMARY}>For your admin</summary>
            <div className="mt-200 flex max-w-[68ch] flex-col gap-200 text-[length:var(--text-300)] leading-300">
                {children}
            </div>
        </details>
    );
}

interface ErrorCardProps extends QueryStateProps {
    /** Cards failing for the same reason in one view collapse to one. */
    reason: string;
    title: string;
    /** One plain sentence for whoever is reading the page. */
    summary: string;
    tone: "caution" | "destructive";
    /** Steps only an admin can take, kept out of the way of everyone else. */
    admin?: ReactNode;
    /** The raw error, for whoever reports it. */
    detail?: string;
    onRetry?: () => void;
}

function ErrorCard({ reason, title, summary, tone, admin, detail, onRetry, className }: ErrorCardProps) {
    const first = useFirstForReason(reason);
    if (!first) {
        return (
            <div
                className={cn(
                    "flex flex-wrap items-center justify-between gap-300 rounded-xl border border-dashed border-border bg-card px-500 py-400",
                    className,
                )}
            >
                <span className="text-[length:var(--text-300)] leading-300 text-muted-foreground">
                    This didn't load either, for the same reason.
                </span>
                {onRetry && (
                    <button type="button" onClick={onRetry} className={RETRY_BUTTON}>
                        Try again
                    </button>
                )}
            </div>
        );
    }
    return (
        <div
            role="alert"
            className={cn(
                "flex min-h-[160px] flex-col justify-center gap-300 rounded-xl border bg-card p-500",
                tone === "caution" ? "border-caution/50" : "border-destructive/40",
                className,
            )}
        >
            <span
                className={cn(
                    "text-[length:var(--text-400)] leading-400 font-semibold",
                    tone === "caution" ? "text-foreground" : "text-destructive",
                )}
            >
                {title}
            </span>
            <p className="max-w-[60ch] text-[length:var(--text-300)] leading-300 text-muted-foreground">{summary}</p>
            {admin && <AdminSteps>{admin}</AdminSteps>}
            {detail && (
                <details className={DISCLOSURE}>
                    <summary className={SUMMARY}>Details</summary>
                    <p className="mt-200 max-w-[68ch] font-monospace break-words">{detail}</p>
                </details>
            )}
            {onRetry && (
                <button type="button" onClick={onRetry} className={RETRY_BUTTON}>
                    Try again
                </button>
            )}
        </div>
    );
}

interface ModelUpdateRequiredProps extends QueryStateProps {
    /** Missing columns, tables or measures the app needs. */
    missing: readonly string[];
    /** The raw engine error, when this came from a failed page query. */
    detail?: string;
    onRetry?: () => void;
}

function missingFromMessage(message: string): string[] {
    const missing = parseMissingModelObject(message);
    if (missing?.kind === "column") return [`${missing.table ? `${missing.table}` : "Model"}[${missing.name}]`];
    if (missing?.kind === "table") return [`${missing.name} table`];
    if (missing?.kind === "measure") return [`[${missing.name}]`];
    return [];
}

/** Shown when this app is newer than the semantic model it is reading. */
export function ModelUpdateRequired({ missing, detail, onRetry, className }: ModelUpdateRequiredProps) {
    return (
        <ErrorCard
            reason="model-update"
            tone="caution"
            title="Needs an update"
            summary="This part of the app needs a newer version of the data model. Ask your admin to update it."
            admin={
                <>
                    <p>
                        The semantic model is older than this app. Run{" "}
                        <code className="font-mono">AnalyticsHubInstaller.exe update</code> (or{" "}
                        <code className="font-mono">npx valuelens-install update</code>
                        ), then run the loads or refresh again and reopen the app.
                    </p>
                    {missing.length > 0 && <p>Missing from the model: {missing.join(", ")}</p>}
                </>
            }
            detail={detail}
            onRetry={onRetry}
            className={className}
        />
    );
}

/** Shown when the semantic model has never been refreshed, so it holds no data yet. */
export function ModelNotLoaded({ detail, onRetry, className }: { detail?: string; onRetry?: () => void; className?: string }) {
    return (
        <ErrorCard
            reason="model-not-loaded"
            tone="caution"
            title="Data not loaded yet"
            summary="Your data hasn't arrived yet. If it's the first load, check back once it finishes."
            admin={
                <p>
                    The semantic model hasn't been refreshed. If the first load has finished, run{" "}
                    <code className="font-mono">AnalyticsHubInstaller.exe</code> and choose Repair or change, or refresh
                    the model in Fabric, then reopen the app.
                </p>
            }
            detail={detail}
            onRetry={onRetry}
            className={className}
        />
    );
}

/** Shown when Power BI kept throttling a query: nothing is broken, it needs a minute. */
export function PowerBiBusy({ detail, onRetry, className }: { detail?: string; onRetry?: () => void; className?: string }) {
    return (
        <ErrorCard
            reason="busy"
            tone="caution"
            title="Power BI is busy"
            summary="Too many queries reached Power BI at once. Nothing is broken: wait a minute, then try again."
            detail={detail && detail !== BUSY_MESSAGE ? detail : undefined}
            onRetry={onRetry}
            className={className}
        />
    );
}

/** Shown when the semantic model rejects the query or is unreachable. */
export function QueryError({ message, onRetry, className }: QueryErrorProps) {
    if (isBusyMessage(message)) {
        return <PowerBiBusy className={className} detail={message} onRetry={onRetry} />;
    }
    if (isModelNotRefreshedError(message)) {
        return <ModelNotLoaded className={className} detail={message} onRetry={onRetry} />;
    }
    if (isMissingFromModelError(message)) {
        return <ModelUpdateRequired className={className} missing={missingFromMessage(message)} detail={message} onRetry={onRetry} />;
    }

    return (
        <ErrorCard
            reason={`error:${message}`}
            tone="destructive"
            title="This didn't load"
            summary="Something went wrong reading the data. Try again; if it keeps failing, share the details with your admin."
            detail={message}
            onRetry={onRetry}
            className={className}
        />
    );
}
