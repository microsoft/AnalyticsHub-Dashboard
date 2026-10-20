//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { act, cleanup, render, screen } from "@testing-library/react";
import { FabricClient, type FabricClientConfig, type IFabricApiProxy } from "@microsoft/fabric-app-data";
import { useCssTheme } from "@microsoft/fabric-visuals";
import { tableFromArrays, tableToIPC } from "apache-arrow";
import type { ContextType, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FilterContext } from "@/hooks/filter.context";
import { onlyStages, StageFilterContext, type StageFilter } from "@/hooks/stage-filter.context";
import { TaskTimesContext } from "@/hooks/task-times.context";
import { ThemeContext } from "@/hooks/theme.context";
import { defaultFilters } from "@/lib/filters";
import { DEFAULT_ORG_ATTRIBUTE, describeOrgAttribute } from "@/lib/org-attribute";
import { withPriority } from "@/lib/query-priority";
import { QueryScheduler, scheduledProxy } from "@/lib/query-scheduler";
import type { SavedTaskTime } from "@/lib/settings-store";
import { withTaskTimes } from "@/queries/assumptions/task-times";
import { executiveSummary } from "@/queries/executive";
import { ExecutiveScreen } from ".";

const state = vi.hoisted(() => ({ client: undefined as unknown }));

vi.mock("@/lib/fabric-client", async (original) => ({
    ...(await original<typeof import("@/lib/fabric-client")>()),
    getFabricClient: () => state.client,
}));

vi.mock("@/lib/runtime-config", async (original) => ({
    ...(await original<typeof import("@/lib/runtime-config")>()),
    runtimeConfig: () => ({ rayfin: {}, semanticModels: { vl: { workspaceId: "ws", itemId: "model" } } }),
}));

vi.mock("@/components/commercial-terms-provider", () => ({
    CommercialTermsProvider: ({ children }: { children: ReactNode }) => children,
}));

const SUMMARY = executiveSummary().query;
/** One task's own times, saved in the app: the summary at them is another query. */
const SAVED: readonly SavedTaskTime[] = [{ task: "Summarise a meeting", low: 5, typical: 10, high: 20 }];
const TIMED = withTaskTimes(SUMMARY, SAVED);
const OPENING = onlyStages(["the-bottom-line", "is-it-growing"]);
const EVERY_STAGE = onlyStages(["the-bottom-line", "is-it-growing", "where-it-is-landing", "what-needs-attention"]);
const isTrend = (query: string | undefined) => query?.includes('"Month Start"') === true;
const tick = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

const FILTERS: ContextType<typeof FilterContext> = {
    filters: defaultFilters,
    setFilters: () => undefined,
    options: { agentTypes: [], agentNames: [], activities: [], firstDate: "2026-05-08", lastDate: "2026-07-06" },
    optionsError: undefined,
    applicable: [],
    orgAttribute: describeOrgAttribute(DEFAULT_ORG_ATTRIBUTE),
    orgAttributes: [DEFAULT_ORG_ATTRIBUTE],
    orgValues: undefined,
};

function answerTable(query: string): ArrayBuffer {
    const columns: Record<string, unknown[]> =
        query === SUMMARY
            ? { "[Hours]": [4321], "[Tasks]": [9876], "[Licensed Seats]": [20], "[Seats In Use]": [10] }
            : query === TIMED
              ? { "[Hours]": [5555], "[Tasks]": [9876], "[Licensed Seats]": [20], "[Seats In Use]": [10] }
              : { "[Value]": [] as string[] };
    return tableToIPC(tableFromArrays(columns), "stream").slice().buffer;
}

/** The real SDK and scheduler with one slot, so a queue forms; each query is held until `answerNext()`. */
function setup() {
    const sent: string[] = [];
    const held: Array<() => void> = [];
    const executeDax = vi.fn(
        (_workspace: string, _model: string, query: string) =>
            new Promise<{ requestId: string; data: ArrayBuffer }>((resolve) => {
                sent.push(query);
                held.push(() => resolve({ requestId: "r", data: answerTable(query) }));
            }),
    );
    const inner = { semanticModel: { executeDax } } as unknown as IFabricApiProxy;
    const scheduler = new QueryScheduler({ concurrency: 1, log: () => {} });
    state.client = new FabricClient({
        proxy: scheduledProxy(inner, scheduler),
        daxProtocol: "arrow",
        cache: { maxEntries: 1000 },
        semanticModels: { vl: { workspaceId: "ws", itemId: "model" } },
    } as FabricClientConfig);
    return { sent, scheduler, answerNext: () => held.shift()?.() };
}

function Themed({ children }: { children: ReactNode }) {
    const theme = useCssTheme();
    return <ThemeContext.Provider value={{ theme, isDark: false, toggleTheme: () => {} }}>{children}</ThemeContext.Provider>;
}

