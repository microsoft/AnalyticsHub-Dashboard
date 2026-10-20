//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, render, act, waitFor } from "@testing-library/react";
import { FabricApiProxyError } from "@microsoft/fabric-app-data";
import { createElement } from "react";
import { useSemanticModelQuery, useSpeculativeQuery, clearQueryCache } from "@/hooks/use-semantic-model-query";
import { currentCaller, type QueryCaller } from "@/lib/query-priority";
import { BUSY_MESSAGE, QueryScheduler, recoveriesOf } from "@/lib/query-scheduler";

// Mock the Fabric client module so tests run offline.
const mockClearCache = vi.fn();
const mockSemanticModelClearCache = vi.fn();
const mockQuery = vi.fn();

vi.mock("@/lib/fabric-client", () => ({
    QUERY_CACHE_MAX_AGE_MS: 60 * 60 * 1000,
    getFabricClient: () => ({
        clearCache: mockClearCache,
        semanticModel: () => ({
            query: mockQuery,
            clearCache: mockSemanticModelClearCache,
        }),
    }),
}));

describe("useSemanticModelQuery", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("starts in the loading state", () => {
        mockQuery.mockReturnValue(new Promise(() => {})); // never resolves

        const { result } = renderHook(() =>
            useSemanticModelQuery({ connection: "model", query: "EVALUATE ROW()" }),
        );

        expect(result.current.isLoading).toBe(true);
        expect(result.current.data).toBeUndefined();
        expect(result.current.error).toBeUndefined();
    });

    it("returns data on a successful query", async () => {
        const successResult = {
            status: "success" as const,
            table: { columns: [{ name: "Value" }], rows: [[1]] },
            fromCache: false,
            cachedAt: undefined,
        };
        mockQuery.mockResolvedValue(successResult);

        const { result } = renderHook(() =>
            useSemanticModelQuery({ connection: "model", query: "EVALUATE ROW()" }),
        );

        await waitFor(() => expect(result.current.isLoading).toBe(false));

        expect(result.current.data).toEqual(successResult);
        expect(result.current.error).toBeUndefined();
    });

    it("exposes an error when the query result has status 'error'", async () => {
        const errorResult = {
            status: "error" as const,
            error: { message: "401 Unauthorized" },
        };
        mockQuery.mockResolvedValue(errorResult);

        const { result } = renderHook(() =>
            useSemanticModelQuery({ connection: "model", query: "EVALUATE ROW()" }),
        );

        await waitFor(() => expect(result.current.isLoading).toBe(false));

        expect(result.current.error?.message).toBe("401 Unauthorized");
    });

    it("re-executes the query when refetch is called", async () => {
        const successResult = {
            status: "success" as const,
            table: { columns: [], rows: [] },
            fromCache: false,
            cachedAt: undefined,
        };
        mockQuery.mockResolvedValue(successResult);

        const { result } = renderHook(() =>
            useSemanticModelQuery({ connection: "model", query: "EVALUATE ROW()" }),
        );

        await waitFor(() => expect(result.current.isLoading).toBe(false));
        expect(mockQuery).toHaveBeenCalledTimes(1);

        await act(async () => {
            await result.current.refetch();
        });

        expect(mockQuery).toHaveBeenCalledTimes(2);
        expect(mockQuery).toHaveBeenNthCalledWith(2, "EVALUATE ROW()", { bypassCache: undefined });
    });

    it("asks Power BI, not the cache, when Try again follows an error", async () => {
        const busy = { status: "error" as const, error: { category: "api", message: BUSY_MESSAGE }, fromCache: false };
        const answer = { status: "success" as const, table: { columns: [], rows: [[1]] }, fromCache: false };
        mockQuery.mockResolvedValueOnce(busy).mockResolvedValueOnce(answer);

        const { result } = renderHook(() => useSemanticModelQuery({ connection: "model", query: "EVALUATE ROW()" }));
        await waitFor(() => expect(result.current.isLoading).toBe(false));
        expect(result.current.error?.message).toBe(BUSY_MESSAGE);

        await act(async () => {
            await result.current.refetch();
        });

        expect(mockQuery).toHaveBeenNthCalledWith(2, "EVALUATE ROW()", { bypassCache: true });
        expect(result.current.data).toEqual(answer);
        expect(result.current.error).toBeUndefined();
    });

    it("asks again when the cache kept a busy error, but not a real query error", async () => {
        const kept = { status: "error" as const, error: { category: "query", message: "Too many requests" }, fromCache: true, cachedAt: new Date() };
        const answer = { status: "success" as const, table: { columns: [], rows: [[1]] }, fromCache: false };
        mockQuery.mockResolvedValueOnce(kept).mockResolvedValueOnce(answer);

        const { result } = renderHook(() => useSemanticModelQuery({ connection: "model", query: "Q" }));
        await waitFor(() => expect(result.current.data).toEqual(answer));
        expect(mockQuery).toHaveBeenNthCalledWith(2, "Q", { bypassCache: true });

        mockQuery.mockReset();
        const wrong = { ...kept, error: { category: "query", message: "Cannot find table 'X'." } };
        mockQuery.mockResolvedValue(wrong);
        const second = renderHook(() => useSemanticModelQuery({ connection: "model", query: "R" }));
        await waitFor(() => expect(second.result.current.isLoading).toBe(false));
        expect(second.result.current.error?.message).toBe("Cannot find table 'X'.");
        expect(mockQuery).toHaveBeenCalledOnce();
    });

    it("stops loading when its query is cleared while one is still loading", async () => {
        mockQuery.mockReturnValue(new Promise(() => {}));
        const { result, rerender } = renderHook(({ query }) => useSemanticModelQuery({ connection: "model", query }), {
            initialProps: { query: "Q" },
        });
        expect(result.current.isLoading).toBe(true);

        rerender({ query: "" });
        await waitFor(() => expect(result.current.isLoading).toBe(false));
        expect(mockQuery).toHaveBeenCalledOnce();
    });
});

