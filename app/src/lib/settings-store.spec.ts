//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------
import { afterEach, describe, expect, it, vi } from "vitest";

const browser = vi.hoisted(() => ({ storage: undefined as Storage | undefined }));

vi.mock("@/lib/runtime-config", () => ({
    runtimeConfig: () => ({ host: "azure" }),
}));

vi.mock("@/lib/managed/browser-storage", () => ({
    browserStorage: () => browser.storage,
}));

vi.mock("@/services/rayfin-auth.service", () => ({
    getAccessToken: () => Promise.resolve("api-token"),
}));

afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetModules();
    browser.storage = undefined;
});

describe("HttpSettingsStore", () => {
    it("loads and saves commercial terms through the settings API", async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(new Response(JSON.stringify([{ id: "00000000-0000-0000-0000-000000000001", creditRate: 0.02 }])))
            .mockResolvedValueOnce(new Response(JSON.stringify([{ id: "00000000-0000-0000-0000-000000000001", creditRate: 0.02 }])))
            .mockResolvedValueOnce(new Response(JSON.stringify({ id: "00000000-0000-0000-0000-000000000001", creditRate: 0.03, updatedBy: "admin" })));
        vi.stubGlobal("fetch", fetchMock);
        const { getSettingsStore, COMMERCIAL_TERMS_ID } = await import("@/lib/settings-store");

        await expect(getSettingsStore().loadCommercialTerms()).resolves.toMatchObject({ creditRate: 0.02 });
        await expect(getSettingsStore().saveCommercialTerms({ creditRate: 0.03 }, "ignored")).resolves.toMatchObject({ creditRate: 0.03, updatedBy: "admin" });

        expect(fetchMock).toHaveBeenLastCalledWith(`/api/settings/CommercialTerms/${COMMERCIAL_TERMS_ID}`, expect.objectContaining({
            method: "PUT",
            headers: expect.objectContaining({ authorization: "Bearer api-token" }),
        }));
    });

    it("round-trips monthly budgets alongside the rates", async () => {
        const row = { id: "00000000-0000-0000-0000-000000000001", creditRate: 0.02, budgetCowork: "5000", budgetStudio: 2500.5, budgetAzure: null };
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(new Response(JSON.stringify([row])))
            .mockResolvedValueOnce(new Response(JSON.stringify([row])))
            .mockImplementationOnce((_url: string, init: RequestInit) => Promise.resolve(new Response(init.body as string)));
        vi.stubGlobal("fetch", fetchMock);
        const { getSettingsStore } = await import("@/lib/settings-store");

        await expect(getSettingsStore().loadCommercialTerms()).resolves.toMatchObject({
            creditRate: 0.02,
            budgetCowork: 5000,
            budgetStudio: 2500.5,
            budgetAzure: undefined,
        });
        const saved = await getSettingsStore().saveCommercialTerms({ budgetAzure: 750, budgetStudio: undefined }, "a@example.com");
        expect(saved).toMatchObject({ creditRate: 0.02, budgetCowork: 5000, budgetAzure: 750, budgetStudio: undefined });

        const body = JSON.parse(fetchMock.mock.calls[2][1].body as string);
        expect(body).toMatchObject({ creditRate: 0.02, budgetCowork: 5000, budgetAzure: 750 });
        expect(body.budgetStudio ?? null).toBeNull();
    });

    it("round-trips the reporting currency beside the exchange rate, and drops a code it doesn't offer", async () => {
        const row = { id: "00000000-0000-0000-0000-000000000001", exchangeRate: 0.75, currency: "gbp" };
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(new Response(JSON.stringify([row])))
            .mockResolvedValueOnce(new Response(JSON.stringify([row])))
            .mockImplementationOnce((_url: string, init: RequestInit) => Promise.resolve(new Response(init.body as string)))
            .mockResolvedValueOnce(new Response(JSON.stringify([row])))
            .mockImplementationOnce((_url: string, init: RequestInit) => Promise.resolve(new Response(init.body as string)));
        vi.stubGlobal("fetch", fetchMock);
        const { getSettingsStore } = await import("@/lib/settings-store");

        await expect(getSettingsStore().loadCommercialTerms()).resolves.toMatchObject({ currency: "GBP", exchangeRate: 0.75 });
        await expect(getSettingsStore().saveCommercialTerms({ currency: "EUR", exchangeRate: 0.9 }, undefined)).resolves.toMatchObject({
            currency: "EUR",
            exchangeRate: 0.9,
        });
        expect(JSON.parse(fetchMock.mock.calls[2][1].body as string)).toMatchObject({ currency: "EUR", exchangeRate: 0.9 });

        const cleared = await getSettingsStore().saveCommercialTerms({ currency: "XYZ" }, undefined);
        expect(cleared.currency).toBeUndefined();
        expect(JSON.parse(fetchMock.mock.calls[4][1].body as string).currency).toBeNull();
    });

    it("upserts and deletes task times through the settings API", async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(new Response(JSON.stringify({ task: "Email Drafting", minLow: 1, minTypical: 2, minHigh: 3 })))
            .mockResolvedValueOnce(new Response(null, { status: 204 }))
            .mockResolvedValueOnce(new Response(JSON.stringify([{ task: "Email Drafting", minLow: 1, minTypical: 2, minHigh: 3 }])));
        vi.stubGlobal("fetch", fetchMock);
        const { getSettingsStore } = await import("@/lib/settings-store");

        const saved = await getSettingsStore().saveTaskTimes([
            { task: "Email Drafting", time: { low: 1, typical: 2, high: 3 } },
            { task: "General Chat", time: null },
        ], "ignored");

        expect(saved).toEqual([{ task: "Email Drafting", low: 1, typical: 2, high: 3, updatedAt: undefined, updatedBy: undefined }]);
        expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/settings/TaskTime/"), expect.objectContaining({ method: "PUT" }));
        expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/settings/TaskTime/"), expect.objectContaining({ method: "DELETE" }));
    });

    it("saves, lists and deletes report packs through the settings API", async () => {
        const id = "00000000-0000-0000-0000-0000000000aa";
        const fetchMock = vi.fn()
            .mockImplementationOnce((_url: string, init: RequestInit) => Promise.resolve(new Response(init.body as string)))
            .mockResolvedValueOnce(new Response(JSON.stringify([
                { id, name: "Weekly", stages: '["budget-runway","gone"]' },
                { id: "x", name: "Broken", stages: "[]" },
            ])))
            .mockResolvedValueOnce(new Response(null, { status: 204 }));
        vi.stubGlobal("fetch", fetchMock);
        const { getSettingsStore } = await import("@/lib/settings-store");

        const saved = await getSettingsStore().saveReportPack({ id, name: " Weekly ", stages: ["budget-runway", "budget-runway"] }, "a@example.com");
        expect(saved).toMatchObject({ id, name: "Weekly", stages: ["budget-runway"] });
        expect(fetchMock.mock.calls[0][0]).toBe(`/api/settings/ReportPack/${id}`);
        expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toMatchObject({ stages: '["budget-runway"]', updatedBy: "a@example.com" });

        await expect(getSettingsStore().loadReportPacks()).resolves.toEqual([
            expect.objectContaining({ id, name: "Weekly", stages: ["budget-runway"] }),
        ]);
        await getSettingsStore().deleteReportPack(id);
        expect(fetchMock).toHaveBeenLastCalledWith(`/api/settings/ReportPack/${id}`, expect.objectContaining({ method: "DELETE" }));
    });

    it("refuses to save a pack with no stages", async () => {
        vi.stubGlobal("fetch", vi.fn());
        const { getSettingsStore } = await import("@/lib/settings-store");
        await expect(getSettingsStore().saveReportPack({ id: "p", name: "Empty", stages: [] }, undefined)).rejects.toThrow("at least one stage");
    });

    it("surfaces admin-only writes as a friendly message", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("forbidden", { status: 403 })));
        const { getSettingsStore } = await import("@/lib/settings-store");

        await expect(getSettingsStore().saveCommercialTerms({ creditRate: 0.04 }, undefined))
            .rejects.toThrow("Only Analytics Hub admins can change this");
    });
});

