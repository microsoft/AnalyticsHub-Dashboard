//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FileStack, Menu, Moon, PanelLeftClose, PanelLeftOpen, Sun } from "lucide-react";
import { DataToContext } from "@/hooks/data-to.context";
import { useFilterContext } from "@/hooks/filter.context";
import { useMediaQuery } from "@/hooks/use-media-query";
import { isPlainClick, routeHash } from "@/lib/route";
import { useReportPacks } from "@/hooks/report-packs.context";
import { useSourceFreshness } from "@/hooks/use-source-freshness";
import { paletteClass, usePaletteTheme } from "@/hooks/use-palette-theme";
import { ThemeContext, useThemeContext } from "@/hooks/theme.context";
import { AuthContext } from "@/hooks/auth.context";
import { useSourceAvailability } from "@/hooks/source-availability.context";
import { useAccessScope } from "@/hooks/use-access-scope";
import { pageStages, StageFilterContext } from "@/hooks/stage-filter.context";
import { useIsRefreshing } from "@/lib/refresh-tracker";
import { PAGE_SOURCES } from "@/lib/freshness";
import { earliestDate, newPackId, packFilters, packSources, stageLabel, type PackRun, type ReportPack } from "@/lib/report-pack";
import { runtimeConfig } from "@/lib/runtime-config";
import { cn } from "@/lib/utils";
import { getAccessToken } from "@/services/rayfin-auth.service";
import {
    availableDestinations,
    destinations,
    isDestinationReady,
    isPackable,
    isReference,
    STAGE_PANEL_ID,
    stageTabId,
    type Destination,
    type DestinationId,
    type StageId,
} from "./destinations";
import { AccessScopeChip, NoScopeNotice } from "./access-scope";
import { FilterBar } from "./filter-bar";
import { NavDrawer } from "./nav-drawer";
import { ReportHeader } from "./report-header";
import { PackActions } from "./report-pack-actions";
import { ErrorGroup } from "./query-states";
import { ReportPackEditor } from "./report-pack-editor";
import { ReportsNav } from "./reports-nav";
import { SharePanel } from "./share-panel";
import { StageTabs } from "./stage-tabs";

interface VersionResponse {
    latest?: string;
    updateAvailable?: boolean;
    releaseUrl?: string;
}

function UpdateNotice() {
    const auth = useContext(AuthContext);
    const [version, setVersion] = useState<VersionResponse | null>(null);
    const isAzureAdmin = runtimeConfig().host === "azure" && (auth?.user?.roles ?? []).includes("AnalyticsHub.Admin");

    useEffect(() => {
        if (!isAzureAdmin) return;
        let cancelled = false;
        getAccessToken()
            .then((token) => fetch("/api/version", { cache: "no-store", headers: { authorization: `Bearer ${token}` } }))
            .then((response) => response.ok ? response.json() as Promise<VersionResponse> : null)
            .then((value) => !cancelled && setVersion(value))
            .catch(() => undefined);
        return () => {
            cancelled = true;
        };
    }, [isAzureAdmin]);

    if (!isAzureAdmin || !version?.updateAvailable) return null;

    const label = `Update available: ${version.latest ?? "latest"}`;
    return version.releaseUrl ? (
        <a href={version.releaseUrl} className="px-200 text-[length:var(--text-200)] leading-200 text-muted-foreground underline">
            {label}
        </a>
    ) : (
        <span className="px-200 text-[length:var(--text-200)] leading-200 text-muted-foreground">{label}</span>
    );
}

const NARROW = "(max-width: 767px)";
const MEDIUM = "(max-width: 1023px)";
export const RAIL_STORAGE_KEY = "analyticshub.compactRail";

// Storage can be unavailable in a sandboxed embed; the rail then follows the window width.
function readRailPreference(): boolean | undefined {
    try {
        const value = window.localStorage.getItem(RAIL_STORAGE_KEY);
        return value === "true" ? true : value === "false" ? false : undefined;
    } catch {
        return undefined;
    }
}

