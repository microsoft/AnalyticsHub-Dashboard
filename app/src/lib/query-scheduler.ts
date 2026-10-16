//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------
import { FabricApiProxyError, type IFabricApiProxy } from "@microsoft/fabric-app-data";
import { currentPriority, type QueryPriority } from "@/lib/query-priority";

/**
 * What a card says when Power BI keeps throttling a query after every retry.
 * It names the cause and the fix, rather than a connection that is fine.
 */
export const BUSY_MESSAGE = "Power BI is busy: too many queries reached it at once. Wait a minute, then try again.";

const WINDOW_MS = 60_000;

export interface QuerySchedulerOptions {
    /** Queries in flight at once. */
    concurrency?: number;
    /**
     * Background queries in flight at once, on top of `concurrency` so what is
     * on screen keeps every slot; they start only while nothing on screen is
     * running or waiting.
     */
    lowConcurrency?: number;
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

/** Queries in flight or queued, by lane, and how many have finished since the app opened. */
export interface SchedulerActivity {
    foreground: number;
    background: number;
    finished: number;
}

type Admit = (lane: QueryPriority) => void;

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

/**
 * Paces the app's semantic model queries so a page load can't trip Power
 * BI's per-user limit or swamp a busy capacity: a few in flight at once,
 * under 90 a minute, and identical queries in flight share one request. A
 * throttled query waits — as long as Retry-After asks, else an exponential
 * backoff with jitter — and every other query waits with it, so the app
 * stops sending while Power BI is catching up.
 *
 * Background queries — pages fetched ahead of a visit — run in a lane of
 * their own: one at a time in a slot of its own, only while nothing on
 * screen is running or waiting, and on half the per-minute budget. Asking
 * for one in the foreground moves it to the front lane, even while it waits
 * for budget. One that waited checks again that the screen is quiet before
 * it starts, and if not, gives its slot back and queues again.
 */
export class QueryScheduler {
    private readonly concurrency: number;
    private readonly lowConcurrency: number;
    private readonly perMinute: number;
    private readonly maxRetries: number;
    private readonly baseDelayMs: number;
    private readonly maxRetryAfterMs: number;
    private readonly now: () => number;
    private readonly random: () => number;

    private active = 0;
    private lowActive = 0;
    private readonly waiting: Admit[] = [];
    private readonly lowWaiting: Array<{ key: string; admit: Admit }> = [];
    private readonly lanes = new Map<string, QueryPriority>();
    private readonly listeners = new Set<() => void>();
    private finished = 0;
    private readonly starts: number[] = [];
    private pausedUntil = 0;
    private readonly inFlight = new Map<string, Promise<unknown>>();
    private readonly naps = new Map<string, () => void>();

    constructor(options: QuerySchedulerOptions = {}) {
        this.concurrency = options.concurrency ?? 4;
        this.lowConcurrency = options.lowConcurrency ?? 1;
        this.perMinute = options.perMinute ?? 90;
        this.maxRetries = options.maxRetries ?? 3;
        this.baseDelayMs = options.baseDelayMs ?? 1000;
        this.maxRetryAfterMs = options.maxRetryAfterMs ?? 60_000;
        this.now = options.now ?? Date.now;
        this.random = options.random ?? Math.random;
    }

    /** Runs `task`, or joins the identical one already in flight under `key`. */
    run<T>(key: string, task: () => Promise<T>, priority: QueryPriority = "normal"): Promise<T> {
        const existing = this.inFlight.get(key);
        if (existing) {
            if (priority === "normal") this.promote(key);
            return existing as Promise<T>;
        }
        this.lanes.set(key, priority);
        const promise = this.attempt(key, task).finally(() => {
            this.inFlight.delete(key);
            this.lanes.delete(key);
            this.finished++;
            this.notify();
        });
        this.inFlight.set(key, promise);
        this.notify();
        return promise;
    }

    /** Queries in flight or queued in each lane. */
    activity(): SchedulerActivity {
        let background = 0;
        for (const lane of this.lanes.values()) if (lane === "low") background++;
        return { foreground: this.lanes.size - background, background, finished: this.finished };
    }

    /** Calls `listener` whenever a query starts, finishes or changes lane. */
    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private notify(): void {
        for (const listener of this.listeners) listener();
    }

