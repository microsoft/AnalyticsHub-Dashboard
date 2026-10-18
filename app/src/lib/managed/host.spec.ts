//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { afterEach, describe, expect, it, vi } from "vitest";
import { loadManagedSdk, setManagedSdk, withHostTimeout, type ManagedSdk } from "./host";
import { createManagedSdk } from "./sdk";

const fake = vi.hoisted(() => ({
    dataSources: {},
    execute: vi.fn(),
    getUser: vi.fn(),
    getContext: vi.fn(),
    onMetric: vi.fn(),
}));

vi.mock("./sdk", () => ({ createManagedSdk: vi.fn(() => fake) }));

afterEach(() => {
    setManagedSdk(undefined);
    vi.unstubAllEnvs();
    vi.useRealTimers();
    vi.clearAllMocks();
});

describe("loadManagedSdk", () => {
    it("refuses outside the managed build", async () => {
        await expect(loadManagedSdk()).rejects.toThrow("The Managed Runtime SDK is only in the managed build.");
        expect(createManagedSdk).not.toHaveBeenCalled();
    });

    it("loads the SDK once in the managed build", async () => {
        vi.stubEnv("MODE", "managed");

        await expect(loadManagedSdk()).resolves.toBe(fake);
        await expect(loadManagedSdk()).resolves.toBe(fake);
        expect(createManagedSdk).toHaveBeenCalledTimes(1);
    });

    it("tries again after a load fails", async () => {
        await expect(loadManagedSdk()).rejects.toThrow();

        vi.stubEnv("MODE", "managed");
        vi.mocked(createManagedSdk).mockImplementationOnce(() => {
            throw new Error("No host");
        });
        await expect(loadManagedSdk()).rejects.toThrow("No host");
        await expect(loadManagedSdk()).resolves.toBe(fake);
    });

    it("uses a fake SDK when given one", async () => {
        const other = { ...fake, dataSources: { powerbi: { apis: {} } } } as ManagedSdk;
        setManagedSdk(other);

        await expect(loadManagedSdk()).resolves.toBe(other);
    });
});

describe("withHostTimeout", () => {
    it("passes on what the host answers", async () => {
        await expect(withHostTimeout(Promise.resolve(5), 1_000, "The host")).resolves.toBe(5);
        await expect(withHostTimeout(Promise.reject(new Error("No")), 1_000, "The host")).rejects.toThrow("No");
    });

    it("gives up, naming the host, when it doesn't answer in time", async () => {
        vi.useFakeTimers();
        const pending = withHostTimeout(new Promise(() => undefined), 8_000, "The host");
        const assertion = expect(pending).rejects.toThrow("The host didn't answer within 8 seconds.");

        await vi.advanceTimersByTimeAsync(8_000);
        await assertion;
    });

    it("clears its timer once the host answers", async () => {
        vi.useFakeTimers();

        await withHostTimeout(Promise.resolve("ok"), 8_000, "The host");
        expect(vi.getTimerCount()).toBe(0);
    });
});
