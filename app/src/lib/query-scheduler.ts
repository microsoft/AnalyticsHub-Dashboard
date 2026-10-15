//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------
import { FabricApiProxyError, type IFabricApiProxy } from "@microsoft/fabric-app-data";

/**
 * What a card says when Power BI keeps throttling a query after every retry.
 * It names the cause and the fix, rather than a connection that is fine.
 */
export const BUSY_MESSAGE = "Power BI is busy: too many queries reached it at once. Wait a minute, then try again.";

const WINDOW_MS = 60_000;

export interface QuerySchedulerOptions {
    /** Queries in flight at once. */
    concurrency?: number;
    /** Queries started in any 60 seconds, held under Power BI's 120 per user. */
    perMinute?: number;
    /** Retries for a throttled query before it gives up. */
    maxRetries?: number;
    /** The first backoff, doubled for each retry when Power BI sends no Retry-After. */
    baseDelayMs?: number;
    /** The longest Retry-After worth waiting for; longer gives up at once. */
    maxRetryAfterMs?: number;
    now?: () => number;
    random?: () => number;
}

interface Throttle {
    status: number;
    retryAfterMs: number | undefined;
}

/** A Retry-After header or field as milliseconds: seconds, or an HTTP date. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
    if (!value) return undefined;
    const trimmed = value.trim();
    if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
    const date = Date.parse(trimmed);
    return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

const RETRY_AFTER_TEXT = /retry[-_\s]?after["'\s:=]*(\d+(?:\.\d+)?)/i;
const THROTTLE_TEXT = /too many requests|rate[-\s]?limit|throttl/i;

function retryAfterOf(error: unknown): number | undefined {
    const carried = (error as { retryAfterMs?: unknown }).retryAfterMs;
    if (typeof carried === "number" && Number.isFinite(carried)) return Math.max(0, carried);
    const text = `${(error as { body?: unknown }).body ?? ""} ${error instanceof Error ? error.message : ""}`;
    const match = RETRY_AFTER_TEXT.exec(text);
    return match ? Math.round(Number(match[1]) * 1000) : undefined;
}

/** Whether a proxy error is Power BI or the capacity asking the app to slow down. */
export function throttleOf(error: unknown): Throttle | undefined {
    if (error instanceof FabricApiProxyError) {
        if (error.status === 429 || error.status === 503) return { status: error.status, retryAfterMs: retryAfterOf(error) };
        return undefined;
    }
    if (!(error instanceof Error)) return undefined;
    const cause = (error as { cause?: { code?: unknown } }).cause;
    if (cause?.code === "RATE_LIMITED" || THROTTLE_TEXT.test(error.message)) return { status: 429, retryAfterMs: retryAfterOf(error) };
    return undefined;
}

/** Whether a card's error is throttling rather than a broken connection or query. */
export function isBusyMessage(message: string | undefined): boolean {
    if (!message) return false;
    return message.includes("Power BI is busy") || THROTTLE_TEXT.test(message);
}

