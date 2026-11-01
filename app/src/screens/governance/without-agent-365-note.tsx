//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { Info } from "lucide-react";
import { BODY } from "@/lib/type-scale";
import { WITHOUT_AGENT_365 } from "@/queries/governance";

/** Says what a Governance tab leaves out when it reads Resource Graph because Agent 365 isn't connected. */
export function WithoutAgent365Note() {
    return (
        <p className={`flex max-w-[80ch] items-start gap-200 ${BODY} text-muted-foreground`}>
            <Info className="icon-size-200 mt-[2px] shrink-0" aria-hidden="true" />
            {WITHOUT_AGENT_365}
        </p>
    );
}
