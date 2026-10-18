//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------
import type { OpaqueSession } from "@microsoft/rayfin-auth";
import { errorMessage, setViewer, startManagedDiagnostics } from "@/lib/managed/diagnostics";
import { HOST_TIMEOUT_MS, loadManagedSdk, withHostTimeout } from "@/lib/managed/host";
import type { AnalyticsHubUser, IAuthService } from "./rayfin-auth.service";

const HOST_LABEL = "The Managed Runtime host";

/**
 * The Microsoft Copilot Managed Runtime signs viewers in to Microsoft 365
 * before the app loads, so this only asks the host who they are. Data comes
 * through the app's Power BI connector, under each viewer's own connection,
 * so there's no API token to hand out.
 */
export class ManagedAuthService implements IAuthService {
    private user: AnalyticsHubUser | null = null;

    /** Never throws: when the host doesn't answer, the gate offers to try again. */
    async initEmbeddedAuth(): Promise<OpaqueSession | null> {
        try {
            return await this.connect();
        } catch (error) {
            setViewer(undefined, errorMessage(error));
            return null;
        }
    }

    /** Asks the host again, for the gate's Try again. */
    async signIn(): Promise<OpaqueSession> {
        try {
            return await this.connect();
        } catch (error) {
            setViewer(undefined, errorMessage(error));
            throw error instanceof Error ? error : new Error(errorMessage(error));
        }
    }

    getAccessToken(): Promise<string> {
        return Promise.reject(new Error("On the Managed Runtime, data comes through the app's Power BI connector, not an API token."));
    }

    getUser(): AnalyticsHubUser | null {
        return this.user;
    }

    private async connect(): Promise<OpaqueSession> {
        const sdk = await withHostTimeout(loadManagedSdk(), HOST_TIMEOUT_MS, HOST_LABEL);
        startManagedDiagnostics(sdk);
        const viewer = await withHostTimeout(sdk.getUser(), HOST_TIMEOUT_MS, HOST_LABEL);
        setViewer(viewer);
        this.user = {
            ...(viewer.objectId ? { id: viewer.objectId } : {}),
            ...(viewer.fullName ? { name: viewer.fullName } : {}),
        };
        return {
            user: { id: viewer.objectId || "managed-user", email: "" },
            isAuthenticated: true,
            isAnonymous: false,
        } as OpaqueSession;
    }
}
