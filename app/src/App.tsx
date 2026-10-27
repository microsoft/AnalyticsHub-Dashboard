//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppShell, type AppView } from "./components/app-shell";
import {
    availableDestinations,
    destinations,
    openStage,
    type DestinationId,
    type StageId,
} from "./components/destinations";
import { FilterProvider } from "./components/filter-provider";
import { Prefetcher } from "./components/prefetcher";
import { QueryLoading } from "./components/query-states";
import { ReportPackView } from "./components/report-pack-view";
import { ReportPacksProvider } from "./components/report-packs-provider";
import { TaskTimesProvider } from "./components/task-times-provider";
import { useFilterContext } from "./hooks/filter.context";
import { NavigationContext } from "./hooks/navigation.context";
import { useReportPacks } from "./hooks/report-packs.context";
import { SourceAvailabilityContext, useSourceAvailability } from "./hooks/source-availability.context";
import { useSourceProbes } from "./hooks/use-source-probes";
import { packFilters, packRuns } from "./lib/report-pack";
import { parseHash, routeHash, type Route } from "./lib/route";
import { runtimeConfig } from "./lib/runtime-config";
import { SCREENS } from "./screens/registry";

const HOME: Route = { kind: "destination", id: "executive" };

/**
 * The open destination and stage, or report pack, its slicers and the shell
 * around it. A page whose source turns out to have no data, or a pack that
 * has been deleted, gives way to the Executive summary.
 *
 * The view and its filters live in the URL's hash (see `lib/route.ts`), so
 * Back, Forward, refresh and a copied link all return to the same place.
 */
function Workspace() {
    const [initial] = useState(() => parseHash(window.location.hash));
    const [selected, setSelected] = useState<Route>(initial.route ?? HOME);
    // Set by a navigation, so the next URL change adds a history entry rather than replacing one.
    const pushNext = useRef(false);
    // Read once by the URL sync: true when the next settled view is a navigation of its own.
    const takePush = useCallback(() => {
        const push = pushNext.current;
        pushNext.current = false;
        return push;
    }, []);
    const sources = useSourceAvailability();
    const { packs, status: packsStatus } = useReportPacks();
    const available = useMemo(() => availableDestinations(runtimeConfig().semanticModels, sources), [sources]);

    const view = useMemo<AppView>(() => {
        if (selected.kind === "pack") {
            const pack = packs.find(({ id }) => id === selected.id);
            if (pack) return { kind: "pack", pack, ...packRuns(pack.stages, available) };
        }
        const destination = selected.kind === "destination" ? available.find((candidate) => candidate.id === selected.id) : undefined;
        const id = destination?.id ?? "executive";
        const stage = destination && selected.kind === "destination" ? selected.stage : undefined;
        return { kind: "destination", id, stage: openStage(destinations.find((candidate) => candidate.id === id)!, stage) };
    }, [selected, packs, available]);

    const applicable = useMemo(
        () =>
            view.kind === "pack"
                ? packFilters(view.runs)
                : (destinations.find((candidate) => candidate.id === view.id)?.filters ?? []),
        [view],
    );

    const navigation = useMemo(
        () => ({
            navigate: (id: DestinationId, stage?: StageId) => {
                pushNext.current = true;
                setSelected({ kind: "destination", id, stage });
            },
        }),
        [],
    );
    const openPack = useCallback((id: string) => {
        pushNext.current = true;
        setSelected({ kind: "pack", id });
    }, []);

    const route = useMemo<Route>(
        () => (view.kind === "pack" ? { kind: "pack", id: view.pack.id } : { kind: "destination", id: view.id, stage: view.stage }),
        [view],
    );
    // A pack named in the URL may simply not have loaded yet; leave the URL alone until it has.
    const settled = !(selected.kind === "pack" && packsStatus === "loading" && route.kind !== "pack");

    const Screen = view.kind === "destination" ? SCREENS[view.id] : undefined;

    return (
        <FilterProvider applicable={applicable} initial={initial.filters}>
            <RouteSync route={route} settled={settled} takePush={takePush} onPop={setSelected} />
            <NavigationContext.Provider value={navigation}>
                <AppShell view={view} onNavigate={navigation.navigate} onOpenPack={openPack}>
                    {view.kind === "pack" ? (
                        <ReportPackView key={view.pack.id} runs={view.runs} missing={view.missing} />
                    ) : (
                        Screen && (
                            // Screens load on demand so only the visible destination queries the model.
                            <Suspense fallback={<QueryLoading />}>
                                <Screen key={view.id} />
                            </Suspense>
                        )
                    )}
                </AppShell>
                {/* Outside the shell, so a page fetched ahead never lands in a download. */}
                <Prefetcher
                    available={available}
                    current={view.kind === "destination" ? view.id : undefined}
                    stage={view.kind === "destination" ? view.stage : undefined}
                    screens={SCREENS}
                />
            </NavigationContext.Provider>
        </FilterProvider>
    );
}

interface RouteSyncProps {
    route: Route;
    /** False while the view shown is only a stand-in for one still loading. */
    settled: boolean;
    /** Whether this change is a navigation, which adds a history entry; reading it resets it. */
    takePush: () => boolean;
    onPop: (route: Route) => void;
}

/**
 * Keeps the URL's hash in step with the view and filters. A navigation adds
 * a history entry; a filter change, or settling on a destination's first
 * stage, replaces the current one. Back and Forward restore both.
 */
function RouteSync({ route, settled, takePush, onPop }: RouteSyncProps) {
    const { filters, setFilters } = useFilterContext();
    const hash = routeHash(route, filters);

    useEffect(() => {
        if (!settled) return;
        const push = takePush();
        if (window.location.hash === hash) return;
        const url = `${window.location.pathname}${window.location.search}${hash}`;
        if (push) window.history.pushState(null, "", url);
        else window.history.replaceState(null, "", url);
    }, [hash, settled, takePush]);

    useEffect(() => {
        const restore = () => {
            const parsed = parseHash(window.location.hash);
            onPop(parsed.route ?? HOME);
            setFilters((current) => (routeHash(HOME, current) === routeHash(HOME, parsed.filters) ? current : parsed.filters));
        };
        window.addEventListener("popstate", restore);
        return () => window.removeEventListener("popstate", restore);
    }, [onPop, setFilters]);

    return null;
}

function App() {
    const sources = useSourceProbes();
    return (
        <SourceAvailabilityContext.Provider value={sources}>
            <TaskTimesProvider>
                <ReportPacksProvider>
                    <Workspace />
                </ReportPacksProvider>
            </TaskTimesProvider>
        </SourceAvailabilityContext.Provider>
    );
}

export default App;
