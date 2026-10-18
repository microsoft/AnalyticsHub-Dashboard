//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { getContext } from "@microsoft/managed-apps/app";
import { getUser } from "@microsoft/managed-apps/auth";
import { getClient } from "@microsoft/managed-apps/data";
import { initializeLogger } from "@microsoft/managed-apps/telemetry";

import type { DataSources, HostMetric, ManagedSdk } from "./host";

type DataSourcesInfo = Parameters<typeof getClient>[0];

/** Metrics kept until the diagnostics store subscribes. */
const EARLY_METRIC_LIMIT = 50;

/** `generated/dataSources.ts`, which `ms app add data-source` writes. Absent until a data source is added. */
const generated = Object.values(
    import.meta.glob("/generated/dataSources.ts", { eager: true, import: "default" }),
)[0] as DataSourcesInfo | undefined;

let created: ManagedSdk | undefined;

/** Wraps the SDK. The host's metric stream starts once, here. */
export function createManagedSdk(): ManagedSdk {
    if (created)
        return created;

    const dataSources = generated ?? {};
    const client = getClient(dataSources);
    const listeners = new Set<(metric: HostMetric) => void>();
    const early: HostMetric[] = [];

    initializeLogger({
        logMetric(value) {
            const metric = value as unknown as HostMetric;
            if (listeners.size === 0) {
                if (early.length < EARLY_METRIC_LIMIT)
                    early.push(metric);
                return;
            }
            for (const listener of listeners)
                listener(metric);
        },
    });

    created = {
        dataSources: dataSources as unknown as DataSources,
        async execute(dataSource, operation, parameters) {
            const result = await client.executeAsync<Record<string, unknown>, unknown>({
                connectorOperation: { tableName: dataSource, operationName: operation, parameters },
            });
            const error = result.error;
            return {
                success: result.success,
                data: result.data,
                ...(error ? {
                    error: {
                        message: error.message,
                        ...("status" in error && typeof error.status === "number" ? { status: error.status } : {}),
                        ...("code" in error && typeof error.code === "string" ? { code: error.code } : {}),
                        ...("requestId" in error && typeof error.requestId === "string" ? { requestId: error.requestId } : {}),
                    },
                } : {}),
            };
        },
        async getUser() {
            const { fullName, objectId, tenantId } = await getUser();
            return { fullName, objectId, tenantId };
        },
        async getContext() {
            const { app, host } = await getContext();
            return { appId: app.appId, environmentId: app.environmentId, sessionId: host.sessionId };
        },
        onMetric(listener) {
            listeners.add(listener);
            for (const metric of early.splice(0))
                listener(metric);
            return () => {
                listeners.delete(listener);
            };
        },
    };
    return created;
}
