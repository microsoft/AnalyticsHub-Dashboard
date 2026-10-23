//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------
import { isConnectionConfigured } from "@/lib/connections";
import { runtimeConfig, type RuntimeConfig } from "@/lib/runtime-config";
import { evaluatorConnection } from "@/queries/shared";

export interface FabricItemLinkConfig {
    portalUrl?: string;
    workspaceId?: string;
    itemId?: string;
    tenantId?: string;
    /** The hostname the app is served from. */
    hostname?: string;
    /** Link shape to build. */
    host?: "fabric" | "azure";
    /** The portal's path segment for the item type: the app item by default. */
    itemType?: "appbackends" | "aiskills" | "datasets" | "reports";
}

const MSIT_HOSTING = /\.msit\.fabricapps\.net$/i;
const MSIT_PORTAL = "https://msit.fabric.microsoft.com";

function fromRuntime(): FabricItemLinkConfig {
    const config = runtimeConfig();
    if (config.host === "azure") {
        const model = config.semanticModels.vl ?? Object.values(config.semanticModels)[0];
        return { host: "azure", workspaceId: model?.workspaceId, itemId: model?.itemId };
    }
    const { portalUrl, workspaceId, itemId, tenantId } = config.rayfin;
    return {
        host: "fabric",
        portalUrl,
        workspaceId,
        itemId,
        tenantId,
        hostname: typeof window === "undefined" ? undefined : window.location.hostname,
    };
}

/** The host-aware link for the app's primary item. */
export function fabricItemUrl(config: FabricItemLinkConfig = fromRuntime()): string | null {
    const { portalUrl, workspaceId, itemId, tenantId, hostname, host = "fabric", itemType = "appbackends" } = config;
    if (!workspaceId || !itemId)
        return null;

    if (host === "azure")
        return `https://app.powerbi.com/groups/${encodeURIComponent(workspaceId)}/datasets/${encodeURIComponent(itemId)}/details`;

    if (!portalUrl)
        return null;
    let url: URL;
    try {
        url = new URL(hostname && MSIT_HOSTING.test(hostname) ? MSIT_PORTAL : portalUrl);
    } catch {
        return null;
    }

    const basePath = url.pathname.replace(/\/+$/, "");
    url.pathname = `${basePath}/groups/${encodeURIComponent(workspaceId)}/${itemType}/${encodeURIComponent(itemId)}`;
    if (tenantId)
        url.searchParams.set("ctid", tenantId);

    return url.toString();
}

/**
 * The data agent the installer set up, on the same portal and tenant as the
 * app item. Fabric still files data agents under their old name, AI skills.
 */
export function dataAgentUrl(agent: { workspaceId: string; itemId: string }, config: FabricItemLinkConfig = fromRuntime()): string | null {
    if (config.host === "azure")
        return null;
    return fabricItemUrl({ ...config, ...agent, itemType: "aiskills" });
}

/**
 * A semantic model's details page, from which its reports open: on the
 * portal the app item lives on, or in Power BI for the Azure host.
 */
export function semanticModelUrl(model: { workspaceId: string; itemId: string }, config: FabricItemLinkConfig = fromRuntime()): string | null {
    if (config.host === "azure")
        return fabricItemUrl({ host: "azure", ...model });
    const url = fabricItemUrl({ ...config, ...model, itemType: "datasets" });
    if (!url)
        return null;
    const parsed = new URL(url);
    parsed.pathname = `${parsed.pathname}/details`;
    return parsed.toString();
}

/** A Power BI report: on the portal the app item lives on, or in Power BI for the Azure host. */
export function reportUrl(report: { workspaceId: string; itemId: string }, config: FabricItemLinkConfig = fromRuntime()): string | null {
    if (config.host === "azure")
        return `https://app.powerbi.com/groups/${encodeURIComponent(report.workspaceId)}/reports/${encodeURIComponent(report.itemId)}`;
    return fabricItemUrl({ ...config, ...report, itemType: "reports" });
}

/**
 * The Agent Evaluator report the installer published, when the config names
 * one, or else its model. The app doesn't query either; the Agents page only
 * links to it.
 */
export function agentEvaluatorUrl(
    runtime: Pick<RuntimeConfig, "semanticModels" | "modules"> = runtimeConfig(),
    config: FabricItemLinkConfig = fromRuntime(),
): string | null {
    if (runtime.modules?.agentEvaluator === false || !isConnectionConfigured(runtime.semanticModels, evaluatorConnection))
        return null;
    const { workspaceId, itemId, reportId } = runtime.semanticModels[evaluatorConnection] ?? {};
    if (!workspaceId || !itemId)
        return null;
    return reportId
        ? reportUrl({ workspaceId: workspaceId.trim(), itemId: reportId.trim() }, config)
        : semanticModelUrl({ workspaceId: workspaceId.trim(), itemId: itemId.trim() }, config);
}
