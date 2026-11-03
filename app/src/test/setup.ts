//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";

// The app keeps the open view in the URL hash, and jsdom keeps one URL per test file.
// Start each test at the root URL so one test's navigation doesn't open the next test elsewhere.
afterEach(() => {
    if (typeof window !== "undefined" && window.location.hash) window.history.replaceState(null, "", window.location.pathname);
});

// jsdom does not implement matchMedia, which the reduced-motion check in
// `lib/scroll-to-anchor` calls. Stub it so components that read it can
// render under test.
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
    window.matchMedia = (query: string): MediaQueryList =>
        ({
            matches: false,
            media: query,
            onchange: null,
            addEventListener: () => {},
            removeEventListener: () => {},
            addListener: () => {},
            removeListener: () => {},
            dispatchEvent: () => false,
        }) as unknown as MediaQueryList;
}
