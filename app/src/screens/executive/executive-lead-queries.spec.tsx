//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { act, cleanup, render } from "@testing-library/react";
import { FabricClient, type FabricClientConfig, type IFabricApiProxy } from "@microsoft/fabric-app-data";
import { useCssTheme } from "@microsoft/fabric-visuals";
import { tableFromArrays, tableToIPC } from "apache-arrow";
import type { ContextType, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FilterContext } from "@/hooks/filter.context";
import { onlyStages, StageFilterContext } from "@/hooks/stage-filter.context";
import { TaskTimesContext } from "@/hooks/task-times.context";
import { ThemeContext } from "@/hooks/theme.context";
import { defaultFilters } from "@/lib/filters";
import { DEFAULT_ORG_ATTRIBUTE, describeOrgAttribute } from "@/lib/org-attribute";
import { QueryScheduler, scheduledProxy } from "@/lib/query-scheduler";
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

/** The bottom line and the trend, as the page first opens: the app's saved task times may still be on their way. */
function page(taskTimes: "loading" | "ready") {
    return (
        <FilterContext.Provider value={FILTERS}>
            <TaskTimesContext.Provider value={{ status: taskTimes, saved: [], save: () => Promise.resolve() }}>
                <Themed>
                    <StageFilterContext.Provider value={onlyStages(["the-bottom-line", "is-it-growing"])}>
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
    it("asks the bottom line, then the trend, ahead of the queries already waiting once the task times are known", async () => {
        const { sent, scheduler, answerNext } = setup();
        const { rerender } = render(page("loading"));
        await tick(0);
        // Both show hours, so both wait for the task times.
        expect(sent).toEqual([]);

        // Meanwhile the page's other cards ask: one has the only slot, and the rest wait.
        const model = (state.client as FabricClient).semanticModel("vl");
        const others = ["A", "B", "C"].map((name) => `EVALUATE ROW("${name}", 1)`);
        for (const query of others) void model.query(query);
        await tick(0);
        expect(sent).toEqual([others[0]]);
        expect(scheduler.activity().foreground).toBe(3);

        rerender(page("ready"));
        await tick(0);
        expect(scheduler.activity().foreground).toBe(5);
        expect(sent).toEqual([others[0]]);

        for (let answered = 0; answered < 4; answered++) {
            answerNext();
            await tick(0);
        }
        expect(sent).toHaveLength(5);
        expect(sent[1]).toBe(SUMMARY);
        expect(isTrend(sent[2])).toBe(true);
        expect(sent.slice(3)).toEqual(others.slice(1));
    });
});