describe("LocalSettingsStore", () => {
    const KEY = "analytics-hub:managed:";
    const TERMS_ID = "00000000-0000-0000-0000-000000000001";
    const PACK_ID = "00000000-0000-0000-0000-0000000000aa";

    function fakeStorage(entries: Record<string, string> = {}) {
        const items = new Map(Object.entries(entries));
        return {
            items,
            getItem: vi.fn((key: string): string | null => items.get(key) ?? null),
            setItem: vi.fn((key: string, value: string): void => {
                items.set(key, value);
            }),
            removeItem: (key: string) => items.delete(key),
            clear: () => items.clear(),
            key: (index: number) => [...items.keys()][index] ?? null,
            get length() {
                return items.size;
            },
        };
    }

    async function managedStore(storage?: ReturnType<typeof fakeStorage>) {
        vi.stubEnv("MODE", "managed");
        browser.storage = storage as unknown as Storage | undefined;
        const settings = await import("@/lib/settings-store");
        return { LocalSettingsStore: settings.LocalSettingsStore, store: settings.getSettingsStore() };
    }

    it("is a Copilot Managed App's store, and keeps settings in this browser between visits", async () => {
        const storage = fakeStorage();
        const { LocalSettingsStore, store } = await managedStore(storage);
        expect(store).toBeInstanceOf(LocalSettingsStore);

        const saved = await store.saveCommercialTerms({ creditRate: 0.02, budgetCowork: 5000 }, "a@example.com");

        expect(saved).toMatchObject({ creditRate: 0.02, budgetCowork: 5000, updatedBy: "a@example.com" });
        expect(saved.updatedAt).toBeInstanceOf(Date);
        expect(JSON.parse(storage.items.get(`${KEY}CommercialTerms`)!)).toEqual([
            expect.objectContaining({ id: TERMS_ID, creditRate: 0.02, budgetCowork: 5000, updatedBy: "a@example.com" }),
        ]);
        await expect(new LocalSettingsStore(storage as unknown as Storage).loadCommercialTerms()).resolves.toEqual(saved);
    });

    it("isn't used by the Fabric or Azure builds", async () => {
        const settings = await import("@/lib/settings-store");
        expect(settings.getSettingsStore()).not.toBeInstanceOf(settings.LocalSettingsStore);
    });

    it("merges a change over the saved terms, and clears what it's told to", async () => {
        const { store } = await managedStore(fakeStorage());
        await expect(store.loadCommercialTerms()).resolves.toBeNull();

        await store.saveCommercialTerms({ creditRate: 0.02, budgetStudio: 2500, currency: "GBP" }, "a@example.com");
        const saved = await store.saveCommercialTerms({ budgetAzure: 750, budgetStudio: undefined, currency: "XYZ" }, undefined);

        expect(saved).toMatchObject({ creditRate: 0.02, budgetAzure: 750, budgetStudio: undefined, currency: undefined, updatedBy: undefined });
        await expect(store.loadCommercialTerms()).resolves.toEqual(saved);
    });

    it("upserts task times by task, and drops one set back to the model's", async () => {
        const { store } = await managedStore(fakeStorage());
        await store.saveTaskTimes([
            { task: "Email Drafting", time: { low: 1, typical: 2, high: 3 } },
            { task: "General Chat", time: { low: 4, typical: 5, high: 6 } },
        ], "a@example.com");

        const saved = await store.saveTaskTimes([
            { task: " email drafting ", time: { low: 2, typical: 3, high: 4 } },
            { task: "General Chat", time: null },
        ], undefined);

        expect(saved).toEqual([expect.objectContaining({ task: " email drafting ", low: 2, typical: 3, high: 4, updatedBy: undefined })]);
        await expect(store.loadTaskTimes()).resolves.toEqual(saved);
    });

    it("saves, replaces, lists and deletes report packs", async () => {
        const { store } = await managedStore(fakeStorage());

        const saved = await store.saveReportPack({ id: PACK_ID, name: " Weekly ", stages: ["budget-runway", "budget-runway"] }, "a@example.com");
        expect(saved).toMatchObject({ id: PACK_ID, name: "Weekly", stages: ["budget-runway"] });
        await store.saveReportPack({ id: PACK_ID, name: "Monthly", stages: ["budget-runway"] }, undefined);
        await store.saveReportPack({ id: "00000000-0000-0000-0000-0000000000bb", name: "Annual", stages: ["budget-runway"] }, undefined);

        await expect(store.loadReportPacks()).resolves.toEqual([
            expect.objectContaining({ name: "Annual" }),
            expect.objectContaining({ id: PACK_ID, name: "Monthly" }),
        ]);
        await store.deleteReportPack(PACK_ID);
        await expect(store.loadReportPacks()).resolves.toEqual([expect.objectContaining({ name: "Annual" })]);
        await expect(store.saveReportPack({ id: "p", name: "Empty", stages: [] }, undefined)).rejects.toThrow("at least one stage");
    });

    it("skips saved entries it can't read", async () => {
        const { store } = await managedStore(fakeStorage({
            [`${KEY}TaskTime`]: "not json",
            [`${KEY}ReportPack`]: JSON.stringify({ id: PACK_ID }),
            [`${KEY}CommercialTerms`]: JSON.stringify([1, null, ["x"], { id: TERMS_ID, creditRate: 0.5 }]),
        }));

        await expect(store.loadTaskTimes()).resolves.toEqual([]);
        await expect(store.loadReportPacks()).resolves.toEqual([]);
        await expect(store.loadCommercialTerms()).resolves.toMatchObject({ creditRate: 0.5 });
    });

    it("keeps settings until the app closes when the browser has no storage", async () => {
        const { LocalSettingsStore, store } = await managedStore(undefined);

        await store.saveTaskTimes([{ task: "Email Drafting", time: { low: 1, typical: 2, high: 3 } }], undefined);

        await expect(store.loadTaskTimes()).resolves.toEqual([expect.objectContaining({ task: "Email Drafting", typical: 2 })]);
        await expect(new LocalSettingsStore().loadTaskTimes()).resolves.toEqual([]);
    });

    it("says so when the browser won't save a change, and keeps what was there", async () => {
        const storage = fakeStorage({ [`${KEY}CommercialTerms`]: JSON.stringify([{ id: TERMS_ID, creditRate: 0.02 }]) });
        storage.setItem.mockImplementation(() => {
            throw new DOMException("Quota exceeded", "QuotaExceededError");
        });
        const { store } = await managedStore(storage);

        await expect(store.saveCommercialTerms({ creditRate: 0.03 }, undefined))
            .rejects.toThrow("This browser wouldn't save the change. It may be out of space for this site.");
        await expect(store.loadCommercialTerms()).resolves.toMatchObject({ creditRate: 0.02 });
    });

    it("loads nothing rather than fail when the browser blocks reading", async () => {
        const storage = fakeStorage();
        storage.getItem.mockImplementation(() => {
            throw new DOMException("Blocked", "SecurityError");
        });
        const { store } = await managedStore(storage);

        await expect(store.loadTaskTimes()).resolves.toEqual([]);
        await expect(store.loadCommercialTerms()).resolves.toBeNull();
    });
});