//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { ColumnMetadataMap } from "./to-data-table";
import { applyDaxFilters, daxString } from "./dax-filters";

/**
 * The row bridge exposes loaded org attributes without requiring a declared
 * model column for every source field.
 *
 * Every org-bound query is written against `Organization`, the column the
 * model always has, and {@link withOrgAttribute} binds other attributes to the bridge.
 */
export const ORG_TABLE = "Chat + Agent Org Data";
export const DEFAULT_ORG_ATTRIBUTE = "Organization";
export const ORG_ATTRIBUTE_TABLE = "Org Attribute Source";
export const ORG_ATTRIBUTE_VALUE_REF = `'${ORG_ATTRIBUTE_TABLE}'[Value]`;

const AUTHORED_REFERENCE = `'${ORG_TABLE}'[${DEFAULT_ORG_ATTRIBUTE}]`;
const AUTHORED_RESULT_COLUMN = `${ORG_TABLE}[${DEFAULT_ORG_ATTRIBUTE}]`;

export interface OrgAttribute {
    /** The raw source column name, e.g. `officeLocation`. */
    column: string;
    /** For headings and filters, e.g. `Office location`. */
    label: string;
    /** Lower-case for prose, e.g. `office location`. */
    noun: string;
    /** Lower-case plural for prose, e.g. `office locations`. */
    plural: string;
}

/** A DAX reference to an org column, with `]` escaped as DAX requires. */
export function orgColumnRef(column: string): string {
    return `'${ORG_TABLE}'[${column.replace(/]/g, "]]")}]`;
}

function humanise(column: string): string {
    const words = column
        .replace(/[_-]+/g, " ")
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .trim()
        .split(/\s+/)
        .map((word, index) => {
            const isAcronym = word.length > 1 && word === word.toUpperCase();
            if (isAcronym) return word;
            return index === 0 ? word[0].toUpperCase() + word.slice(1).toLowerCase() : word.toLowerCase();
        });
    return words.join(" ") || column;
}

function pluralise(phrase: string): string {
    const words = phrase.split(" ");
    const last = words.pop() ?? "";
    const isAcronym = last.length > 1 && last === last.toUpperCase();
    const plural = isAcronym
        ? `${last}s`
        : /[^aeiou]y$/i.test(last)
          ? `${last.slice(0, -1)}ies`
          : /(s|x|z|ch|sh)$/i.test(last)
            ? `${last}es`
            : `${last}s`;
    return [...words, plural].join(" ");
}

export function describeOrgAttribute(column: string): OrgAttribute {
    const label = humanise(column);
    const noun = label
        .split(" ")
        .map((word) => (word.length > 1 && word === word.toUpperCase() ? word : word.toLowerCase()))
        .join(" ");
    return { column, label, noun, plural: pluralise(noun) };
}

/**
 * Prefixes a noun phrase with "a" or "an" by how its first word sounds:
 * "an organization", "a unit", "an HR team", "a UK region".
 */
export function withIndefiniteArticle(phrase: string): string {
    const first = phrase.trim().split(/\s+/)[0] ?? "";
    const isAcronym = first.length > 1 && first === first.toUpperCase() && /[A-Z]/.test(first);
    const vowelSound = isAcronym
        ? /^[AEFHILMNORSX]/.test(first)
        : /^(hour|honest|honou?r|heir)/i.test(first) ||
          (/^[aeiou]/i.test(first) && !/^(u[nrst]i|us[eu]|uk|eu|one|once)/i.test(first));
    return `${vowelSound ? "an" : "a"} ${phrase}`;
}

export interface OrgColumnStatistic {
    column: string;
    cardinality: number;
    /** `undefined` for non-text columns. */
    maxLength: number | undefined;
}

const PERSON_OR_INTERNAL_COLUMNS = new Set([
    "id", "userid", "userkey", "personid", "personkey", "employeeid", "employeekey",
    "objectid", "aadid", "aadobjectid", "entraid", "entraobjectid",
    "upn", "userprincipalname", "principalname", "email", "emailaddress", "mail",
    "personidnormalized", "personidnormalised", "useridnormalized", "useridnormalised",
    "userprincipalnamenormalized", "userprincipalnamenormalised",
    "managerid", "manageruserid", "manageruserkey", "managerupn", "manageruserprincipalname",
    "displayname", "fullname", "preferredname", "firstname", "lastname", "givenname", "surname", "name", "user",
    "hierarchypath", "managementpath", "orgpath", "orgjoinkey", "totalemployees", "hierarchyerror", "orgdatasource",
]);

/** Business codes such as CostCenterId are attributes, not person identifiers. */
export function isOrgAttribute(column: string): boolean {
    const key = column.replace(/[^a-z0-9]/gi, "").toLowerCase();
    return key.length > 0 &&
        !PERSON_OR_INTERNAL_COLUMNS.has(key) &&
        !/^(person|user|employee|manager)(id|key|upn|email|emailaddress|principalname)(normali[sz]ed)?$/.test(key) &&
        !/^rownumber-/i.test(column) &&
        key !== "level5userkey";
}

