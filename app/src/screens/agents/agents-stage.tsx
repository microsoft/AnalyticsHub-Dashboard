//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useId, useMemo, useRef, useState, type Ref } from "react";
import { DataGrid, type GridColumnDef, type Row } from "@microsoft/fabric-datagrid";
import { ChevronDown, Download, ExternalLink, Info, Search } from "lucide-react";
import { stageAnchor } from "@/components/destinations";
import { KpiCard, KpiStat } from "@/components/kpi-card";
import { OpenDestinationLink } from "@/components/open-destination-link";
import { QueryEmpty, QueryError, QueryLoading } from "@/components/query-states";
import { ChartPanel } from "@/components/report-panels";
import { Section } from "@/components/section";
import { useDataTo } from "@/hooks/data-to.context";
import { useOrgAttribute } from "@/hooks/filter.context";
import { useSourceAvailability } from "@/hooks/source-availability.context";
import { useThemeContext } from "@/hooks/theme.context";
import { useFilteredQuery } from "@/hooks/use-filtered-query";
import { useTableQuery } from "@/hooks/use-table-query";
import { rowChartHeight } from "@/lib/chart-height";
import { agentEvaluatorUrl } from "@/lib/fabric-item-url";
import { INPUT, SECONDARY } from "@/lib/form-controls";
import { formatKpi } from "@/lib/format-kpi";
import { heatDomain, heatRenderer } from "@/lib/heat";
import { listTotal } from "@/lib/list-total";
import { isAbsent } from "@/lib/optional-sources";
import { prefersReducedMotion } from "@/lib/scroll-to-anchor";
import { readNumber, toSummaryRow } from "@/lib/summary-row";
import { downloadTableCsv } from "@/lib/table-csv";
import { toDataTable } from "@/lib/to-data-table";
import { formatCell, textCell } from "@/lib/tree-grid";
import { BODY, SMALL } from "@/lib/type-scale";
import { cn } from "@/lib/utils";
import {
    agentActivitySummary,
    agentFilter,
    agentLeaderboard,
    agentOrgs,
    agentTrend,
    agentTypes,
    agentWeekly,
    toAgentEntries,
    type AgentEntry,
} from "@/queries/agents";
import { agentsCsvTable, matchesAgent } from "./agents-table-data";

/** The table shows this many agents; search and Export reach all the query returns. */
export const AGENTS_SHOWN = 200;

/** Columns only the Agent 365 registry fills in. */
const REGISTRY_COLUMNS: ReadonlySet<string> = new Set(["Status", "Owner"]);

const dayFormat = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

function formatDay(value: unknown): string | null {
    return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
        ? dayFormat.format(new Date(`${value}T00:00:00Z`))
        : null;
}

function isUnused(row: Row): boolean {
    return row.People === 0;
}

/** Usage an agent doesn't have in the selection stays blank, as it does in the report. */
function usageCell(format: (value: unknown) => string | null) {
    return (value: unknown, row: Row) => (isUnused(row) ? null : format(value));
}

/**
 * One grid row per agent. Missing usage is stored as the column's lowest
 * value rather than a blank, because the grid sorts blanks first when
 * sorting high to low; the cells still render blank.
 */
function toRow(entry: AgentEntry): Row {
    return {
        _id: entry.key,
        Agent: entry.name,
        Type: entry.type ?? "",
        Status: entry.inRegistry ? "Registered" : "Unregistered",
        Owner: entry.creator ?? "",
        People: entry.users,
        Sessions: entry.sessions,
        "Sessions Per Person": entry.sessionsPerUser ?? 0,
        "Last Active": entry.lastActivity ?? "",
    };
}

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

interface PickerOption {
    key: string;
    label: string;
}

/**
 * The detail card's agent list, alphabetical, used agents first. The
 * registry repeats names ("Agent" five times), so a repeated name carries
 * its creator or type, then a number if that still doesn't tell them apart.
 */
