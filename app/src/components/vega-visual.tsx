//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------
import { useMemo, type ComponentProps } from "react";
import { VegaVisual as EvalVegaVisual } from "@microsoft/fabric-visuals";
import { EmbeddableVegaVisual } from "@microsoft/fabric-visuals/embeddable";
import { useIsPrefetch } from "@/hooks/prefetch.context";
import { rowCountKey } from "@/lib/chart-height";

export type { VegaVisualHandle, VisualizationSpec } from "@microsoft/fabric-visuals";

/** True when the page's Content-Security-Policy blocks `new Function`, as the Azure host's does. */
export function isEvalBlocked(): boolean {
    try {
        void new Function("");
        return false;
    } catch {
        return true;
    }
}

/**
 * The chart component for this host. Fabric allows eval, so it keeps the stock
 * VegaVisual; under a strict CSP the embeddable build interprets Vega
 * expressions instead. Both take the same props.
 */
const HostVegaVisual = isEvalBlocked() ? EmbeddableVegaVisual : EvalVegaVisual;

export type VegaVisualProps = ComponentProps<typeof HostVegaVisual> & {
    /** What the chart shows, read by screen readers in place of "Vega visualization". */
    label: string;
};

/**
 * Row-per-category charts size their frame from the row count, and the stock
 * visual doesn't re-lay its plot when new data shrinks that frame: the rows
 * collapse onto one line and the bars vanish until the window is resized.
 * Remounting on a new row count draws the chart fresh at its new size.
 */
export function VegaVisual({ label, spec, ...props }: VegaVisualProps) {
    // A page fetched ahead of a visit only wants its data; drawing it would cost the open page.
    const prefetching = useIsPrefetch();
    // Vega names the chart from the spec's description.
    const described = useMemo(
        () => (spec && typeof spec === "object" ? ({ ...(spec as object), description: label } as typeof spec) : spec),
        [spec, label],
    );
    if (prefetching) return null;
    return <HostVegaVisual key={rowCountKey(props.data)} spec={described} {...props} />;
}
