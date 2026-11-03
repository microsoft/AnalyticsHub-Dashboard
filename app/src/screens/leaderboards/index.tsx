//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useStageFilter } from "@/hooks/stage-filter.context";
import { AgentRegistryStage } from "./agent-registry-stage";
import { LeaderboardStage } from "./leaderboard-stage";
import { CrossVendorPanel } from "@/screens/cross-vendor/page-panel-gate";

/**
 * Who is doing the most, read top to bottom: the people, then the agents.
 * The report's Leaderboard page and the usage half of its Agent Registry
 * page; the registry itself is Governance's.
 */
export function LeaderboardsScreen() {
    const { show } = useStageFilter();
    return (
        <div className="flex flex-col gap-800">
            {show("leaderboard") && <LeaderboardStage />}
            {show("leaderboard") && <CrossVendorPanel page="leaderboards" />}
            {show("agents") && <AgentRegistryStage />}
        </div>
    );
}
