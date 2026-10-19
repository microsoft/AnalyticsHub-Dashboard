//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useMemo } from "react";
import { useOrgAttribute } from "@/hooks/filter.context";
import { useStageFilter } from "@/hooks/stage-filter.context";
import { useConsumptionTable } from "@/hooks/use-consumption-query";
import { useHueColors } from "@/hooks/use-palette-theme";
import { useSummaryQuery, useTableQuery, type SummaryResult, type TableResult } from "@/hooks/use-table-query";
import { dateBetween } from "@/lib/dax-filters";
import type { FilterKey } from "@/lib/filters";
import { withOrgAttribute } from "@/lib/org-attribute";
import { reportingDateFilter } from "@/queries/consumption";
import {
    executiveCredits,
    executiveDepartments,
    executiveMonths,
    executiveSummary,
    monthLabel,
} from "@/queries/executive";
import { CONSUMPTION_CONFIGURED } from "@/screens/value/cost-vs-value-data";
import { useExecutiveRange, type ExecutiveRangeState } from "./use-executive-range";

/** Copilot Chat and apps, agents, Cowork: each source keeps its colour in both trends. */
const HOURS_HUES = ["--vl-blue", "--vl-amber", "--vl-lavender"] as const;
/** Copilot Studio agents, Cowork. */
const CREDIT_HUES = ["--vl-amber", "--vl-lavender"] as const;
/** The trend sets its own dates: six months to the end of the range. */
const TREND_IGNORES: FilterKey[] = ["dateRange"];
const SKIP = { connection: "", query: "" };

type Source<T extends (...args: never[]) => unknown> = ReturnType<T>;

export interface ExecutiveData {
    range: ExecutiveRangeState;
    summary: SummaryResult;
    /** Each month of the trend, with the rates the cards compare. */
    months: TableResult;
    monthsSource: Source<typeof executiveMonths>;
    /** Credits each month of the trend; an org filter can't narrow Copilot Studio's tenant billing. */
    credits: TableResult;
    creditsSource: Source<typeof executiveCredits>;
    /** Credits each month of the date range, for the card's total. */
    creditsInRange: TableResult;
    departments: TableResult;
}

/**
 * The queries more than one stage reads, run once for the page, and only for
 * the stages on show. The trend waits for the activity's dates so it never
 * asks for months it then drops. The summary and the trend are the slowest
 * queries the page waits on, so they ask ahead of the other queries waiting.
 */
export function useExecutiveData(): ExecutiveData {
    const range = useExecutiveRange();
    const { window, start, end } = range.range ?? {};
    const org = useOrgAttribute();
    const { show } = useStageFilter();
    const hoursColors = useHueColors(HOURS_HUES);
    const creditColors = useHueColors(CREDIT_HUES);
    const trend = window && (show("the-bottom-line") || show("is-it-growing"));
    const byOrg = show("where-it-is-landing") || show("what-needs-attention");

    const params = useMemo(
        () => (window ? { months: window.months.map(monthLabel), rangeMonth: window.rangeMonth } : undefined),
        [window],
    );
    const monthsSource = useMemo(() => executiveMonths(params && { ...params, colors: hoursColors }), [params, hoursColors]);
    const creditsSource = useMemo(
        () => executiveCredits(params && { ...params, colors: creditColors }),
        [params, creditColors],
    );

    const summary = useSummaryQuery({ ...executiveSummary(), lead: true });
    const months = useTableQuery(
        trend ? { ...monthsSource, lead: true } : { ...monthsSource, ...SKIP },
        trend ? [dateBetween("'Calendar'[Date]", window.from, window.to)] : [],
        TREND_IGNORES,
    );

    const totalSource = useMemo(() => executiveCredits(), []);
    const readCredits = CONSUMPTION_CONFIGURED && trend && start && end;
    const readTotal = readCredits && show("the-bottom-line");
    const credits = useConsumptionTable(
        readCredits ? creditsSource : { ...creditsSource, ...SKIP },
        readCredits ? [reportingDateFilter(window.from, window.to)] : [],
        TREND_IGNORES,
    );
    const creditsInRange = useConsumptionTable(
        readTotal ? totalSource : { ...totalSource, ...SKIP },
        readTotal ? [reportingDateFilter(start, end)] : [],
        TREND_IGNORES,
    );

    const departmentsSource = useMemo(() => withOrgAttribute(executiveDepartments(), org), [org]);
    const departments = useTableQuery(byOrg ? departmentsSource : { ...departmentsSource, ...SKIP });

    return { range, summary, months, monthsSource, credits, creditsSource, creditsInRange, departments };
}
