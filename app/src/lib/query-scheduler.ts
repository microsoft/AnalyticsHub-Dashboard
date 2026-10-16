//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------
import { FabricApiProxyError, type IFabricApiProxy } from "@microsoft/fabric-app-data";
// The copy of Arrow the SDK reads answers with, so its codecs apply here too.
import { RecordBatchReader, tableFromIPC } from "apache-arrow";
import { currentCaller, currentPriority, type QueryPriority } from "@/lib/query-priority";

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
     * busy message. Retry-After is kept in full, so a query that can't wait
     * as long as it asks gives up at once.
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

/** Hands a waiting query its slot, or nothing once everyone who asked for it has gone. */
type Admit = (lane: QueryPriority | undefined) => void;

interface Throttle {
    status: number;
    /** The HTTP status the reply came with, when it isn't `status`: 200 for an error table. */
    http?: number;
    retryAfterMs: number | undefined;
    /** Power BI's error code, when the throttle came as an error table. */
    code?: string;
}

/** What the scheduler knows about one semantic model's limit. Power BI throttles each model on its own. */
interface ModelState {
    /** The model's workspace and item ids, as `onModelRecovered` names it. */
    id: string;
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
    /** A query to it gave up with the busy message since it last answered. */
    owed: boolean;
    /** It answered while a pause it asked for stood: busy cards hear so when the pause ends. */
    recovery: ReturnType<typeof setTimeout> | undefined;
}

/** One query in flight, shared by every card that asks for it meanwhile. */
interface Job {
    key: string;
    lane: QueryPriority;
    model: ModelState;
    promise: Promise<unknown>;
    /** Cards waiting on it that can say they have gone. */
    interest: number;
    /** Something asked for it with no way to say it has gone, so it runs to the end. */
    kept: boolean;
    /** Everyone who asked for it has gone. */
    abandoned: boolean;
    /** Its request is with Power BI. */
    sending: boolean;
    nap: (() => void) | undefined;
    unlisten: Array<() => void>;
    wait: Wait;
}

/** When one query on screen first had to wait on its model, for the cap on how long it waits. */
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
/**
 * The names an error quotes, as Power BI writes them: tagged, in single
 * quotes or in brackets. A table called "Rate Limit" is no throttle.
 */
const NAMES = /<(oii|ccon|pii|euii|euoi)>[\s\S]*?<\/\1>|(?:^|[\s(=,])'[^']*'(?=$|[\s).,;:])|\[[^\]["{}]*\]/gi;
/** Where in the DAX an error is: a query error, never a throttle. */
const QUERY_POSITION = /\bQuery\s*\(\s*\d+\s*,\s*\d+\s*\)/i;
/** An error code short and plain enough to print. */
const CODE_TEXT = /^[\w.-]{1,64}$/;

function retryAfterOf(error: unknown): number | undefined {
    const carried = (error as { retryAfterMs?: unknown }).retryAfterMs;
    if (typeof carried === "number" && Number.isFinite(carried)) return Math.max(0, carried);
    const text = `${(error as { body?: unknown }).body ?? ""} ${error instanceof Error ? error.message : ""}`;
    const match = RETRY_AFTER_TEXT.exec(text);
    return match ? Math.round(Number(match[1]) * 1000) : undefined;
}

/** Whether text asks the app to slow down, outside any name it quotes or a query error. */
function saysThrottle(text: string): boolean {
    return !QUERY_POSITION.test(text) && THROTTLE_TEXT.test(text.replace(NAMES, " "));
}

function throttle(status: number, error: unknown, http = status): Throttle {
    const reply = (error as { replyStatus?: unknown }).replyStatus;
    const found: Throttle = { status, retryAfterMs: retryAfterOf(error) };
    const sent = typeof reply === "number" ? reply : http;
    if (sent !== status) found.http = sent;
    const code = (error as { errorCode?: unknown }).errorCode;
    if (typeof code === "string" && CODE_TEXT.test(code)) found.code = code;
    return found;
}

/** Whether a proxy error is Power BI or the capacity asking the app to slow down. */
export function throttleOf(error: unknown): Throttle | undefined {
    if (error instanceof FabricApiProxyError) {
        if (error.status === 429 || error.status === 503) return throttle(error.status, error);
        // A rate limit says so, whatever status it came with.
        return saysThrottle(error.message) ? throttle(429, error, error.status) : undefined;
    }
    if (!(error instanceof Error)) return undefined;
    const cause = (error as { cause?: { code?: unknown } }).cause;
    if (cause?.code === "RATE_LIMITED" || saysThrottle(error.message)) return throttle(429, error);
    return undefined;
}