describe("useSemanticModelQuery, once a card has moved on", () => {
    type Sent = { query: string; options: unknown; caller: QueryCaller | undefined; answer: (value: unknown) => void };
    let sent: Sent[];
    let clock = 0;
    const busy = { status: "error" as const, error: { category: "api", message: BUSY_MESSAGE }, fromCache: false };
    const answer = (value: number) => ({ status: "success" as const, table: { columns: [{ name: "Value" }], rows: [[value]] }, fromCache: false });

    beforeEach(() => {
        mockQuery.mockReset();
        sent = [];
        mockQuery.mockImplementation((query: string, options: unknown) => new Promise((resolve) => {
            sent.push({ query, options, caller: currentCaller(), answer: resolve });
        }));
    });

    /** `model` throttles a query, then answers another, as a scheduler hears it: cards left busy on it ask again. */
    async function recover(model: string) {
        const scheduler = new QueryScheduler({ maxRetries: 0, random: () => 0, log: () => {}, now: () => clock, backgroundHoldMs: 0 });
        const throttle = new FabricApiProxyError({ status: 429, requestId: "r", sessionId: "s", body: "", message: "HTTP 429" });
        await scheduler.run("throttle", () => Promise.reject(throttle), "normal", model).catch(() => {});
        clock += 60 * 60 * 1000;
        const before = recoveriesOf(model);
        await act(async () => {
            await scheduler.run("health", async () => "ok", "normal", model);
        });
        expect(recoveriesOf(model)).toBe(before + 1);
    }

    it.each([
        { change: "model", from: { connection: "a", query: "OLD" }, to: { connection: "b", query: "NEW" } },
        { change: "query", from: { connection: "a", query: "OLD" }, to: { connection: "a", query: "NEW" } },
    ])("ignores what its old query reports once it changes $change, and asks again when its new model answers", async ({ change, from, to }) => {
        const oldModel = `ws/moved-${change}-${from.connection}`;
        const newModel = `ws/moved-${change}-${to.connection}`;
        const { result, rerender } = renderHook((props) => useSemanticModelQuery(props), { initialProps: from });
        const old = sent[0];
        old.caller?.asking?.(oldModel);

        rerender(to);
        const current = sent[1];
        expect(current.query).toBe("NEW");
        current.caller?.asking?.(newModel);
        current.caller?.gaveUp?.(newModel, recoveriesOf(newModel));
        await act(async () => current.answer(busy));
        expect(result.current.error?.message).toBe(BUSY_MESSAGE);

        // The old query reports late, as if from a request that began after its model last answered again.
        old.caller?.asking?.(oldModel);
        old.caller?.gaveUp?.(oldModel, recoveriesOf(oldModel) + 1);
        await act(async () => old.answer(answer(7777)));
        expect(result.current).toMatchObject({ data: busy, isLoading: false });
        expect(result.current.error?.message).toBe(BUSY_MESSAGE);

        await recover(newModel);
        expect(sent).toHaveLength(3);
        expect(sent[2]).toMatchObject({ query: "NEW", options: { bypassCache: true } });
        await act(async () => sent[2].answer(answer(1111)));
        expect(result.current).toMatchObject({ data: answer(1111), error: undefined, isLoading: false });
    });

    it("shows only its latest ask's answer when an earlier ask answers last", async () => {
        const { result } = renderHook(() => useSemanticModelQuery({ connection: "a", query: "Q" }));
        await act(async () => sent[0].answer(answer(1)));
        let first!: Promise<void>;
        let second!: Promise<void>;
        act(() => {
            first = result.current.refetch();
        });
        act(() => {
            second = result.current.refetch();
        });
        expect(sent).toHaveLength(3);
        expect(result.current.isLoading).toBe(true);

        await act(async () => {
            sent[2].answer(answer(2));
            await second;
        });
        expect(result.current).toMatchObject({ data: answer(2), error: undefined, isLoading: false });
        await act(async () => {
            sent[1].answer(busy);
            await first;
        });
        expect(result.current).toMatchObject({ data: answer(2), error: undefined, isLoading: false });
        expect(sent).toHaveLength(3);
    });

    it("does nothing for a Try again kept from before it changed query", async () => {
        const { result, rerender } = renderHook((props) => useSemanticModelQuery(props), { initialProps: { connection: "a", query: "OLD" } });
        await act(async () => sent[0].answer(busy));
        const kept = result.current.refetch;
        rerender({ connection: "a", query: "NEW" });
        await act(async () => sent[1].answer(answer(1111)));

        act(() => {
            void kept();
        });
        expect(sent.map(({ query }) => query)).toEqual(["OLD", "NEW"]);
        expect(result.current).toMatchObject({ data: answer(1111), error: undefined, isLoading: false });
    });

    it("asks as a lead card, Try again too, only when the page's first view waits on it", async () => {
        const { result } = renderHook(() => useSemanticModelQuery({ connection: "a", query: "Q", lead: true }));
        expect(sent[0].caller?.lead).toBe(true);
        await act(async () => sent[0].answer(busy));
        act(() => {
            void result.current.refetch();
        });
        expect(sent[1]).toMatchObject({ query: "Q", options: { bypassCache: true } });
        expect(sent[1].caller?.lead).toBe(true);

        renderHook(() => useSemanticModelQuery({ connection: "a", query: "R" }));
        expect(sent[2].caller?.lead).toBeFalsy();
    });

    it.each([
        { from: false, to: true },
        { from: true, to: false },
    ])("keeps its query in flight when lead turns from $from to $to, and asks next time as it now says", async ({ from, to }) => {
        const { result, rerender } = renderHook((props) => useSemanticModelQuery(props), {
            initialProps: { connection: "a", query: "Q", lead: from },
        });
        expect(sent[0].caller?.lead).toBe(from);

        rerender({ connection: "a", query: "Q", lead: to });
        expect(sent).toHaveLength(1);
        expect(sent[0].caller?.signal?.aborted).toBe(false);

        await act(async () => sent[0].answer(busy));
        expect(result.current).toMatchObject({ data: busy, isLoading: false });
        act(() => {
            void result.current.refetch();
        });
        expect(sent).toHaveLength(2);
        expect(sent[1]).toMatchObject({ query: "Q", options: { bypassCache: true } });
        expect(sent[1].caller?.lead).toBe(to);
    });
});

