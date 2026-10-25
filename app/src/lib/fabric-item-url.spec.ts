//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import { agentEvaluatorUrl, dataAgentUrl, fabricItemUrl, semanticModelUrl } from "@/lib/fabric-item-url";

const ids = {
    workspaceId: "ws-1",
    itemId: "item-1",
    tenantId: "tenant-1",
};

describe("fabricItemUrl", () => {
    it("links to the app item on the build's portal, in the tenant it was deployed to", () => {
        expect(fabricItemUrl({
            ...ids,
            portalUrl: "https://app.fabric.microsoft.com/",
            hostname: "loyal-arch-1-westus3.webapp.fabricapps.net",
        })).toBe("https://app.fabric.microsoft.com/groups/ws-1/appbackends/item-1?ctid=tenant-1");
    });

    it("opens internal-ring apps on the internal portal", () => {
        expect(fabricItemUrl({
            ...ids,
            portalUrl: "https://app.fabric.microsoft.com",
            hostname: "calm-fawn-1-westcentralus.webapp.msit.fabricapps.net",
        })).toBe("https://msit.fabric.microsoft.com/groups/ws-1/appbackends/item-1?ctid=tenant-1");
    });

    it("keeps the portal's path and query, and leaves out an unknown tenant", () => {
        expect(fabricItemUrl({
            workspaceId: "ws 1",
            itemId: "item-1",
            portalUrl: "https://portal.example.com/fabric/?debug.useLocalManifests=1",
        })).toBe("https://portal.example.com/fabric/groups/ws%201/appbackends/item-1?debug.useLocalManifests=1");
    });

    it("has no link without the portal, workspace and item", () => {
        expect(fabricItemUrl({ ...ids, portalUrl: undefined })).toBeNull();
        expect(fabricItemUrl({ ...ids, portalUrl: "https://app.fabric.microsoft.com", workspaceId: "" })).toBeNull();
        expect(fabricItemUrl({ ...ids, portalUrl: "https://app.fabric.microsoft.com", itemId: undefined })).toBeNull();
        expect(fabricItemUrl({ ...ids, portalUrl: "not a url" })).toBeNull();
    });
});

describe("dataAgentUrl", () => {
    it("links to the data agent on the app's portal and tenant", () => {
        expect(dataAgentUrl(
            { workspaceId: "ws-2", itemId: "agent-1" },
            { ...ids, portalUrl: "https://app.fabric.microsoft.com", hostname: "loyal-arch-1-westus3.webapp.fabricapps.net" },
        )).toBe("https://app.fabric.microsoft.com/groups/ws-2/aiskills/agent-1?ctid=tenant-1");
    });

    it("has no link on Azure", () => {
        expect(dataAgentUrl({ workspaceId: "ws-2", itemId: "agent-1" }, { ...ids, host: "azure" })).toBeNull();
    });
});

describe("semanticModelUrl", () => {
    const model = { workspaceId: "ws-2", itemId: "model-2" };

    it("opens the model's details on the app's portal, in its tenant", () => {
        expect(semanticModelUrl(model, { ...ids, host: "fabric", portalUrl: "https://app.fabric.microsoft.com" })).toBe(
            "https://app.fabric.microsoft.com/groups/ws-2/datasets/model-2/details?ctid=tenant-1",
        );
    });

    it("opens the model in Power BI for the Azure host", () => {
        expect(semanticModelUrl(model, { host: "azure" })).toBe(
            "https://app.powerbi.com/groups/ws-2/datasets/model-2/details",
        );
    });

    it("has no link without the portal", () => {
        expect(semanticModelUrl(model, { host: "fabric" })).toBeNull();
    });
});

describe("agentEvaluatorUrl", () => {
    const WORKSPACE = "11111111-1111-1111-1111-111111111111";
    const ITEM = "22222222-2222-2222-2222-222222222222";
    const portal = { ...ids, host: "fabric" as const, portalUrl: "https://app.fabric.microsoft.com" };

    it("links to the Agent Evaluator model the installer set up", () => {
        const runtime = { semanticModels: { ae: { workspaceId: WORKSPACE, itemId: ITEM } } };
        expect(agentEvaluatorUrl(runtime, portal)).toBe(
            `https://app.fabric.microsoft.com/groups/${WORKSPACE}/datasets/${ITEM}/details?ctid=tenant-1`,
        );
    });

    it("opens the Agent Evaluator report instead, when the config names one", () => {
        const REPORT = "33333333-3333-3333-3333-333333333333";
        const runtime = { semanticModels: { ae: { workspaceId: WORKSPACE, itemId: ITEM, reportId: REPORT } } };
        expect(agentEvaluatorUrl(runtime, portal)).toBe(
            `https://app.fabric.microsoft.com/groups/${WORKSPACE}/reports/${REPORT}?ctid=tenant-1`,
        );
        expect(agentEvaluatorUrl(runtime, { host: "azure" })).toBe(
            `https://app.powerbi.com/groups/${WORKSPACE}/reports/${REPORT}`,
        );
    });

    it("has no link when Agent Evaluator wasn't installed or was turned off", () => {
        expect(agentEvaluatorUrl({ semanticModels: {} }, portal)).toBeNull();
        expect(
            agentEvaluatorUrl({ semanticModels: { ae: { workspaceId: "<Agent Evaluator workspace ID>", itemId: ITEM } } }, portal),
        ).toBeNull();
        expect(
            agentEvaluatorUrl(
                {
                    semanticModels: { ae: { workspaceId: WORKSPACE, itemId: ITEM } },
                    modules: { m365Activity: true, agent365: true, productFeedback: true, consumption: true, agentEvaluator: false },
                },
                portal,
            ),
        ).toBeNull();
    });
});
