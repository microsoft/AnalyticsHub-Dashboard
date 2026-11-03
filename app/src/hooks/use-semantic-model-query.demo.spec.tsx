import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    query: vi.fn(),
    syntheticQueryResult: vi.fn(() => ({
        status: "success" as const,
        table: { columns: [{ name: "[Hours]" }], rows: [[42]] },
        fromCache: false,
        cachedAt: undefined,
    })),
}));

vi.mock("@/lib/runtime-config", () => ({
    runtimeConfig: () => ({ demo: true }),
}));

vi.mock("@/lib/fabric-client", () => ({
    QUERY_CACHE_MAX_AGE_MS: 60 * 60 * 1000,
    getFabricClient: () => ({
        clearCache: vi.fn(),
        semanticModel: () => ({ query: mocks.query, clearCache: vi.fn() }),
    }),
}));

vi.mock("@/demo/synthetic-model", () => ({
    syntheticQueryResult: mocks.syntheticQueryResult,
}));

import { useSemanticModelQuery, useSpeculativeQuery } from "@/hooks/use-semantic-model-query";

afterEach(() => {
    vi.clearAllMocks();
});

describe("semantic model queries in demo mode", () => {
    it("returns local synthetic data without calling the Fabric client", async () => {
        const { result } = renderHook(() =>
            useSemanticModelQuery({
                connection: "vl",
                query: 'EVALUATE ROW("Hours", 42)',
                columnMetadata: { "[Hours]": { name: "Hours" } },
            }),
        );

        await waitFor(() => expect(result.current.data?.status).toBe("success"));
        expect(result.current.data).toMatchObject({ table: { rows: [[42]] } });
        expect(mocks.syntheticQueryResult).toHaveBeenCalledOnce();
        expect(mocks.query).not.toHaveBeenCalled();
    });

    it("skips speculative live requests", () => {
        renderHook(() => useSpeculativeQuery({ connection: "vl", query: "EVALUATE ROW()" }));
        expect(mocks.query).not.toHaveBeenCalled();
    });
});
