//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------
import { FabricApiProxyError, FabricGenericProxyError, type IFabricApiProxy } from "@microsoft/fabric-app-data";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    BUSY_MESSAGE,
    isBusyMessage,
    parseRetryAfter,
    QueryScheduler,
    scheduledProxy,
    throttleOf,
} from "@/lib/query-scheduler";

function apiError(status: number, body = "", message = `HTTP ${status}`) {
    return new FabricApiProxyError({ status, requestId: "r", sessionId: "s", body, message });
}

/** A task that resolves only when the test says so. */
function deferred<T = string>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T10:00:00Z"));
});

afterEach(() => {
    vi.useRealTimers();
});

describe("parseRetryAfter", () => {
    it("reads seconds", () => {
        expect(parseRetryAfter("7")).toBe(7000);
        expect(parseRetryAfter(" 1.5 ")).toBe(1500);
    });

    it("reads an HTTP date as the time left until it", () => {
        const now = Date.parse("2026-07-01T10:00:00Z");
        expect(parseRetryAfter("Wed, 01 Jul 2026 10:00:30 GMT", now)).toBe(30_000);
        expect(parseRetryAfter("Wed, 01 Jul 2026 09:59:00 GMT", now)).toBe(0);
    });

    it("ignores what it can't read", () => {
        expect(parseRetryAfter(undefined)).toBeUndefined();
        expect(parseRetryAfter(null)).toBeUndefined();
        expect(parseRetryAfter("soon")).toBeUndefined();
    });
});

describe("throttleOf", () => {
    it("treats 429 and 503 as throttling, and nothing else", () => {
        expect(throttleOf(apiError(429))).toEqual({ status: 429, retryAfterMs: undefined });
        expect(throttleOf(apiError(503))).toEqual({ status: 503, retryAfterMs: undefined });
        expect(throttleOf(apiError(400))).toBeUndefined();
        expect(throttleOf(apiError(500))).toBeUndefined();
        expect(throttleOf(new TypeError("offline"))).toBeUndefined();
    });

    it("reads Retry-After carried on the error, or written in its body", () => {
        const carried = Object.assign(apiError(429), { retryAfterMs: 4000 });
        expect(throttleOf(carried)?.retryAfterMs).toBe(4000);
        expect(throttleOf(apiError(429, '{"retryAfter": 12}'))?.retryAfterMs).toBe(12_000);
    });

    it("spots the host's rate limit when it carries no status", () => {
        const limited = new FabricGenericProxyError({ message: "Request failed", cause: { code: "RATE_LIMITED" } });
        expect(throttleOf(limited)?.status).toBe(429);
        expect(throttleOf(new Error("Too many requests"))?.status).toBe(429);
    });
});

describe("isBusyMessage", () => {
    it("matches the busy message and Power BI's throttling text", () => {
        expect(isBusyMessage(BUSY_MESSAGE)).toBe(true);
        expect(isBusyMessage("Too many requests")).toBe(true);
        expect(isBusyMessage("The dates with Copilot activity couldn't be read: Power BI is busy: …")).toBe(true);
        expect(isBusyMessage("The column 'X'[Y] cannot be found")).toBe(false);
        expect(isBusyMessage(undefined)).toBe(false);
    });
});

