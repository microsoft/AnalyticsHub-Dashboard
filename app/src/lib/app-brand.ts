//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

export const DEFAULT_APP_NAME = "Analytics Hub";
export const PREVIEW_APP_NAME = "Analytics Hub dashboard";

export function appDisplayName(): string {
    return import.meta.env.VITE_DATAHUB_PREVIEW === "true" ? PREVIEW_APP_NAME : DEFAULT_APP_NAME;
}

export function appDisplayNameWithArticle(): string {
    return `an ${appDisplayName()}`;
}
