//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { destinations, type DestinationId, type StageId } from "@/components/destinations";
import {
    TENANT_DEFAULT_RANGE,
    tenantDefaultFilters,
    type Audience,
    type DatePreset,
    type DateFilterValue,
    type FilterState,
    type Licence,
} from "./filters";

/** What the canvas is asked to show: a destination at one of its stages, or a report pack. */
export type Route = { kind: "destination"; id: DestinationId; stage?: StageId } | { kind: "pack"; id: string };

export interface ParsedLocation {
    /** Undefined when the hash names nothing the app knows. */
    route: Route | undefined;
    filters: FilterState;
}

/*
 * The view lives in the URL's hash, not its path or query: the sign-in
 * redirect is built from the path and query, and `?host=teams` and
 * `?auth=popup` belong to the host. So `#/adoption/activation?licence=licensed`
 * opens Adoption's Activation stage for licensed people; a filter left at the
 * session's default is left out.
 */

const LICENCES: readonly Licence[] = ["all", "licensed", "unlicensed"];
const AUDIENCES: readonly Audience[] = ["all", "copilot", "agents", "cowork"];
const PRESETS: readonly DatePreset[] = ["4w", "8w", "12w", "custom"];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function findDestination(id: string) {
    return destinations.find((destination) => destination.id === id);
}

function parseRoute(path: string): Route | undefined {
    const [first, second] = path.split("/").filter(Boolean).map(safeDecode);
    if (!first) return undefined;
    if (first === "pack") return second ? { kind: "pack", id: second } : undefined;
    const destination = findDestination(first);
    if (!destination) return undefined;
    const stage = destination.stages.find((candidate) => candidate.id === second)?.id;
    return { kind: "destination", id: destination.id, stage };
}

function safeDecode(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

function parseDates(params: URLSearchParams): DateFilterValue | undefined {
    if (params.get("dates") === "all") return undefined;
    const from = params.get("from");
    const to = params.get("to");
    if (from && to && ISO_DATE.test(from) && ISO_DATE.test(to) && from <= to) {
        const preset = params.get("preset") as DatePreset | null;
        return { preset: preset && PRESETS.includes(preset) ? (preset as Exclude<DatePreset, "all">) : "custom", from, to };
    }
    return TENANT_DEFAULT_RANGE;
}

function pick<T extends string>(value: string | null, allowed: readonly T[], fallback: T): T {
    return value && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/** Reads the view and filters from a URL hash such as `#/value/estimated-value?org=Sales`. */
export function parseHash(hash: string): ParsedLocation {
    const body = hash.replace(/^#/, "");
    const queryAt = body.indexOf("?");
    const path = queryAt === -1 ? body : body.slice(0, queryAt);
    const params = new URLSearchParams(queryAt === -1 ? "" : body.slice(queryAt + 1));
    const filters: FilterState = {
        dateRange: parseDates(params),
        orgAttribute: params.get("orgBy") || tenantDefaultFilters.orgAttribute,
        organizations: params.getAll("org").filter(Boolean),
        licence: pick(params.get("licence"), LICENCES, tenantDefaultFilters.licence),
        audience: pick(params.get("audience"), AUDIENCES, tenantDefaultFilters.audience),
        agentTypes: params.getAll("agentType").filter(Boolean),
        agentNames: params.getAll("agent").filter(Boolean),
    };
    return { route: parseRoute(path), filters };
}

function filterParams(filters: FilterState): URLSearchParams {
    const params = new URLSearchParams();
    const range = filters.dateRange;
    if (range === undefined) params.set("dates", "all");
    else if (range.relative !== true) {
        params.set("from", range.from);
        params.set("to", range.to);
        if (range.preset !== "custom") params.set("preset", range.preset);
    }
    if (filters.orgAttribute !== tenantDefaultFilters.orgAttribute) params.set("orgBy", filters.orgAttribute);
    for (const org of filters.organizations) params.append("org", org);
    if (filters.licence !== "all") params.set("licence", filters.licence);
    if (filters.audience !== "all") params.set("audience", filters.audience);
    for (const type of filters.agentTypes) params.append("agentType", type);
    for (const name of filters.agentNames) params.append("agent", name);
    return params;
}

/** The hash for a route, with the filters that differ from the session's defaults. */
export function routeHash(route: Route, filters?: FilterState): string {
    const path =
        route.kind === "pack"
            ? `/pack/${encodeURIComponent(route.id)}`
            : `/${route.id}${route.stage ? `/${route.stage}` : ""}`;
    const query = filters ? filterParams(filters).toString() : "";
    return `#${path}${query ? `?${query}` : ""}`;
}

/** Whether two routes open the same view. */
export function sameRoute(a: Route | undefined, b: Route | undefined): boolean {
    if (!a || !b) return a === b;
    if (a.kind === "pack" || b.kind === "pack") return a.kind === b.kind && a.id === b.id;
    return a.id === b.id && a.stage === b.stage;
}

/**
 * Whether a click on an in-app link should navigate in place: a plain
 * left click. A modified or middle click is left to the browser, which
 * opens the link's hash in a new tab or window.
 */
export function isPlainClick(event: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; defaultPrevented: boolean }): boolean {
    return !event.defaultPrevented && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}
