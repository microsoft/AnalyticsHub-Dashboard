//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { DataTable } from "@microsoft/fabric-visuals-core";
import { connection } from "../shared";
import { EXPOSURE_ACCESS, governanceExposure } from "./governance-exposure";
import { governanceFilters, type GovernanceMode } from "./governance-mode";
import query from "./governance-public-web.dax?raw";
import resourceGraphQuery from "./governance-public-web-resource-graph.dax?raw";

/** The extra data access column for agents that search the web. */
export const PUBLIC_WEB = "Public web";

/** The exposure grid's columns once Resource Graph says which agents search the web. */
export const EXPOSURE_ACCESS_WITH_WEB = [...EXPOSURE_ACCESS, PUBLIC_WEB] as const;

/**
 * Live tenant-built agents with web search on as a knowledge source, by
 * sharing scope, in the exposure grid's own columns. These agents also sit
 * in their usual data access column; this adds a column rather than moving
 * them. Its own query, as only models with Resource Graph have the table.
 */
export function governancePublicWeb(mode: GovernanceMode = "registry") {
    return {
        connection,
        query: mode === "resourceGraph" ? resourceGraphQuery : query,
        columnMetadata: governanceExposure(mode).columnMetadata,
        filters: governanceFilters(mode),
    };
}

/** Adds the public web cells to the exposure grid, matching columns by name. */
export function withPublicWeb(exposure: DataTable, publicWeb: DataTable | undefined): DataTable {
    if (!publicWeb || publicWeb.rows.length === 0) return exposure;
    const from = exposure.columns.map((column) => publicWeb.columns.findIndex((def) => def.name === column.name));
    if (from.some((index) => index < 0)) return exposure;
    return { ...exposure, rows: [...exposure.rows, ...publicWeb.rows.map((row) => from.map((index) => row[index]))] };
}
