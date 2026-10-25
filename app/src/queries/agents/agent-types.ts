//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { VisualizationSpec } from "@microsoft/fabric-visuals";
import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection, FORMAT_WHOLE } from "../shared";
import query from "./agent-types.dax?raw";
import spec from "./agent-types.json";

const columnMetadata: ColumnMetadataMap = {
    "[Type]": { name: "Type", displayName: "Agent type" },
    "[People]": { name: "People", displayName: "People", format: FORMAT_WHOLE },
    "[Sessions]": { name: "Sessions", displayName: "Sessions", format: FORMAT_WHOLE },
};

/**
 * People using agents of each registry type. Agents the registry doesn't
 * know are grouped as "Not in registry". Someone who used two types counts
 * in both, so the bars can add up to more than the people using agents.
 */
export function agentTypes() {
    return { connection, query, columnMetadata, vegaLiteSpec: spec as VisualizationSpec };
}