//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { OpaqueSession } from "@microsoft/rayfin-auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ManagedAuthGate } from "@/components/managed-auth-gate";
import { AuthProvider } from "@/hooks/use-auth";
import { reportAccessDenied } from "@/lib/access";
import type { IAuthService } from "@/services/rayfin-auth.service";

const runtime = vi.hoisted(() => ({
    access: undefined as { groupId: string; groupName?: string; contact?: string } | undefined,
}));

vi.mock("@/lib/runtime-config", () => ({
    runtimeConfig: () => ({ host: "managed", rayfin: {}, semanticModels: {}, access: runtime.access }),
}));

vi.mock("@/components/managed-diagnostics-panel", () => ({
    ManagedDiagnosticsPanel: () => <section aria-label="Copilot Managed App diagnostics" />,
}));

const diagnostics = { name: "Copilot Managed App diagnostics" };

const viewer: OpaqueSession = {
    user: { id: "user-id", email: "" },
    isAuthenticated: true,
    isAnonymous: false,
};

function createAuthService(overrides: Partial<IAuthService> = {}): IAuthService {
    return {
        initEmbeddedAuth: vi.fn().mockResolvedValue(null),
        signIn: vi.fn().mockResolvedValue(viewer),
        ...overrides,
    };
}

function renderGate(authService: IAuthService) {
    render(
        <AuthProvider rayfinAuthService={authService}>
            <ManagedAuthGate>
                <div>Authenticated app</div>
            </ManagedAuthGate>
        </AuthProvider>,
    );
}

describe("ManagedAuthGate", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubEnv("MODE", "managed");
        runtime.access = undefined;
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it("waits for the host to say who the viewer is, then opens the app without a Fabric hand-off", async () => {
        let answer!: (session: OpaqueSession) => void;
        const authService = createAuthService({
            initEmbeddedAuth: vi.fn(() => new Promise<OpaqueSession>((resolve) => {
                answer = resolve;
            })),
        });
        renderGate(authService);

        expect(screen.getByText("Connecting to Analytics Hub…")).toBeInTheDocument();
        expect(screen.queryByRole("link", { name: "Open in Fabric" })).not.toBeInTheDocument();
        expect(screen.queryByRole("region", diagnostics)).not.toBeInTheDocument();

        await waitFor(() => expect(authService.initEmbeddedAuth).toHaveBeenCalledOnce());
        await act(async () => answer(viewer));

        expect(await screen.findByText("Authenticated app")).toBeInTheDocument();
        expect(screen.queryByRole("region", diagnostics)).not.toBeInTheDocument();
    });

    it("offers to try again when the host doesn't answer, above the diagnostics", async () => {
        const authService = createAuthService();
        renderGate(authService);

        expect(await screen.findByRole("heading", { name: "Analytics Hub couldn't connect" })).toBeInTheDocument();
        expect(screen.getByRole("region", diagnostics)).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /Sign in/ })).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "Try again" }));

        expect(authService.signIn).toHaveBeenCalledOnce();
        expect(await screen.findByText("Authenticated app")).toBeInTheDocument();
        expect(screen.queryByRole("region", diagnostics)).not.toBeInTheDocument();
    });

    it("shows the retry in progress, and what went wrong without the pop-ups advice", async () => {
        let fail!: (error: Error) => void;
        const signIn = vi.fn(() => new Promise<OpaqueSession>((_resolve, reject) => {
            fail = reject;
        }));
        renderGate(createAuthService({ signIn }));

        fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
        expect(screen.getByRole("button", { name: "Connecting…" })).toBeDisabled();

        await act(async () => fail(new Error("The host didn't say who you are.")));

        const alert = await screen.findByRole("alert");
        expect(alert).toHaveTextContent("We couldn't connect: The host didn't say who you are.");
        expect(alert).not.toHaveTextContent("pop-ups");
        expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
    });

    it("explains a Power BI refusal, with diagnostics and an email that names the app rather than a link", async () => {
        runtime.access = { groupId: "group-1", groupName: "Analytics Hub Viewers", contact: "admin@example.com" };
        renderGate(createAuthService({ initEmbeddedAuth: vi.fn().mockResolvedValue(viewer) }));
        expect(await screen.findByText("Authenticated app")).toBeInTheDocument();

        act(() => reportAccessDenied("PowerBIAccessDenied"));

        const alert = await screen.findByRole("alert");
        expect(alert).toHaveTextContent("You're signed in, but Power BI won't let you read the Analytics Hub data.");
        expect(alert).toHaveTextContent("Ask to join Analytics Hub Viewers");
        expect(screen.getByRole("region", diagnostics)).toBeInTheDocument();
        expect(screen.queryByText("Authenticated app")).not.toBeInTheDocument();
        const href = screen.getByRole("link", { name: "Email admin@example.com" }).getAttribute("href") ?? "";
        expect(decodeURIComponent(href)).toContain("so I can open Analytics Hub");
        expect(href).not.toContain("fabric.microsoft.com");
    });
});