describe("useSpeculativeQuery", () => {
    type Sent = { query: string; options: unknown; caller: QueryCaller | undefined };
    let sent: Sent[];

    beforeEach(() => {
        mockQuery.mockReset();
        sent = [];
        mockQuery.mockImplementation((query: string, options: unknown) => {
            sent.push({ query, options, caller: currentCaller() });
            return new Promise(() => {});
        });
    });

    it("asks once, keeps its query on its way when lead changes, and calls it off once the query changes or the page goes", () => {
        const { rerender, unmount } = renderHook((props) => useSpeculativeQuery(props), {
            initialProps: { connection: "vl", query: "Q", lead: true },
        });
        expect(sent).toEqual([{ query: "Q", options: undefined, caller: expect.objectContaining({ lead: true }) }]);
        const first = sent[0].caller?.signal;
        expect(first?.aborted).toBe(false);

        rerender({ connection: "vl", query: "Q", lead: false });
        expect(sent).toHaveLength(1);
        expect(first?.aborted).toBe(false);

        rerender({ connection: "vl", query: "R", lead: false });
        expect(first?.aborted).toBe(true);
        expect(sent.map(({ query }) => query)).toEqual(["Q", "R"]);
        expect(sent[1].caller?.lead).toBe(false);

        unmount();
        expect(sent[1].caller?.signal?.aborted).toBe(true);
    });

    it("asks nothing without a query", () => {
        renderHook(() => useSpeculativeQuery({ connection: "vl", query: "" }));
        expect(sent).toEqual([]);
    });

    it("leaves the page standing when its query can't even start, for the card to say why when it asks", () => {
        mockQuery.mockImplementation(() => {
            throw new Error("No semantic model is set up as 'vl'.");
        });
        function Page() {
            useSpeculativeQuery({ connection: "vl", query: "Q", lead: true });
            return createElement("p", null, "The bottom line");
        }
        const { container } = render(createElement(Page));
        expect(container.textContent).toBe("The bottom line");
    });

    it("asks before the cards below it, whose effects React runs first", () => {
        function Card() {
            useSemanticModelQuery({ connection: "vl", query: "CARD" });
            return null;
        }
        function Page() {
            useSpeculativeQuery({ connection: "vl", query: "PAGE", lead: true });
            return createElement(Card);
        }
        render(createElement(Page));
        expect(sent.map(({ query }) => query)).toEqual(["PAGE", "CARD"]);
    });

    it("calls its query off only once the card asking the same one has joined it", () => {
        const events: string[] = [];
        mockQuery.mockImplementation((query: string) => {
            events.push(`ask ${query}`);
            currentCaller()?.signal?.addEventListener("abort", () => events.push(`call off ${query}`));
            return new Promise(() => {});
        });
        function Summary({ known }: { known: boolean }) {
            useSemanticModelQuery({ connection: "vl", query: known ? "Q" : "" });
            useSpeculativeQuery({ connection: "vl", query: known ? "" : "Q", lead: true });
            return null;
        }
        const { rerender } = render(createElement(Summary, { known: false }));
        expect(events).toEqual(["ask Q"]);

        rerender(createElement(Summary, { known: true }));
        expect(events).toEqual(["ask Q", "ask Q", "call off Q"]);
    });
});

