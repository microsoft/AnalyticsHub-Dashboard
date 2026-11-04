import { useState } from "react";
import { Globe } from "lucide-react";
import { stageAnchor, type StageId } from "@/components/destinations";
import { OpenDestinationLink } from "@/components/open-destination-link";
import { Section } from "@/components/section";
import { useStageFilter } from "@/hooks/stage-filter.context";
import { appDisplayName } from "@/lib/app-brand";
import { BODY, SMALL } from "@/lib/type-scale";
import { cn } from "@/lib/utils";
import portfolio from "./portfolio.json";
import contract from "./contract.json";
import { metricValue, nativeLabel, periodLabel, providers, scopedMetrics, type DemoPortfolio, type NativeMetric } from "./model";
import { ActiveTrendChart, AllToolsSummary, CodingOutput, CostPerActiveChart, CreditsVsSpend, DepartmentHeatmap, LeadersTable, MonthlyReachChart, MultiToolCharts, SpendShareChart, SpendTable, TaskMixHeatmap, TopModelsCharts } from "./insights";
import { SCENARIO_RUN_ID, SCENARIO_SEED, getScenarioInsights, latestMonth, scenarioRange, scenarioTools, taskMapping } from "./scenario";
import { DEMO_ORGANIZATIONS } from "@/demo/organizations";

const data: DemoPortfolio = portfolio;
const panel = "rounded-xl border border-border bg-card p-500";
const select = cn(BODY, "rounded-md border border-input bg-card px-300 py-200 text-foreground focus-visible:outline-2 focus-visible:outline-ring");
const definition = (metric: string) => Object.entries(contract.metric_definitions).find(([key]) => key === metric)?.[1].meaning;
const sourceFor = (id: string) => data.sources.find(s => s.source_id === id)!;
const providerName = (id: string) => providers.find(p => p.id === id)?.name ?? id;

function MetricTable({ metrics }: { metrics: NativeMetric[] }) {
    if (!metrics.length) return <p className={cn(BODY, panel, "text-muted-foreground")}>No observations loaded for this selection. Missing is not zero.</p>;
    return (
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
            <table className={cn(SMALL, "w-full text-left")}>
                <caption className="p-400 text-left text-muted-foreground">Observed fixture values by native source, product, dimensions and period; not population totals.</caption>
                <thead className="bg-muted text-muted-foreground"><tr>{["Source / product", "Native metric", "Observed value", "Native period"].map(h => <th scope="col" key={h} className="p-400 font-semibold">{h}</th>)}</tr></thead>
                <tbody>{metrics.map((m, index) => (
                    <tr key={`${m.source_id}-${m.product}-${m.metric}-${index}`} className="border-t border-border">
                        <td className="p-400 align-top">{providerName(sourceFor(m.source_id).provider)} / {nativeLabel(m.product)}<p className="mt-100 text-muted-foreground">{m.source_id}</p></td>
                        <td className="max-w-[38ch] p-400 align-top">{nativeLabel(m.metric)}<p className="mt-100 text-muted-foreground">{m.product === "Codex" ? "CSV product label only; no verified Codex API or credit/token feed." : m.unit === "boolean" ? "Source records, not distinct people. Duplicate and unresolved identities remain." : definition(m.metric)}</p>{Object.keys(m.dimensions).length > 0 && <p className="mt-100 text-muted-foreground">Dimensions: {JSON.stringify(m.dimensions)}</p>}</td>
                        <td className="p-400 align-top"><strong className={BODY}>{metricValue(m)}</strong><p className="mt-100 text-muted-foreground">{m.unit} / {m.observations} observed record(s)</p></td>
                        <td className="p-400 align-top">{periodLabel(m.period)}<p className="mt-100 text-muted-foreground">Native cadence: {m.period.cadence}; no daily expansion</p></td>
                    </tr>
                ))}</tbody>
            </table>
        </div>
    );
}

