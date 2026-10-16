//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------
import type { CachedQueryResult, QueryTable } from "@microsoft/fabric-app-data";
import { ACCESS_SCOPE_QUERY } from "@/lib/access-scope";
import { getFabricClient } from "@/lib/fabric-client";
import { isMissingFromModelError } from "@/lib/model-errors";
import { connection as valueLensConnection } from "@/queries/shared";

/** Turns keeping results between visits off. */
const KEEP = true;
/** A result older than this is fetched again, whatever the model says. */
export const MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** The most results kept on the device; the oldest go first. */
export const MAX_KEPT = 1000;
/** A result longer than this is a list, not a summary, so it isn't kept. */
export const MAX_ROWS = 2000;
/** Bumped when what is kept changes shape, so older entries are dropped. */
const FORMAT = 1;

/**
 * What changes when the model is refreshed, as one row: who is asking, the
 * last pipeline run the model has loaded, and the size and reach of the audit
 * log. People can't read the model's own refresh time, so this stands in for
 * it. Someone who sees only part of the organisation reads a blank load log,
 * so for them the audit log alone marks a refresh, with the day's limit
 * behind it. A model without the load log fails this, and nothing is kept.
 */
export const RESULTS_VERSION_QUERY = `EVALUATE
ROW(
    "Me", USERPRINCIPALNAME(),
    "Logged", MAX('Load Log'[logged_at]),
    "Rows", COUNTROWS('Chat + Agent Interactions (Audit Logs)'),
    "Last", MAX('Chat + Agent Interactions (Audit Logs)'[ActivityDate])
)`;

/** A column that names a person, as the per-person lists return them. */
const PERSON_COLUMN = /audit_userid|userprincipalname|\bupn\b|e-?mail|\[@?(user|person|owner|manager)\]$|^@?(user|person|owner|manager)$/i;
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;

/** A summary worth keeping: not a long list, and nothing in it names a person. */
export function keepable(table: QueryTable): boolean {
    if (table.rows.length > MAX_ROWS) return false;
    if (table.columns.some((column) => PERSON_COLUMN.test(column.name))) return false;
    return !table.rows.some((row) => row.some((cell) => typeof cell === "string" && EMAIL.test(cell)));
}

export interface KeptResult {
    version: string;
    savedAt: number;
    table: QueryTable;
}

/** Where kept results live: the browser's IndexedDB, or memory in tests. */
export interface ResultBackend {
    get(key: string): Promise<KeptResult | undefined>;
    put(key: string, value: KeptResult): Promise<void>;
    list(): Promise<Array<{ key: string; version: string; savedAt: number }>>;
    remove(keys: readonly string[]): Promise<void>;
}

/**
 * Results kept on this device between visits, until the model is next
 * refreshed. Each is filed under the model's version as it was when it was
 * fetched, and read back only while the version is the same, so a refresh,
 * a change to someone's access or another person signing in fetches afresh.
 * Results read back are held in memory for the rest of the visit.
 *
 * Never throws: a device that won't store anything just fetches as before.
 */
export class ResultStore {
    private readonly held = new Map<string, CachedQueryResult>();
    private version: Promise<string | undefined> | undefined;

    constructor(
        private readonly backend: ResultBackend,
        private readonly readVersion: () => Promise<string | undefined>,
        private readonly prefix = "",
        private readonly now: () => number = Date.now,
    ) {}

    /** The result kept for this query under the current version, if any. */
    async recall(query: string): Promise<CachedQueryResult | undefined> {
        const key = this.prefix + query;
        const held = this.held.get(key);
        if (held) return held;
        try {
            const kept = await this.backend.get(key);
            if (!kept || this.now() - kept.savedAt > MAX_AGE_MS) return undefined;
            if (kept.version !== (await this.currentVersion())) return undefined;
            const result: CachedQueryResult = {
                status: "success",
                table: kept.table,
                requestId: "",
                fromCache: true,
                cachedAt: new Date(kept.savedAt),
            };
            this.hold(key, result);
            return result;
        } catch {
            return undefined;
        }
    }

    /** Keeps a fresh result, unless it failed, is a list or names a person. */
    async remember(query: string, result: CachedQueryResult): Promise<void> {
        if (result.status !== "success" || !keepable(result.table)) return;
        const key = this.prefix + query;
        try {
            const version = await this.currentVersion();
            if (!version) return;
            this.hold(key, result);
            await this.backend.put(key, { version, savedAt: this.now(), table: result.table });
        } catch {
            // Not kept; it is fetched again next time.
        }
    }