    /** Someone is now looking at what a background query fetches, so it joins the front lane. */
    private promote(key: string): void {
        if (this.lanes.get(key) !== "low") return;
        this.lanes.set(key, "normal");
        const index = this.lowWaiting.findIndex((entry) => entry.key === key);
        if (index >= 0) {
            const [entry] = this.lowWaiting.splice(index, 1);
            if (this.waiting.length === 0 && this.active < this.concurrency) {
                this.active++;
                entry.admit("normal");
            } else this.waiting.push(entry.admit);
        }
        this.naps.get(key)?.();
        this.notify();
    }

    private async attempt<T>(key: string, task: () => Promise<T>): Promise<T> {
        for (let retry = 0; ; retry++) {
            const lane = await this.acquire(key);
            let failure: unknown;
            try {
                return await task();
            } catch (error) {
                failure = error;
            } finally {
                this.release(lane);
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

    private async acquire(key: string): Promise<QueryPriority> {
        for (let again = false; ; again = true) {
            const lane = await (this.lanes.get(key) === "low" ? this.admitLow(key, again) : this.admitNormal());
            if (await this.takeStart(key, lane)) return lane;
            // Asked for on screen, or the screen got busy while it waited: give the background slot back.
            this.lowActive--;
        }
    }

    private admitNormal(): Promise<QueryPriority> {
        if (this.active < this.concurrency) {
            this.active++;
            return Promise.resolve("normal");
        }
        return new Promise((resolve) => this.waiting.push(resolve));
    }

    private admitLow(key: string, front = false): Promise<QueryPriority> {
        if (this.lowCanStart()) {
            this.lowActive++;
            return Promise.resolve("low");
        }
        return new Promise((resolve) => {
            if (front) this.lowWaiting.unshift({ key, admit: resolve });
            else this.lowWaiting.push({ key, admit: resolve });
        });
    }

    /** Background work starts only when nothing on screen is running or waiting. */
    private lowCanStart(): boolean {
        return this.active === 0 && this.waiting.length === 0 && this.lowActive < this.lowConcurrency;
    }

    /** Hands the slot straight to the next query in line, so it can't be taken past it. */
    private release(lane: QueryPriority): void {
        if (lane === "low") this.lowActive--;
        else this.active--;
        while (this.waiting.length > 0 && this.active < this.concurrency) {
            this.active++;
            this.waiting.shift()!("normal");
        }
        while (this.lowWaiting.length > 0 && this.lowCanStart()) {
            this.lowActive++;
            this.lowWaiting.shift()!.admit("low");
        }
    }

    /**
     * Takes a start from the per-minute budget. A background query says no
     * instead, at every wake, once it is asked for on screen or the screen is
     * no longer quiet.
     */
    private async takeStart(key: string, lane: QueryPriority): Promise<boolean> {
        // Background work leaves half the per-minute budget for what is on screen.
        const budget = lane === "low" ? Math.max(1, Math.floor(this.perMinute / 2)) : this.perMinute;
        for (;;) {
            if (lane === "low" && !this.backgroundMayStart(key)) return false;
            const now = this.now();
            if (now < this.pausedUntil) {
                await this.nap(key, this.pausedUntil - now);
                continue;
            }
            while (this.starts.length > 0 && now - this.starts[0] >= WINDOW_MS) this.starts.shift();
            if (this.starts.length < budget) {
                this.starts.push(now);
                return true;
            }
            await this.nap(key, this.starts[0] + WINDOW_MS - now);
        }
    }

    private backgroundMayStart(key: string): boolean {
        return this.lanes.get(key) === "low" && this.active === 0 && this.waiting.length === 0;
    }

    /** Sleeps, or wakes early when `key` moves to the front lane. */
    private nap(key: string, ms: number): Promise<void> {
        return new Promise((resolve) => {
            const wake = () => {
                clearTimeout(timer);
                if (this.naps.get(key) === wake) this.naps.delete(key);
                resolve();
            };
            const timer = setTimeout(wake, ms);
            this.naps.set(key, wake);
        });
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
                scheduler.run(
                    ["arrow", workspaceId, itemId, query, JSON.stringify(options ?? {})].join("\0"),
                    () => inner.semanticModel.executeDax(workspaceId, itemId, query, options),
                    currentPriority(),
                ),
            executeDaxJson: (workspaceId, itemId, query) =>
                scheduler.run(
                    ["json", workspaceId, itemId, query].join("\0"),
                    () => inner.semanticModel.executeDaxJson(workspaceId, itemId, query),
                    currentPriority(),
                ),
        },
        lakehouse: inner.lakehouse,
        warehouse: inner.warehouse,
    };
}