function Portfolio() {
    const copilot = getScenarioInsights().copilotCredits.find(row => row.Month === latestMonth.label)!;
    const headlines: Record<string, [string, string][]> = {
        anthropic_enterprise: [["chat", "messages"], ["cowork", "messages"], ["claude_code", "sessions"]],
        openai_chatgpt: [["ChatGPT", "messages"], ["Codex", "messages"]],
        cursor: [["cursor", "tabs_shown"], ["cursor", "tabs_accepted"], ["cursor", "agent_requests"]],
    };
    return (
        <Section id={stageAnchor("vendor-portfolio")} title="Different tools. One honest view." description={`Source-native signals inside ${appDisplayName()}. No comparable activity score or invented ROI.`}>
            <AllToolsSummary />
            <div className="grid gap-400 lg:grid-cols-2">
                <MonthlyReachChart />
                <TaskMixHeatmap />
            </div>
            <h3 className={cn(BODY, "font-semibold")}>Source snapshots</h3>
            <div className="grid gap-400 md:grid-cols-3">
                {providers.map(p => {
                    if (p.id === "microsoft") return (
                        <article key={p.id} aria-label="Microsoft Copilot scenario snapshot" className={cn(panel, "flex flex-col gap-300")}>
                            <div className="flex items-center gap-200"><Globe aria-hidden="true" className="icon-size-300 text-primary" /><h3 className={cn(BODY, "font-semibold")}>{p.name}</h3></div>
                            <p className={cn(SMALL, "text-muted-foreground")}>Microsoft 365 Copilot — seeded scenario usage</p>
                            <dl className="flex flex-col gap-200">
                                {[
                                    ["Licensed seats", DEMO_ORGANIZATIONS.reduce((sum, org) => sum + org.seats, 0)],
                                    ["Active people", copilot.Active],
                                    ["Copilot credits", copilot.Credits],
                                ].map(([label, value]) => <div key={label} className="flex items-center justify-between gap-300 border-b border-border py-200"><dt className={SMALL}>{label}</dt><dd className="text-[length:var(--text-500)] font-semibold">{Number(value).toLocaleString("en-US", { maximumFractionDigits: 1 })}</dd></div>)}
                            </dl>
                            <p className={cn(SMALL, "text-muted-foreground")}>{latestMonth.label}; same period and data as the reach and credits charts.</p>
                            <p className={cn(SMALL, "text-muted-foreground")}>Synthetic scenario, not a live source export. Credits are not USD spend. Native export fixtures below remain separate.</p>
                        </article>
                    );
                    const rows = scopedMetrics(data, p.id);
                    const headline = (headlines[p.id] ?? []).flatMap(([product, metric]) => rows.filter(m => m.product === product && m.metric === metric));
                    return (
                        <article key={p.id} className={cn(panel, "flex flex-col gap-300")}>
                            <div className="flex items-center gap-200"><Globe aria-hidden="true" className="icon-size-300 text-primary" /><h3 className={cn(BODY, "font-semibold")}>{p.name}</h3></div>
                            <p className={cn(SMALL, "text-muted-foreground")}>{p.description}</p>
                            {headline.length ? <><dl className="flex flex-col gap-200">{headline.map(m => <div key={`${m.product}-${m.metric}`} className="flex items-center justify-between gap-300 border-b border-border py-200"><dt className={SMALL}>{nativeLabel(m.product)} / {nativeLabel(m.metric)}</dt><dd className="text-[length:var(--text-500)] font-semibold">{metricValue(m)}</dd></div>)}</dl><p className={cn(SMALL, "text-muted-foreground")}>{periodLabel(headline[0].period)}</p></> : <p className={BODY}>Not loaded in this demo. No zero or live connection implied.</p>}
                            <p className={cn(SMALL, "text-muted-foreground")}>{p.id === "openai_chatgpt" ? "Period-only export. Codex is a CSV product label, not a verified Codex API." : p.id === "anthropic_enterprise" ? "Chat, Cowork and unified channels may overlap; never add them." : p.id === "cursor" ? "Some fields missing; duplicate identities unresolved." : "Existing app pages and models remain separate and unchanged."}</p>
                        </article>
                    );
                })}
            </div>
            <OpenDestinationLink destination="cross-vendor" stage="vendor-usage">Explore native usage</OpenDestinationLink>
        </Section>
    );
}

function AdoptionTrends() {
    return (
        <Section id={stageAnchor("vendor-adoption")} title="Adoption trends" description="Who uses which tool, how that changes week to week, and where tools overlap. Each tool is counted in its own native cadence.">
            <ActiveTrendChart />
            <MultiToolCharts />
            <DepartmentHeatmap />
            <TopModelsCharts />
            <h3 className={cn(BODY, "font-semibold")}>Most active people across tools</h3>
            <LeadersTable />
        </Section>
    );
}

