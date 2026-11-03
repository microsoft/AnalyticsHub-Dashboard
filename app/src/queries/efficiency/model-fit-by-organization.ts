//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describeOrgAttribute, DEFAULT_ORG_ATTRIBUTE, orgColumnRef, withOrgAttribute, type OrgAttribute } from "@/lib/org-attribute";
import { modelFitVerdictsFor } from "./model-fit-verdicts";

/**
 * The organization table from Model Fit, bound straight to the org mapping
 * table so destination filters keep behaving like slicers. Other attributes
 * group by the row bridge under the selected attribute filter.
 */
export function modelFitByOrganization(attribute: OrgAttribute = describeOrgAttribute(DEFAULT_ORG_ATTRIBUTE)) {
    return withOrgAttribute(
        modelFitVerdictsFor(orgColumnRef(DEFAULT_ORG_ATTRIBUTE), `Unassigned ${attribute.noun}`),
        attribute,
    );
}
