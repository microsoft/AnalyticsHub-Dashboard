//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------
import { createContext, useContext } from "react";

/**
 * Whether results fetched here may be kept on the device between visits.
 * False under a list held back until asked for, as those name people.
 */
export const KeepResultsContext = createContext(true);

export function useKeepsResults(): boolean {
    return useContext(KeepResultsContext);
}
