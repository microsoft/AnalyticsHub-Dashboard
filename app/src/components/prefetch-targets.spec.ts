//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------
import { describe, expect, it } from "vitest";
import { destinations, isPackable, isReference, openStage } from "./destinations";
import { prefetchTargets } from "./prefetch-targets";

const key = ({ id, stage }: { id: string; stage: string }) => `${id}/${stage}`;

describe("prefetchTargets", () => {
    it("lists the tab each other page opens on, in menu order, then the open page's other tabs", () => {
        const targets = prefetchTargets(destinations, "adoption", "adoption").map(key);
        const others = destinations
            .filter((destination) => destination.id !== "adoption" && !isReference(destination) && isPackable(destination))
            .map((destination) => `${destination.id}/${openStage(destination)}`);
        const tabs = destinations
            .find((destination) => destination.id === "adoption")!
            .stages.filter((stage) => stage.ready && stage.id !== "adoption")
            .map((stage) => `adoption/${stage.id}`);
        expect(targets).toEqual([...others, ...tabs]);
        expect(targets[0]).toBe("executive/the-bottom-line");
    });

    it("from the executive summary, fetches Value, Consumption and Efficiency first, then the rest in menu order", () => {
        expect(prefetchTargets(destinations, "executive", "the-bottom-line").map(key)).toEqual([
            "value/task-breakdown",
            "consumption/consumption-overview",
            "efficiency/cowork-fit",
            "adoption/adoption",
            "leaderboards/leaderboard",
            "work-patterns/m365-activity",
            "readiness/license-readiness",
            "agent-evaluation/agent-performance",
            "governance/estate-health",
            "feedback/feedback",
            "executive/is-it-growing",
            "executive/where-it-is-landing",
            "executive/what-needs-attention",
        ]);
    });

    it("leaves out reference pages, Ask and the tab on screen", () => {
        const ids = prefetchTargets(destinations, "executive", "the-bottom-line").map((target) => target.id);
        expect(ids).not.toContain("assumptions");
        expect(ids).not.toContain("appendix");
        expect(ids).not.toContain("ask");
        expect(prefetchTargets(destinations, "executive", "the-bottom-line").map(key)).not.toContain(
            "executive/the-bottom-line",
        );
    });

    it("only fetches pages the install has", () => {
        const available = destinations.filter((destination) => ["executive", "adoption"].includes(destination.id));
        expect(prefetchTargets(available, "executive", "the-bottom-line").map((target) => target.id)).toEqual([
            "adoption",
            "executive",
            "executive",
            "executive",
        ]);
    });

    it("fetches every page's first tab while a report pack is open", () => {
        const ids = prefetchTargets(destinations, undefined, undefined).map((target) => target.id);
        expect(ids[0]).toBe("executive");
        expect(new Set(ids).size).toBe(ids.length);
    });
});
