//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { tenantDefaultFilters, type FilterState } from "./filters";
import { isPlainClick, parseHash, routeHash, sameRoute } from "./route";

const click = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false };

describe("parseHash", () => {
    it("reads a destination and stage", () => {
        expect(parseHash("#/adoption/activation").route).toEqual({ kind: "destination", id: "adoption", stage: "activation" });
    });

    it("reads a destination without a stage", () => {
        expect(parseHash("#/value").route).toEqual({ kind: "destination", id: "value", stage: undefined });
    });

    it("drops a stage the destination doesn't have", () => {
        expect(parseHash("#/value/activation").route).toEqual({ kind: "destination", id: "value", stage: undefined });
    });

    it("reads a report pack", () => {
        expect(parseHash("#/pack/monthly%20review").route).toEqual({ kind: "pack", id: "monthly review" });
    });

    it("knows nothing of an empty or unknown hash", () => {
        expect(parseHash("").route).toBeUndefined();
        expect(parseHash("#/").route).toBeUndefined();
        expect(parseHash("#/nowhere/at-all").route).toBeUndefined();
        expect(parseHash("#/pack").route).toBeUndefined();
    });

    it("starts on the tenant's default filters when the hash names none", () => {
        expect(parseHash("#/executive").filters).toEqual(tenantDefaultFilters);
    });

    it("reads every filter", () => {
        const { filters } = parseHash(
            "#/adoption?from=2026-01-05&to=2026-03-29&preset=12w&orgBy=Department&org=Sales&org=HR&licence=licensed&audience=agents&agentType=Declarative&agent=Researcher",
        );
        expect(filters).toEqual<FilterState>({
            dateRange: { preset: "12w", from: "2026-01-05", to: "2026-03-29" },
            orgAttribute: "Department",
            organizations: ["Sales", "HR"],
            licence: "licensed",
            audience: "agents",
            agentTypes: ["Declarative"],
            agentNames: ["Researcher"],
        });
    });

    it("reads every date", () => {
        expect(parseHash("#/adoption?dates=all").filters.dateRange).toBeUndefined();
    });

    it("ignores values it doesn't recognise", () => {
        const { filters } = parseHash("#/adoption?licence=some&audience=nobody&from=2026-13&to=x&preset=9w");
        expect(filters.licence).toBe("all");
        expect(filters.audience).toBe("all");
        expect(filters.dateRange).toEqual(tenantDefaultFilters.dateRange);
    });

    it("calls an unknown preset custom", () => {
        expect(parseHash("#/adoption?from=2026-01-05&to=2026-02-01&preset=9w").filters.dateRange).toEqual({
            preset: "custom",
            from: "2026-01-05",
            to: "2026-02-01",
        });
    });
});

describe("routeHash", () => {
    it("writes a destination and stage", () => {
        expect(routeHash({ kind: "destination", id: "value", stage: "cost-vs-value" })).toBe("#/value/cost-vs-value");
    });

    it("writes a pack", () => {
        expect(routeHash({ kind: "pack", id: "monthly review" })).toBe("#/pack/monthly%20review");
    });

    it("leaves out filters at the session's defaults", () => {
        expect(routeHash({ kind: "destination", id: "executive" }, tenantDefaultFilters)).toBe("#/executive");
    });

    it("round-trips filters that differ from the defaults", () => {
        const filters: FilterState = {
            dateRange: { preset: "custom", from: "2026-02-01", to: "2026-02-28" },
            orgAttribute: "Country",
            organizations: ["Ireland", "Spain & Portugal"],
            licence: "unlicensed",
            audience: "cowork",
            agentTypes: ["Custom engine agent"],
            agentNames: ["HR Helper", "IT Help Desk"],
        };
        const hash = routeHash({ kind: "destination", id: "adoption", stage: "habit-formation" }, filters);
        expect(parseHash(hash)).toEqual({ route: { kind: "destination", id: "adoption", stage: "habit-formation" }, filters });
    });

    it("round-trips every date", () => {
        const hash = routeHash({ kind: "destination", id: "adoption" }, { ...tenantDefaultFilters, dateRange: undefined });
        expect(hash).toBe("#/adoption?dates=all");
        expect(parseHash(hash).filters.dateRange).toBeUndefined();
    });
});

describe("sameRoute", () => {
    it("compares destinations by id and stage, and packs by id", () => {
        expect(sameRoute({ kind: "destination", id: "value" }, { kind: "destination", id: "value" })).toBe(true);
        expect(sameRoute({ kind: "destination", id: "value", stage: "estimated-value" }, { kind: "destination", id: "value" })).toBe(false);
        expect(sameRoute({ kind: "pack", id: "a" }, { kind: "pack", id: "a" })).toBe(true);
        expect(sameRoute({ kind: "pack", id: "a" }, { kind: "destination", id: "value" })).toBe(false);
        expect(sameRoute(undefined, undefined)).toBe(true);
    });
});

describe("isPlainClick", () => {
    it("is true only for an unmodified left click", () => {
        expect(isPlainClick(click)).toBe(true);
        expect(isPlainClick({ ...click, button: 1 })).toBe(false);
        expect(isPlainClick({ ...click, ctrlKey: true })).toBe(false);
        expect(isPlainClick({ ...click, metaKey: true })).toBe(false);
        expect(isPlainClick({ ...click, shiftKey: true })).toBe(false);
        expect(isPlainClick({ ...click, defaultPrevented: true })).toBe(false);
    });
});