describe("QueryScheduler", () => {
    it("holds no more than four queries in flight", async () => {
        const scheduler = new QueryScheduler();
        const tasks = Array.from({ length: 10 }, () => deferred());
        let running = 0;
        let peak = 0;
        const results = tasks.map((task, index) =>
            scheduler.run(`q${index}`, async () => {
                running++;
                peak = Math.max(peak, running);
                try {
                    return await task.promise;
                } finally {
                    running--;
                }
            }),
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(running).toBe(4);
        for (const [index, task] of tasks.entries()) {
            task.resolve(`a${index}`);
            await vi.advanceTimersByTimeAsync(0);
        }
        expect(await Promise.all(results)).toEqual(tasks.map((_, index) => `a${index}`));
        expect(peak).toBe(4);
    });

    it("starts no more than 90 queries in a minute", async () => {
        const scheduler = new QueryScheduler({ concurrency: 1000 });
        const started: number[] = [];
        const results = Array.from({ length: 100 }, (_, index) =>
            scheduler.run(`q${index}`, async () => {
                started.push(Date.now());
                return index;
            }),
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(started).toHaveLength(90);
        await vi.advanceTimersByTimeAsync(59_999);
        expect(started).toHaveLength(90);
        await vi.advanceTimersByTimeAsync(1);
        expect(started).toHaveLength(100);
        await Promise.all(results);
    });

    it("retries a throttled query with backoff, then succeeds", async () => {
        const scheduler = new QueryScheduler({ random: () => 1 });
        const task = vi.fn().mockRejectedValueOnce(apiError(429)).mockResolvedValueOnce("ok");
        const result = scheduler.run("q", task);
        await vi.advanceTimersByTimeAsync(0);
        expect(task).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(999);
        expect(task).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(task).toHaveBeenCalledTimes(2);
        await expect(result).resolves.toBe("ok");
    });

    it("doubles the backoff with each retry, jittered", async () => {
        const scheduler = new QueryScheduler({ random: () => 0 });
        const calls: number[] = [];
        const task = vi.fn(async () => {
            calls.push(Date.now());
            if (calls.length < 3) throw apiError(503);
            return "ok";
        });
        const result = scheduler.run("q", task);
        await vi.advanceTimersByTimeAsync(10_000);
        await expect(result).resolves.toBe("ok");
        // Half the backoff with no jitter: 500 ms, then 1000 ms.
        expect(calls.map((time) => time - calls[0])).toEqual([0, 500, 1500]);
    });

    it("waits as long as Retry-After asks, and holds every other query meanwhile", async () => {
        const scheduler = new QueryScheduler({ random: () => 0 });
        const throttled = vi
            .fn()
            .mockRejectedValueOnce(Object.assign(apiError(429), { retryAfterMs: 5000 }))
            .mockResolvedValueOnce("first");
        const first = scheduler.run("a", throttled);
        await vi.advanceTimersByTimeAsync(0);

        const other = vi.fn().mockResolvedValue("second");
        const second = scheduler.run("b", other);
        await vi.advanceTimersByTimeAsync(4999);
        expect(throttled).toHaveBeenCalledTimes(1);
        expect(other).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);
        await expect(first).resolves.toBe("first");
        await expect(second).resolves.toBe("second");
    });

    it("gives up with the busy message after three retries", async () => {
        const scheduler = new QueryScheduler({ random: () => 1 });
        const task = vi.fn().mockRejectedValue(apiError(429, "Too many requests"));
        const result = scheduler.run("q", task);
        const settled = expect(result).rejects.toMatchObject({ status: 429, message: BUSY_MESSAGE });
        await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000);
        await settled;
        expect(task).toHaveBeenCalledTimes(4);
        await expect(result).rejects.toBeInstanceOf(FabricApiProxyError);
    });

    it("gives up at once when Retry-After asks for longer than a minute", async () => {
        const scheduler = new QueryScheduler();
        const task = vi.fn().mockRejectedValue(Object.assign(apiError(429), { retryAfterMs: 120_000 }));
        await expect(scheduler.run("q", task)).rejects.toMatchObject({ message: BUSY_MESSAGE });
        expect(task).toHaveBeenCalledTimes(1);
    });

    it("doesn't retry errors that aren't throttling", async () => {
        const scheduler = new QueryScheduler();
        const bad = apiError(400, "", "The column 'X'[Y] cannot be found");
        const task = vi.fn().mockRejectedValue(bad);
        await expect(scheduler.run("q", task)).rejects.toBe(bad);
        expect(task).toHaveBeenCalledTimes(1);

        const broken = vi.fn().mockRejectedValue(apiError(500));
        await expect(scheduler.run("r", broken)).rejects.toMatchObject({ status: 500 });
        expect(broken).toHaveBeenCalledTimes(1);
    });

    it("shares one request between identical queries in flight", async () => {
        const scheduler = new QueryScheduler();
        const gate = deferred();
        const task = vi.fn(() => gate.promise);
        const first = scheduler.run("same", task);
        const second = scheduler.run("same", task);
        expect(second).toBe(first);
        gate.resolve("answer");
        await expect(first).resolves.toBe("answer");
        expect(task).toHaveBeenCalledTimes(1);

        // Once settled, the key asks again.
        await expect(scheduler.run("same", async () => "fresh")).resolves.toBe("fresh");
    });

    it("lets a failed query be asked again", async () => {
        const scheduler = new QueryScheduler();
        await expect(scheduler.run("q", () => Promise.reject(apiError(400)))).rejects.toMatchObject({ status: 400 });
        await expect(scheduler.run("q", async () => "ok")).resolves.toBe("ok");
    });
});

describe("scheduledProxy", () => {
    function fakeProxy() {
        const executeDax = vi.fn(async () => ({ data: new ArrayBuffer(0), requestId: "r" }));
        const executeDaxJson = vi.fn(async () => ({ data: {}, requestId: "r" }));
        const inner = {
            semanticModel: { executeDax, executeDaxJson },
            lakehouse: { executeSql: vi.fn() },
            warehouse: { executeSql: vi.fn() },
        } as unknown as IFabricApiProxy;
        return { inner, executeDax, executeDaxJson };
    }

    it("sends identical concurrent DAX once, and different DAX separately", async () => {
        const { inner, executeDax, executeDaxJson } = fakeProxy();
        const proxy = scheduledProxy(inner, new QueryScheduler());
        await Promise.all([
            proxy.semanticModel.executeDax("ws", "m", "EVALUATE A"),
            proxy.semanticModel.executeDax("ws", "m", "EVALUATE A"),
            proxy.semanticModel.executeDax("ws", "m", "EVALUATE B"),
            proxy.semanticModel.executeDaxJson("ws", "m", "EVALUATE A"),
        ]);
        expect(executeDax).toHaveBeenCalledTimes(2);
        expect(executeDaxJson).toHaveBeenCalledTimes(1);
    });

    it("passes the lakehouse and warehouse through untouched", () => {
        const { inner } = fakeProxy();
        const proxy = scheduledProxy(inner);
        expect(proxy.lakehouse).toBe(inner.lakehouse);
        expect(proxy.warehouse).toBe(inner.warehouse);
    });
});
