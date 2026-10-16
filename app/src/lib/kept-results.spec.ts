//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------
import { describe, expect, it, vi } from "vitest";
import type { CachedQueryResult, QueryTable } from "@microsoft/fabric-app-data";
import {
    keepable,
    MAX_AGE_MS,
    MAX_KEPT,
    MAX_ROWS,
    ResultStore,
    resultStore,
    type KeptResult,
    type ResultBackend,
} from "@/lib/kept-results";

class MemoryBackend implements ResultBackend {
    readonly entries = new Map<string, KeptResult>();
    failing = false;

    async get(key: string) {
        if (this.failing) throw new Error("storage refused");
        return this.entries.get(key);
    }
    async put(key: string, value: KeptResult) {
        if (this.failing) throw new Error("storage refused");
        this.entries.set(key, value);
    }
    async list() {
        if (this.failing) throw new Error("storage refused");
        return [...this.entries].map(([key, value]) => ({ key, version: value.version, savedAt: value.savedAt }));
    }
    async remove(keys: readonly string[]) {
        keys.forEach((key) => this.entries.delete(key));
    }
}

const table = (rows: unknown[][] = [[5906850]], columns = ["[Tasks]"]): QueryTable => ({
    columns: columns.map((name) => ({ name, dataType: "number" })) as QueryTable["columns"],
    rows,
});
const success = (data = table()): CachedQueryResult => ({ status: "success", table: data, requestId: "r", fromCache: false });

function setup(version = "v1", start = 1_000_000) {
    const backend = new MemoryBackend();
    let now = start;
    const readVersion = vi.fn(async () => version);
    const store = () => new ResultStore(backend, readVersion, "vl\n", () => now);
    return { backend, readVersion, store, advance: (ms: number) => (now += ms), at: () => now };
}

/** Lets the prune that follows the first version read finish. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("keepable", () => {
    it("keeps a summary", () => {
        expect(keepable(table([["Teams", 15447]], ["Organization[Name]", "[Seats]"]))).toBe(true);
    });

    it.each(["Audit_UserId", "[User]", "User", "Licensing[UserPrincipalName]", "[Email]", "UPN", "Org[Manager]"])(
        "refuses a result with a %s column",
        (name) => {
            expect(keepable(table([["x"]], [name]))).toBe(false);
        },
    );

    it("refuses a result that holds an email address anywhere", () => {
        expect(keepable(table([["someone@example.com", 1]], ["[Name]", "[Tasks]"]))).toBe(false);
    });

    it("refuses a list longer than a summary", () => {
        expect(keepable(table(Array.from({ length: MAX_ROWS + 1 }, (_, i) => [i])))).toBe(false);
        expect(keepable(table(Array.from({ length: MAX_ROWS }, (_, i) => [i])))).toBe(true);
    });
});

describe("ResultStore", () => {
    it("reads a result back on the next visit while the model is unchanged", async () => {
        const { store } = setup();
        await store().remember("Q", success());

        const recalled = await store().recall("Q");

        expect(recalled).toMatchObject({ status: "success", table: table(), fromCache: true });
        expect(recalled?.cachedAt).toBeInstanceOf(Date);
    });

    it("fetches afresh once the model has been refreshed, and drops what it kept", async () => {
        const first = setup("v1");
        await first.store().remember("Q", success());

        const refreshed = new ResultStore(first.backend, async () => "v2", "vl\n", first.at);
        expect(await refreshed.recall("Q")).toBeUndefined();
        await settled();

        expect(first.backend.entries.size).toBe(0);
    });

    it("never gives one person's results to another", async () => {
        const { backend, store, at } = setup('[1,[["a@example.com"]]]');
        await store().remember("Q", success());

        const someoneElse = new ResultStore(backend, async () => '[1,[["b@example.com"]]]', "vl\n", at);

        expect(await someoneElse.recall("Q")).toBeUndefined();
    });

    it("fetches afresh after a day even if the model looks unchanged", async () => {
        const { store, advance } = setup();
        await store().remember("Q", success());

        advance(MAX_AGE_MS + 1);

        expect(await store().recall("Q")).toBeUndefined();
    });

    it("keeps nothing when the model's version can't be read", async () => {
        const { backend, at } = setup();
        await new ResultStore(backend, async () => undefined, "vl\n", at).remember("Q", success());

        expect(backend.entries.size).toBe(0);
    });

    it("keeps nothing that failed, is a list or names a person", async () => {
        const { backend, store } = setup();
        const kept = store();

        await kept.remember("failed", { status: "error", error: { category: "query", message: "no" }, requestId: "r", fromCache: false } as CachedQueryResult);
        await kept.remember("people", success(table([["x"]], ["[User]"])));
        await kept.remember("list", success(table(Array.from({ length: MAX_ROWS + 1 }, (_, i) => [i]))));

        expect(backend.entries.size).toBe(0);
    });

    it("treats storage that refuses as nothing kept", async () => {
        const { backend, store } = setup();
        backend.failing = true;
        const kept = store();

        await expect(kept.remember("Q", success())).resolves.toBeUndefined();
        backend.failing = false;
        expect(backend.entries.size).toBe(0);
        backend.failing = true;
        await expect(store().recall("Q")).resolves.toBeUndefined();
    });

    it("keeps the newest results when there are too many", async () => {
        const { backend, readVersion, at } = setup();
        for (let i = 0; i < MAX_KEPT + 5; i++) {
            backend.entries.set(`vl\nQ${i}`, { version: "v1", savedAt: at() - (MAX_KEPT + 5 - i), table: table() });
        }

        await new ResultStore(backend, readVersion, "vl\n", at).recall("Q0");
        await settled();

        expect(backend.entries.size).toBe(MAX_KEPT);
        expect(backend.entries.has("vl\nQ0")).toBe(false);
        expect(backend.entries.has(`vl\nQ${MAX_KEPT + 4}`)).toBe(true);
    });

    it("reads the model's version once a visit", async () => {
        const { readVersion, store } = setup();
        const kept = store();
        await kept.remember("A", success());
        await kept.remember("B", success());

        expect(readVersion).toHaveBeenCalledTimes(1);
    });

    it("forgets everything it kept", async () => {
        const { backend, store } = setup();
        const kept = store();
        await kept.remember("Q", success());
        backend.entries.set("other\nQ", { version: "v1", savedAt: 0, table: table() });

        await kept.forget();

        expect(await kept.recall("Q")).toBeUndefined();
        expect([...backend.entries.keys()]).toEqual(["other\nQ"]);
    });
});

describe("resultStore", () => {
    it("keeps nothing for the other models, or where the browser can't store anything", () => {
        expect(resultStore("cc")).toBeUndefined();
        expect(resultStore("vl")).toBeUndefined();
    });
});
