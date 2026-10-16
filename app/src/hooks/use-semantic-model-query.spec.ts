//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useSemanticModelQuery, clearQueryCache } from "@/hooks/use-semantic-model-query";
import { BUSY_MESSAGE } from "@/lib/query-scheduler";

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
