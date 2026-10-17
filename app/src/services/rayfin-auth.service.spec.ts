//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({ inTeams: true }));

/** The TeamsJS calls the tab makes in its host: Teams, Outlook or the Microsoft 365 app. */
const host = vi.hoisted(() => ({
    initialize: vi.fn<() => Promise<void>>(),
    getAuthToken: vi.fn<(request?: { silent?: boolean }) => Promise<string>>(),
    authenticate: vi.fn<(params: { url: string }) => Promise<string>>(),
    notifySuccess: vi.fn(),
    notifyFailure: vi.fn(),
}));

vi.mock("@/lib/runtime-config", () => ({
    runtimeConfig: () => ({
        host: "azure",
        rayfin: {},
        semanticModels: {},
        azure: { tenantId: "tenant", clientId: "client", apiScope: "api://host/client/access_as_user", inTeams: runtime.inTeams },
    }),
}));

vi.mock("@microsoft/teams-js", () => ({
    app: { initialize: host.initialize },
    authentication: {
        getAuthToken: host.getAuthToken,
        authenticate: host.authenticate,
        notifySuccess: host.notifySuccess,
        notifyFailure: host.notifyFailure,
    },
}));

// MSAL has no cached account, so only the host can sign the tab in.
vi.mock("@azure/msal-browser", () => ({
    InteractionRequiredAuthError: class InteractionRequiredAuthError extends Error {},
    PublicClientApplication: class {
        initialize = vi.fn().mockResolvedValue(undefined);
        handleRedirectPromise = vi.fn().mockResolvedValue(null);
        getActiveAccount = vi.fn().mockReturnValue(null);
        getAllAccounts = vi.fn().mockReturnValue([]);
        setActiveAccount = vi.fn();
        loginRedirect = vi.fn().mockResolvedValue(undefined);
    },
}));

import { bootstrapAuth } from "@/services/rayfin-auth.service";

/** A token as the host hands it over. The app only reads its claims. */
function hostToken(claims: Record<string, unknown>): string {
    return `header.${btoa(JSON.stringify(claims)).replace(/\+/g, "-").replace(/\//g, "_")}.signature`;
}

const ada = { oid: "user-1", name: "Ada Lovelace", preferred_username: "ada@example.com", roles: ["AnalyticsHub.User"] };

describe("Azure sign-in in a Teams, Outlook or Microsoft 365 tab", () => {
    beforeEach(() => {
        vi.resetAllMocks();
        runtime.inTeams = true;
        host.initialize.mockResolvedValue(undefined);
        history.replaceState(null, "", "/?host=teams");
    });

    afterEach(() => {
        history.replaceState(null, "", "/");
    });

    it("signs in as the tab opens, without a click, when the host has a token", async () => {
        host.getAuthToken.mockResolvedValue(hostToken(ada));
        const auth = bootstrapAuth();

        await expect(auth.initEmbeddedAuth()).resolves.toMatchObject({
            isAuthenticated: true,
            user: { id: "user-1", email: "ada@example.com" },
        });
        expect(host.getAuthToken).toHaveBeenCalledOnce();
        expect(host.getAuthToken).toHaveBeenCalledWith({ silent: true });
        expect(host.authenticate).not.toHaveBeenCalled();
        expect(auth.getUser?.()).toMatchObject({ name: "Ada Lovelace", roles: ["AnalyticsHub.User"] });
    });

    it("falls back to the Sign in button when the host can't sign in silently", async () => {
        host.getAuthToken.mockRejectedValueOnce(new Error("resourceRequiresConsent"));
        const auth = bootstrapAuth();

        await expect(auth.initEmbeddedAuth()).resolves.toBeNull();
        expect(host.authenticate).not.toHaveBeenCalled();

        // The button asks the host again, then opens its pop-up for the prompt.
        host.getAuthToken
            .mockRejectedValueOnce(new Error("resourceRequiresConsent"))
            .mockResolvedValueOnce(hostToken(ada));
        host.authenticate.mockResolvedValueOnce("");
        await expect(auth.signIn()).resolves.toMatchObject({ isAuthenticated: true, user: { id: "user-1" } });
        expect(host.authenticate).toHaveBeenCalledOnce();
        expect(host.authenticate).toHaveBeenCalledWith({ url: `${window.location.origin}/?host=teams&auth=popup` });
    });

    it("doesn't ask for a token silently in the sign-in pop-up", async () => {
        history.replaceState(null, "", "/?host=teams&auth=popup");
        const auth = bootstrapAuth();

        await expect(auth.initEmbeddedAuth()).resolves.toBeNull();
        expect(host.getAuthToken).not.toHaveBeenCalled();
    });

    it("leaves a browser outside a host to the Microsoft sign-in button", async () => {
        runtime.inTeams = false;
        const auth = bootstrapAuth();

        await expect(auth.initEmbeddedAuth()).resolves.toBeNull();
        expect(host.getAuthToken).not.toHaveBeenCalled();
    });
});
