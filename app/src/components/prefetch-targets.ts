//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------
import {
    isDestinationReady,
    isPackable,
    isReference,
    openStage,
    type Destination,
    type DestinationId,
    type StageId,
} from "./destinations";

export interface PrefetchTarget {
    id: DestinationId;
    stage: StageId;
}

/**
 * What to fetch ahead, in order: the tab each other page opens on, in menu
 * order, then the open page's other tabs. Reference pages hold no activity,
 * and Ask runs nothing until a question is asked.
 */
export function prefetchTargets(
    available: readonly Destination[],
    current: DestinationId | undefined,
    currentStage: StageId | undefined,
): PrefetchTarget[] {
    const targets: PrefetchTarget[] = [];
    for (const destination of available) {
        if (destination.id === current || isReference(destination) || !isPackable(destination)) continue;
        if (!isDestinationReady(destination)) continue;
        const stage = openStage(destination);
        if (stage) targets.push({ id: destination.id, stage });
    }
    const page = available.find((destination) => destination.id === current);
    for (const stage of page?.stages ?? [])
        if (stage.ready && stage.id !== currentStage) targets.push({ id: page!.id, stage: stage.id });
    return targets;
}
