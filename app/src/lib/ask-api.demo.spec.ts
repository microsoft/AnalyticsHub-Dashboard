import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/runtime-config", () => ({
    runtimeConfig: () => ({ demo: true }),
}));

vi.mock("@/services/rayfin-auth.service", () => ({
    getAccessToken: vi.fn(),
}));

import { askQuestion } from "@/lib/ask-api";
import { getAccessToken } from "@/services/rayfin-auth.service";

afterEach(() => {
    vi.restoreAllMocks();
});

describe("Ask in demo mode", () => {
    it("answers locally without requesting an access token or making a network call", async () => {
        const fetch = vi.spyOn(globalThis, "fetch");
        const reply = await askQuestion("How is adoption changing?");

        expect(reply.answer).toContain("synthetic sample data");
        expect(reply.runs).toEqual([]);
        expect(getAccessToken).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
    });
});
