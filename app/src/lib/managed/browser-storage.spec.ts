//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { afterEach, describe, expect, it, vi } from "vitest";
import { browserStorage, canUseBrowserStorage } from "./browser-storage";

afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
});

describe("browserStorage", () => {
    it("returns local storage when the browser lets the app write to it, and leaves nothing behind", () => {
        expect(browserStorage()).toBe(window.localStorage);
        expect(canUseBrowserStorage()).toBe(true);
        expect(localStorage.length).toBe(0);
    });

    it("returns nothing when the browser won't save", () => {
        vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
            throw new DOMException("The frame can't use storage.", "SecurityError");
        });

        expect(browserStorage()).toBeUndefined();
        expect(canUseBrowserStorage()).toBe(false);
    });
});
