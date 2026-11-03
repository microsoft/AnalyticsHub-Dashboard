import type { ReactNode } from "react";
import type { DataTable } from "@microsoft/fabric-visuals-core";
import { KpiCard } from "@/components/kpi-card";
import { VegaVisual, type VisualizationSpec } from "@/components/vega-visual";
import { useThemeContext } from "@/hooks/theme.context";
import { BODY, SMALL } from "@/lib/type-scale";
import { cn } from "@/lib/utils";
import { getScenarioInsights, latestMonth, scenarioTools, toolName, type ScenarioInsights } from "./scenario";

export const panel = "rounded-xl border border-border bg-card p-500";
const toolOrder = scenarioTools.map(t => t.name);
const pct = (v: number) => `${Math.round(v * 100)}%`;
const whole = (v: number) => v.toLocaleString("en-US");

function table(rows: readonly object[]): DataTable {
    const columns = rows.length ? Object.keys(rows[0]) : [];
    return { columns: columns.map(name => ({ name })), rows: rows.map(r => columns.map(c => (r as Record<string, unknown>)[c])) } as unknown as DataTable;
}

export function Chart({ title, subtitle, spec, rows, height = 300 }: { title: string; subtitle: string; spec: object; rows: readonly object[]; height?: number }) {
    const { theme } = useThemeContext();
    return (
        <div className={cn(panel, "flex flex-col gap-200")} style={{ height: height + 96 }}>
            <VegaVisual label={title} spec={{ $schema: "https://vega.github.io/schema/vega-lite/v5.json", width: "container", height: "container", ...spec } as VisualizationSpec} data={table(rows)} theme={theme} header={{ title, subtitle }} />
        </div>
    );
}

const toolColor = { field: "Tool", type: "nominal", title: null, sort: toolOrder, legend: { orient: "top", direction: "horizontal" } };
const monthX = { field: "Month", type: "nominal", title: null, sort: null, axis: { labelAngle: 0 } };
const tip = (...fields: [string, string, string?][]) => fields.map(([field, title, format]) => ({ field, title, type: format ? "quantitative" : "nominal", ...(format ? { format } : {}) }));

function groupedBars(y: string, yTitle: string, format: string) {
    return {
        mark: { type: "bar", cornerRadiusEnd: 2 },
        encoding: { x: monthX, xOffset: { field: "Tool", sort: toolOrder }, y: { field: y, type: "quantitative", title: yTitle, axis: { format } }, color: toolColor, tooltip: tip(["Month", "Period"], ["Tool", "Tool"], [y, yTitle, format]) },
    };
}

function heatmap(x: string, y: string, value: string, format: string, title: string, extraTip: [string, string, string?][] = []) {
    return {
        encoding: { x: { field: x, type: "nominal", title: null, sort: x === "Tool" ? toolOrder : null, axis: { orient: "top", labelAngle: 0 } }, y: { field: y, type: "nominal", title: null, sort: null, axis: { labelLimit: 160 } } },
        layer: [
            { mark: { type: "rect", stroke: "white", strokeWidth: 1 }, encoding: { color: { field: value, type: "quantitative", title, legend: null }, tooltip: tip([y, y], [x, x], [value, title, format], ...extraTip) } },
            { mark: { type: "text", fontSize: 11 }, encoding: { text: { field: value, type: "quantitative", format }, color: { condition: { test: `datum['${value}'] > ${value === "Reach" ? 0.45 : 60}`, value: "white" }, value: "black" } } },
        ],
    };
}

const latest = () => latestMonth.label;

export function AllToolsSummary({ insights = getScenarioInsights() }: { insights?: ScenarioInsights }) {
    const reach = insights.monthlyReach.filter(r => r.Month === latestMonth.label);
    return (
        <div className="grid gap-400 sm:grid-cols-2 lg:grid-cols-5">
            {reach.map(r => <KpiCard key={r.Tool} label={`${r.Tool} active people`} value={r.Users} detail={`${pct(r.Reach)} of ${insights.population} people, ${latest()}`} />)}
            <KpiCard label="People using 2+ tools" value={insights.multiToolPeople} emphasis detail={`Active in more than one tool, ${latest()}`} />
        </div>
    );
}

