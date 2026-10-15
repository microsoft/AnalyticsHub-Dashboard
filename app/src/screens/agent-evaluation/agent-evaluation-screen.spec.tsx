//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluatorStatus } from "@/queries/agent-evaluation";
import { AgentEvaluationScreen } from "./index";

const { useTableQuery, useSemanticModelQuery } = vi.hoisted(() => ({ useTableQuery: vi.fn(), useSemanticModelQuery: vi.fn() }));
vi.mock("@/hooks/use-table-query", () => ({ useTableQuery }));
vi.mock("@/hooks/use-semantic-model-query", () => ({ useSemanticModelQuery }));
vi.mock("@/hooks/stage-filter.context", () => ({ useStageFilter: () => ({ show: () => false, inPack: false }) }));
vi.mock("./evaluation-bar", () => ({ EvaluationBar: () => null }));

/** An options answer with no dates, departments or agents: a model without conversations. */
const NO_DATA = {
    table: { columns: [{ name: "Kind" }, { name: "Value" }, { name: "Sort" }], rows: [] },
    error: undefined,
    isLoading: false,
    refetch: vi.fn(),
};

const STATUS = {
    status: "success",
    table: {
        columns: [{ name: "[Environment]" }, { name: "[Lookback Days]" }, { name: "[Transcripts]" }, { name: "[Status]" }],
        rows: [["Contoso (default)", 180, 0, "empty"]],
    },
};

afterEach(() => {
    vi.clearAllMocks();
});

describe("AgentEvaluationScreen when its slicer choices fail", () => {
    const status = { data: undefined, isLoading: false, error: undefined, refetch: vi.fn() };

    it("keeps the page when Power BI is only busy, with a retry for the choices", () => {
        const refetch = vi.fn();
        useTableQuery.mockReturnValue({ table: undefined, error: "Power BI is busy: too many queries.", isLoading: false, refetch });
        useSemanticModelQuery.mockReturnValue(status);
        render(<AgentEvaluationScreen />);

        expect(screen.getByText("Power BI is busy")).toBeTruthy();
        expect(screen.queryByText(/didn't answer/)).toBeNull();
        screen.getByRole("button", { name: "Try again" }).click();
        expect(refetch).toHaveBeenCalledOnce();
    });

    it("still says the model didn't answer when the error is something else", () => {
        useTableQuery.mockReturnValue({ table: undefined, error: "Cannot find table 'Conversations'.", isLoading: false, refetch: vi.fn() });
        useSemanticModelQuery.mockReturnValue(status);
        render(<AgentEvaluationScreen />);

        expect(screen.queryByText("Power BI is busy")).toBeNull();
        expect(screen.getByText(/didn't answer/)).toBeTruthy();
    });
});

describe("AgentEvaluationScreen with no conversations", () => {
    it("says where the parser looked, and how to add environments", () => {
        useTableQuery.mockReturnValue(NO_DATA);
        useSemanticModelQuery.mockReturnValue({ data: STATUS, isLoading: false, error: undefined, refetch: vi.fn() });
        render(<AgentEvaluationScreen />);
        expect(useSemanticModelQuery).toHaveBeenCalledWith({ connection: "ae", query: evaluatorStatus().query });
        expect(screen.getByText("No agent conversations found")).toBeTruthy();
        expect(screen.getByText(/0 transcripts found in Contoso \(default\) in the last 180 days\./)).toBeTruthy();
        expect(screen.getByText(/Repair or change/)).toBeTruthy();
    });

    it("falls back to the general message when the model has no status table", () => {
        useTableQuery.mockReturnValue(NO_DATA);
        useSemanticModelQuery.mockReturnValue({
            data: { status: "error", error: { message: "Cannot find table 'Evaluator Status'." } },
            isLoading: false,
            error: undefined,
            refetch: vi.fn(),
        });
        render(<AgentEvaluationScreen />);
        expect(screen.getByText("No agent conversations yet")).toBeTruthy();
    });
});
