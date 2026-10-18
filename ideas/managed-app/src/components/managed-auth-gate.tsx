//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------
import { type ReactNode } from "react";

import { AuthGate } from "@/components/auth-gate.component";
import { ManagedDiagnosticsPanel } from "@/components/managed-diagnostics-panel";
import { useAuth } from "@/hooks/auth.context";

/**
 * The auth gate in a Copilot Managed App. When the app can't open, the
 * Diagnostics panel sits under the gate's card to show what the host and the
 * Power BI connector said.
 */
export function ManagedAuthGate({ children }: { children: ReactNode }) {
    const { isLoading, isAuthenticated, accessDenied } = useAuth();
    if (isLoading || (isAuthenticated && !accessDenied))
        return <AuthGate>{children}</AuthGate>;

    return (
        <div className="flex min-h-screen items-center justify-center bg-background p-400">
            <div className="flex w-full max-w-md flex-col gap-400">
                <AuthGate>{children}</AuthGate>
                <ManagedDiagnosticsPanel />
            </div>
        </div>
    );
}
