//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDiagnostics, resetDiagnostics } from "@/lib/managed/diagnostics";
import { setManagedSdk, type ManagedSdk } from "@/lib/managed/host";
import { ManagedAuthService } from "./managed-auth.service";

const viewer = { fullName: "Avery Smith", objectId: "oid-1", tenantId: "tid-1" };

function useSdk(getUser: ManagedSdk["getUser"]): ManagedSdk {
    const sdk: ManagedSdk = {
        dataSources: {},
        execute: vi.fn(),
        getUser: vi.fn(getUser),
        getContext: vi.fn().mockResolvedValue({ appId: "app-1", environmentId: "env-1", sessionId: "session-1" }),
        onMetric: vi.fn(() => () => undefined),
    };
    setManagedSdk(sdk);
    return sdk;
}

beforeEach(() => resetDiagnostics());

afterEach(() => {
    setManagedSdk(undefined);
    vi.useRealTimers();
});

describe("ManagedAuthService", () => {
    it("signs the viewer in as the host's user", async () => {
        const sdk = useSdk(async () => viewer);
        const auth = new ManagedAuthService();

        await expect(auth.initEmbeddedAuth()).resolves.toEqual({ user: { id: "oid-1", email: "" }, isAuthenticated: true, isAnonymous: false });
        expect(auth.getUser()).toEqual({ id: "oid-1", name: "Avery Smith" });
        expect(getDiagnostics().viewer).toEqual(viewer);
        expect(sdk.onMetric).toHaveBeenCalledTimes(1);
    });

    it("signs in a viewer the host doesn't name", async () => {
        useSdk(async () => ({ fullName: "", objectId: "", tenantId: "" }));
        const auth = new ManagedAuthService();

        await expect(auth.initEmbeddedAuth()).resolves.toMatchObject({ user: { id: "managed-user", email: "" } });
        expect(auth.getUser()).toEqual({});
    });

    it("returns no session, and records why, when the host won't say who the viewer is", async () => {
        useSdk(async () => {
            throw new Error("No user");
        });
        const auth = new ManagedAuthService();

        await expect(auth.initEmbeddedAuth()).resolves.toBeNull();
        expect(getDiagnostics().viewerError).toBe("No user");
        expect(auth.getUser()).toBeNull();
    });

    it("gives up on a host that doesn't answer within 8 seconds", async () => {
        vi.useFakeTimers();
        useSdk(() => new Promise<never>(() => undefined));

        const pending = new ManagedAuthService().initEmbeddedAuth();
        await vi.advanceTimersByTimeAsync(8_000);

        await expect(pending).resolves.toBeNull();
        expect(getDiagnostics().viewerError).toBe("The Managed Runtime host didn't answer within 8 seconds.");
    });

    it("returns no session outside the managed build", async () => {
        await expect(new ManagedAuthService().initEmbeddedAuth()).resolves.toBeNull();
        expect(getDiagnostics().viewerError).toBe("The Managed Runtime SDK is only in the managed build.");
    });

    it("throws from signIn so the gate can say why, and clears the error once it works", async () => {
        useSdk(async () => {
            throw "No user";
        });
        await expect(new ManagedAuthService().signIn()).rejects.toThrow("No user");
        expect(getDiagnostics().viewerError).toBe("No user");

        useSdk(async () => viewer);
        await expect(new ManagedAuthService().signIn()).resolves.toMatchObject({ isAuthenticated: true });
        expect(getDiagnostics().viewerError).toBeUndefined();
    });

    it("has no API token to hand out", async () => {
        await expect(new ManagedAuthService().getAccessToken()).rejects.toThrow("not an API token");
    });
});