/**
 * Bridge values are invariant text serialized by the model. Project membership
 * onto the org key explicitly; RLS must not depend on reverse bridge filtering.
 * Evaluator models can supply their alternate org join key.
 */
export function orgValueFilter(column: string, values: readonly string[], keyColumn = "PersonId_Normalized"): string {
    return `TREATAS(CALCULATETABLE(VALUES('${ORG_ATTRIBUTE_TABLE}'[PersonId_Normalized]), '${ORG_ATTRIBUTE_TABLE}'[Attribute] = ${daxString(column)}, ${ORG_ATTRIBUTE_VALUE_REF} IN {${values.map(daxString).join(", ")}}), ${orgColumnRef(keyColumn)})`;
}

/**
 * Candidates from model statistics, regardless of type or cardinality.
 * A bounded value check subsequently excludes blank-plus-single-value columns.
 * `Organization` leads; the rest are alphabetical by label.
 */
export function pickOrgAttributes(stats: readonly OrgColumnStatistic[]): string[] {
    const picked = stats
        .filter(
            (stat) =>
                stat.cardinality >= 2 &&
                isOrgAttribute(stat.column),
        )
        .map((stat) => stat.column);

    return [...new Set(picked)].sort((a, b) => {
        if (a === DEFAULT_ORG_ATTRIBUTE) return -1;
        if (b === DEFAULT_ORG_ATTRIBUTE) return 1;
        return humanise(a).localeCompare(humanise(b));
    });
}

/**
 * Rebinds a query authored against `Organization` to a bridge attribute:
 * the DAX reference, the result-column key its metadata is looked up by, and
 * the "Organization" display names and chart titles. The cleaned field `name`
 * stays the same, so Vega specs and grid columns keep working unchanged.
 */
export function withOrgAttribute<
    T extends { query: string; columnMetadata?: ColumnMetadataMap; vegaLiteSpec?: unknown },
>(config: T, attribute: OrgAttribute): T {
    if (attribute.column === DEFAULT_ORG_ATTRIBUTE) return config;

    const next: T = {
        ...config,
        query: applyDaxFilters(
            rebindOrgAttributeReferences(config.query),
            [`'${ORG_ATTRIBUTE_TABLE}'[Attribute] = ${daxString(attribute.column)}`],
        ),
    };

    if (config.columnMetadata) {
        const columnMetadata: ColumnMetadataMap = {};
        for (const [key, definition] of Object.entries(config.columnMetadata)) {
            const relabelled =
                definition.displayName === DEFAULT_ORG_ATTRIBUTE ? { ...definition, displayName: attribute.label } : definition;
            columnMetadata[key === AUTHORED_RESULT_COLUMN ? `${ORG_ATTRIBUTE_TABLE}[Value]` : key] = relabelled;
        }
        next.columnMetadata = columnMetadata;
    }

    if (config.vegaLiteSpec !== undefined) {
        next.vegaLiteSpec = relabelTitles(config.vegaLiteSpec, attribute.label) as T["vegaLiteSpec"];
    }
    return next;
}

/** Rebinds query-scoped expressions too, including definitions added after the initial query binding. */
export function rebindOrgAttributeReferences(query: string): string {
    // Expanded audit-table ALLEXCEPT also used to clear org grouping. The bridge
    // is on the many side, so its Value now needs clearing explicitly, while
    // Attribute stays selected. Skip literals/comments in the same pass.
    const tokens = /REMOVEFILTERS\s*\(\s*'Chat \+ Agent Org Data'\s*\)|ALLEXCEPT\s*\(\s*'Chat \+ Agent Interactions \(Audit Logs\)'\s*,(?:\s*'Chat \+ Agent Interactions \(Audit Logs\)'\[(?:[^\]]|\]\])*\]\s*,?)+\s*\)|'Chat \+ Agent Org Data'\[Organization\]|"(?:[^"]|"")*"|'(?:[^']|'')*'|\[(?:[^\]]|\]\])*\]|\/\/[^\r\n]*|--[^\r\n]*|\/\*[\s\S]*?\*\//gi;
    return query.replace(tokens, (token) => {
        if (token.toLowerCase() === AUTHORED_REFERENCE.toLowerCase()) return ORG_ATTRIBUTE_VALUE_REF;
        if (/^(REMOVEFILTERS|ALLEXCEPT)\s*\(/i.test(token)) {
            return `${token}, REMOVEFILTERS(${ORG_ATTRIBUTE_VALUE_REF})`;
        }
        return token;
    });
}

/** Swaps every `title: "Organization"` in a spec — axes, legends, tooltips — for the attribute's label. */
function relabelTitles(value: unknown, label: string): unknown {
    if (Array.isArray(value)) return value.map((entry) => relabelTitles(entry, label));
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [
            key,
            key === "title" && entry === DEFAULT_ORG_ATTRIBUTE ? label : relabelTitles(entry, label),
        ]),
    );
}
