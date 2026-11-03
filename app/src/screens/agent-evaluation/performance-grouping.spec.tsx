import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evaluationOrgAttributes, type EvaluationOptions } from "@/queries/agent-evaluation";
import { PerformanceStage } from "./performance-stage";

const state = vi.hoisted(() => ({
    inventory: undefined as unknown,
    eligibility: undefined as unknown,
    semantic: vi.fn(),
    table: vi.fn(),
}));

vi.mock("@/hooks/use-semantic-model-query", () => ({
    useSemanticModelQuery: (source: unknown) => {
        state.semantic(source);
        return { data: state.inventory, isLoading: false, error: undefined, refetch: vi.fn() };
    },
}));
vi.mock("@/hooks/use-table-query", () => ({
    useSummaryQuery: () => ({ row: undefined }),
    useTableQuery: (source: { query: string }) => {
        state.table(source);
        return {
            table: source.query.includes('"Kind", "Group by"') ? state.eligibility : undefined,
            isLoading: false, error: undefined, refetch: vi.fn(),
        };
    },
}));
vi.mock("@/hooks/theme.context", () => ({ useThemeContext: () => ({ theme: { colors: ["#000000"] } }) }));
vi.mock("@/hooks/use-palette-theme", () => ({ useOutcomeColors: () => undefined }));
vi.mock("@/lib/color-scale", () => ({
    outcomePalette: () => ({ positive: "#009900", negative: "#990000", neutral: "#999999", caution: "#999900" }),
    withColorScale: (spec: unknown) => spec,
}));
vi.mock("@/components/report-panels", () => ({
    ChartPanel: () => null, KpiRowState: () => null, NoteCard: () => null, Panel: () => null,
}));
vi.mock("@microsoft/fabric-datagrid", () => ({ DataGrid: () => null }));

const OPTIONS: EvaluationOptions = {
    firstDate: "2026-01-01", lastDate: "2026-02-01", departments: [], agents: [],
    groupCounts: { agent: 2, theme: 2, topic: 2 },
};

function openGrouping() {
    const panel = document.querySelector('[role="dialog"][aria-label="Group by"]')!;
    const event = new Event("toggle");
    Object.defineProperty(event, "newState", { value: "open" });
    fireEvent(panel, event);
}

beforeEach(() => {
    state.inventory = undefined;
    state.eligibility = undefined;
});

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});

describe("Evaluator grouping menu", () => {
    it("does not start inventory or per-column conversation scans before the menu opens", () => {
        render(<PerformanceStage options={OPTIONS} extra={[]} />);
        expect(state.semantic).toHaveBeenLastCalledWith({ ...evaluationOrgAttributes(), query: "" });
        expect(state.table.mock.calls.some(([source]) => source.query.includes('"Kind", "Group by"'))).toBe(false);
        openGrouping();
        expect(state.semantic).toHaveBeenLastCalledWith(evaluationOrgAttributes());
    });

    it("offers only discovered eligible columns and uses their actual Evaluator reference", () => {
        const view = render(<PerformanceStage options={OPTIONS} extra={[]} />);
        openGrouping();
        act(() => {
            state.inventory = {
                status: "success",
                table: {
                    columns: [{ name: "[Column]" }],
                    rows: [["CostCenterId"], ["Sparse"], ["PersonId"]],
                },
            };
        });
        view.rerender(<PerformanceStage options={OPTIONS} extra={[]} />);
        const query = state.table.mock.calls.find(([source]) => source.query.includes('"Kind", "Group by"'))?.[0].query;
        expect(query).toContain("'Org Attribute Source'[Value]");
        expect(query).toContain('TREATAS({"CostCenterId"}, \'Org Attribute Source\'[Attribute])');
        expect(query).not.toContain('"PersonId"');
        expect(screen.queryByRole("button", { name: "Cost center id", hidden: true })).toBeNull();
        act(() => {
            state.eligibility = {
                columns: [{ name: "Kind" }, { name: "Value" }, { name: "Sort" }],
                rows: [["Group by", "org:CostCenterId", 2], ["Group by", "org:Sparse", 1]],
            };
        });
        view.rerender(<PerformanceStage options={OPTIONS} extra={[]} />);
        fireEvent.click(screen.getByRole("button", { name: "Cost center id", hidden: true }));
        expect(screen.queryByRole("button", { name: "Sparse", hidden: true })).toBeNull();
        expect(state.table.mock.calls.some(([source]) =>
            source.query.includes('"@Resolution"') &&
            source.query.includes("'Org Attribute Source'[Value],") &&
            source.query.includes('TREATAS({"CostCenterId"}, \'Org Attribute Source\'[Attribute])'),
        )).toBe(true);
    });

    it("keeps the menu available when every built-in grouping has fewer than two groups", () => {
        render(<PerformanceStage options={{ ...OPTIONS, groupCounts: {} }} extra={[]} />);
        expect(screen.getByRole("button", { name: /Group by.*No groups to compare/ })).toBeTruthy();
        openGrouping();
        expect(state.semantic).toHaveBeenLastCalledWith(evaluationOrgAttributes());
    });
});
