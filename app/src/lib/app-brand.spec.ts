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
    it("uses DataHub App without the compatibility preview flag", () => {
        vi.stubEnv("VITE_DATAHUB_PREVIEW", "");
        expect(appDisplayName()).toBe("DataHub App");
        expect(appDisplayNameWithArticle()).toBe("a DataHub App");
    });

    it("uses DataHub App with the compatibility preview flag", () => {
        vi.stubEnv("VITE_DATAHUB_PREVIEW", "true");
        expect(appDisplayName()).toBe("DataHub App");
        expect(appDisplayNameWithArticle()).toBe("a DataHub App");
    });
});
