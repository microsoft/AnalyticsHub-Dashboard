export interface NativePeriod {
    start: string;
    end: string;
    boundary: string;
    cadence: string;
}

export interface NativeMetric {
    source_id: string;
    product: string;
    metric: string;
    unit: string;
    currency: string | null;
    cost_basis: string | null;
    dimensions: Record<string, string | undefined>;
    period: NativePeriod;
    observations: number;
    observed_value?: string;
    true_observations?: number;
    false_observations?: number;
}

export interface DemoSource {
    source_id: string;
    provider: string;
    adapter: string;
    source_file: string;
    classification: string;
    evidence_level: string;
    evidence_reference: string;
    schema_version: string;
    completeness: string;
    input_rows: number;
    missing_metric_count: number;
    declared_period: NativePeriod;
    sha256: string;
    freshness: { status: string; source_refreshed_at: string | null };
}

export interface DemoPortfolio {
    contract_version: string;
    ingested_at: string;
    sources: DemoSource[];
    portfolio: {
        metrics: NativeMetric[];
        deferred_sources: Record<string, string>;
    };
}

export const providers = [
    { id: "anthropic_enterprise", name: "Claude", description: "Chat, Cowork & Claude Code" },
    { id: "openai_chatgpt", name: "ChatGPT / Codex", description: "Partial workspace Users CSV" },
    { id: "cursor", name: "Cursor", description: "Native daily coding usage" },
    { id: "microsoft", name: "Microsoft Copilot", description: "Existing collectors unchanged; not loaded here" },
    { id: "github_copilot", name: "GitHub Copilot", description: "Usage adapter deferred; not loaded here" },
] as const;

export function scopedMetrics(data: DemoPortfolio, provider = "all", product = "all"): NativeMetric[] {
    const sources = new Set(data.sources.filter(s => provider === "all" || s.provider === provider).map(s => s.source_id));
    return data.portfolio.metrics.filter(m => sources.has(m.source_id) && (product === "all" || m.product === product));
}

export function periodLabel(period: NativePeriod): string {
    const start = period.start.slice(0, 10);
    const end = period.end.slice(0, 10);
    if (period.boundary === "exclusive_end") return `${start} to ${end} (end exclusive, UTC)`;
    return start === end ? `${start} (inclusive date)` : `${start} to ${end} (inclusive dates; period only)`;
}

export function nativeLabel(value: string): string {
    const labels: Record<string, string> = {
        chat: "Claude Chat", cowork: "Cowork", claude_code: "Claude Code",
        chat_cowork_unified_chat: "Unified Chat channel",
        chat_cowork_unified_sessions: "Unified Cowork channel",
        cursor: "Cursor", reported_charge: "Fixture-reported charge",
    };
    return labels[value] ?? value.replaceAll("_", " ");
}

export function metricValue(metric: NativeMetric): string {
    if (metric.unit === "boolean") return `${metric.true_observations} true / ${metric.false_observations} false`;
    return `${metric.currency ? metric.currency + " " : ""}${metric.observed_value}`;
}
