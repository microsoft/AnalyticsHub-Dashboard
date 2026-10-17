//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

/** One parameter of a connector operation, as `ms app add data-source` describes it. */
export interface ApiParameter {
    name: string;
    /** Where it goes: `path`, `query`, `body` or `header`. */
    in: string;
    required?: boolean;
    type?: string;
}

export interface ApiDefinition {
    path: string;
    method: string;
    parameters: ApiParameter[];
}

export interface DataSourceInfo {
    apis: Record<string, ApiDefinition>;
}

/** The app's connector data sources, by name. */
export type DataSources = Readonly<Record<string, DataSourceInfo>>;

export interface ManagedOperationResult {
    success: boolean;
    data?: unknown;
    error?: { message: string; status?: number; code?: string; requestId?: string };
}

export interface ManagedUser {
    fullName: string;
    objectId: string;
    tenantId: string;
}

export interface ManagedContext {
    appId: string;
    environmentId: string;
    sessionId: string;
}

/** A metric the host streams to the app: `sessionLoadSummary`, `networkRequest` or `dataRequestsSummary`. */
export interface HostMetric {
    type: string;
    [field: string]: unknown;
}

/** What the app uses from the Managed Runtime SDK. `./sdk` is the only module that imports the SDK. */
export interface ManagedSdk {
    /** The data sources `ms app add data-source` wrote. Empty until one is added. */
    readonly dataSources: DataSources;
    execute(dataSource: string, operation: string, parameters: Record<string, unknown>): Promise<ManagedOperationResult>;
    getUser(): Promise<ManagedUser>;
    getContext(): Promise<ManagedContext>;
    /** Sends each host metric to the listener, starting with any that arrived before it subscribed. */
    onMetric(listener: (metric: HostMetric) => void): () => void;
}

/** How long to wait for the host. Its own handshake gives up after 30 seconds. */
export const HOST_TIMEOUT_MS = 8_000;

let sdk: Promise<ManagedSdk> | undefined;

/** The Managed Runtime SDK. Only the managed build includes it; anywhere else this rejects. A failed load is retried next time. */
export function loadManagedSdk(): Promise<ManagedSdk> {
    // Inline so other builds drop the SDK at build time.
    sdk ??= (import.meta.env.MODE === "managed"
        ? import("./sdk").then(({ createManagedSdk }) => createManagedSdk())
        : Promise.reject(new Error("The Managed Runtime SDK is only in the managed build.")))
        .catch((error: unknown) => {
            sdk = undefined;
            throw error;
        });
    return sdk;
}

/** Uses a fake SDK, or forgets the one loaded. For tests. */
export function setManagedSdk(fake: ManagedSdk | undefined): void {
    sdk = fake ? Promise.resolve(fake) : undefined;
}

/** Rejects with a message naming `label` when the host hasn't answered in `ms`. */
export function withHostTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} didn't answer within ${Math.round(ms / 1000)} seconds.`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
