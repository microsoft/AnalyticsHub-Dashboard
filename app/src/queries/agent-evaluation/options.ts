//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { EVALUATOR_METADATA } from "@/lib/filter-profiles";
import type { DataTable } from "@microsoft/fabric-visuals-core";
import type { QueryTable } from "@microsoft/fabric-app-data";
import { daxString, dateBetween, treatAs } from "@/lib/dax-filters";
import { availablePresets, presetRange, type DatePreset, type DateRange } from "@/lib/filters";
import { describeOrgAttribute, pickOrgAttributes } from "@/lib/org-attribute";
import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { evaluatorConnection as connection, FORMAT_WHOLE } from "../shared";
import query from "./evaluation-options.dax?raw";
import orgAttributesQuery from "./org-attributes.dax?raw";
import eligibilityRow from "./group-eligibility-row.dax?raw";

export interface GroupByColumn {
    id: string;
    label: string;
    /** A fully qualified column reference, substituted into the by-group query. */
    column: string;
    /** Raw attribute name in the row bridge, absent for Agent and Topic groupings. */
    attribute?: string;
    /** Topic names are written as identifiers ("PolicyLookup") and read better as words. */
    humanize?: boolean;
}

/**
 * Model-owned non-org groupings. Org columns are discovered separately,
 * only when the grouping menu is needed.
 */
export const GROUP_BY_COLUMNS: readonly GroupByColumn[] = [
    { id: "agent", label: "Agent", column: "'Agent Performance'[BotFriendlyName]" },
    { id: "theme", label: "Topic theme", column: "'Agent Performance'[Topic Theme]" },
    { id: "topic", label: "Topic", column: "'Agent Performance'[Topic (resolved)]", humanize: true },
];

/** Keep saved IDs and labels without using these aliases as an allowlist. */
const ORG_ALIASES: Record<string, { id: string; label: string }> = {
    Organization: { id: "department", label: "Department" },
    JobTitle: { id: "job-title", label: "Job title" },
    officeLocation: { id: "office", label: "Office" },
    country: { id: "country", label: "Country" },
    usageLocation: { id: "usage-location", label: "Usage location" },
    companyName: { id: "company", label: "Company" },
    Function: { id: "function", label: "Function" },
    Location: { id: "location", label: "Location" },
};

/** At most two populated groups with conversations; no returned value lists. */
function groupCount(group: GroupByColumn): string {
    const tokens: Record<string, string> = {
        __ID__: daxString(group.id),
        __COLUMN__: group.column,
        __ATTRIBUTE_FILTER__: group.attribute === undefined ? "" : `, ${evaluationGroupFilter(group)}`,
    };
    return eligibilityRow.replace(/__ID__|__COLUMN__|__ATTRIBUTE_FILTER__/g, (token) => tokens[token]).trim();
}

/** Scope the shared bridge Value column to exactly the selected attribute. */
export function evaluationGroupFilter(group: GroupByColumn): string {
    return treatAs("'Org Attribute Source'[Attribute]", group.attribute === undefined ? [] : [group.attribute]);
}

export function evaluationOrgAttributes() {
    return { connection, filters: EVALUATOR_METADATA, query: orgAttributesQuery };
}

/** Read actual Evaluator bridge attributes, not the main model's inventory. */
export function readEvaluationOrgAttributes(table: QueryTable): GroupByColumn[] {
    const at = (name: string) => table.columns.findIndex((column) => column.name === `[${name}]`);
    const column = at("Column");
    return pickOrgAttributes(table.rows.flatMap((row) =>
        typeof row[column] === "string"
            ? [{ column: row[column] as string, cardinality: 2, maxLength: undefined }]
            : [],
    )).map((name) => ({
        ...(Object.hasOwn(ORG_ALIASES, name) ? ORG_ALIASES[name] : { id: `org:${name}`, label: describeOrgAttribute(name).label }),
        column: "'Org Attribute Source'[Value]",
        attribute: name,
    }));
}

const columnMetadata: ColumnMetadataMap = {
    "[Kind]": { name: "Kind", displayName: "Kind" },
    "[Value]": { name: "Value", displayName: "Value" },
    "[Sort]": { name: "Sort", displayName: "Conversations", format: FORMAT_WHOLE },
};