function saveRailPreference(compact: boolean) {
    try {
        window.localStorage.setItem(RAIL_STORAGE_KEY, String(compact));
    } catch {
        // Not remembered; the toggle still works for this visit.
    }
}

const CREATOR_PROFILE_URL = "https://github.com/Keithland89";

/** The sidebar's footer: who made the app, linked to their profile. */
function CreatorCredit() {
    return (
        <footer className="px-200 text-[length:var(--text-200)] leading-200 text-muted-foreground">
            Created by{" "}
            <a
                href={CREATOR_PROFILE_URL}
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
                Keith McGrane
            </a>
        </footer>
    );
}

/** What the canvas shows: one destination at one of its stages, or a report pack's stages from any of them. */
export type AppView =
    | { kind: "destination"; id: DestinationId; stage?: StageId }
    | { kind: "pack"; pack: ReportPack; runs: readonly PackRun[]; missing: readonly StageId[] };

interface AppShellProps {
    view: AppView;
    onNavigate: (id: DestinationId, stage?: StageId) => void;
    onOpenPack: (id: string) => void;
    children: ReactNode;
}

/**
 * Sidebar-and-canvas frame. The sidebar is the whole navigation model — the
 * destinations replacing the report's pages and bookmark bars, and the
 * report's appendix set apart below them as reference. A destination's
 * stages are its tabs. A destination shows one stage at a time, so a page
 * only waits for, and queries, what is on screen.
 *
 * The sidebar is a full rail from 1024px, an icon rail below that (either
 * can be switched to the other, and the choice is remembered), and a menu
 * behind a top bar below 768px.
 *
 * Each destination carries its own palette: the sidebar shows every hue at
 * once so they read as distinct places, and the canvas — chrome and charts
 * alike — takes on the hue of the one that is open.
 */
