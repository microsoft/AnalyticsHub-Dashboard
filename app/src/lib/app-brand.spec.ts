//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { afterEach, describe, expect, it, vi } from "vitest";
import { appDisplayName, appDisplayNameWithArticle } from "./app-brand";

afterEach(() => vi.unstubAllEnvs());

describe("app branding", () => {
    it("keeps the existing name without the preview flag", () => {
        vi.stubEnv("VITE_DATAHUB_PREVIEW", "");
        expect(appDisplayName()).toBe("Analytics Hub");
        expect(appDisplayNameWithArticle()).toBe("an Analytics Hub");
    });

    it("uses DataHub only for an explicitly enabled preview", () => {
        vi.stubEnv("VITE_DATAHUB_PREVIEW", "true");
        expect(appDisplayName()).toBe("DataHub");
        expect(appDisplayNameWithArticle()).toBe("a DataHub");
    });
});
