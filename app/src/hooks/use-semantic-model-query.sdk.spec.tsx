//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { FabricClient, type FabricClientConfig, type IFabricApiProxy } from "@microsoft/fabric-app-data";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryError } from "@/components/query-states";
import { PrefetchContext } from "@/hooks/prefetch.context";
import { useSemanticModelQuery } from "@/hooks/use-semantic-model-query";
import { BUSY_MESSAGE, QueryScheduler, scheduledProxy } from "@/lib/query-scheduler";

const state = vi.hoisted(() => ({ client: undefined as unknown }));

// The app's own scheduler isn't the one below: a busy card hears its model recover from any scheduler.
vi.mock("@/lib/fabric-client", async (original) => ({
    ...(await original<typeof import("@/lib/fabric-client")>()),
    getFabricClient: () => state.client,
}));

const THROTTLED = { error: { code: "TooManyRequests", message: "Too many requests" } };
const ANSWER = { results: [{ tables: [{ rows: [{ "[Value]": 1 }] }] }] };

/** The real SDK and scheduler, with Power BI replaced by `reply`. */
function setup(reply: (model: string, query: string) => unknown) {
    const scheduler = new QueryScheduler({ random: () => 0, log: () => {} });
    const executeDaxJson = vi.fn(async (_workspace: string, model: string, query: string) => ({
        requestId: "r",
        data: await reply(model, query),
    }));
    const inner = {
        semanticModel: { executeDax: vi.fn(), executeDaxJson },
        lakehouse: { executeSql: vi.fn() },
        warehouse: { executeSql: vi.fn() },
    } as unknown as IFabricApiProxy;
    state.client = new FabricClient({
        proxy: scheduledProxy(inner, scheduler),
        daxProtocol: "json",
        cache: { maxEntries: 1000 },
        semanticModels: { vl: { workspaceId: "ws", itemId: "model-a" }, cc: { workspaceId: "ws", itemId: "model-b" } },
    } as FabricClientConfig);
    const sent = (query: string) => executeDaxJson.mock.calls.filter((call) => call[2] === query).length;
    return { scheduler, executeDaxJson, sent };
}

const tick = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

describe("useSemanticModelQuery when its card goes", () => {
    it("stops asking a throttled model once the only card waiting has gone, and caches nothing for it", async () => {
        let reply: unknown = THROTTLED;
        const { scheduler, executeDaxJson } = setup(() => reply);
        const card = renderHook(() => useSemanticModelQuery({ connection: "vl", query: "Q" }));
        await tick(0);
        expect(executeDaxJson).toHaveBeenCalledTimes(1);

        card.unmount();
        await tick(60_000);
        expect(executeDaxJson).toHaveBeenCalledTimes(1);
        expect(scheduler.activity()).toMatchObject({ foreground: 0, background: 0 });

        reply = ANSWER;
        const next = renderHook(() => useSemanticModelQuery({ connection: "vl", query: "Q" }));
        await tick(0);
        expect(next.result.current.data).toMatchObject({ status: "success", fromCache: false });
        expect(executeDaxJson).toHaveBeenCalledTimes(2);
    });

    it("keeps trying for a card still showing the same query", async () => {
        let reply: unknown = THROTTLED;
        const { executeDaxJson } = setup(() => reply);
        const one = renderHook(() => useSemanticModelQuery({ connection: "vl", query: "Q" }));
        const two = renderHook(() => useSemanticModelQuery({ connection: "vl", query: "Q" }));
        await tick(0);
        expect(executeDaxJson).toHaveBeenCalledTimes(1);

        reply = ANSWER;
        one.unmount();
        await tick(500);
        expect(two.result.current.data).toMatchObject({ status: "success" });
        expect(executeDaxJson).toHaveBeenCalledTimes(2);
    });
});

