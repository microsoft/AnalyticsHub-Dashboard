import { afterEach, describe, expect, it, vi } from "vitest";

const config = vi.hoisted(() => ({ variant: undefined as "analytics" | undefined }));
vi.mock("@/lib/runtime-config", () => ({
    runtimeConfig: () => ({ demo: true, demoVariant: config.variant, host: "fabric" }),
}));

afterEach(() => {
    config.variant = undefined;
    vi.resetModules();
    vi.unstubAllGlobals();
});

describe("isolated demo budget assumptions", () => {
    it("keeps legacy demo budgets unset", async () => {
        const { getSettingsStore } = await import("./settings-store");
        expect(await getSettingsStore().loadCommercialTerms()).toBeNull();
    });
    it("seeds labeled analytics-only assumptions and saves edits only in memory", async () => {
        config.variant = "analytics";
        const fetch = vi.fn();
        vi.stubGlobal("fetch", fetch);
        const { getSettingsStore } = await import("./settings-store");
        const store = getSettingsStore();
        expect(await store.loadCommercialTerms()).toEqual({ budgetCowork: 1000, budgetStudio: 2000, budgetAzure: 15000 });
        await store.saveCommercialTerms({ budgetAzure: 20000 }, undefined);
        expect(await store.loadCommercialTerms()).toMatchObject({ budgetAzure: 20000 });
        expect(fetch).not.toHaveBeenCalled();
    });
});