export function ActiveTrendChart({ insights = getScenarioInsights() }: { insights?: ScenarioInsights }) {
    return <Chart title="Weekly active people by tool" subtitle="Daily-cadence sources only. ChatGPT exports are monthly, so they appear in the monthly reach chart" rows={insights.weeklyActive} spec={{
        mark: { type: "line", point: true, strokeWidth: 2 },
        encoding: { x: { field: "Week", type: "temporal", timeUnit: "utcyearmonthdate", title: null, axis: { format: "%d %b" } }, y: { field: "Users", type: "quantitative", title: "Active people" }, color: toolColor, tooltip: tip(["Week", "Week commencing"], ["Tool", "Tool"], ["Users", "Active people", ",.0f"]) },
    }} />;
}

export function MonthlyReachChart({ insights = getScenarioInsights() }: { insights?: ScenarioInsights }) {
    return <Chart title="Share of people active in each tool" subtitle={`Each tool's reach of the ${insights.population}-person organisation, month by month. Shares overlap, so they don't add to 100%`} rows={insights.monthlyReach} spec={groupedBars("Reach", "Share of people", ".0%")} />;
}

export function DepartmentHeatmap({ insights = getScenarioInsights() }: { insights?: ScenarioInsights }) {
    return <Chart height={480} title="Usage by department" subtitle={`Share of each department active in each tool, ${latest()}`} rows={insights.departmentHeat} spec={heatmap("Tool", "Department", "Reach", ".0%", "Share active", [["Active", "Active people", ",.0f"], ["Headcount", "Headcount", ",.0f"]])} />;
}

export function MultiToolCharts({ insights = getScenarioInsights() }: { insights?: ScenarioInsights }) {
    return (
        <div className="grid gap-400 lg:grid-cols-2">
            <Chart height={240} title="How many tools people use" subtitle={`People active in one or more tools, ${latest()}`} rows={insights.toolCounts} spec={{
                mark: { type: "bar", cornerRadiusEnd: 2 },
                encoding: { x: { field: "Tools", type: "nominal", title: null, sort: null, axis: { labelAngle: 0 } }, y: { field: "People", type: "quantitative", title: "People" }, tooltip: tip(["Tools", "Tools used"], ["People", "People", ",.0f"]) },
            }} />
            <Chart height={240} title="Copilot users who also use another tool" subtitle={`Active in Microsoft 365 Copilot and the named tool, ${latest()}`} rows={insights.copilotPlus} spec={{
                mark: { type: "bar", cornerRadiusEnd: 2 },
                encoding: { y: { field: "Pair", type: "nominal", title: null, sort: null, axis: { labelLimit: 200 } }, x: { field: "People", type: "quantitative", title: "People" }, tooltip: tip(["Pair", "Tools"], ["People", "People", ",.0f"]) },
            }} />
        </div>
    );
}

export function TopModelsCharts({ insights = getScenarioInsights() }: { insights?: ScenarioInsights }) {
    const tools = ["Claude", "ChatGPT / Codex", "Cursor"];
    const subtitle: Record<string, string> = { Claude: "By reported charge (USD)", "ChatGPT / Codex": "By messages", Cursor: "By days as the most-used model" };
    return (
        <div className="grid gap-400 lg:grid-cols-3">
            {tools.map(tool => {
                const rows = insights.topModels.filter(m => m.Tool === tool);
                const format = tool === "Claude" ? "$,.0f" : ",.0f";
                return <Chart key={tool} height={200} title={`${tool} models`} subtitle={`${subtitle[tool]}, ${latest()}. Each tool keeps its own unit`} rows={rows} spec={{
                    mark: { type: "bar", cornerRadiusEnd: 2 },
                    encoding: { y: { field: "Model", type: "nominal", title: null, sort: "-x" }, x: { field: "Value", type: "quantitative", title: rows[0]?.Unit ?? null, axis: { format } }, tooltip: tip(["Model", "Model"], ["Value", rows[0]?.Unit ?? "Value", format]) },
                }} />;
            })}
        </div>
    );
}

