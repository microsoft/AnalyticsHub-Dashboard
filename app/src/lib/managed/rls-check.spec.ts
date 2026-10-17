//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { QueryTable } from "@microsoft/fabric-app-data";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDiagnostics, resetDiagnostics } from "./diagnostics";
import { readIdentity, runIdentityCheck } from "./rls-check";

const runtime = vi.hoisted(() => ({
    semanticModels: {} as Record<string, { workspaceId: string; itemId: string }>,
}));

const fabric = vi.hoisted(() => ({ query: vi.fn(), semanticModel: vi.fn() }));

vi.mock("@/lib/runtime-config", () => ({
    MANAGED_CONFIG_PATH: "managed-app.config.json",
    runtimeConfig: () => ({ host: "managed", rayfin: {}, semanticModels: runtime.semanticModels }),
}));

vi.mock("@/lib/fabric-client", () => ({
    getFabricClient: () => ({ semanticModel: fabric.semanticModel }),
}));

function table(columns: string[], rows: unknown[][]): QueryTable {
    return { columns: columns.map((name) => ({ name, dataType: "String" })), rows };
}

beforeEach(() => {
    vi.clearAllMocks();
    resetDiagnostics();
    runtime.semanticModels = { vl: { workspaceId: "11111111-1111-4111-8111-111111111111", itemId: "22222222-2222-4222-8222-222222222222" } };
    fabric.semanticModel.mockReturnValue({ query: fabric.query });
});

describe("runIdentityCheck", () => {
    it("asks the Analytics Hub model, past the cache, who the viewer is, and records it", async () => {
        fabric.query.mockResolvedValue({ status: "success", table: table(["[UPN]", "[User]"], [["avery@contoso.com", "avery@contoso.com"]]) });

        const check = await runIdentityCheck();

        expect(check).toEqual({ status: "done", model: "vl", upn: "avery@contoso.com", user: "avery@contoso.com", checkedAt: expect.any(Number) });
        expect(fabric.semanticModel).toHaveBeenCalledWith("vl");
        expect(fabric.query).toHaveBeenCalledWith(expect.stringContaining("USERPRINCIPALNAME()"), { bypassCache: true });
        expect(getDiagnostics().identity).toEqual(check);
    });

    it("shows the check running until the model answers", async () => {
        let answer!: (result: unknown) => void;
        fabric.query.mockReturnValue(new Promise((resolve) => {
            answer = resolve;
        }));

        const pending = runIdentityCheck();
        expect(getDiagnostics().identity).toMatchObject({ status: "running", model: "vl" });

        answer({ status: "success", table: table(["UPN", "User"], [["a@contoso.com", ""]]) });
        await expect(pending).resolves.toMatchObject({ status: "done", upn: "a@contoso.com" });
        expect(getDiagnostics().identity).not.toHaveProperty("user");
    });

    it("records why the model couldn't answer", async () => {
        fabric.query.mockResolvedValue({ status: "error", error: { category: "api", message: "The user doesn't have access." } });

        await expect(runIdentityCheck()).resolves.toEqual({
            status: "failed",
            model: "vl",
            error: "The user doesn't have access.",
            checkedAt: expect.any(Number),
        });
    });

    it("records a query that throws", async () => {
        fabric.query.mockRejectedValue(new Error("Connector unreachable"));

        await expect(runIdentityCheck()).resolves.toMatchObject({ status: "failed", error: "Connector unreachable" });
        expect(getDiagnostics().identity?.status).toBe("failed");
    });

    it("doesn't ask when the Analytics Hub model isn't set up", async () => {
        runtime.semanticModels = { vl: { workspaceId: "<workspace-id>", itemId: "<item-id>" } };

        await expect(runIdentityCheck()).resolves.toEqual({
            status: "failed",
            model: "vl",
            error: "The Analytics Hub model isn't set up in managed-app.config.json, so there's no model to ask.",
            checkedAt: expect.any(Number),
        });
        expect(fabric.semanticModel).not.toHaveBeenCalled();
    });
});

describe("readIdentity", () => {
    it("reads columns named with or without brackets or a table", () => {
        expect(readIdentity(table(["[UPN]", "[User]"], [[" a@contoso.com ", "CONTOSO\\a"]]))).toEqual({ upn: "a@contoso.com", user: "CONTOSO\\a" });
        expect(readIdentity(table(["user", "Row[UPN]"], [["b", "b@contoso.com"]]))).toEqual({ upn: "b@contoso.com", user: "b" });
    });

    it("leaves out blanks, other types and missing rows", () => {
        expect(readIdentity(table(["[UPN]", "[User]"], [["  ", null]]))).toEqual({});
        expect(readIdentity(table(["[UPN]", "[User]"], [[42, true]]))).toEqual({});
        expect(readIdentity(table(["[UPN]"], []))).toEqual({});
        expect(readIdentity(table(["[Other]"], [["x"]]))).toEqual({});
    });
});