/** Whether a card's error is throttling rather than a broken connection or query, outside any name it quotes or a query error. */
export function isBusyMessage(message: string | undefined): boolean {
    if (!message || QUERY_POSITION.test(message)) return false;
    const text = message.replace(NAMES, " ");
    return text.includes("Power BI is busy") || THROTTLE_TEXT.test(text);
}

/** Why a query stopped: every card that asked for it has gone. The SDK doesn't cache it. */
function goneError(): Error {
    return Object.assign(new Error("Nothing on the page is waiting for this query any more."), { name: "AbortError" });
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
    if (!found || !saysThrottle(`${found.code} ${found.message}`)) return undefined;
    const message = found.message || found.code;
    return Object.assign(new FabricApiProxyError({ status: 429, requestId, sessionId: "", body: message, message }), {
        errorCode: found.code,
        replyStatus: 200,
    });
}

const seconds = (ms: number) => (ms / 1000).toFixed(ms < 10_000 ? 1 : 0);

const recoveryListeners = new Set<(model: string) => void>();
const recoveries = new Map<string, number>();

/**
 * Calls `listener` with a model's id (`workspaceId/itemId`) when the model
 * answers again after a query to it gave up with the busy message, so a card
 * still showing that message can ask again. An id names one model across the
 * app, so this hears every scheduler.
 */
export function onModelRecovered(listener: (model: string) => void): () => void {
    recoveryListeners.add(listener);
    return () => {
        recoveryListeners.delete(listener);
    };
}

/**
 * How many times a model has answered again after a query to it gave up busy.
 * A card that sees it change while it asks heard too early to act on it, so
 * asks again once it shows busy.
 */
export function recoveriesOf(model: string): number {
    return recoveries.get(model) ?? 0;
}

