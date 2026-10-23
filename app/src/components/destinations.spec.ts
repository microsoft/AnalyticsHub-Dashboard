//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import {
    availableProducts,
    destinations,
    isBandDestination,
    productDestinations,
    products,
    tabLabel,
    type Destination,
} from "@/components/destinations";

const byId = (id: string) => destinations.find((destination) => destination.id === id) as Destination;

describe("destinations", () => {
    it("each belong to one of the three products", () => {
        const ids = products.map((product) => product.id);
        expect(ids).toEqual(["valuelens", "consumption", "evaluator"]);
        for (const destination of destinations) expect(ids).toContain(destination.product);
    });

    it("put Ask and the assumptions in the band, outside any product's tabs", () => {
        expect(destinations.filter(isBandDestination).map((destination) => destination.id)).toEqual(["ask", "assumptions"]);
        expect(productDestinations(destinations, "valuelens").map((destination) => destination.id)).not.toContain("ask");
    });

    it("take a shorter tab name where one is set", () => {
        expect(tabLabel(byId("executive"))).toBe("Summary");
        expect(tabLabel(byId("appendix"))).toBe("Guide");
        expect(tabLabel(byId("adoption"))).toBe("Adoption");
    });

    it("give Consumption Central and Agent Evaluator one destination each, whose stages are their tabs", () => {
        expect(productDestinations(destinations, "consumption").map((destination) => destination.id)).toEqual(["consumption"]);
        expect(productDestinations(destinations, "evaluator").map((destination) => destination.id)).toEqual(["agent-evaluation"]);
    });

    it("offer only the products with a destination available, in switcher order", () => {
        const valueLensOnly = destinations.filter((destination) => destination.product === "valuelens");
        expect(availableProducts(valueLensOnly).map((product) => product.id)).toEqual(["valuelens"]);
        expect(availableProducts(destinations).map((product) => product.id)).toEqual(["valuelens", "consumption", "evaluator"]);
        // Ask alone does not make a product worth switching to.
        expect(availableProducts([byId("ask"), byId("consumption")]).map((product) => product.id)).toEqual(["consumption"]);
    });
});
