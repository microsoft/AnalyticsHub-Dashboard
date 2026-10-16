//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

/** `low` waits until nothing on screen is loading; `normal` is everything a person is looking at. */
export type QueryPriority = "normal" | "low";

let current: QueryPriority = "normal";

/**
 * Starts the requests `start` makes in `priority`'s lane. The SDK checks its
 * cache and calls the scheduled proxy synchronously inside `query()`, so the
 * lane is read before `start` returns; anything later runs as `normal`.
 */
export function withPriority<T>(priority: QueryPriority, start: () => T): T {
    const previous = current;
    current = priority;
    try {
        return start();
    } finally {
        current = previous;
    }
}

/** The lane of the request being started right now. */
export function currentPriority(): QueryPriority {
    return current;
}
