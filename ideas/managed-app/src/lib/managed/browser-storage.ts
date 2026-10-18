//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

const PROBE_KEY = "analytics-hub:managed:probe";

/** This browser's local storage, when it lets the app write to it. A player frame may not. */
export function browserStorage(): Storage | undefined {
    try {
        const storage = window.localStorage;
        storage.setItem(PROBE_KEY, "1");
        storage.removeItem(PROBE_KEY);
        return storage;
    } catch {
        return undefined;
    }
}

/** Whether settings saved on the Copilot Managed Runtime outlast the session. */
export function canUseBrowserStorage(): boolean {
    return browserStorage() !== undefined;
}
