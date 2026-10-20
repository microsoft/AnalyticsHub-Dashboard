//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { formatKpi } from "./format-kpi";
import { DEFAULT_ORG_ATTRIBUTE, type OrgAttribute } from "./org-attribute";

/** Below this share of people with a department, views by department leave most people out. */
export const LOW_DEPARTMENT_COVERAGE = 0.8;

/** How to fill the gaps. The default org column comes from each person's Department in Microsoft Entra ID. */
export const DEPARTMENT_ADVICE =
    "Views by department leave out everyone without one. Fill in Department on users in Microsoft Entra ID.";

const WHERE_DEPARTMENT_COMES_FROM =
    "The organization comes from each person's Department in Microsoft Entra ID. If it's blank for most people, fill it in there.";

export interface DepartmentCoverage {
    have: number;
    people: number;
    /** Too few people have a department for views by department to be representative. */
    low: boolean;
    /** E.g. "180 of 200 people with a task have a department". */
    text: string;
}

/**
 * How many of the people with a task have a department, from the summary's
 * `[People With Organization]` and `[People]`. Only the default org column is
 * counted, so another chosen attribute gets `undefined`.
 */
export function departmentCoverage(
    have: number | undefined,
    people: number | undefined,
    column: string,
): DepartmentCoverage | undefined {
    if (column !== DEFAULT_ORG_ATTRIBUTE || have === undefined || people === undefined || people <= 0) return undefined;
    return {
        have,
        people,
        low: have / people < LOW_DEPARTMENT_COVERAGE,
        text: `${formatKpi(have, "whole")} of ${formatKpi(people, "whole")} people with a task have a department`,
    };
}

/** The coverage line for a note, with advice when it is low. */
export function coverageNote(coverage: DepartmentCoverage): string {
    return coverage.low ? `${coverage.text}. ${DEPARTMENT_ADVICE}` : coverage.text;
}

/**
 * An empty "No organizations to compare" description that says why it may be
 * empty: how many people have a department and how to fill the gaps, or, with
 * no count to hand, where the department comes from.
 */
export function orgEmptyDescription(base: string, org: OrgAttribute, coverage?: DepartmentCoverage): string {
    if (org.column !== DEFAULT_ORG_ATTRIBUTE) return base;
    if (coverage) return coverage.low ? `${base} ${coverage.text}. ${DEPARTMENT_ADVICE}` : `${base} ${coverage.text}.`;
    return `${base} ${WHERE_DEPARTMENT_COMES_FROM}`;
}