describe("useSemanticModelQuery's cache age", () => {
    const hourAndASecond = 60 * 60 * 1000 + 1000;
    const fresh = { status: "success" as const, table: { columns: [], rows: [[1]] }, fromCache: false };

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("uses a result the SDK has held for less than an hour", async () => {
        const held = { ...fresh, fromCache: true, cachedAt: new Date(Date.now() - 60_000) };
        mockQuery.mockResolvedValue(held);

        const { result } = renderHook(() => useSemanticModelQuery({ connection: "vl", query: "Q" }));

        await waitFor(() => expect(result.current.isLoading).toBe(false));
        expect(result.current.data).toEqual(held);
        expect(mockQuery).toHaveBeenCalledOnce();
    });

    it("asks the model again for a result held longer than an hour", async () => {
        const old = { ...fresh, table: { columns: [], rows: [[0]] }, fromCache: true, cachedAt: new Date(Date.now() - hourAndASecond) };
        mockQuery.mockResolvedValueOnce(old).mockResolvedValueOnce(fresh);

        const { result } = renderHook(() => useSemanticModelQuery({ connection: "vl", query: "Q" }));

        await waitFor(() => expect(result.current.isLoading).toBe(false));
        expect(result.current.data).toEqual(fresh);
        expect(mockQuery).toHaveBeenNthCalledWith(1, "Q", { bypassCache: undefined });
        expect(mockQuery).toHaveBeenNthCalledWith(2, "Q", { bypassCache: true });
    });
});

describe("clearQueryCache", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("clears all caches when called without an argument", () => {
        clearQueryCache();
        expect(mockClearCache).toHaveBeenCalledOnce();
        expect(mockSemanticModelClearCache).not.toHaveBeenCalled();
    });

    it("clears only the specified model cache when called with a connection alias", () => {
        clearQueryCache("salesModel");
        expect(mockSemanticModelClearCache).toHaveBeenCalledOnce();
        expect(mockClearCache).not.toHaveBeenCalled();
    });
});
