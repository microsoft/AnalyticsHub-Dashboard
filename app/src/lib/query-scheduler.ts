//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------
import { FabricApiProxyError, type IFabricApiProxy } from "@microsoft/fabric-app-data";
// The copy of Arrow the SDK reads answers with, so its codecs apply here too.
import { RecordBatchReader, tableFromIPC } from "apache-arrow";
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
    /** Throttled tries of one query before it gives up, if `maxWaitMs` hasn't run out first. */
    maxRetries?: number;
    /** The first backoff, doubled for each throttled reply in a row when Power BI sends no Retry-After. */
    baseDelayMs?: number;
    /** The longest backoff between two tries. */
    maxDelayMs?: number;
    /**
     * How long a query waits on a throttled model before it gives up with the
     * busy message. A Retry-After longer than what is left gives up at once.
     */
    maxWaitMs?: number;
    /** How long background queries to a model wait after its last throttled reply. */
    backgroundHoldMs?: number;
    /** Where the scheduler says what it does about throttling; the browser console by default. */
    log?: (level: "info" | "warn", message: string) => void;
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
    /** Power BI's error code, when the throttle came as an error table. */
    code?: string;
}

/** What the scheduler knows about one semantic model's limit. Power BI throttles each model on its own. */
interface ModelState {
    /** The start of the model's id, for the console. */
    label: string;
    /** No query to the model starts before this. */
    pausedUntil: number;
    /** Throttled replies in a row. While above zero, one query at a time tries the model. */
    strikes: number;
    running: number;
    /** Background queries to the model wait until this... */
    heldUntil: number;
    /** ...and until a query on screen to it succeeds. */
    awaitingSuccess: boolean;
    holding: boolean;
    timer: ReturnType<typeof setTimeout> | undefined;
}

