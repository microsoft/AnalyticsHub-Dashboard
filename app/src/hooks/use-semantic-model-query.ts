//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useState, useEffect, useCallback } from "react";
import { type CachedQueryResult } from "@microsoft/fabric-app-data";
import { getFabricClient } from "@/lib/fabric-client";
import { resultStore } from "@/lib/kept-results";
import { withPriority } from "@/lib/query-priority";
import { connection as valueLensConnection } from "@/queries/shared";
import { useKeepsResults } from "./keep-results.context";
import { useIsPrefetch } from "./prefetch.context";

interface UseSemanticModelQueryOptions {
    /** Connection alias from fabric.yaml (e.g., "salesModel"). */
    connection: string;
    /** DAX query string. */
    query: string;
    /** If true, skip reading from cache (still writes the fresh result). */
    bypassCache?: boolean;
    /** If false, the result is never kept on the device between visits. */
    keep?: boolean;
}

interface UseSemanticModelQueryResult {
    data: CachedQueryResult | undefined;
    isLoading: boolean;
    error: Error | undefined;
    refetch: () => Promise<void>;
}

/**
 * React hook that executes a DAX query against a Power BI semantic model
 * via the Fabric SDK. Results are cached by the SDK's built-in LRU cache,
 * and summaries from the ValueLens model are also kept on the device until
 * the model is next refreshed (see `lib/kept-results.ts`).
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
    const { connection, query, bypassCache, keep } = options;
    const [data, setData] = useState<CachedQueryResult | undefined>();
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<Error | undefined>();

    const canExecute = Boolean(connection && query);
    const priority = useIsPrefetch() ? "low" : "normal";
    const keeps = useKeepsResults() && keep !== false;

    const execute = useCallback(async () => {
        if (!canExecute) return;
        setIsLoading(true);
        setError(undefined);

        try {
            const store = keeps ? resultStore(connection) : undefined;
            const kept = store && !bypassCache ? await store.recall(query) : undefined;
            if (kept) {
                setData(kept);
                return;
            }

            const result = await withPriority(priority, () =>
                getFabricClient().semanticModel(connection).query(query, { bypassCache }),
            );

            setData(result);

            if (result.status === "error") {
                setError(new Error(result.error.message));
            } else {
                void store?.remember(query, result);
            }
        } catch (err) {
            setError(err instanceof Error ? err : new Error(String(err)));
        } finally {
            setIsLoading(false);
        }
    }, [connection, query, bypassCache, canExecute, priority, keeps]);

    useEffect(() => {
        // Starts a fetch from the semantic model; the loading flag must flip as it starts.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        execute();
    }, [execute]);

    return { data, isLoading, error, refetch: execute };
}

/**
 * Clears cached query results from the SDK's LRU cache, and any kept on
 * the device. Pass a connection alias to clear a specific model, or omit to
 * clear all.
 *
 * @example
 * clearQueryCache();              // clear all models
 * clearQueryCache("salesModel");  // clear a specific model
 */
export function clearQueryCache(connection?: string): void {
    if (connection) {
        getFabricClient().semanticModel(connection).clearCache();
        void resultStore(connection)?.forget();
    } else {
        getFabricClient().clearCache();
        void resultStore(valueLensConnection)?.forget();
    }
}