export function CodingOutput({ insights = getScenarioInsights() }: { insights?: ScenarioInsights }) {
    const { claude, cursor } = insights.coding;
    return (
        <div className="flex flex-col gap-400">
            <div className="grid gap-400 lg:grid-cols-2">
                <article className={cn(panel, "flex flex-col gap-300")}>
                    <h3 className={cn(BODY, "font-semibold")}>Claude Code, {latest()}</h3>
                    <div className="grid grid-cols-2 gap-300 md:grid-cols-4">
                        <KpiCard label="Lines added" value={claude.linesAdded} />
                        <KpiCard label="Commits" value={claude.commits} />
                        <KpiCard label="Pull requests" value={claude.pullRequests} />
                        <KpiCard label="Sessions" value={claude.sessions} />
                    </div>
                    <p className={cn(SMALL, "text-muted-foreground")}>{whole(claude.activeCoders)} people coding. Acceptance rate isn&apos;t in this source, so it isn&apos;t shown.</p>
                </article>
                <article className={cn(panel, "flex flex-col gap-300")}>
                    <h3 className={cn(BODY, "font-semibold")}>Cursor, {latest()}</h3>
                    <div className="grid grid-cols-2 gap-300 md:grid-cols-4">
                        <KpiCard label="Lines added" value={cursor.linesAdded} />
                        <KpiCard label="Accepted lines" value={cursor.linesAdded ? cursor.acceptedLinesAdded / cursor.linesAdded : undefined} format="percent" />
                        <KpiCard label="Tab accept rate" value={cursor.tabsShown ? cursor.tabsAccepted / cursor.tabsShown : undefined} format="percent" />
                        <KpiCard label="Agent requests" value={cursor.agentRequests} />
                    </div>
                    <p className={cn(SMALL, "text-muted-foreground")}>{whole(cursor.activeCoders)} people coding. Rates are accepted over shown or suggested, within Cursor only.</p>
                </article>
            </div>
            <Chart title="Lines added each week" subtitle="Claude Code and Cursor count lines differently, so compare each tool's trend, not the two totals" rows={insights.codingWeekly} spec={{
                mark: { type: "area", line: true, opacity: 0.25 },
                encoding: { x: { field: "Week", type: "temporal", timeUnit: "utcyearmonthdate", title: null, axis: { format: "%d %b" } }, y: { field: "Lines", type: "quantitative", title: "Lines added", stack: null }, color: { field: "Tool", type: "nominal", title: null, legend: { orient: "top", direction: "horizontal" } }, tooltip: tip(["Week", "Week commencing"], ["Tool", "Tool"], ["Lines", "Lines added", ",.0f"]) },
            }} />
        </div>
    );
}

export function SpendShareChart({ insights = getScenarioInsights() }: { insights?: ScenarioInsights }) {
    return <Chart title="Each tool's share of spend" subtitle="USD charges within each month. Charge bases differ by vendor; see the table below" rows={insights.spend} spec={{
        mark: { type: "bar" },
        encoding: { x: monthX, y: { field: "USD", type: "quantitative", stack: "normalize", title: "Share of the month's USD charges", axis: { format: ".0%" } }, color: toolColor, tooltip: tip(["Month", "Period"], ["Tool", "Tool"], ["USD", "Charge (USD)", "$,.2f"], ["Basis", "Basis"]) },
    }} />;
}

export function CostPerActiveChart({ insights = getScenarioInsights() }: { insights?: ScenarioInsights }) {
    return <Chart title="Cost per active person" subtitle="Each tool's USD charge divided by its own active people in the same month" rows={insights.spend.filter(r => r.PerActive !== null)} spec={groupedBars("PerActive", "USD per active person", "$,.0f")} />;
}