/** When one query first had to wait on its model, for the cap on how long it waits. */
interface Wait {
    since: number | undefined;
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
/** An error code short and plain enough to print. */
const CODE_TEXT = /^[\w.-]{1,64}$/;

function retryAfterOf(error: unknown): number | undefined {
    const carried = (error as { retryAfterMs?: unknown }).retryAfterMs;
    if (typeof carried === "number" && Number.isFinite(carried)) return Math.max(0, carried);
    const text = `${(error as { body?: unknown }).body ?? ""} ${error instanceof Error ? error.message : ""}`;
    const match = RETRY_AFTER_TEXT.exec(text);
    return match ? Math.round(Number(match[1]) * 1000) : undefined;
}

function throttle(status: number, error: unknown): Throttle {
    const found: Throttle = { status, retryAfterMs: retryAfterOf(error) };
    const code = (error as { errorCode?: unknown }).errorCode;
    if (typeof code === "string" && CODE_TEXT.test(code)) found.code = code;
    return found;
}

/** Whether a proxy error is Power BI or the capacity asking the app to slow down. */
export function throttleOf(error: unknown): Throttle | undefined {
    if (error instanceof FabricApiProxyError) {
        if (error.status === 429 || error.status === 503) return throttle(error.status, error);
        // A rate limit says so, whatever status it came with.
        return THROTTLE_TEXT.test(error.message) ? throttle(429, error) : undefined;
    }
    if (!(error instanceof Error)) return undefined;
    const cause = (error as { cause?: { code?: unknown } }).cause;
    if (cause?.code === "RATE_LIMITED" || THROTTLE_TEXT.test(error.message)) return throttle(429, error);
    return undefined;
}

/** Whether a card's error is throttling rather than a broken connection or query. */
export function isBusyMessage(message: string | undefined): boolean {
    if (!message) return false;
    return message.includes("Power BI is busy") || THROTTLE_TEXT.test(message);
}

function busyError(error: unknown, throttle: Throttle): FabricApiProxyError {
    const source = (error ?? {}) as { requestId?: string; sessionId?: string; body?: string };
    return new FabricApiProxyError({
        status: throttle.status,
        requestId: source.requestId ?? "",
        sessionId: source.sessionId ?? "",
        body: source.body ?? "",
        message: BUSY_MESSAGE,
    });
}

/** The error Power BI sends in place of an answer, still with HTTP 200. */
export interface ReplyError {
    code: string;
    message: string;
}

const ERROR_COLUMNS = ["ErrorCode", "ErrorMessage", "ErrorDescription"];
/** An error table is a few kilobytes, so a larger answer isn't read twice. */
const ERROR_TABLE_MAX_BYTES = 64 * 1024;

/** Reads an Arrow answer's error table the way the SDK does: the three error columns, first row. */
export function arrowErrorOf(data: ArrayBuffer | undefined): ReplyError | undefined {
    const size = data?.byteLength;
    if (typeof size !== "number" || size === 0 || size > ERROR_TABLE_MAX_BYTES) return undefined;
    try {
        const bytes = new Uint8Array(data!);
        const reader = RecordBatchReader.from(bytes);
        reader.open();
        const names = new Set((reader.schema?.fields ?? []).map((field) => field.name));
        if (!ERROR_COLUMNS.every((column) => names.has(column))) return undefined;
        const row = (tableFromIPC(bytes).get(0)?.toJSON() ?? {}) as Record<string, unknown>;
        return { code: String(row.ErrorCode ?? ""), message: String(row.ErrorMessage ?? "") };
    } catch {
        // Not something this can read: the SDK reports it as it always has.
        return undefined;
    }
}

interface JsonError {
    code?: unknown;
    message?: unknown;
}

/** Reads a JSON answer's error the way the SDK does: the body's, the result's, then the table's. */
export function jsonErrorOf(data: unknown): ReplyError | undefined {
    const body = data as { error?: JsonError; results?: Array<{ error?: JsonError; tables?: Array<{ error?: JsonError }> }> } | null;
    const result = body?.results?.[0];
    const error = [body?.error, result?.error, result?.tables?.[0]?.error].find((found) => found?.message || found?.code);
    return error ? { code: String(error.code ?? ""), message: String(error.message ?? "") } : undefined;
}

/** A throttle sent as an error in an HTTP 200, as the 429 it means, so it is retried and never cached. */
export function throttledReply(found: ReplyError | undefined, requestId: string): FabricApiProxyError | undefined {
    if (!found || !THROTTLE_TEXT.test(`${found.code} ${found.message}`)) return undefined;
    const message = found.message || found.code;
    return Object.assign(new FabricApiProxyError({ status: 429, requestId, sessionId: "", body: message, message }), {
        errorCode: found.code,
    });
}

const seconds = (ms: number) => (ms / 1000).toFixed(ms < 10_000 ? 1 : 0);

/**
 * Paces the app's semantic model queries so a page load can't trip Power
 * BI's per-user limit or swamp a busy capacity: a few in flight at once,
 * under 90 a minute, and identical queries in flight share one request.
 *
 * Power BI throttles each model on its own, so a throttle pauses only the
 * model that sent it; queries to other models carry on. Its queries wait —
 * as long as Retry-After asks, else an exponential backoff with jitter —
 * then one at a time tries the model until it answers. A query that has
 * waited on the model for `maxWaitMs` gives up with the busy message.
 *
 * Background queries — pages fetched ahead of a visit — run in a lane of
 * their own: one at a time in a slot of its own, only while nothing on
 * screen is running or waiting, and on half the per-minute budget. Asking
 * for one in the foreground moves it to the front lane, even while it waits
 * for budget. One that waited checks again that the screen is quiet before
 * it starts, and if not, gives its slot back and queues again. After a
 * throttle, background queries to that model wait `backgroundHoldMs`, and
 * until a query on screen to it succeeds.
 */
export class QueryScheduler {
    private readonly concurrency: number;
    private readonly lowConcurrency: number;
    private readonly perMinute: number;
    private readonly maxRetries: number;
    private readonly baseDelayMs: number;
    private readonly maxDelayMs: number;
    private readonly maxWaitMs: number;
    private readonly backgroundHoldMs: number;
    private readonly log: (level: "info" | "warn", message: string) => void;
    private readonly now: () => number;
    private readonly random: () => number;