/** Heavy per-column fact scans run only after the grouping menu opens. */
export function evaluationOrgGroupOptions(columns: readonly GroupByColumn[]) {
    const rows = columns.map(groupCount);
    return {
        connection,
        filters: EVALUATOR_METADATA,
        query: rows.length === 0 ? "" : `EVALUATE\n${rows.length === 1 ? rows[0] : `UNION(\n${rows.join(",\n")}\n)`}`,
        columnMetadata,
    };
}

/** The page's slicer choices and data window, read once and never filtered by the page itself. */
export function evaluationOptions() {
    return {
        connection,
        filters: EVALUATOR_METADATA,
        query: query.replace("__GROUP_COUNTS__", () => GROUP_BY_COLUMNS.map(groupCount).join(",\n    ")),
        columnMetadata,
    };
}

export interface EvaluationChoice {
    value: string;
    label: string;
    count: number;
}

export interface EvaluationOptions {
    firstDate: string | undefined;
    lastDate: string | undefined;
    departments: EvaluationChoice[];
    agents: EvaluationChoice[];
    /** Eligibility counts (at most two populated conversation groups), by column id. */
    groupCounts: Record<string, number>;
}

/** Sorts the options query into the page's slicers, largest first as the query orders them. */
export function readEvaluationOptions(table: DataTable): EvaluationOptions {
    const options: EvaluationOptions = { firstDate: undefined, lastDate: undefined, departments: [], agents: [], groupCounts: {} };
    const at = (name: string) => table.columns.findIndex((column) => column.name === name);
    const [kind, value, sort] = ["Kind", "Value", "Sort"].map(at);
    for (const row of table.rows) {
        const text = typeof row[value] === "string" ? (row[value] as string).trim() : "";
        const count = typeof row[sort] === "number" ? (row[sort] as number) : 0;
        if (!text) continue;
        switch (row[kind]) {
            case "First date":
                options.firstDate = text;
                break;
            case "Last date":
                options.lastDate = text;
                break;
            case "Department":
                options.departments.push({ value: text, label: text, count });
                break;
            case "Agent":
                options.agents.push({ value: text, label: text, count });
                break;
            case "Group by":
                options.groupCounts[text] = count;
                break;
        }
    }
    return options;
}

/** Whether the model holds any conversations at all, as against none in the slicers' current choice. */
export function hasEvaluationData(options: EvaluationOptions): boolean {
    return options.firstDate !== undefined || options.agents.length > 0;
}

/** Group by columns worth offering: one group would only repeat the total. */
export function groupByChoices(
    groupCounts: Record<string, number>,
    orgColumns: readonly GroupByColumn[] = [],
): GroupByColumn[] {
    const department = orgColumns.filter((column) => column.id === "department");
    const others = orgColumns.filter((column) => column.id !== "department");
    return [GROUP_BY_COLUMNS[0], ...department, ...GROUP_BY_COLUMNS.slice(1), ...others]
        .filter((column) => (groupCounts[column.id] ?? 0) >= 2);
}

export type EvaluationPreset = Exclude<DatePreset, "custom">;

export interface EvaluationSelection {
    preset: EvaluationPreset;
    department: string | undefined;
    agent: string | undefined;
}

export const NO_SELECTION: EvaluationSelection = { preset: "all", department: undefined, agent: undefined };

/** The dates a preset covers in this model, or nothing for all of them. */
export function selectionRange(
    preset: EvaluationPreset,
    options: Pick<EvaluationOptions, "firstDate" | "lastDate"> | undefined,
): DateRange | undefined {
    const first = options?.firstDate;
    const last = options?.lastDate;
    if (preset === "all" || !first || !last) return undefined;
    return availablePresets(first, last).includes(preset) ? presetRange(preset, first, last) : undefined;
}

/** The DAX filters for the page's slicers, applied to every query on it. */
export function evaluationFilters(selection: EvaluationSelection, options: EvaluationOptions | undefined): string[] {
    const filters: string[] = [];
    const range = selectionRange(selection.preset, options);
    if (range) filters.push(dateBetween("'Calendar'[Date]", range.from, range.to));
    if (selection.department) filters.push(treatAs("'Chat + Agent Org Data'[Organization]", [selection.department]));
    if (selection.agent) filters.push(treatAs("'Agent Performance'[BotFriendlyName]", [selection.agent]));
    return filters;
}
