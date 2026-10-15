//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useMemo } from "react";
import { ConcentrationPanel } from "@/components/concentration-panel";
import { useOrgAttribute } from "@/hooks/filter.context";
import { useTableQuery } from "@/hooks/use-table-query";
import { readConcentration } from "@/lib/concentration";
import { leaderboardConcentration, type LeaderboardCohort } from "@/queries/work";

/**
 * How much of the ranked cohort's sessions the busiest people account for,
 * over the same per-person rows as the user breakdown, worked out in the
 * model so it covers people beyond the breakdown's cap.
 */
export function LeaderboardConcentration({ cohort, noun }: { cohort: LeaderboardCohort; noun: string }) {
    const org = useOrgAttribute();
    const source = useMemo(() => leaderboardConcentration(cohort, org), [cohort, org]);
    const result = useTableQuery(source);
    const summary = useMemo(() => readConcentration(result.table), [result.table]);

    return (
        <ConcentrationPanel
            result={result}
            summary={summary}
            noun={noun}
            title={`How concentrated ${noun} are`}
            subtitle={`Each person's share of ${noun}, busiest first, for the dates and filters selected`}
            emptyTitle="Nobody to rank"
            emptyDescription={`No one had ${noun} in this selection.`}
        />
    );
}
