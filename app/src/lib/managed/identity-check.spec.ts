//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { identityCheck } from "./identity-check";

describe("identityCheck", () => {
    it("asks the Analytics Hub model who the viewer is", () => {
        const { connection, query } = identityCheck();

        expect(connection).toBe("vl");
        expect(query.charCodeAt(0)).not.toBe(0xfeff);
        expect(query.trim()).toMatch(/^EVALUATE\b/);
        expect(query).toContain('"UPN", USERPRINCIPALNAME()');
        expect(query).toContain('"User", USERNAME()');
        expect(query).toContain('"ObjectId", USEROBJECTID()');
    });
});