export function CreditsVsSpend({ insights = getScenarioInsights() }: { insights?: ScenarioInsights }) {
    return (
        <div className="grid gap-400 lg:grid-cols-2">
            <Chart height={240} title="Microsoft 365 Copilot credits" subtitle="Credits consumed each month. Credits are not currency" rows={insights.copilotCredits} spec={{
                mark: { type: "bar", cornerRadiusEnd: 2 },
                encoding: { x: monthX, y: { field: "Credits", type: "quantitative", title: "Credits" }, tooltip: tip(["Month", "Period"], ["Credits", "Credits", ",.1f"], ["Active", "Active people", ",.0f"], ["PerActive", "Credits per active person", ",.1f"]) },
            }} />
            <Chart height={240} title="Spend on other AI tools" subtitle="USD charges each month, shown beside credits and never added to them" rows={insights.spend} spec={groupedBars("USD", "USD", "$,.0f")} />
        </div>
    );
}

export function SpendTable({ insights = getScenarioInsights() }: { insights?: ScenarioInsights }) {
    return (
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
            <table className={cn(SMALL, "w-full text-left")}>
                <caption className="p-400 text-left text-muted-foreground">Monthly charges by tool. No cross-month or cross-currency total.</caption>
                <thead className="bg-muted text-muted-foreground"><tr>{["Period", "Tool", "USD charge", "Active people", "Per active person", "Basis"].map(h => <th scope="col" key={h} className="p-400 font-semibold">{h}</th>)}</tr></thead>
                <tbody>{insights.spend.map(r => (
                    <tr key={`${r.Month}-${r.Tool}`} className="border-t border-border">
                        <td className="p-400">{r.Month}</td><td className="p-400">{r.Tool}</td>
                        <td className="p-400">USD {r.USD.toFixed(2)}</td><td className="p-400">{whole(r.Active)}</td>
                        <td className="p-400">{r.PerActive === null ? "Not calculated" : `USD ${r.PerActive.toFixed(2)}`}</td><td className="p-400">{r.Basis}</td>
                    </tr>
                ))}</tbody>
            </table>
        </div>
    );
}

export function TaskMixHeatmap({ insights = getScenarioInsights() }: { insights?: ScenarioInsights }) {
    return <Chart height={240} title="Which tool people use for which task" subtitle={`People active for each task, ${latest()}. Tasks come from each tool's native product or app`} rows={insights.taskMix} spec={heatmap("Tool", "Task", "People", ",.0f", "People")} />;
}

export function LeadersTable({ insights = getScenarioInsights(), caption }: { insights?: ScenarioInsights; caption?: ReactNode }) {
    return (
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
            <table className={cn(SMALL, "w-full text-left")}>
                <caption className="p-400 text-left text-muted-foreground">{caption ?? `Ranked by tools used, then active days, ${latest()}.`}</caption>
                <thead className="bg-muted text-muted-foreground"><tr>{["#", "Person", "Department", "Tools used", "Active days", "Copilot days", "Claude days", "Cursor days", "ChatGPT / Codex"].map(h => <th scope="col" key={h} className="p-400 font-semibold">{h}</th>)}</tr></thead>
                <tbody>{insights.leaders.map((l, i) => (
                    <tr key={`${l.name}-${i}`} className="border-t border-border">
                        <td className="p-400">{i + 1}</td><td className="p-400 font-semibold">{l.name}</td><td className="p-400">{l.department}</td>
                        <td className="p-400">{l.tools.map(toolName).join(", ")}</td><td className="p-400">{l.activeDays}</td>
                        <td className="p-400">{l.copilotDays}</td><td className="p-400">{l.claudeDays}</td><td className="p-400">{l.cursorDays}</td>
                        <td className="p-400">{l.chatgptActive ? "Active this period" : "Not active"}</td>
                    </tr>
                ))}</tbody>
            </table>
        </div>
    );
}
