//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { connection } from "@/queries/shared";
import query from "./identity-check.dax?raw";

/**
 * Who the Analytics Hub model takes the viewer to be, for the Diagnostics
 * panel's row-level security check. It lives here rather than in `queries/`
 * so the Fabric and Azure builds never carry it.
 */
export function identityCheck() {
    return { connection, query };
}