function pickerGroups(entries: readonly AgentEntry[]): { used: PickerOption[]; unused: PickerOption[] } {
    const nameCount = new Map<string, number>();
    for (const entry of entries) nameCount.set(entry.name, (nameCount.get(entry.name) ?? 0) + 1);
    const labels = entries.map((entry) =>
        (nameCount.get(entry.name) ?? 0) > 1 ? `${entry.name} · ${entry.creator ?? entry.type ?? "no creator"}` : entry.name,
    );
    const labelCount = new Map<string, number>();
    for (const label of labels) labelCount.set(label, (labelCount.get(label) ?? 0) + 1);

    const seen = new Map<string, number>();
    const options = entries.map((entry, index) => {
        const label = labels[index];
        if ((labelCount.get(label) ?? 0) < 2) return { entry, label };
        const repeat = (seen.get(label) ?? 0) + 1;
        seen.set(label, repeat);
        return { entry, label: `${label} (${repeat})` };
    });
    options.sort((a, b) => collator.compare(a.label, b.label));

    const toOption = ({ entry, label }: { entry: AgentEntry; label: string }) => ({ key: entry.key, label });
    return {
        used: options.filter(({ entry }) => entry.users > 0).map(toOption),
        unused: options.filter(({ entry }) => entry.users === 0).map(toOption),
    };
}

function describe(entry: AgentEntry): { text: string; supplied: boolean } {
    if (entry.description) return { text: entry.description, supplied: true };
    return entry.inRegistry
        ? { text: "The registry has no description for this agent.", supplied: false }
        : {
              text: "No registry entry matches this agent, so there's no description to show. Its name and usage come from the audit log.",
              supplied: false,
          };
}

/** The agent's week-by-week use and the organizations using it most. */
function AgentActivity({ filter }: { filter: string }) {
    const attribute = useOrgAttribute();
    const trend = useMemo(() => agentTrend(filter), [filter]);
    const orgs = useMemo(() => agentOrgs(filter, attribute), [filter, attribute]);
    const trendResult = useTableQuery(trend);
    const orgResult = useTableQuery(orgs);
    const top = useMemo(() => {
        const table = orgResult.table;
        if (!table) return undefined;
        const users = table.columns.findIndex((column) => column.name === "Users");
        return table.rows.map((row) => ({
            name: typeof row[0] === "string" && row[0].trim() ? row[0] : `Unassigned ${attribute.noun}`,
            users: typeof row[users] === "number" ? row[users] : undefined,
        }));
    }, [orgResult.table, attribute.noun]);

    return (
        <div className="flex flex-col gap-400 border-t border-border px-500 py-400">
            <ChartPanel
                result={trendResult}
                spec={trend.vegaLiteSpec}
                height={280}
                title="Weekly use"
                subtitle="People using this agent each week"
                emptyTitle="No weekly use"
                emptyDescription="Nobody used this agent in this selection."
            />
            <div className="flex flex-col gap-200">
                <p className={`${SMALL} font-semibold text-foreground`}>Top {attribute.plural}</p>
                {orgResult.error !== undefined ? (
                    <QueryError message={orgResult.error} onRetry={orgResult.refetch} />
                ) : orgResult.isLoading || !top ? (
                    <QueryLoading className="h-[120px]" />
                ) : top.length === 0 ? (
                    <p className={`${SMALL} text-muted-foreground`}>Nobody used this agent in this selection.</p>
                ) : (
                    <ol className="flex flex-col gap-100">
                        {top.map((org, index) => (
                            <li key={`${org.name}-${index}`} className={cn(BODY, "flex items-baseline justify-between gap-300")}>
                                <span className="min-w-0 truncate text-card-foreground" title={org.name}>
                                    {org.name}
                                </span>
                                <span className="shrink-0 tabular-nums text-muted-foreground">
                                    {org.users === undefined ? "—" : `${formatKpi(org.users, "whole")} ${org.users === 1 ? "person" : "people"}`}
                                </span>
                            </li>
                        ))}
                    </ol>
                )}
            </div>
        </div>
    );
}

interface AgentDetailProps {
    entries: readonly AgentEntry[];
    selected: AgentEntry;
    onSelect: (key: string) => void;
    evaluatorUrl: string | null;
    ref?: Ref<HTMLElement>;
}

