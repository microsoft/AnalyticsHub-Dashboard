//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { useSemanticModelQuery, clearQueryCache } from "@/hooks/use-semantic-model-query";
import { KeepResultsContext } from "@/hooks/keep-results.context";

// Mock the Fabric client module so tests run offline.
const mockClearCache = vi.fn();
const mockSemanticModelClearCache = vi.fn();
const mockQuery = vi.fn();

const mockRecall = vi.fn();
const mockRemember = vi.fn();
const mockForget = vi.fn();
let mockStore: object | undefined;

vi.mock("@/lib/kept-results", () => ({
    resultStore: (connection: string) => (connection === "vl" ? mockStore : undefined),
}));

vi.mock("@/lib/fabric-client", () => ({
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
    });
});

describe("useSemanticModelQuery with results kept on the device", () => {
    const fresh = { status: "success" as const, table: { columns: [], rows: [[1]] }, fromCache: false };
    const kept = { status: "success" as const, table: { columns: [], rows: [[2]] }, fromCache: true };

    beforeEach(() => {
        vi.clearAllMocks();
        mockStore = { recall: mockRecall, remember: mockRemember, forget: mockForget };
        mockQuery.mockResolvedValue(fresh);
    });

    it("shows a kept result without asking the model", async () => {
        mockRecall.mockResolvedValue(kept);

        const { result } = renderHook(() => useSemanticModelQuery({ connection: "vl", query: "Q" }));

        await waitFor(() => expect(result.current.isLoading).toBe(false));
        expect(result.current.data).toEqual(kept);
        expect(mockQuery).not.toHaveBeenCalled();
    });

    it("asks the model when nothing is kept, and keeps the answer", async () => {
        mockRecall.mockResolvedValue(undefined);

        const { result } = renderHook(() => useSemanticModelQuery({ connection: "vl", query: "Q" }));

        await waitFor(() => expect(result.current.isLoading).toBe(false));
        expect(result.current.data).toEqual(fresh);
        expect(mockRemember).toHaveBeenCalledWith("Q", fresh);
    });

    it("doesn't keep an error", async () => {
        mockRecall.mockResolvedValue(undefined);
        mockQuery.mockResolvedValue({ status: "error", error: { message: "no" } });

        const { result } = renderHook(() => useSemanticModelQuery({ connection: "vl", query: "Q" }));

        await waitFor(() => expect(result.current.isLoading).toBe(false));
        expect(mockRemember).not.toHaveBeenCalled();
    });

    it.each([
        ["asked not to", { keep: false }, undefined],
        ["asked for fresh data", { bypassCache: true }, undefined],
        ["under a list held back until asked for", {}, false],
    ])("neither reads nor keeps when %s", async (_, options, context) => {
        const wrapper = context === undefined
            ? undefined
            : ({ children }: { children: ReactNode }) => createElement(KeepResultsContext.Provider, { value: context }, children);

        const { result } = renderHook(() => useSemanticModelQuery({ connection: "vl", query: "Q", ...options }), { wrapper });

        await waitFor(() => expect(result.current.isLoading).toBe(false));
        expect(mockRecall).not.toHaveBeenCalled();
        expect(mockQuery).toHaveBeenCalledOnce();
        if (!("bypassCache" in options)) expect(mockRemember).not.toHaveBeenCalled();
    });

    it("forgets kept results when the cache is cleared", () => {
        clearQueryCache();
        clearQueryCache("vl");
        expect(mockForget).toHaveBeenCalledTimes(2);
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