function busyError(error: unknown, throttle: Throttle): FabricApiProxyError {
    const source = error as { requestId?: string; sessionId?: string; body?: string };
    return new FabricApiProxyError({
        status: throttle.status,
        requestId: source.requestId ?? "",
        sessionId: source.sessionId ?? "",
        body: source.body ?? "",
        message: BUSY_MESSAGE,
    });
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Paces the app's semantic model queries so a page load can't trip Power
 * BI's per-user limit or swamp a busy capacity: a few in flight at once,
 * under 90 a minute, and identical queries in flight share one request. A
 * throttled query waits — as long as Retry-After asks, else an exponential
 * backoff with jitter — and every other query waits with it, so the app
 * stops sending while Power BI is catching up.
 */
export class QueryScheduler {
    private readonly concurrency: number;
    private readonly perMinute: number;
    private readonly maxRetries: number;
    private readonly baseDelayMs: number;
    private readonly maxRetryAfterMs: number;
    private readonly now: () => number;
    private readonly random: () => number;

    private active = 0;
    private readonly waiting: Array<() => void> = [];
    private readonly starts: number[] = [];
    private pausedUntil = 0;
    private readonly inFlight = new Map<string, Promise<unknown>>();

    constructor(options: QuerySchedulerOptions = {}) {
        this.concurrency = options.concurrency ?? 4;
        this.perMinute = options.perMinute ?? 90;
        this.maxRetries = options.maxRetries ?? 3;
        this.baseDelayMs = options.baseDelayMs ?? 1000;
        this.maxRetryAfterMs = options.maxRetryAfterMs ?? 60_000;
        this.now = options.now ?? Date.now;
        this.random = options.random ?? Math.random;
    }

    /** Runs `task`, or joins the identical one already in flight under `key`. */
    run<T>(key: string, task: () => Promise<T>): Promise<T> {
        const existing = this.inFlight.get(key);
        if (existing) return existing as Promise<T>;
        const promise = this.attempt(task).finally(() => this.inFlight.delete(key));
        this.inFlight.set(key, promise);
        return promise;
    }

    private async attempt<T>(task: () => Promise<T>): Promise<T> {
        for (let retry = 0; ; retry++) {
            await this.acquire();
            let failure: unknown;
            try {
                return await task();
            } catch (error) {
                failure = error;
            } finally {
                this.release();
            }
            const throttle = throttleOf(failure);
            if (!throttle) throw failure;
            if (retry >= this.maxRetries || (throttle.retryAfterMs ?? 0) > this.maxRetryAfterMs)
                throw busyError(failure, throttle);
            this.pausedUntil = Math.max(this.pausedUntil, this.now() + this.delay(retry, throttle.retryAfterMs));
        }
    }

    private delay(retry: number, retryAfterMs: number | undefined): number {
        if (retryAfterMs !== undefined) return retryAfterMs + Math.round(this.random() * 250);
        const backoff = this.baseDelayMs * 2 ** retry;
        return Math.round(backoff / 2 + this.random() * (backoff / 2));
    }

    private async acquire(): Promise<void> {
        if (this.active < this.concurrency) this.active++;
        else await new Promise<void>((resolve) => this.waiting.push(resolve));
        await this.takeStart();
    }

    /** Hands the slot straight to the next query in line, so it can't be taken past it. */
    private release(): void {
        const next = this.waiting.shift();
        if (next) next();
        else this.active--;
    }

    private async takeStart(): Promise<void> {
        for (;;) {
            const now = this.now();
            if (now < this.pausedUntil) {
                await sleep(this.pausedUntil - now);
                continue;
            }
            while (this.starts.length > 0 && now - this.starts[0] >= WINDOW_MS) this.starts.shift();
            if (this.starts.length < this.perMinute) {
                this.starts.push(now);
                return;
            }
            await sleep(this.starts[0] + WINDOW_MS - now);
        }
    }
}

/**
 * The SDK's proxy with every DAX request paced by `scheduler`. It sits under
 * the SDK's result cache, so a cached answer costs nothing against the limit.
 */
export function scheduledProxy(inner: IFabricApiProxy, scheduler = new QueryScheduler()): IFabricApiProxy {
    return {
        semanticModel: {
            executeDax: (workspaceId, itemId, query, options) =>
                scheduler.run(["arrow", workspaceId, itemId, query, JSON.stringify(options ?? {})].join("\0"), () =>
                    inner.semanticModel.executeDax(workspaceId, itemId, query, options),
                ),
            executeDaxJson: (workspaceId, itemId, query) =>
                scheduler.run(["json", workspaceId, itemId, query].join("\0"), () =>
                    inner.semanticModel.executeDaxJson(workspaceId, itemId, query),
                ),
        },
        lakehouse: inner.lakehouse,
        warehouse: inner.warehouse,
    };
}
