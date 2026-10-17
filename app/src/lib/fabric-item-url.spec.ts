//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { afterEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
    config: { host: "managed", rayfin: {}, semanticModels: {} } as { host: string; rayfin: { portalUrl?: string }; semanticModels: object },
}));

vi.mock("@/lib/runtime-config", () => ({ runtimeConfig: () => runtime.config }));

import { dataAgentUrl, fabricItemUrl } from "@/lib/fabric-item-url";

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

describe("in a Copilot Managed App", () => {
    const agent = { workspaceId: "ws-2", itemId: "agent-1" };

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it("has no app item to link to", () => {
        vi.stubEnv("MODE", "managed");
        runtime.config = { host: "managed", rayfin: {}, semanticModels: {} };
        expect(fabricItemUrl()).toBeNull();
    });

    it("still links to the data agent, which lives in Fabric", () => {
        vi.stubEnv("MODE", "managed");
        runtime.config = { host: "managed", rayfin: {}, semanticModels: {} };
        expect(dataAgentUrl(agent)).toBe("https://app.fabric.microsoft.com/groups/ws-2/aiskills/agent-1");

        runtime.config = { host: "managed", rayfin: { portalUrl: "https://msit.fabric.microsoft.com" }, semanticModels: {} };
        expect(dataAgentUrl(agent)).toBe("https://msit.fabric.microsoft.com/groups/ws-2/aiskills/agent-1");
    });
});