/** The page as it first opens, by default its bottom line and trend: the app's saved task times may still be on their way. */
function page(taskTimes: "loading" | "ready", saved: readonly SavedTaskTime[] = [], stages: StageFilter = OPENING) {
    return (
        <FilterContext.Provider value={FILTERS}>
            <TaskTimesContext.Provider value={{ status: taskTimes, saved, save: () => Promise.resolve() }}>
                <Themed>
                    <StageFilterContext.Provider value={stages}>
                        <ExecutiveScreen />
                    </StageFilterContext.Provider>
                </Themed>
            </TaskTimesContext.Provider>
        </FilterContext.Provider>
    );
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.stubGlobal(
        "ResizeObserver",
        class {
            observe() {}
            unobserve() {}
            disconnect() {}
        },
    );
});

afterEach(() => {
    cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe("Executive summary on a cold open", () => {
    it("asks the bottom line from the first query, and the trend ahead of the queries already waiting once the task times are known", async () => {
        const { sent, scheduler, answerNext } = setup();
        const { rerender } = render(page("loading"));
        await tick(0);
        // The bottom line doesn't wait for the task times: it's asked at the model's own. The trend waits.
        expect(sent).toEqual([SUMMARY]);

        // Meanwhile the page's other cards ask, and wait behind it for the only slot.
        const model = (state.client as FabricClient).semanticModel("vl");
        const others = ["A", "B", "C"].map((name) => `EVALUATE ROW("${name}", 1)`);
        for (const query of others) void model.query(query);
        await tick(0);
        expect(sent).toEqual([SUMMARY]);
        expect(scheduler.activity().foreground).toBe(4);

        // None are saved, so the bottom line waits for the query already on its way, and the trend queues ahead of the rest.
        rerender(page("ready"));
        await tick(0);
        expect(scheduler.activity().foreground).toBe(5);
        expect(sent).toEqual([SUMMARY]);

        answerNext();
        await tick(0);
        expect(screen.getByText("4,321")).toBeTruthy();
        for (let answered = 1; answered < 4; answered++) {
            answerNext();
            await tick(0);
        }
        expect(sent).toHaveLength(5);
        expect(sent[0]).toBe(SUMMARY);
        expect(isTrend(sent[1])).toBe(true);
        expect(sent.slice(2)).toEqual(others);
    });

    it("shows nothing from an answer that comes before the task times, then reads it from the cache once none turn out to be saved", async () => {
        const { sent, answerNext } = setup();
        const { rerender } = render(page("loading"));
        await tick(0);
        answerNext();
        await tick(0);
        expect(screen.queryByText("4,321")).toBeNull();

        rerender(page("ready"));
        await tick(0);
        expect(screen.getByText("4,321")).toBeTruthy();
        expect(sent.filter((query) => query === SUMMARY)).toHaveLength(1);
        expect(isTrend(sent[1])).toBe(true);
    });

    it("asks the bottom line again at the task times saved in the app, and never shows the answer at the model's own", async () => {
        const { sent, answerNext } = setup();
        const { rerender } = render(page("loading"));
        await tick(0);
        expect(sent).toEqual([SUMMARY]);

        rerender(page("ready", SAVED));
        await tick(0);
        answerNext();
        await tick(0);
        expect(sent).toEqual([SUMMARY, TIMED]);
        expect(screen.queryByText("4,321")).toBeNull();

        answerNext();
        await tick(0);
        expect(screen.getByText("5,555")).toBeTruthy();
        expect(screen.queryByText("4,321")).toBeNull();
        expect(isTrend(sent[2])).toBe(true);
    });

    it("asks the bottom line before the queries of the stages below it", async () => {
        const { sent, scheduler } = setup();
        render(page("loading", [], EVERY_STAGE));
        await tick(0);
        expect(sent).toEqual([SUMMARY]);
        // The stages below asked too, and wait behind it.
        expect(scheduler.activity().foreground).toBeGreaterThan(1);
    });

    it("keeps the bottom line's place in the queue when the task times come while it waits, none saved", async () => {
        const { sent, answerNext } = setup();
        const model = (state.client as FabricClient).semanticModel("vl");
        // The app's own first queries may hold every slot as the page opens.
        const FIRST = 'EVALUATE ROW("First", 1)';
        void model.query(FIRST);
        await tick(0);
        const { rerender } = render(page("loading"));
        await tick(0);
        expect(sent).toEqual([FIRST]);

        // Another query the page's first view waits on queues behind it meanwhile.
        const LEAD = 'EVALUATE ROW("Lead", 1)';
        void withPriority("normal", () => model.query(LEAD), { lead: true });
        rerender(page("ready"));
        await tick(0);

        answerNext();
        await tick(0);
        expect(sent).toEqual([FIRST, SUMMARY]);
        answerNext();
        await tick(0);
        expect(screen.getByText("4,321")).toBeTruthy();
        expect(sent).toEqual([FIRST, SUMMARY, LEAD]);
        answerNext();
        await tick(0);
        expect(isTrend(sent[3])).toBe(true);
    });
});