describe("useSemanticModelQuery after Power BI was busy", () => {
    it("asks a busy card's own query again once its model answers Try again on another card, and leaves other models' cards alone", async () => {
        const throttling = new Set(["model-a", "model-b"]);
        const { sent } = setup((model) => (throttling.has(model) ? THROTTLED : ANSWER));
        const options = renderHook(() => useSemanticModelQuery({ connection: "vl", query: "OPTIONS" }));
        const summary = renderHook(() => useSemanticModelQuery({ connection: "vl", query: "SUMMARY" }));
        const other = renderHook(() => useSemanticModelQuery({ connection: "cc", query: "CREDITS" }));
        // Every card gives up, then each model's last pause runs out.
        await tick(90_000);
        for (const card of [options, summary, other]) expect(card.result.current.error?.message).toBe(BUSY_MESSAGE);
        const before = { summary: sent("SUMMARY"), credits: sent("CREDITS") };

        throttling.clear();
        act(() => void options.result.current.refetch());
        await tick(0);

        expect(options.result.current.data).toMatchObject({ status: "success" });
        expect(sent("SUMMARY")).toBe(before.summary + 1);
        expect(summary.result.current.data).toMatchObject({ status: "success", fromCache: false });
        expect(summary.result.current.error).toBeUndefined();
        expect(summary.result.current.isLoading).toBe(false);
        expect(sent("CREDITS")).toBe(before.credits);
        expect(other.result.current.error?.message).toBe(BUSY_MESSAGE);
    });

    it("clears a busy card hidden behind the page's busy card once Try again on the page's card finds the model answering", async () => {
        let throttling = true;
        const { executeDaxJson, sent } = setup(() => (throttling ? THROTTLED : ANSWER));
        // As the Executive summary: the page's filter choices hold back the stages, which still ask for the summary.
        function Page() {
            const summary = useSemanticModelQuery({ connection: "vl", query: "SUMMARY" });
            const options = useSemanticModelQuery({ connection: "vl", query: "OPTIONS" });
            if (options.error) return <QueryError message={options.error.message} onRetry={options.refetch} />;
            if (summary.error) return <QueryError message={summary.error.message} onRetry={summary.refetch} />;
            return <p>{summary.data?.status === "success" ? "The bottom line" : "Loading"}</p>;
        }
        render(<Page />);
        await tick(90_000);
        expect(screen.getAllByText("Power BI is busy")).toHaveLength(1);
        const before = executeDaxJson.mock.calls.length;
        const summaries = sent("SUMMARY");

        throttling = false;
        fireEvent.click(screen.getByRole("button", { name: "Try again" }));
        await tick(0);

        const after = executeDaxJson.mock.calls.slice(before).map((call) => call[2]);
        expect(after).toEqual(["OPTIONS", "SUMMARY"]);
        expect(sent("SUMMARY")).toBe(summaries + 1);
        expect(screen.getByText("The bottom line")).toBeTruthy();
        expect(screen.queryByText("Power BI is busy")).toBeNull();
    });

    it("leaves a card alone that never showed the busy message, and a card that has gone", async () => {
        let throttling = true;
        const { sent } = setup((_model, query) => (throttling && query !== "FINE" ? THROTTLED : ANSWER));
        const fine = renderHook(() => useSemanticModelQuery({ connection: "vl", query: "FINE" }));
        const gone = renderHook(() => useSemanticModelQuery({ connection: "vl", query: "GONE" }));
        const options = renderHook(() => useSemanticModelQuery({ connection: "vl", query: "OPTIONS" }));
        await tick(90_000);
        expect(gone.result.current.error?.message).toBe(BUSY_MESSAGE);
        const before = { fine: sent("FINE"), gone: sent("GONE") };

        gone.unmount();
        throttling = false;
        act(() => void options.result.current.refetch());
        await tick(0);

        expect(options.result.current.data).toMatchObject({ status: "success" });
        expect(fine.result.current.data).toMatchObject({ status: "success" });
        expect(sent("FINE")).toBe(before.fine);
        expect(sent("GONE")).toBe(before.gone);
    });
});

describe("useSemanticModelQuery on a page fetched ahead while Power BI was busy", () => {
    it("sends the page's query when the page is opened long after the throttle, rather than giving up at once", async () => {
        let throttling = true;
        let answerProbe!: () => void;
        const probe = new Promise<void>((resolve) => {
            answerProbe = resolve;
        });
        const { sent } = setup(async (_model, query) => {
            if (query === "PROBE") await probe;
            return throttling ? THROTTLED : ANSWER;
        });
        const ahead = renderHook(() => useSemanticModelQuery({ connection: "vl", query: "Q" }), {
            wrapper: ({ children }) => <PrefetchContext.Provider value>{children}</PrefetchContext.Provider>,
        });
        await tick(0);
        throttling = false;
        // Fetching ahead waits for a query on screen to succeed.
        await tick(120_000);
        expect(sent("Q")).toBe(1);

        // Another card on the page tries the model first, and is still waiting for its answer.
        const other = renderHook(() => useSemanticModelQuery({ connection: "vl", query: "PROBE" }));
        await tick(0);
        const opened = renderHook(() => useSemanticModelQuery({ connection: "vl", query: "Q" }));
        await tick(10_000);
        expect(opened.result.current.error).toBeUndefined();
        expect(opened.result.current.isLoading).toBe(true);

        answerProbe();
        await tick(0);
        expect(other.result.current.data).toMatchObject({ status: "success" });
        expect(opened.result.current.data).toMatchObject({ status: "success" });
        expect(ahead.result.current.data).toMatchObject({ status: "success" });
        expect(sent("Q")).toBe(2);
    });
});
