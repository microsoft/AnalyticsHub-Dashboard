//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { VisualizationSpec } from "@microsoft/fabric-visuals";
import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection, FORMAT_WHOLE } from "../shared";
import query from "./agent-weekly.dax?raw";
import spec from "./agent-weekly.json";

const columnMetadata: ColumnMetadataMap = {
    "Chat + Agent Interactions (Audit Logs)[WeekStart]": {
        name: "Chat + Agent Interactions (Audit Logs)WeekStart",
        displayName: "Week starting",
        format: "dd mmm yyyy",
    },
    "[Agent Users]": { name: "Agent Users", displayName: "People using agents", format: FORMAT_WHOLE },
    "[Agent Sessions]": { name: "Agent Sessions", displayName: "Agent sessions", format: FORMAT_WHOLE },
};

/** People using any agent, and their agent sessions, week by week. */
export function agentWeekly() {
    return { connection, query, columnMetadata, vegaLiteSpec: spec as VisualizationSpec };
}