/**
 * The selected agent's description, registry details and use in the
 * selection, week by week and by organization. Picking an agent here or
 * selecting its row in the table both change it.
 */
function AgentDetail({ entries, selected, onSelect, evaluatorUrl, ref }: AgentDetailProps) {
    const headingId = useId();
    const selectId = useId();
    const groups = useMemo(() => pickerGroups(entries), [entries]);
    const description = describe(selected);
    const meta = [selected.type, selected.creator].filter(Boolean).join(" · ");
    const used = selected.users > 0;
    const filter = used ? agentFilter(selected.agentKey) : undefined;

    const registryFacts = selected.inRegistry
        ? [
              {
                  term: "Available in",
                  detail: selected.surfaces ? (
                      <ul className="flex flex-wrap gap-100">
                          {selected.surfaces.map((surface) => (
                              <li
                                  key={surface}
                                  className={`rounded-full bg-secondary px-200 py-[2px] ${SMALL} text-secondary-foreground`}
                              >
                                  {surface}
                              </li>
                          ))}
                      </ul>
                  ) : (
                      (selected.features ?? "Not recorded")
                  ),
              },
              { term: "Lifecycle stage", detail: selected.lifecycle ?? "Not recorded" },
              { term: "Adoption", detail: selected.adoption ?? "Not recorded" },
          ]
        : [];

    const usage = [
        { term: "People", value: formatKpi(selected.users, "whole") },
        { term: "Sessions", value: formatKpi(selected.sessions, "whole") },
        { term: "Sessions / person", value: formatKpi(selected.sessionsPerUser, "rate") },
        { term: "Orgs reached", value: formatKpi(selected.orgsReached, "whole") },
        { term: "Last active", value: formatDay(selected.lastActivity) ?? "—" },
    ];

    return (
        <article
            ref={ref}
            aria-labelledby={headingId}
            className="flex scroll-mt-600 flex-col rounded-xl border border-border bg-card"
        >
            <div className="flex flex-col gap-300 border-b border-border px-500 py-400">
                <h3 id={headingId} className="text-[length:var(--text-400)] leading-400 font-semibold text-foreground">
                    Agent detail
                </h3>
                <div className="flex flex-col gap-100">
                    <label htmlFor={selectId} className={`${SMALL} text-muted-foreground`}>
                        Agent
                    </label>
                    <div className="relative">
                        <select
                            id={selectId}
                            value={selected.key}
                            onChange={(event) => onSelect(event.target.value)}
                            className={cn(
                                "h-[36px] w-full appearance-none truncate rounded-md border border-input bg-card pr-[36px] pl-300",
                                "text-[length:var(--text-300)] text-foreground hover:bg-secondary",
                                "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring",
                            )}
                        >
                            {groups.used.length > 0 && (
                                <optgroup label="Used in this selection">
                                    {groups.used.map((option) => (
                                        <option key={option.key} value={option.key}>
                                            {option.label}
                                        </option>
                                    ))}
                                </optgroup>
                            )}
                            {groups.unused.length > 0 && (
                                <optgroup label="Not used in this selection">
                                    {groups.unused.map((option) => (
                                        <option key={option.key} value={option.key}>
                                            {option.label}
                                        </option>
                                    ))}
                                </optgroup>
                            )}
                        </select>
                        <ChevronDown
                            className="icon-size-200 pointer-events-none absolute top-1/2 right-300 -translate-y-1/2 text-muted-foreground"
                            aria-hidden="true"
                        />
                    </div>
                </div>
            </div>

            <div aria-live="polite" className="flex flex-col gap-100 px-500 pt-400">
                <h4 className="text-[length:var(--text-400)] leading-400 font-semibold text-card-foreground [overflow-wrap:anywhere]">
                    {selected.name}
                </h4>
                {meta && <p className={`${SMALL} text-muted-foreground`}>{meta}</p>}
                <p
                    className={cn(
                        "mt-200 max-w-[60ch]",
                        BODY,
                        description.supplied ? "text-card-foreground" : "text-muted-foreground",
                    )}
                >
                    {description.text}
                </p>
            </div>

            {registryFacts.length > 0 && (
                <dl className="flex flex-col gap-300 px-500 pt-400">
                    {registryFacts.map(({ term, detail }) => (
                        <div key={term} className="flex flex-col gap-100">
                            <dt className={`${SMALL} text-muted-foreground`}>{term}</dt>
                            <dd className={`${BODY} text-card-foreground`}>{detail}</dd>
                        </div>
                    ))}
                </dl>
            )}

            <div className="mt-400 flex flex-col gap-300 border-t border-border px-500 py-400">
                <p className={`${SMALL} font-semibold text-foreground`}>In this selection</p>
                {used ? (
                    <dl className="grid grid-cols-2 gap-x-400 gap-y-300 sm:grid-cols-3 2xl:grid-cols-2">
                        {usage.map(({ term, value }) => (
                            <div key={term} className="flex flex-col gap-100">
                                <dt className={`${SMALL} text-muted-foreground`}>{term}</dt>
                                <dd className={`${BODY} font-semibold tabular-nums text-card-foreground`}>{value}</dd>
                            </div>
                        ))}
                    </dl>
                ) : (
                    <p className={`${SMALL} text-muted-foreground`}>Nobody used this agent in this selection.</p>
                )}
            </div>

            {filter && <AgentActivity key={filter} filter={filter} />}

            {(selected.registryId || evaluatorUrl) && (
                <div className={`flex flex-col gap-200 border-t border-border px-500 py-300 ${SMALL} text-muted-foreground`}>
                    {selected.registryId && (
                        <p>
                            Registry ID <span className="font-mono break-all text-foreground">{selected.registryId}</span>
                        </p>
                    )}
                    {evaluatorUrl && (
                        <a
                            href={evaluatorUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-100 self-start font-semibold text-primary underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                        >
                            Open in Agent Evaluator
                            <ExternalLink className="icon-size-200" aria-hidden="true" />
                            <span className="sr-only">(opens in a new tab)</span>
                        </a>
                    )}
                </div>
            )}
        </article>
    );
}

/**
 * Every agent in use, ranked by people then sessions: the registry's agents
 * alongside the ones only the audit log names, with search, Export and the
 * detail card for whichever agent is selected.
 */
function AgentsTable({ registry }: { registry: boolean }) {
    const { theme } = useThemeContext();
    const dataTo = useDataTo();
    const searchId = useId();
    const board = agentLeaderboard();
    const result = useFilteredQuery(board);
    const [selectedKey, setSelectedKey] = useState<string>();
    const [search, setSearch] = useState("");
    const gridRef = useRef<HTMLDivElement>(null);
    const detailRef = useRef<HTMLElement>(null);
    const evaluatorUrl = useMemo(() => agentEvaluatorUrl(), []);

    const table = useMemo(
        () => (result.data?.status === "success" ? toDataTable(result.data.table, board.columnMetadata) : undefined),
        [result.data, board.columnMetadata],
    );
    const entries = useMemo(() => (table ? toAgentEntries(table) : undefined), [table]);
    const matches = useMemo(() => entries?.filter((entry) => matchesAgent(entry, search)), [entries, search]);
    const shown = useMemo(() => matches?.slice(0, AGENTS_SHOWN), [matches]);
    const rows = useMemo(() => shown?.map(toRow), [shown]);
    const byKey = useMemo(() => new Map((entries ?? []).map((entry) => [entry.key, entry])), [entries]);
    const used = useMemo(() => (entries ?? []).filter((entry) => entry.users > 0), [entries]);
    const peopleDomain = useMemo(() => heatDomain(used.map((entry) => entry.users)), [used]);
    const rateDomain = useMemo(() => heatDomain(used.map((entry) => entry.sessionsPerUser)), [used]);
    // Until someone picks an agent, and whenever the pick drops out of the selection, the card shows the top agent.
    const selected = entries?.find((entry) => entry.key === selectedKey) ?? entries?.[0];

    const columns: GridColumnDef[] = useMemo(() => {
        const peopleCell = heatRenderer({ domain: peopleDomain, format: formatCell("whole") });
        const rateCell = heatRenderer({ domain: rateDomain, format: formatCell("rate") });
        const all: GridColumnDef[] = [
            {
                id: "Agent",
                header: "Agent",
                width: 300,
                cellRenderer: (value, row) => {
                    const current = row._id === selected?.key;
                    const name = textCell(value);
                    const entry = byKey.get(String(row._id));
                    const about = [name, entry?.description, entry?.registryId && `Registry ID ${entry.registryId}`]
                        .filter(Boolean)
                        .join("\n");
                    return (
                        <span
                            data-agent-key={row._id}
                            aria-current={current || undefined}
                            title={about}
                            className={cn("flex min-w-0 items-center gap-200", current && "font-semibold text-primary")}
                        >
                            <span
                                aria-hidden="true"
                                className={cn("size-[6px] shrink-0 rounded-full", current ? "bg-primary" : "bg-transparent")}
                            />
                            <span className="truncate">{name}</span>
                            {entry?.description && (
                                <Info className="icon-size-200 shrink-0 text-muted-foreground" aria-hidden="true" />
                            )}
                        </span>
                    );
                },
            },
            {
                id: "Type",
                header: "Type",
                width: 170,
                cellRenderer: (value, row) =>
                    row.Status === "Unregistered" ? (
                        <span className="text-muted-foreground">{textCell(value)}</span>
                    ) : (
                        textCell(value)
                    ),
            },
            {
                id: "Status",
                header: "Status",
                width: 220,
                cellRenderer: (value, row) => {
                    const registered = value === "Registered";
                    const lifecycle = byKey.get(String(row._id))?.lifecycle;
                    return (
                        <span className="flex min-w-0 items-center gap-200" title={lifecycle}>
                            <span
                                className={cn(
                                    "shrink-0 rounded-full px-200 py-[1px]",
                                    SMALL,
                                    registered ? "bg-secondary text-secondary-foreground" : "border border-border text-muted-foreground",
                                )}
                            >
                                {textCell(value)}
                            </span>
                            {lifecycle && <span className="truncate text-muted-foreground">{lifecycle}</span>}
                        </span>
                    );
                },
            },
            { id: "Owner", header: "Owner", width: 170 },
            {
                id: "People",
                header: "People",
                width: 96,
                numericStyling: true,
                filterable: false,
                cellRenderer: (value, row) => (isUnused(row) ? null : peopleCell(value, row)),
            },
            {
                id: "Sessions",
                header: "Sessions",
                width: 104,
                numericStyling: true,
                filterable: false,
                cellRenderer: usageCell(formatCell("whole")),
            },
            {
                id: "Sessions Per Person",
                header: "Sessions / person",
                width: 140,
                numericStyling: true,
                filterable: false,
                cellRenderer: (value, row) => (isUnused(row) ? null : rateCell(value, row)),
            },
            {
                id: "Last Active",
                header: "Last active",
                width: 128,
                filterable: false,
                cellRenderer: usageCell(formatDay),
            },
        ];
        return registry ? all : all.filter((column) => !REGISTRY_COLUMNS.has(column.id));
    }, [selected?.key, peopleDomain, rateDomain, registry, byKey]);

    /** Selects the agent whose row holds `target`; false when `target` isn't in a body row. */
    const pick = (target: EventTarget): boolean => {
        const key =
            target instanceof Element
                ? target.closest("tr")?.querySelector<HTMLElement>("[data-agent-key]")?.dataset.agentKey
                : undefined;
        if (!key) return false;
        setSelectedKey(key);

        // Side by side the card is already in view; stacked under the table it can be off screen.
        const card = detailRef.current;
        const grid = gridRef.current;
        if (card && grid) {
            const cardTop = card.getBoundingClientRect().top;
            const stacked = cardTop >= grid.getBoundingClientRect().bottom;
            if (stacked && (cardTop < 0 || cardTop > window.innerHeight * 0.6)) {
                card.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
            }
        }
        return true;
    };

    if (result.data?.status === "error") {
        return <QueryError className="h-[600px]" message={result.data.error.message} onRetry={result.refetch} />;
    }
    if (result.isLoading || !entries || !matches || !rows) {
        return <QueryLoading className="h-[600px]" />;
    }
    if (!selected) {
        return (
            <QueryEmpty
                className="h-[600px]"
                title="No agents to rank"
                description={
                    registry
                        ? "Neither the registry nor the audit log has an agent in this selection. Clear a filter, or check that the registry ingestion has run."
                        : "The audit log has no agent use in this selection. Clear a filter to widen it."
                }
            />
        );
    }

    const total = listTotal(table);
    const searching = search.trim() !== "";
    const of = searching ? matches.length : (total ?? entries.length);
    const footer = [
        searching
            ? `${formatKpi(rows.length, "whole")} of ${formatKpi(of, "whole")} matching agents shown`
            : `Top ${formatKpi(rows.length, "whole")} of ${formatKpi(of, "whole")} shown`,
        "sorted by People, then Sessions",
        evaluatorUrl ? "click a row for detail and Open in Agent Evaluator ↗" : "click a row for detail",
    ].join(" · ");

    return (
        <div className="flex flex-col gap-300">
            <div className="flex flex-wrap items-center justify-between gap-200">
                <label htmlFor={searchId} className="relative flex items-center">
                    <span className="sr-only">Find an agent</span>
                    <Search
                        className="pointer-events-none absolute left-200 icon-size-200 text-muted-foreground"
                        aria-hidden="true"
                    />
                    <input
                        id={searchId}
                        type="search"
                        value={search}
                        placeholder="Find an agent"
                        autoComplete="off"
                        spellCheck={false}
                        onChange={(event) => setSearch(event.target.value)}
                        className={cn(INPUT, "w-[240px] max-w-full pl-700")}
                    />
                </label>
                <button
                    type="button"
                    className={cn(SECONDARY, "inline-flex items-center gap-200")}
                    disabled={matches.length === 0}
                    title={`Download ${searching ? "the matching agents" : "every agent listed"} as CSV`}
                    onClick={() => downloadTableCsv(agentsCsvTable(matches), "Agents", dataTo)}
                >
                    <Download className="icon-size-200" aria-hidden="true" />
                    Export
                </button>
            </div>
            <div className="grid grid-cols-1 items-start gap-400 2xl:grid-cols-[minmax(0,1fr)_340px]">
                <div className="flex min-w-0 flex-col gap-200">
                    {rows.length === 0 ? (
                        <QueryEmpty
                            className="h-[240px]"
                            title="No matching agents"
                            description="No agent's name, type, owner or registry ID holds that search."
                        />
                    ) : (
                        <div
                            ref={gridRef}
                            className="flex h-[600px] min-w-0 flex-col [&_tbody_tr]:cursor-pointer"
                            onClick={(event) => pick(event.target)}
                            onKeyDown={(event) => {
                                if ((event.key === "Enter" || event.key === " ") && pick(event.target)) event.preventDefault();
                            }}
                        >
                            <DataGrid
                                columns={columns}
                                data={rows}
                                defaultSort={[
                                    { columnId: "People", direction: "desc" },
                                    { columnId: "Sessions", direction: "desc" },
                                ]}
                                theme={theme}
                                header={{
                                    title: "Agents",
                                    subtitle: registry
                                        ? "Registered agents and the ones only the audit log names. Hover a name for its description."
                                        : "Agents as the audit log names them.",
                                }}
                            />
                        </div>
                    )}
                    <p className={`${SMALL} text-muted-foreground`}>{footer}</p>
                    {(total === undefined || (registry && listTotal(table, "Registered") === undefined)) && (
                        <p className={`${SMALL} text-muted-foreground`}>
                            Overall agent counts are unavailable. The listed agents are not a substitute for these totals.
                        </p>
                    )}
                </div>
                <AgentDetail
                    ref={detailRef}
                    entries={entries}
                    selected={selected}
                    onSelect={setSelectedKey}
                    evaluatorUrl={evaluatorUrl}
                />
            </div>
        </div>
    );
}

/**
 * The Agents destination: how many agents are in use, how many people use
 * them each week and of which kind, then every agent ranked with its detail.
 *
 * Usage is read straight from the audit log, and agents the registry doesn't
 * know are listed by their audit-log names. Where every registered agent sits
 * in its lifecycle, who owns it and who can reach it is Governance's story;
 * how well each one answers is the Agent Evaluator report's.
 */
export function AgentsStage() {
    const registry = !isAbsent(useSourceAvailability(), "agentRegistry");

    const activity = useFilteredQuery(agentActivitySummary());
    const boardSource = agentLeaderboard();
    // The same query as the table's, so it is fetched once.
    const board = useFilteredQuery(boardSource);
    const weekly = useMemo(() => agentWeekly(), []);
    const types = useMemo(() => agentTypes(), []);
    const weeklyResult = useTableQuery(weekly);
    const typesResult = useTableQuery(types);

    const activityRow = useMemo(
        () => (activity.data?.status === "success" ? toSummaryRow(activity.data.table) : undefined),
        [activity.data],
    );
    const boardTable = useMemo(
        () => (board.data?.status === "success" ? toDataTable(board.data.table, boardSource.columnMetadata) : undefined),
        [board.data, boardSource.columnMetadata],
    );
    const inUse = listTotal(boardTable, "In Use");
    const registered = listTotal(boardTable, "Registered");

    return (
        <Section
            id={stageAnchor("agents")}
            title="Agents"
            description="Which agents people use, how often, and what each one is for."
        >
            {activity.data?.status === "error" ? (
                <QueryError message={activity.data.error.message} onRetry={activity.refetch} />
            ) : activity.isLoading || !activity.data || board.isLoading ? (
                <div className="grid gap-300 md:grid-cols-2 xl:grid-cols-4">
                    <QueryLoading />
                    <QueryLoading />
                    <QueryLoading />
                    <QueryLoading />
                </div>
            ) : (
                <div className="grid gap-300 md:grid-cols-2 xl:grid-cols-4" data-export="">
                    <KpiCard
                        label="Agents in use"
                        value={inUse}
                        emphasis
                        detail={registry ? <KpiStat label="Registered" value={registered} /> : undefined}
                    />
                    <KpiCard
                        label="People using agents"
                        value={readNumber(activityRow, "[Agent Users]")}
                        detail={
                            <KpiStat
                                label="Share of active users"
                                value={readNumber(activityRow, "[Agent User Share]")}
                                format="percent"
                            />
                        }
                    />
                    <KpiCard
                        label="Agent sessions"
                        value={readNumber(activityRow, "[Agent Sessions]")}
                        detail={
                            <KpiStat
                                label="Per agent user"
                                value={readNumber(activityRow, "[Sessions Per User]")}
                                format="rate"
                            />
                        }
                    />
                    <KpiCard
                        label="Sessions per person per week"
                        value={readNumber(activityRow, "[Sessions Per User Per Week]")}
                        format="rate"
                    />
                </div>
            )}

            {registry && (
                <OpenDestinationLink destination="governance" stage="estate-health">
                    Where every registered agent sits, who owns it and who can reach it
                </OpenDestinationLink>
            )}

            <div className={cn("grid grid-cols-1 gap-500", registry && "xl:grid-cols-2")}>
                <ChartPanel
                    result={weeklyResult}
                    spec={weekly.vegaLiteSpec}
                    height={320}
                    title="People using agents, weekly"
                    subtitle="Distinct people who used any agent each week"
                    emptyTitle="No agent use"
                    emptyDescription="The audit log records no agent use in this period."
                />
                {registry && (
                    <ChartPanel
                        result={typesResult}
                        spec={types.vegaLiteSpec}
                        height={Math.max(320, rowChartHeight(typesResult.table?.rows.length ?? 0, { perRow: 36, chrome: 120 }))}
                        title="People by agent type"
                        subtitle="People may use more than one type, so these don't add up to the total"
                        emptyTitle="No agent use"
                        emptyDescription="The audit log records no agent use in this period."
                    />
                )}
            </div>

            <AgentsTable registry={registry} />
        </Section>
    );
}