/**
 * Paces the app's semantic model queries so a page load can't trip Power
 * BI's per-user limit or swamp a busy capacity: a few in flight at once,
 * under 90 a minute, and identical queries in flight share one request.
 *
 * Power BI throttles each model on its own, so a throttle pauses only the
 * model that sent it; queries to other models carry on. Its queries wait —
 * as long as Retry-After asks, else an exponential backoff with jitter —
 * then one at a time tries the model until it answers. A query that has
 * waited on the model for `maxWaitMs` — a background query starts counting
 * afresh once it is asked for on screen — or can't wait out its pause, gives
 * up with the busy message; once the model next answers, and any pause it
 * asked for has ended, `onModelRecovered` says so, so those cards ask again.
 * Only a throttle is retried: a query error is passed
 * on as it came, even if a name it quotes says "rate limit".
 *
 * A query stops waiting once every card that asked for it has gone; one
 * already sent finishes and its answer is kept, but a throttle isn't retried.
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
    private readonly waiting: Array<{ job: Job; admit: Admit }> = [];
    private readonly lowWaiting: Array<{ job: Job; admit: Admit }> = [];
    private readonly models = new Map<string, ModelState>();
    private readonly listeners = new Set<() => void>();
    private finished = 0;
    private readonly starts: number[] = [];
    private readonly jobs = new Map<string, Job>();

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
     * `signal` says when the caller has gone: once every caller has, the query
     * stops waiting and isn't sent or tried again. One already sent finishes.
     */
    run<T>(key: string, task: () => Promise<T>, priority: QueryPriority = "normal", model = "", signal?: AbortSignal): Promise<T> {
        if (signal?.aborted) return Promise.reject(goneError());
        const existing = this.jobs.get(key);
        if (existing) {
            this.join(existing, signal);
            if (priority === "normal") this.promote(existing);
            return existing.promise as Promise<T>;
        }
        const job: Job = {
            key,
            lane: priority,
            model: this.modelState(model),
            promise: Promise.resolve(),
            interest: 0,
            kept: false,
            abandoned: false,
            sending: false,
            nap: undefined,
            unlisten: [],
            wait: { since: undefined },
        };
        this.join(job, signal);
        this.jobs.set(key, job);
        job.promise = this.attempt(job, task).finally(() => {
            this.detach(job);
            for (const unlisten of job.unlisten) unlisten();
            this.finished++;
            this.notify();
        });
        this.notify();
        return job.promise as Promise<T>;
    }

    /** Queries in flight or queued in each lane. */
    activity(): SchedulerActivity {
        let background = 0;
        for (const job of this.jobs.values()) if (job.lane === "low") background++;
        return { foreground: this.jobs.size - background, background, finished: this.finished };
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
                id,
                label: id.split("/").pop()!.slice(0, 8) || "default",
                pausedUntil: 0,
                strikes: 0,
                running: 0,
                heldUntil: 0,
                awaitingSuccess: false,
                holding: false,
                timer: undefined,
                owed: false,
                recovery: undefined,
            };
            this.models.set(id, state);
        }
        return state;
    }

    /** Counts a caller in: one with a signal until it aborts, one without until the query ends. */
    private join(job: Job, signal: AbortSignal | undefined): void {
        job.abandoned = false;
        if (!signal) {
            job.kept = true;
            return;
        }
        job.interest++;
        const leave = () => this.leave(job);
        signal.addEventListener("abort", leave, { once: true });
        job.unlisten.push(() => signal.removeEventListener("abort", leave));
    }

    private leave(job: Job): void {
        job.interest--;
        if (job.interest === 0 && !job.kept) this.abandon(job);
    }

    /** Every caller has gone. A query waiting stops now; one already sent finishes, but isn't tried again. */
    private abandon(job: Job): void {
        job.abandoned = true;
        if (job.sending) return;
        this.detach(job);
        for (const queue of [this.waiting, this.lowWaiting]) {
            const index = queue.findIndex((entry) => entry.job === job);
            if (index >= 0) queue.splice(index, 1)[0].admit(undefined);
        }
        job.nap?.();
        this.drainLow();
        this.notify();
    }

    /** Ends an abandoned query where it stands. */
    private quit(job: Job): Error {
        this.detach(job);
        this.notify();
        return goneError();
    }

    /** Lets the next identical query start afresh. */
    private detach(job: Job): void {
        if (this.jobs.get(job.key) === job) this.jobs.delete(job.key);
    }

    /** Someone is now looking at what a background query fetches, so it joins the front lane. */
    private promote(job: Job): void {
        if (job.lane !== "low") return;
        job.lane = "normal";
        // Its wait counts from now: one it began in the background, maybe long ago, would give up without a try.
        job.wait.since = undefined;
        const index = this.lowWaiting.findIndex((entry) => entry.job === job);
        if (index >= 0) {
            const [entry] = this.lowWaiting.splice(index, 1);
            if (this.waiting.length === 0 && this.active < this.concurrency) {
                this.active++;
                entry.admit("normal");
            } else this.waiting.push(entry);
        }
        job.nap?.();
        this.notify();
    }

    private async attempt<T>(job: Job, task: () => Promise<T>): Promise<T> {
        const wait = job.wait;
        for (let retry = 0; ; retry++) {
            const lane = await this.acquire(job, wait);
            if (job.abandoned) {
                this.sent(job, lane);
                throw this.quit(job);
            }
            let failure: unknown;
            let throttle: Throttle | undefined;
            try {
                const result = await task();
                this.answered(job);
                return result;
            } catch (error) {
                failure = error;
                throttle = throttleOf(error);
                // Before the slot goes back, so no query to the model starts in between.
                if (throttle) this.throttled(job.model, throttle);
            } finally {
                this.sent(job, lane);
            }
            if (!throttle) throw failure;
            // Nobody is waiting for it now; the model's pause still stands for everyone else.
            if (job.abandoned) throw this.quit(job);
            const now = this.now();
            wait.since ??= now;
            const left = wait.since + this.maxWaitMs - now;
            if (retry >= this.maxRetries || left <= 0 || (throttle.retryAfterMs ?? 0) > left)
                throw this.giveUp(job.model, wait, failure, throttle);
        }
    }

    /** A start is over: its slot goes back, and queries waiting on its model look again. */
    private sent(job: Job, lane: QueryPriority): void {
        job.sending = false;
        job.model.running--;
        this.release(lane);
        this.wakeModel(job.model);
    }

    private giveUp(model: ModelState, wait: Wait, failure: unknown, throttle: Throttle): FabricApiProxyError {
        const now = this.now();
        model.owed = true;
        this.log(
            "warn",
            `Analytics Hub: model ${model.label} is still throttling after ${seconds(now - (wait.since ?? now))} s, so a card shows "Power BI is busy".`,
        );
        return busyError(failure, throttle);
    }

    /** A throttled reply pauses its model and holds its background queries. */
    private throttled(model: ModelState, throttle: Throttle): void {
        const now = this.now();
        // Busy again: cards wait for its next answer rather than the end of this pause.
        clearTimeout(model.recovery);
        model.recovery = undefined;
        if (now >= model.pausedUntil) {
            const pause = this.delay(model.strikes, throttle.retryAfterMs);
            model.strikes++;
            model.pausedUntil = now + pause;
            const code = throttle.code ? `, ${throttle.code}` : "";
            this.log(
                "warn",
                `Analytics Hub: Power BI throttled a query to model ${model.label} (HTTP ${throttle.http ?? throttle.status}${code}), ${model.strikes} in a row. ` +
                    `Its queries wait ${seconds(pause)} s, then try it one at a time.`,
            );
        } else if (throttle.retryAfterMs !== undefined) {
            // A reply to a query sent before the pause began may ask for longer, and gets it in full.
            model.pausedUntil = Math.max(model.pausedUntil, now + throttle.retryAfterMs);
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

    private answered(job: Job): void {
        const model = job.model;
        if (model.strikes > 0) {
            model.strikes = 0;
            this.log("info", `Analytics Hub: model ${model.label} is answering again.`);
        }
        if (job.lane !== "low") model.awaitingSuccess = false;
        if (model.owed) this.recovered(model);
        this.resumeIfClear(model);
    }

    /** Tells the cards the model left busy that it answers again, once any pause it asked for ends: before, they would only wait again. */
    private recovered(model: ModelState): void {
        clearTimeout(model.recovery);
        model.recovery = undefined;
        const pause = model.pausedUntil - this.now();
        if (pause > 0) {
            model.recovery = setTimeout(() => this.recovered(model), pause);
            return;
        }
        model.owed = false;
        recoveries.set(model.id, recoveriesOf(model.id) + 1);
        this.log("info", `Analytics Hub: cards that showed "Power BI is busy" ask model ${model.label} again.`);
        for (const listener of [...recoveryListeners]) listener(model.id);
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
        for (const job of this.jobs.values()) if (job.model === model) job.nap?.();
    }

    /** How long a throttled model pauses: all Retry-After asks, else an exponential backoff with jitter. */
    private delay(strikes: number, retryAfterMs: number | undefined): number {
        if (retryAfterMs !== undefined) return retryAfterMs + Math.round(this.random() * 250);
        const backoff = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** strikes);
        return Math.round(backoff / 2 + this.random() * (backoff / 2));
    }

    private async acquire(job: Job, wait: Wait): Promise<QueryPriority> {
        for (let again = false; ; again = true) {
            if (this.blocked(job.model)) await this.modelClear(job, wait);
            if (job.abandoned) throw this.quit(job);
            const lane = await (job.lane === "low" ? this.admitLow(job, again) : this.admitNormal(job));
            if (lane === undefined) throw this.quit(job);
            if (await this.takeStart(job, lane)) return lane;
            this.giveBack(job, lane);
        }
    }

    /**
     * Waits, holding no slot, until the model may be tried. It gives up once
     * the query has waited too long, or at once if the model's pause outlasts
     * the wait left, so nothing is sent before the model asked.
     */
    private async modelClear(job: Job, wait: Wait): Promise<void> {
        const model = job.model;
        for (;;) {
            if (job.abandoned) throw this.quit(job);
            const now = this.now();
            if (!this.blocked(model, now)) return;
            wait.since ??= now;
            const left = wait.since + this.maxWaitMs - now;
            const pause = model.pausedUntil - now;
            if (left <= 0 || pause > left) throw this.giveUp(model, wait, undefined, { status: 429, retryAfterMs: undefined });
            // Until the pause ends, or until the query trying the model settles and wakes it.
            await this.nap(job, pause > 0 ? pause : left);
        }
    }

    /** Gives back a slot taken for a start that didn't happen. */
    private giveBack(job: Job, lane: QueryPriority): void {
        if (lane === "normal") {
            this.release("normal");
            return;
        }
        this.lowActive--;
        // Not once it is asked for on screen, so no background query starts ahead of it.
        if (job.lane === "low" || job.abandoned) this.drainLow();
    }

    private admitNormal(job: Job): Promise<QueryPriority | undefined> {
        if (this.active < this.concurrency) {
            this.active++;
            return Promise.resolve("normal");
        }
        return new Promise((resolve) => this.waiting.push({ job, admit: resolve }));
    }

    private admitLow(job: Job, front = false): Promise<QueryPriority | undefined> {
        if (this.lowCanStart(job)) {
            this.lowActive++;
            return Promise.resolve("low");
        }
        return new Promise((resolve) => {
            if (front) this.lowWaiting.unshift({ job, admit: resolve });
            else this.lowWaiting.push({ job, admit: resolve });
        });
    }

    private screenQuiet(): boolean {
        return this.active === 0 && this.waiting.length === 0;
    }

    /** Background work starts only when nothing on screen is running or waiting, and its model isn't held. */
    private lowCanStart(job: Job): boolean {
        return this.screenQuiet() && this.lowActive < this.lowConcurrency && !this.held(job.model);
    }

    /** Hands the slot straight to the next query in line, so it can't be taken past it. */
    private release(lane: QueryPriority): void {
        if (lane === "low") this.lowActive--;
        else this.active--;
        while (this.waiting.length > 0 && this.active < this.concurrency) {
            this.active++;
            this.waiting.shift()!.admit("normal");
        }
        this.drainLow();
    }

    /** Starts the background queries first in line whose model isn't held. */
    private drainLow(): void {
        let index = 0;
        while (index < this.lowWaiting.length && this.screenQuiet() && this.lowActive < this.lowConcurrency) {
            const entry = this.lowWaiting[index];
            if (this.held(entry.job.model)) {
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
     * wake, once the query is abandoned or its model is paused or being tried;
     * a background query also says no once it is asked for on screen, the
     * screen is no longer quiet, or its model is held.
     */
    private async takeStart(job: Job, lane: QueryPriority): Promise<boolean> {
        // Background work leaves half the per-minute budget for what is on screen.
        const budget = lane === "low" ? Math.max(1, Math.floor(this.perMinute / 2)) : this.perMinute;
        for (;;) {
            if (job.abandoned) return false;
            if (lane === "low" && !this.backgroundMayStart(job)) return false;
            const now = this.now();
            if (this.blocked(job.model, now)) return false;
            while (this.starts.length > 0 && now - this.starts[0] >= WINDOW_MS) this.starts.shift();
            if (this.starts.length < budget) {
                this.starts.push(now);
                job.model.running++;
                job.sending = true;
                return true;
            }
            await this.nap(job, this.starts[0] + WINDOW_MS - now);
        }
    }

    private backgroundMayStart(job: Job): boolean {
        return job.lane === "low" && this.screenQuiet() && !this.held(job.model);
    }

    /** Sleeps, or wakes early when the query moves to the front lane, is abandoned, or its model may have cleared. */
    private nap(job: Job, ms: number): Promise<void> {
        return new Promise((resolve) => {
            const wake = () => {
                clearTimeout(timer);
                if (job.nap === wake) job.nap = undefined;
                resolve();
            };
            const timer = setTimeout(wake, ms);
            job.nap = wake;
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
    const run = <T>(key: string[], model: string, task: () => Promise<T>): Promise<T> => {
        const caller = currentCaller();
        caller?.asking?.(model);
        return scheduler.run(key.join("\0"), task, currentPriority(), model, caller?.signal);
    };
    return {
        semanticModel: {
            executeDax: (workspaceId, itemId, query, options) =>
                run(["arrow", workspaceId, itemId, query, JSON.stringify(options ?? {})], `${workspaceId}/${itemId}`, async () => {
                    const response = await inner.semanticModel.executeDax(workspaceId, itemId, query, options);
                    const throttled = throttledReply(arrowErrorOf(response?.data), response?.requestId ?? "");
                    if (throttled) throw throttled;
                    return response;
                }),
            executeDaxJson: (workspaceId, itemId, query) =>
                run(["json", workspaceId, itemId, query], `${workspaceId}/${itemId}`, async () => {
                    const response = await inner.semanticModel.executeDaxJson(workspaceId, itemId, query);
                    const throttled = throttledReply(jsonErrorOf(response?.data), response?.requestId ?? "");
                    if (throttled) throw throttled;
                    return response;
                }),
        },
        lakehouse: inner.lakehouse,
        warehouse: inner.warehouse,
    };
}