    private active = 0;
    private lowActive = 0;
    private readonly waiting: Admit[] = [];
    private readonly lowWaiting: Array<{ key: string; admit: Admit }> = [];
    private readonly lanes = new Map<string, QueryPriority>();
    private readonly keyModels = new Map<string, ModelState>();
    private readonly models = new Map<string, ModelState>();
    private readonly listeners = new Set<() => void>();
    private finished = 0;
    private readonly starts: number[] = [];
    private readonly inFlight = new Map<string, Promise<unknown>>();
    private readonly naps = new Map<string, () => void>();

    constructor(options: QuerySchedulerOptions = {}) {
        this.concurrency = options.concurrency ?? 4;
        this.lowConcurrency = options.lowConcurrency ?? 1;
        this.perMinute = options.perMinute ?? 90;
        this.maxRetries = options.maxRetries ?? 10;
        this.baseDelayMs = options.baseDelayMs ?? 1000;
        this.maxDelayMs = options.maxDelayMs ?? 15_000;
        // Power BI has sent no Retry-After, and how soon a throttled model recovers hasn't been
        // measured; a minute is a guess to tune once it is.
        this.maxWaitMs = options.maxWaitMs ?? 60_000;
        this.backgroundHoldMs = options.backgroundHoldMs ?? 60_000;
        this.log = options.log ?? ((level, message) => console[level](message));
        this.now = options.now ?? Date.now;
        this.random = options.random ?? Math.random;
    }