function CodingStage() {
    return (
        <Section id={stageAnchor("vendor-coding")} title="Coding output" description="Claude Code and Cursor report coding activity in their own terms. Each tool's figures stay separate.">
            <CodingOutput />
        </Section>
    );
}

function SpendStage() {
    return (
        <Section id={stageAnchor("vendor-spend")} title="Spend & credits" description="Monthly charges by tool, each in its own basis. Copilot credits sit beside USD spend and are never added to it.">
            <div className="grid gap-400 lg:grid-cols-2">
                <SpendShareChart />
                <CostPerActiveChart />
            </div>
            <CreditsVsSpend />
            <SpendTable />
        </Section>
    );
}

function Usage() {
    const [provider, setProvider] = useState("all");
    const [product, setProduct] = useState("all");
    const products = [...new Set(scopedMetrics(data, provider).map(m => m.product))];
    return (
        <Section id={stageAnchor("vendor-usage")} title="Native usage" description="Keep units, products and original periods separate. Source completeness does not imply every metric is present.">
            <div className="flex flex-wrap gap-400">
                <label className={cn(SMALL, "flex flex-col gap-200")}>Vendor<select className={select} value={provider} onChange={event => { setProvider(event.target.value); setProduct("all"); }}><option value="all">All loaded sources</option>{providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
                <label className={cn(SMALL, "flex flex-col gap-200")}>Native product<select className={select} value={product} onChange={event => setProduct(event.target.value)}><option value="all">All native products</option>{products.map(p => <option key={p} value={p}>{nativeLabel(p)}</option>)}</select></label>
            </div>
            <MetricTable metrics={scopedMetrics(data, provider, product).filter(m => m.unit !== "currency")} />
        </Section>
    );
}

function Cost() {
    const costs = scopedMetrics(data).filter(m => m.unit === "currency");
    return (
        <Section id={stageAnchor("vendor-cost")} title="Cost & evidence" description="A fixture-reported charge is not a verified invoice, a seat-price estimate or a financial total.">
            <div className="grid gap-400 md:grid-cols-2">
                <div className={panel}><h3 className={cn(BODY, "font-semibold")}>Claude grouped charge</h3>{costs.map(c => <div key={c.source_id}><p className="my-400 text-[length:var(--text-hero-800)] font-semibold text-primary">{metricValue(c)}</p><p className={BODY}>Exact decimal amount as reported; grouped charge, not a model price.</p><p className={cn(SMALL, "mt-300 text-muted-foreground")}>Basis: {c.cost_basis}; {nativeLabel(c.product)}; {periodLabel(c.period)}.</p></div>)}</div>
                <div className={cn(panel, BODY, "flex flex-col gap-300")}><h3 className="font-semibold">Not calculated</h3><p>No verified billed spend or estimated seat spend loaded for any vendor.</p><p>No portfolio financial total, currency conversion, hours saved or ROI.</p><p>ChatGPT seat adoption is not OpenAI developer API consumption. Cursor spend and Codex credits/tokens are deferred.</p></div>
            </div>
            <MetricTable metrics={costs} />
        </Section>
    );
}

function Coverage() {
    return (
        <Section id={stageAnchor("vendor-coverage")} title="Source coverage" description="Four source snapshots. Fixture row completeness, metric coverage and live validation are different questions.">
            <div className="grid gap-400 md:grid-cols-2">
                {data.sources.map(s => (
                    <article key={s.source_id} className={cn(panel, SMALL, "flex flex-col gap-200")}>
                        <h3 className={cn(BODY, "font-semibold")}>{providerName(s.provider)} / {s.source_file}</h3>
                        <p>{periodLabel(s.declared_period)}</p>
                        <p>{s.input_rows} input rows; {s.completeness} fixture ingestion; <strong>{s.missing_metric_count} missing metric fields</strong>, never zero-filled.</p>
                        <p>Schema evidence: {s.evidence_level}; {s.schema_version}. No live validation.</p>
                        <p className="text-muted-foreground">{s.evidence_reference}</p>
                        <p>Freshness: {s.freshness.status}. {s.freshness.source_refreshed_at ? `Fixture refresh label: ${s.freshness.source_refreshed_at}; not a current freshness SLA.` : "No refresh timestamp supplied."}</p>
                        <details><summary className="cursor-pointer text-primary">Schema limitations & fingerprint</summary><p className="mt-200">{Object.entries(contract.sources).find(([key]) => key === s.adapter)?.[1].limitations}</p><p className="mt-200 break-all">{s.sha256}</p></details>
                    </article>
                ))}
            </div>
            <div className={cn(panel, BODY, "flex flex-col gap-300")}><h3 className="font-semibold">Not connected or not yet supported</h3>{Object.entries(data.portfolio.deferred_sources).map(([key, value]) => <p key={key}><strong>{nativeLabel(key)}: </strong>{value}</p>)}</div>
        </Section>
    );
}

function Methodology() {
    return (
        <Section id={stageAnchor("vendor-methodology")} title="Methodology" description="How the view's data is built, and what it does not claim.">
            <div role="note" aria-label="Synthetic demo disclosure" className={cn(BODY, "rounded-xl border border-border bg-accent p-400 text-accent-foreground")}>
                <strong>All data in this view is synthetic and illustrative.</strong> It is not live or verified: no customer data, real usage, verified billing or ROI. App-wide date and organization filters do not apply.
            </div>
            <div className={cn(panel, BODY, "flex flex-col gap-300")}>
                <h3 className="font-semibold">Call walkthrough</h3>
                <p>Start on Portfolio, then Adoption trends, Coding output and Spend &amp; credits. Native usage, Cost &amp; evidence and Source coverage show the small source fixture behind the contract.</p>
                <h3 className="font-semibold">Scenario data</h3>
                <p>A seeded generator (seed {SCENARIO_SEED}, run {SCENARIO_RUN_ID}) builds {scenarioRange} for {DEMO_ORGANIZATIONS.reduce((sum, organization) => sum + organization.seats, 0)} people in {DEMO_ORGANIZATIONS.length} organizations. This is a separate comparison scenario, not the published CSV cohort on the other pages or a Fabric export. Every row keeps its vendor&apos;s native shape and synthetic provenance, and the same seed always gives the same data.</p>
                <p>People are linked across tools by a scenario-assigned identity map, not by email matching. Charts keep each tool&apos;s cadence: ChatGPT exports are monthly, so it appears only in monthly views. {latestMonth.label} is a partial month. No figure adds periods, currencies or units together.</p>
                <p>Copilot credits, Cursor spend and ChatGPT seat charges are scenario extensions outside contract v1, using illustrative prices. Model names are generic classes, not product availability claims.</p>
                <h3 className="font-semibold">Task mapping</h3>
                <ul className="list-disc space-y-200 pl-500">{scenarioTools.map(t => <li key={t.id}><strong>{t.name}: </strong>{taskMapping.filter(m => m.tool === t.id).map(m => `${m.native} → ${m.task}`).join("; ")}</li>)}</ul>
                <h3 className="font-semibold">Identity and time boundaries</h3>
                <p>No automatic email joins or unique-person count. Candidate identities include ambiguity and a missing source ID. Boolean activity counts are records, not people.</p>
                <p>Claude and Cursor cover October 25; ChatGPT retains October 1-26 inclusive, despite its native daily label. No daily trend is inferred from that export.</p>
                <p>This extension makes no vendor API calls or semantic model queries. Its data is never merged with the app&apos;s live pages, filters, freshness or report packs. Fixture ingestion label: {data.ingested_at}.</p>
                <ul className="list-disc space-y-200 pl-500">{contract.invariants.map(i => <li key={i}>{i}</li>)}</ul>
                <h3 className="font-semibold">Native metric dictionary</h3>
                {Object.entries(contract.metric_definitions).map(([key, value]) => <p key={key}><strong>{nativeLabel(key)} ({value.unit}): </strong>{value.meaning}</p>)}
            </div>
        </Section>
    );
}

export function CrossVendorScreen() {
    const { show } = useStageFilter();
    const stages: [StageId, typeof Portfolio][] = [
        ["vendor-portfolio", Portfolio], ["vendor-adoption", AdoptionTrends], ["vendor-coding", CodingStage], ["vendor-spend", SpendStage],
        ["vendor-usage", Usage], ["vendor-cost", Cost], ["vendor-coverage", Coverage], ["vendor-methodology", Methodology],
    ];
    if (import.meta.env.VITE_CROSS_VENDOR_DEMO !== "true") return <p className={BODY}>The synthetic cross-vendor view is not enabled for this build.</p>;
    return (
        <div className="flex flex-col gap-600">
            {stages.map(([id, Screen]) => show(id) && <Screen key={id} />)}
        </div>
    );
}