    /** Drops everything kept, here and on the device. */
    async forget(): Promise<void> {
        this.held.clear();
        try {
            const keys = (await this.backend.list()).map((entry) => entry.key).filter((key) => key.startsWith(this.prefix));
            await this.backend.remove(keys);
        } catch {
            // Nothing to drop.
        }
    }

    private currentVersion(): Promise<string | undefined> {
        if (!this.version) {
            this.version = this.readVersion().catch(() => undefined);
            void this.version.then((version) => (version ? this.prune(version) : undefined));
        }
        return this.version;
    }

    /** Drops results from another version, any too old, and the oldest past the limit. */
    private async prune(version: string): Promise<void> {
        try {
            const entries = (await this.backend.list()).filter((entry) => entry.key.startsWith(this.prefix));
            const stale = (entry: { version: string; savedAt: number }) =>
                entry.version !== version || this.now() - entry.savedAt > MAX_AGE_MS;
            const current = entries.filter((entry) => !stale(entry)).sort((a, b) => b.savedAt - a.savedAt);
            const drop = [...entries.filter(stale), ...current.slice(MAX_KEPT)].map((entry) => entry.key);
            if (drop.length > 0) await this.backend.remove(drop);
        } catch {
            // Tried again next visit.
        }
    }

    private hold(key: string, result: CachedQueryResult): void {
        this.held.delete(key);
        this.held.set(key, result);
        if (this.held.size > MAX_KEPT) this.held.delete(this.held.keys().next().value!);
    }
}

const DATABASE = "analytics-hub-results";
const STORE = "results";

function settle<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

/** Kept results in the browser's IndexedDB. */
export function indexedDbBackend(factory: IDBFactory): ResultBackend {
    let database: Promise<IDBDatabase> | undefined;
    const open = () =>
        (database ??= new Promise((resolve, reject) => {
            const request = factory.open(DATABASE, 1);
            request.onupgradeneeded = () => request.result.createObjectStore(STORE);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
            request.onblocked = () => reject(new Error("Kept results are open in an older version of the app."));
        }));
    const store = async (mode: IDBTransactionMode) => (await open()).transaction(STORE, mode).objectStore(STORE);

    return {
        get: async (key) => (await settle((await store("readonly")).get(key))) as KeptResult | undefined,
        put: async (key, value) => void (await settle((await store("readwrite")).put(value, key))),
        list: async () => {
            const cursor = (await store("readonly")).openCursor();
            const entries: Array<{ key: string; version: string; savedAt: number }> = [];
            return new Promise((resolve, reject) => {
                cursor.onsuccess = () => {
                    const at = cursor.result;
                    if (!at) return resolve(entries);
                    const value = at.value as KeptResult;
                    entries.push({ key: String(at.key), version: value.version, savedAt: value.savedAt });
                    at.continue();
                };
                cursor.onerror = () => reject(cursor.error);
            });
        },
        remove: async (keys) => {
            if (keys.length === 0) return;
            const results = await store("readwrite");
            await Promise.all(keys.map((key) => settle(results.delete(key))));
        },
    };
}

const json = (value: unknown) => JSON.stringify(value, (_, item: unknown) => (typeof item === "bigint" ? item.toString() : item));

/** The ValueLens model's version for the person signed in, or `undefined` when it can't be told. */
async function readValueLensVersion(): Promise<string | undefined> {
    const model = getFabricClient().semanticModel(valueLensConnection);
    const [stamp, scope] = await Promise.all([model.query(RESULTS_VERSION_QUERY), model.query(ACCESS_SCOPE_QUERY)]);
    if (stamp.status !== "success" || stamp.table.rows.length === 0) return undefined;
    if (scope.status === "error" && !isMissingFromModelError(scope.error.message)) return undefined;
    return json([FORMAT, stamp.table.rows, scope.status === "success" ? scope.table.rows : "off"]);
}

/** The browser's IndexedDB, unless the page may not use it. */
function deviceStorage(): IDBFactory | undefined {
    try {
        return typeof indexedDB === "undefined" ? undefined : indexedDB;
    } catch {
        return undefined;
    }
}

let valueLensStore: ResultStore | null | undefined;

/**
 * The store for a connection's results, or `undefined` where nothing is kept:
 * only the ValueLens model, whose queries are the slow ones, and only where
 * the browser lets the app store anything.
 */
export function resultStore(connection: string): ResultStore | undefined {
    if (!KEEP || connection !== valueLensConnection) return undefined;
    if (valueLensStore === undefined) {
        const storage = deviceStorage();
        valueLensStore = storage
            ? new ResultStore(indexedDbBackend(storage), readValueLensVersion, `${valueLensConnection}\n`)
            : null;
    }
    return valueLensStore ?? undefined;
}