    /**
     * Runs `task`, or joins the identical one already in flight under `key`.
     * `model` names the semantic model it asks, which a throttle pauses on its own.
     */
    run<T>(key: string, task: () => Promise<T>, priority: QueryPriority = "normal", model = ""): Promise<T> {
        const existing = this.inFlight.get(key);
        if (existing) {
            if (priority === "normal") this.promote(key);
            return existing as Promise<T>;
        }
        const state = this.modelState(model);
        this.lanes.set(key, priority);
        this.keyModels.set(key, state);
        const promise = this.attempt(key, task, state).finally(() => {
            this.inFlight.delete(key);
            this.lanes.delete(key);
            this.keyModels.delete(key);
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

    private modelState(id: string): ModelState {
        let state = this.models.get(id);
        if (!state) {
            state = {
                label: id.split("/").pop()!.slice(0, 8) || "default",
                pausedUntil: 0,
                strikes: 0,
                running: 0,
                heldUntil: 0,
                awaitingSuccess: false,
                holding: false,
                timer: undefined,
            };
            this.models.set(id, state);
        }
        return state;
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

    private async attempt<T>(key: string, task: () => Promise<T>, model: ModelState): Promise<T> {
        const wait: Wait = { since: undefined };
        for (let retry = 0; ; retry++) {
            const lane = await this.acquire(key, model, wait);
            let failure: unknown;
            let throttle: Throttle | undefined;
            try {
                const result = await task();
                this.answered(key, model);
                return result;
            } catch (error) {
                failure = error;
                throttle = throttleOf(error);
                // Before the slot goes back, so no query to the model starts in between.
                if (throttle) this.throttled(model, throttle);
            } finally {
                model.running--;
                this.release(lane);
                this.wakeModel(model);
            }
            if (!throttle) throw failure;
            const now = this.now();
            wait.since ??= now;
            const left = wait.since + this.maxWaitMs - now;
            if (retry >= this.maxRetries || left <= 0 || (throttle.retryAfterMs ?? 0) > left)
                throw this.giveUp(model, wait, failure, throttle);
        }
    }

    private giveUp(model: ModelState, wait: Wait, failure: unknown, throttle: Throttle): FabricApiProxyError {
        const now = this.now();
        this.log(
            "warn",
            `Analytics Hub: model ${model.label} is still throttling after ${seconds(now - (wait.since ?? now))} s, so a card shows "Power BI is busy".`,
        );
        return busyError(failure, throttle);
    }

    /** A throttled reply pauses its model and holds its background queries. */
    private throttled(model: ModelState, throttle: Throttle): void {
        const now = this.now();
        if (now >= model.pausedUntil) {
            const pause = this.delay(model.strikes, throttle.retryAfterMs);
            model.strikes++;
            model.pausedUntil = now + pause;
            const code = throttle.code ? `, ${throttle.code}` : "";
            this.log(
                "warn",
                `Analytics Hub: Power BI throttled a query to model ${model.label} (HTTP ${throttle.status}${code}), ${model.strikes} in a row. ` +
                    `Its queries wait ${seconds(pause)} s, then try it one at a time.`,
            );
        } else if (throttle.retryAfterMs !== undefined) {
            // A reply to a query sent before the pause began may ask for longer.
            model.pausedUntil = Math.max(model.pausedUntil, now + Math.min(throttle.retryAfterMs, this.maxWaitMs));
        }
        model.heldUntil = Math.max(model.heldUntil, now + this.backgroundHoldMs);
        model.awaitingSuccess = true;
        if (!model.holding) {
            model.holding = true;
            this.log(
                "info",
                `Analytics Hub: background loading from model ${model.label} paused for at least ${seconds(this.backgroundHoldMs)} s, and until it answers a query on screen.`,
            );
        }
        clearTimeout(model.timer);
        model.timer = setTimeout(() => {
            model.timer = undefined;
            this.resumeIfClear(model);
        }, model.heldUntil - now);
    }

    private answered(key: string, model: ModelState): void {
        if (model.strikes > 0) {
            model.strikes = 0;
            this.log("info", `Analytics Hub: model ${model.label} is answering again.`);
        }
        if (this.lanes.get(key) !== "low") model.awaitingSuccess = false;
        this.resumeIfClear(model);
    }

    private resumeIfClear(model: ModelState): void {
        if (!model.holding || this.held(model)) return;
        model.holding = false;
        this.log("info", `Analytics Hub: background loading from model ${model.label} resumed.`);
        this.drainLow();
    }

    /** Background queries to the model wait. */
    private held(model: ModelState): boolean {
        return model.awaitingSuccess || this.now() < model.heldUntil;
    }

    /** No query to the model may start: it is paused, or a query is already trying it. */
    private blocked(model: ModelState, now = this.now()): boolean {
        return now < model.pausedUntil || (model.strikes > 0 && model.running > 0);
    }

    /** Wakes every query napping on the model, to look at it again. */
    private wakeModel(model: ModelState): void {
        for (const [key, state] of this.keyModels) if (state === model) this.naps.get(key)?.();
    }

    private delay(strikes: number, retryAfterMs: number | undefined): number {
        if (retryAfterMs !== undefined) return Math.min(retryAfterMs, this.maxWaitMs) + Math.round(this.random() * 250);
        const backoff = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** strikes);
        return Math.round(backoff / 2 + this.random() * (backoff / 2));
    }

    private async acquire(key: string, model: ModelState, wait: Wait): Promise<QueryPriority> {
        for (let again = false; ; again = true) {
            if (this.blocked(model)) await this.modelClear(key, model, wait);
            const lane = await (this.lanes.get(key) === "low" ? this.admitLow(key, again) : this.admitNormal());
            if (await this.takeStart(key, lane, model)) return lane;
            this.giveBack(key, lane);
        }
    }

    /** Waits, holding no slot, until the model may be tried; gives up once the query has waited too long. */
    private async modelClear(key: string, model: ModelState, wait: Wait): Promise<void> {
        for (;;) {
            const now = this.now();
            if (!this.blocked(model, now)) return;
            wait.since ??= now;
            const left = wait.since + this.maxWaitMs - now;
            if (left <= 0) throw this.giveUp(model, wait, undefined, { status: 429, retryAfterMs: undefined });
            // Until the pause ends, or until the query trying the model settles and wakes it.
            await this.nap(key, now < model.pausedUntil ? Math.min(left, model.pausedUntil - now) : left);
        }
    }

    /** Gives back a slot taken for a start that didn't happen. */
    private giveBack(key: string, lane: QueryPriority): void {
        if (lane === "normal") {
            this.release("normal");
            return;
        }
        this.lowActive--;
        // Not once it is asked for on screen, so no background query starts ahead of it.
        if (this.lanes.get(key) === "low") this.drainLow();
    }

    private admitNormal(): Promise<QueryPriority> {
        if (this.active < this.concurrency) {
            this.active++;
            return Promise.resolve("normal");
        }
        return new Promise((resolve) => this.waiting.push(resolve));
    }

    private admitLow(key: string, front = false): Promise<QueryPriority> {
        if (this.lowCanStart(key)) {
            this.lowActive++;
            return Promise.resolve("low");
        }
        return new Promise((resolve) => {
            if (front) this.lowWaiting.unshift({ key, admit: resolve });
            else this.lowWaiting.push({ key, admit: resolve });
        });
    }

    private screenQuiet(): boolean {
        return this.active === 0 && this.waiting.length === 0;
    }

    /** Background work starts only when nothing on screen is running or waiting, and its model isn't held. */
    private lowCanStart(key: string): boolean {
        return this.screenQuiet() && this.lowActive < this.lowConcurrency && !this.held(this.keyModels.get(key)!);
    }

    /** Hands the slot straight to the next query in line, so it can't be taken past it. */
    private release(lane: QueryPriority): void {
        if (lane === "low") this.lowActive--;
        else this.active--;
        while (this.waiting.length > 0 && this.active < this.concurrency) {
            this.active++;
            this.waiting.shift()!("normal");
        }
        this.drainLow();
    }

    /** Starts the background queries first in line whose model isn't held. */
    private drainLow(): void {
        let index = 0;
        while (index < this.lowWaiting.length && this.screenQuiet() && this.lowActive < this.lowConcurrency) {
            const entry = this.lowWaiting[index];
            if (this.held(this.keyModels.get(entry.key)!)) {
                index++;
                continue;
            }
            this.lowWaiting.splice(index, 1);
            this.lowActive++;
            entry.admit("low");
        }
    }

    /**
     * Takes a start from the per-minute budget. It says no instead, at every
     * wake, once the model is paused or being tried; a background query also
     * says no once it is asked for on screen, the screen is no longer quiet,
     * or its model is held.
     */
    private async takeStart(key: string, lane: QueryPriority, model: ModelState): Promise<boolean> {
        // Background work leaves half the per-minute budget for what is on screen.
        const budget = lane === "low" ? Math.max(1, Math.floor(this.perMinute / 2)) : this.perMinute;
        for (;;) {
            if (lane === "low" && !this.backgroundMayStart(key)) return false;
            const now = this.now();
            if (this.blocked(model, now)) return false;
            while (this.starts.length > 0 && now - this.starts[0] >= WINDOW_MS) this.starts.shift();
            if (this.starts.length < budget) {
                this.starts.push(now);
                model.running++;
                return true;
            }
            await this.nap(key, this.starts[0] + WINDOW_MS - now);
        }
    }

    private backgroundMayStart(key: string): boolean {
        return this.lanes.get(key) === "low" && this.screenQuiet() && !this.held(this.keyModels.get(key)!);
    }

    /** Sleeps, or wakes early when `key` moves to the front lane or its model may have cleared. */
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
 * the SDK's result cache, so a cached answer costs nothing against the limit,
 * and a throttle Power BI sends as an error in an HTTP 200 is retried here
 * rather than cached.
 */
export function scheduledProxy(inner: IFabricApiProxy, scheduler = new QueryScheduler()): IFabricApiProxy {
    return {
        semanticModel: {
            executeDax: (workspaceId, itemId, query, options) =>
                scheduler.run(
                    ["arrow", workspaceId, itemId, query, JSON.stringify(options ?? {})].join("\0"),
                    async () => {
                        const response = await inner.semanticModel.executeDax(workspaceId, itemId, query, options);
                        const throttled = throttledReply(arrowErrorOf(response?.data), response?.requestId ?? "");
                        if (throttled) throw throttled;
                        return response;
                    },
                    currentPriority(),
                    `${workspaceId}/${itemId}`,
                ),
            executeDaxJson: (workspaceId, itemId, query) =>
                scheduler.run(
                    ["json", workspaceId, itemId, query].join("\0"),
                    async () => {
                        const response = await inner.semanticModel.executeDaxJson(workspaceId, itemId, query);
                        const throttled = throttledReply(jsonErrorOf(response?.data), response?.requestId ?? "");
                        if (throttled) throw throttled;
                        return response;
                    },
                    currentPriority(),
                    `${workspaceId}/${itemId}`,
                ),
        },
        lakehouse: inner.lakehouse,
        warehouse: inner.warehouse,
    };
}
