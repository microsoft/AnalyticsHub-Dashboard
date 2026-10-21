//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { act, fireEvent, render } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { FilterContext } from "@/hooks/filter.context";
import { defaultFilters, filterLabel } from "@/lib/filters";
import { DEFAULT_ORG_ATTRIBUTE, describeOrgAttribute } from "@/lib/org-attribute";
import { FilterBar } from "./filter-bar";

type FilterContextValue = ComponentProps<typeof FilterContext.Provider>["value"];

/** Opens a filter menu's panel, as the browser does for its popover. */
function openMenu(name: string) {
    const panel = document.querySelector(`[role="dialog"][aria-label="${name}"]`);
    if (!panel) throw new Error(`No filter menu named ${name}.`);
    const toggle = new Event("toggle");
    Object.defineProperty(toggle, "newState", { value: "open" });
    act(() => {
        panel.dispatchEvent(toggle);
    });
}

describe("FilterBar", () => {
    it("loads the menus' choices as a menu other than the dates opens", () => {
        const requestFilterChoices = vi.fn();
        const context: FilterContextValue = {
            filters: defaultFilters,
            setFilters: () => {},
            options: undefined,
            optionsError: undefined,
            applicable: ["dateRange", "organizations", "agentTypes", "agentNames"],
            orgAttribute: describeOrgAttribute(DEFAULT_ORG_ATTRIBUTE),
            orgAttributes: [DEFAULT_ORG_ATTRIBUTE, "Department"],
            orgValues: undefined,
            requestFilterChoices,
        };
        render(
            <FilterContext.Provider value={context}>
                <FilterBar destinationLabel="Agents" />
            </FilterContext.Provider>,
        );

        // Its presets and fields come with the page's filter options.
        openMenu(filterLabel("dateRange", ""));
        expect(requestFilterChoices).not.toHaveBeenCalled();

        const menus = [
            "Group by",
            describeOrgAttribute(DEFAULT_ORG_ATTRIBUTE).label,
            filterLabel("agentTypes", ""),
            filterLabel("agentNames", ""),
        ];
        for (const menu of menus) {
            requestFilterChoices.mockClear();
            openMenu(menu);
            expect(requestFilterChoices, menu).toHaveBeenCalledOnce();
        }
    });

    it("keeps the org menu open as its column changes, and ends a search typed there", () => {
        const organizations = Array.from({ length: 9 }, (_, index) => `Org ${String.fromCharCode(65 + index)}`);
        const departments = Array.from({ length: 9 }, (_, index) => `Department ${index + 1}`);
        const bar = (column: string, orgValues: readonly string[]) => (
            <FilterContext.Provider
                value={{
                    filters: defaultFilters,
                    setFilters: () => {},
                    options: undefined,
                    optionsError: undefined,
                    applicable: ["organizations"],
                    orgAttribute: describeOrgAttribute(column),
                    orgAttributes: [DEFAULT_ORG_ATTRIBUTE, "Department"],
                    orgValues,
                    requestFilterChoices: () => {},
                }}
            >
                <FilterBar destinationLabel="Agents" />
            </FilterContext.Provider>
        );
        const choices = (panel: Element) => [...panel.querySelectorAll("li")].map((item) => item.textContent);
        const searchBox = (panel: Element) => panel.querySelector<HTMLInputElement>('input[type="search"]')!;

        const { rerender } = render(bar(DEFAULT_ORG_ATTRIBUTE, organizations));
        const label = describeOrgAttribute(DEFAULT_ORG_ATTRIBUTE).label;
        openMenu(label);
        const panel = document.querySelector(`[role="dialog"][aria-label="${label}"]`)!;
        fireEvent.change(searchBox(panel), { target: { value: "Org A" } });
        expect(choices(panel)).toEqual(["Org A"]);

        rerender(bar("Department", departments));
        // The same panel, so the menu stays open: the org columns can change the column while it's open.
        expect(panel.isConnected).toBe(true);
        expect(panel.getAttribute("aria-label")).toBe(describeOrgAttribute("Department").label);
        expect(searchBox(panel).value).toBe("");
        expect(choices(panel)).toEqual(departments);

        rerender(bar(DEFAULT_ORG_ATTRIBUTE, organizations));
        expect(searchBox(panel).value).toBe("");
        expect(choices(panel)).toEqual(organizations);
    });
});