export function AppShell({ view, onNavigate, onOpenPack, children }: AppShellProps) {
    const themeContext = useThemeContext();
    const { isDark, toggleTheme } = themeContext;
    const { filters } = useFilterContext();
    const narrow = useMediaQuery(NARROW);
    const medium = useMediaQuery(MEDIUM);
    const [railPreference, setRailPreference] = useState(readRailPreference);
    const compact = !narrow && (railPreference ?? medium);
    const [menuOpen, setMenuOpen] = useState(false);
    // Widening to the full rail closes the drawer, so it doesn't reopen on the next narrowing.
    if (!narrow && menuOpen) setMenuOpen(false);
    const menuButtonRef = useRef<HTMLButtonElement>(null);
    const active = view.kind === "destination" ? view.id : undefined;
    const activeStage = view.kind === "destination" ? view.stage : undefined;
    // A pack takes on the hue of the destination it opens with.
    const palette: DestinationId = active ?? (view.kind === "pack" ? view.runs[0]?.destination.id : undefined) ?? "executive";
    const paletteTheme = usePaletteTheme(palette);
    const refreshing = useIsRefreshing();
    const current = destinations.find((destination) => destination.id === active);
    const viewKey = view.kind === "destination" ? view.id : `pack:${view.pack.id}`;
    const mainRef = useRef<HTMLElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    const { save } = useReportPacks();
    const [editing, setEditing] = useState<{ pack: ReportPack; heading: string }>();
    const closeEditor = useCallback(() => setEditing(undefined), []);
    const savePack = async (pack: ReportPack) => {
        const saved = await save(pack);
        setEditing(undefined);
        onOpenPack(saved.id);
    };
    const toggleRail = () => {
        const next = !compact;
        saveRailPreference(next);
        setRailPreference(next);
    };
    const go = (id: DestinationId, stage?: StageId) => {
        setMenuOpen(false);
        onNavigate(id, stage);
    };
    const openPack = (id: string) => {
        setMenuOpen(false);
        onOpenPack(id);
    };
    // A page's download holds every stage, so they all render while it is drawn.
    const [wholePage, setWholePage] = useState(false);
    const stageFilter = useMemo(
        () => pageStages(wholePage || !activeStage ? "all" : activeStage),
        [wholePage, activeStage],
    );
    const tabs = useMemo(() => (current?.stages ?? []).filter((stage) => stage.ready), [current]);
    const showWholePage = useCallback(() => {
        setWholePage(true);
        return () => setWholePage(false);
    }, []);

    const headerSources = useMemo(
        () => (view.kind === "pack" ? packSources(view.runs) : PAGE_SOURCES[view.id]),
        [view],
    );
    const dates = useSourceFreshness(headerSources);
    const dataTo = earliestDate(headerSources.map((source) => dates[source]));
    const filterKeys = useMemo(
        () => (view.kind === "pack" ? packFilters(view.runs) : (current?.filters ?? [])),
        [view, current],
    );
    const title = view.kind === "pack" ? view.pack.name : current?.label;
    const sources = useSourceAvailability();
    const accessScope = useAccessScope();
    const noScope = accessScope.kind === "none";
    // Pages whose model the install didn't set up, or whose source has no data, are left out of the sidebar.
    const available = useMemo(() => availableDestinations(runtimeConfig().semanticModels, sources), [sources]);

    useEffect(() => {
        if (mainRef.current) mainRef.current.scrollTop = 0;
    }, [viewKey, activeStage]);

    // On moving to another page, focus its heading so a screen reader announces it and the keyboard starts there.
    // Not on the first page, and not on a stage change: the tabs keep focus while arrowing between them.
    const shownKey = useRef(viewKey);
    useEffect(() => {
        if (shownKey.current === viewKey) return;
        shownKey.current = viewKey;
        mainRef.current?.querySelector<HTMLElement>("h1")?.focus({ preventScroll: true });
    }, [viewKey]);

    // Chart and table frames title themselves with an h4, but each sits straight under its section's h2.
    // A screen reader's heading list would skip a level, so expose those titles as level 3.
    useEffect(() => {
        const main = mainRef.current;
        if (!main || typeof MutationObserver === "undefined") return;
        const relevel = () =>
            main.querySelectorAll("h4[id$='-title']:not([aria-level])").forEach((title) => title.setAttribute("aria-level", "3"));
        relevel();
        const observer = new MutationObserver(relevel);
        observer.observe(main, { childList: true, subtree: true });
        return () => observer.disconnect();
    }, []);

    const renderDestination = (destination: Destination) => {
        const Icon = destination.icon;
        const isActive = destination.id === active;
        const ready = isDestinationReady(destination);
        const itemClass = cn(
            "flex w-full items-center rounded-md py-200 text-left transition-colors",
            compact ? "justify-center px-200" : "gap-300 px-300",
            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
            isActive ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-secondary hover:text-foreground",
        );
        const label = (
            <span
                className={cn(
                    "text-[length:var(--text-300)] leading-300",
                    isActive && "font-semibold",
                    compact && "sr-only",
                )}
            >
                {destination.label}
                {!ready && <span className="sr-only"> (coming next)</span>}
            </span>
        );
        return (
            <li key={destination.id} className={paletteClass(destination.id)}>
                {ready ? (
                    <a
                        href={routeHash({ kind: "destination", id: destination.id }, filters)}
                        onClick={(event) => {
                            if (!isPlainClick(event)) return;
                            event.preventDefault();
                            go(destination.id);
                        }}
                        aria-current={isActive ? "page" : undefined}
                        title={compact ? destination.label : undefined}
                        className={itemClass}
                    >
                        <Icon className="icon-size-200 shrink-0 text-primary" aria-hidden="true" />
                        {label}
                    </a>
                ) : (
                    <span aria-disabled="true" className={cn(itemClass, "cursor-not-allowed opacity-50 hover:bg-transparent")}>
                        <Icon className="icon-size-200 shrink-0 text-primary" aria-hidden="true" />
                        {label}
                    </span>
                )}
            </li>
        );
    };

    const reference = available.filter(isReference);

    const sidebar = (inMenu: boolean) => (
        <>
            {!inMenu && (
                <div className={cn("flex items-start", compact ? "justify-center" : "justify-between gap-200 px-200")}>
                    {!compact && (
                        <div className="flex flex-col gap-100">
                            <span className="text-[length:var(--text-500)] leading-500 font-semibold">Analytics Hub</span>
                            <span className="text-[length:var(--text-200)] leading-200 text-muted-foreground">for Microsoft Copilot</span>
                        </div>
                    )}
                    <button
                        type="button"
                        onClick={toggleRail}
                        aria-label={compact ? "Expand sidebar" : "Collapse sidebar"}
                        title={compact ? "Expand sidebar" : "Collapse sidebar"}
                        className="rounded-md p-200 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                    >
                        {compact ? (
                            <PanelLeftOpen className="icon-size-200" aria-hidden="true" />
                        ) : (
                            <PanelLeftClose className="icon-size-200" aria-hidden="true" />
                        )}
                    </button>
                </div>
            )}

            <ul className="flex flex-1 flex-col gap-100-nudge">
                {available.filter((destination) => !isReference(destination)).map(renderDestination)}
            </ul>

            {reference.length > 0 && (
                <div className={cn("flex flex-col gap-100 border-t border-border pt-400")}>
                    <span
                        id={inMenu ? "menu-reference" : "nav-reference"}
                        className={cn("px-300 text-[length:var(--text-200)] leading-200 font-semibold text-muted-foreground", compact && "sr-only")}
                    >
                        Reference
                    </span>
                    <ul aria-labelledby={inMenu ? "menu-reference" : "nav-reference"} className="flex flex-col gap-100-nudge">
                        {reference.map(renderDestination)}
                    </ul>
                </div>
            )}

            {!compact && (
                <>
                    <ReportsNav
                        activePack={view.kind === "pack" ? view.pack.id : undefined}
                        onOpen={openPack}
                        onCreate={() => {
                            setMenuOpen(false);
                            setEditing({ pack: { id: newPackId(), name: "", stages: [] }, heading: "New report pack" });
                        }}
                    />

                    <SharePanel />

                    <UpdateNotice />
                </>
            )}

            <button
                type="button"
                onClick={toggleTheme}
                aria-pressed={isDark}
                aria-label={compact ? "Dark mode" : undefined}
                title={compact ? (isDark ? "Light mode" : "Dark mode") : undefined}
                className={cn(
                    "flex items-center rounded-md border border-border py-200 text-[length:var(--text-300)] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                    compact ? "justify-center px-200" : "gap-300 px-300",
                )}
            >
                {isDark ? <Sun className="icon-size-200" aria-hidden="true" /> : <Moon className="icon-size-200" aria-hidden="true" />}
                {!compact && (isDark ? "Light mode" : "Dark mode")}
            </button>

            {!compact && <CreatorCredit />}
        </>
    );

    return (
        // The shell and both scroll areas are positioned so absolute descendants (sr-only text
        // especially) stay inside them; otherwise they extend the document and add a second scrollbar.
        <div
            className={cn(
                "relative flex h-dvh w-full overflow-hidden bg-background text-foreground",
                narrow && "flex-col",
                paletteClass(palette),
            )}
            data-print="flow"
        >
            <a
                href="#main"
                onClick={(event) => {
                    event.preventDefault();
                    mainRef.current?.focus();
                }}
                data-print="hide"
                className="sr-only z-50 rounded-md bg-card px-300 py-200 text-[length:var(--text-300)] font-semibold text-foreground shadow-md focus:not-sr-only focus:absolute focus:top-200 focus:left-200 focus-visible:outline-2 focus-visible:outline-ring"
            >
                Skip to content
            </a>

            {narrow ? (
                <header data-print="hide" className="flex shrink-0 items-center gap-200 border-b border-border bg-card px-200 py-100">
                    <button
                        ref={menuButtonRef}
                        type="button"
                        onClick={() => setMenuOpen(true)}
                        aria-label="Open menu"
                        aria-expanded={menuOpen}
                        aria-controls="sections-menu"
                        className="flex size-[44px] items-center justify-center rounded-md text-foreground hover:bg-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                    >
                        <Menu className="icon-size-300" aria-hidden="true" />
                    </button>
                    <span className="text-[length:var(--text-400)] leading-400 font-semibold">Analytics Hub</span>
                </header>
            ) : (
                <nav
                    aria-label="Sections"
                    data-print="hide"
                    className={cn(
                        "relative flex shrink-0 flex-col gap-500 overflow-y-auto border-r border-border bg-card py-500",
                        compact ? "w-[64px] px-200" : "w-[248px] px-400",
                    )}
                >
                    {sidebar(false)}
                </nav>
            )}

            {narrow && (
                <NavDrawer open={menuOpen} onClose={() => setMenuOpen(false)} returnFocus={menuButtonRef}>
                    {sidebar(true)}
                </NavDrawer>
            )}

            <main
                ref={mainRef}
                id="main"
                tabIndex={-1}
                inert={narrow && menuOpen ? true : undefined}
                data-print="flow"
                className="relative min-w-0 flex-1 overflow-y-auto outline-none [scrollbar-gutter:stable]"
            >
                <div className="mx-auto flex max-w-[1400px] flex-col gap-600 px-400 pt-500 pb-800 md:px-600 lg:px-700 lg:pt-600" data-print="flow">
                    {view.kind === "pack" ? (
                        <ReportHeader
                            key={viewKey}
                            icon={FileStack}
                            title={view.pack.name}
                            blurb={view.pack.description}
                            sources={headerSources}
                            dates={dates}
                            filterKeys={filterKeys}
                            missing={view.missing.map(stageLabel)}
                            contentRef={contentRef}
                            meta={<AccessScopeChip state={accessScope} />}
                            downloadable={!noScope}
                            actions={
                                <PackActions
                                    pack={view.pack}
                                    onEdit={(pack, heading) => setEditing({ pack, heading })}
                                    onDeleted={() => onNavigate("executive")}
                                />
                            }
                        />
                    ) : (
                        current && (
                            <ReportHeader
                                key={viewKey}
                                icon={current.icon}
                                title={current.label}
                                blurb={current.blurb}
                                sources={headerSources}
                                dates={dates}
                                filterKeys={filterKeys}
                                contentRef={contentRef}
                                prepareExport={showWholePage}
                                meta={<AccessScopeChip state={accessScope} />}
                                downloadable={isPackable(current) && !noScope}
                            />
                        )
                    )}
                    {noScope ? (
                        <NoScopeNotice />
                    ) : (
                        <>
                            {title && filterKeys.length > 0 && <FilterBar destinationLabel={title} />}
                            {current && tabs.length > 1 && (
                                <StageTabs
                                    label={`${current.label} stages`}
                                    stages={tabs}
                                    open={activeStage}
                                    onOpen={(stage) => onNavigate(current.id, stage)}
                                />
                            )}
                            <ThemeContext.Provider value={{ ...themeContext, theme: paletteTheme }}>
                                <DataToContext.Provider value={dataTo}>
                                    <div
                                        ref={contentRef}
                                        {...(current && tabs.length > 1 && activeStage
                                            ? { id: STAGE_PANEL_ID, role: "tabpanel", "aria-labelledby": stageTabId(activeStage) }
                                            : {})}
                                        aria-busy={refreshing || undefined}
                                        data-refreshing={refreshing || undefined}
                                        className="flex flex-col gap-700 transition-opacity duration-200 data-[refreshing]:opacity-55 data-[refreshing]:delay-150"
                                    >
                                        <ErrorGroup>
                                            {view.kind === "destination" ? (
                                                <StageFilterContext.Provider value={stageFilter}>{children}</StageFilterContext.Provider>
                                            ) : (
                                                children
                                            )}
                                        </ErrorGroup>
                                    </div>
                                </DataToContext.Provider>
                            </ThemeContext.Provider>
                        </>
                    )}
                </div>
            </main>

            {editing && (
                <ReportPackEditor
                    key={editing.pack.id}
                    pack={editing.pack}
                    heading={editing.heading}
                    available={available}
                    onSave={savePack}
                    onClose={closeEditor}
                />
            )}
        </div>
    );
}
