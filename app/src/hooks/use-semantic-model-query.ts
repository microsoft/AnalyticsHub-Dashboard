//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useState, useEffect, useCallback, useRef } from "react";
import { type CachedQueryResult } from "@microsoft/fabric-app-data";
import { getFabricClient, QUERY_CACHE_MAX_AGE_MS } from "@/lib/fabric-client";
import { withPriority } from "@/lib/query-priority";
import { isBusyMessage } from "@/lib/query-scheduler";
import { useIsPrefetch } from "./prefetch.context";

interface UseSemanticModelQueryOptions {
    /** Connection alias from fabric.yaml (e.g., "salesModel"). */
    connection: string;
    /** DAX query string. */
    query: string;
    /** If true, skip reading from cache (still writes the fresh result). */
    bypassCache?: boolean;
}

interface UseSemanticModelQueryResult {
    data: CachedQueryResult | undefined;
    isLoading: boolean;
    error: Error | undefined;
    /** Runs the query again; after an error it asks Power BI rather than the cache. */
    refetch: () => Promise<void>;
}

/** A busy error the cache kept: Power BI was only asking the app to slow down, so ask again. */
function cachedBusy(result: CachedQueryResult): boolean {
    return result.fromCache && result.status === "error" && isBusyMessage(result.error.message);
}

/**
 * React hook that executes a DAX query against a Power BI semantic model
 * via the Fabric SDK. Results are cached by the SDK's built-in LRU cache for
 * the rest of the visit, up to an hour each (`QUERY_CACHE_MAX_AGE_MS`).
 *
 * The connection alias is resolved from `fabric.generated.ts`
 * (managed by `npx fabric-app-data`).
 *
 * @example
 * // Basic usage
 * const { data, isLoading } = useSemanticModelQuery({
 *   connection: "salesModel",
 *   query: 'EVALUATE SUMMARIZE(Sales, Products[Name], "Total", SUM(Sales[Amount]))',
 * });
 *
 * if (data?.status === "success") {
 *   const table = data.table;
 *   // table.columns, table.rows
 * }
 *
 * @example
 * // Handling errors (SDK never throws — check result.status)
 * if (data?.status === "error") {
 *   console.error(data.error.message); // e.g., "401 Unauthorized"
 * }
 *
 * @example
 * // Checking cache status
 * if (data?.fromCache) {
 *   console.log(`Cached at ${data.cachedAt}`);
 * }
 *
 * @example
 * // Bypassing cache for fresh data
 * const { data } = useSemanticModelQuery({
 *   connection: "salesModel",
 *   query: 'EVALUATE ...',
 *   bypassCache: true,
 * });
 */
export function useSemanticModelQuery(
    options: UseSemanticModelQueryOptions,
): UseSemanticModelQueryResult {
    const { connection, query, bypassCache } = options;
    const [data, setData] = useState<CachedQueryResult | undefined>();
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<Error | undefined>();
    const latest = useRef<CachedQueryResult | undefined>(undefined);

    const canExecute = Boolean(connection && query);
    const priority = useIsPrefetch() ? "low" : "normal";

    const execute = useCallback(async (fresh = false) => {
        if (!canExecute) return;
        setIsLoading(true);
        setError(undefined);

        try {
            const model = getFabricClient().semanticModel(connection);
            let result = await withPriority(priority, () => model.query(query, { bypassCache: fresh || bypassCache }));
            const stale = result.fromCache && result.cachedAt && Date.now() - result.cachedAt.getTime() > QUERY_CACHE_MAX_AGE_MS;
            if (stale || cachedBusy(result)) {
                result = await withPriority(priority, () => model.query(query, { bypassCache: true }));
            }

            latest.current = result;
            setData(result);

            if (result.status === "error") {
                setError(new Error(result.error.message));
            }
        } catch (err) {
            latest.current = undefined;
            setError(err instanceof Error ? err : new Error(String(err)));
        } finally {
            setIsLoading(false);
        }
    }, [connection, query, bypassCache, canExecute, priority]);

    useEffect(() => {
        // Starts a fetch from the semantic model; the loading flag must flip as it starts.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        execute();
    }, [execute]);

    // "Try again" after an error asks Power BI, not the cache that kept it; after a success the cache is right.
    const refetch = useCallback(() => execute(latest.current?.status !== "success"), [execute]);

    return { data, isLoading, error, refetch };
}

/**
 * Clears cached query results from the SDK's LRU cache.
 * Pass a connection alias to clear a specific model, or omit to clear all.
 *
 * @example
 * clearQueryCache();              // clear all models
 * clearQueryCache("salesModel");  // clear a specific model
 */
export function clearQueryCache(connection?: string): void {
    if (connection) {
        getFabricClient().semanticModel(connection).clearCache();
    } else {
        getFabricClient().clearCache();
    }
}
