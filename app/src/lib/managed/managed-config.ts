//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

/**
 * `managed-app.config.json` from the app folder, bundled into the managed
 * build. It's gitignored and optional, so a glob rather than an import lets
 * the build go ahead without it. Undefined when there's no file.
 *
 * A function rather than a constant, so other builds have no module-level
 * code to keep.
 */
export function readManagedConfigFile(): unknown {
    return Object.values(
        import.meta.glob("/managed-app.config.json", { eager: true, import: "default" }),
    )[0];
}
