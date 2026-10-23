//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useStageFilter } from "@/hooks/stage-filter.context";
import { AgentsStage } from "./agents-stage";

/**
 * Which agents people use: how many, how often and of which kind, then every
 * agent ranked with its detail. How well each agent answers stays in the
 * Agent Evaluator report, which an agent's detail links to.
 */
export function AgentsScreen() {
    const { show } = useStageFilter();
    return <div className="flex flex-col gap-800">{show("agents") && <AgentsStage />}</div>;
}