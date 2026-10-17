//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { QueryTable } from "@microsoft/fabric-app-data";
import { isConnectionConfigured } from "@/lib/connections";
import { getFabricClient } from "@/lib/fabric-client";
import { MANAGED_CONFIG_PATH, runtimeConfig } from "@/lib/runtime-config";
import { errorMessage, setIdentityCheck, type IdentityCheck } from "./diagnostics";
import { identityCheck } from "./identity-check";

/** Asks the Analytics Hub model, fresh, who the viewer is, and records the answer. Costs one connector call. */
export async function runIdentityCheck(): Promise<IdentityCheck> {
    const { connection, query } = identityCheck();
    if (!isConnectionConfigured(runtimeConfig().semanticModels, connection)) {
        const check: IdentityCheck = {
            status: "failed",
            model: connection,
            error: `The Analytics Hub model isn't set up in ${MANAGED_CONFIG_PATH}, so there's no model to ask.`,
            checkedAt: Date.now(),
        };
        setIdentityCheck(check);
        return check;
    }
    setIdentityCheck({ status: "running", model: connection, checkedAt: Date.now() });

    let check: IdentityCheck;
    try {
        const result = await getFabricClient().semanticModel(connection).query(query, { bypassCache: true });
        check = result.status === "success"
            ? { status: "done", model: connection, ...readIdentity(result.table), checkedAt: Date.now() }
            : { status: "failed", model: connection, error: result.error.message, checkedAt: Date.now() };
    } catch (error) {
        check = { status: "failed", model: connection, error: errorMessage(error), checkedAt: Date.now() };
    }
    setIdentityCheck(check);
    return check;
}

/** The UPN, user name and object ID in the check's one row. Columns may come back as `[UPN]` or `UPN`. */
export function readIdentity(table: QueryTable): Pick<IdentityCheck, "upn" | "user" | "objectId"> {
    const read = (name: string) => {
        const index = table.columns.findIndex((column) => column.name.replace(/^.*\[|\]$/g, "").toLowerCase() === name);
        const cell = index >= 0 ? table.rows[0]?.[index] : undefined;
        return typeof cell === "string" && cell.trim() ? cell.trim() : undefined;
    };
    const upn = read("upn");
    const user = read("user");
    const objectId = read("objectid");
    return { ...(upn ? { upn } : {}), ...(user ? { user } : {}), ...(objectId ? { objectId } : {}) };
}
