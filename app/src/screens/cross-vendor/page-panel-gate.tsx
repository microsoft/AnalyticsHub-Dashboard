import { lazy, Suspense, type ComponentType } from "react";
import { useStageFilter } from "@/hooks/stage-filter.context";
import type { CrossVendorPage } from "./page-panels";

let Panel: ComponentType<{ page: CrossVendorPage }> | undefined;

/** A cross-vendor panel on an existing page; nothing renders (or loads) unless the demo flag is on. */
export function CrossVendorPanel({ page }: { page: CrossVendorPage }) {
    const { inPack } = useStageFilter();
    if (import.meta.env.VITE_CROSS_VENDOR_DEMO !== "true" || inPack) return null;
    Panel ??= lazy(() => import("./page-panels"));
    return <Suspense fallback={null}><Panel page={page} /></Suspense>;
}
