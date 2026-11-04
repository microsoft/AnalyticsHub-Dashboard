export interface Activity {
    date: string; week: string; month: string; user: string; app: string; agent: string; agentType: string; audience: string;
    thread: string; message: string; behavior: string; category: string; group: string; outcome: string; resource: string;
    grade: string; shape: string; basis: string; model: string; tier: string; sessionTier: string; workflow: string; coworkCategory: string;
    prompt: boolean; observed: boolean; licensed: boolean; cowork: boolean; refs: number; types: number;
}
export interface Person { user: string; name: string; org: string; licensed: boolean; job: string; country: string; active: boolean }
type SourceRow = Record<string, string>;
type ConsumptionTable = "PersonServiceCreditsMetrics" | "PersonPolicyMap" | "SpendingPolicyMetadata" | "PeopleMetaData"
    | "StudioTenantDaily" | "StudioPerUser" | "StudioPerAgent" | "entra_org" | "AzureAiSpendDaily" | "AzureAiTokensDaily"
    | "AzureSolutionSpend" | "AzureDeploymentHealth" | "AzureBillingReconciliation" | "GitHubAiUsage" | "GitHubUserMap";
interface SampleData {
    activity: Activity[]; people: Person[]; agents: SourceRow[]; feedback: SourceRow[];
    times: SourceRow[]; signals: SourceRow[]; glossary: SourceRow[]; consumption: Record<ConsumptionTable, SourceRow[]>;
    terms: { credit_rate: number; prepaid_credit_rate: number; prepaid_credit_balance: number };
    provenance: { description: string; classification: string; inputActivityRows: number; outputActivityRows: number; files: Record<string, string> };
}
// Optional for ordinary app builds; the dedicated demo build generates this input first.
const files = import.meta.glob<SampleData>("./sample-data.generated.json", { eager: true, import: "default" });
const data = files["./sample-data.generated.json"];
if (!data) throw new Error("Offline sample data is missing. Run npm run demo:data before starting the demo.");

export { data as samples };
export type RecordRow = Record<string, unknown>;
export const peopleById = new Map(data.people.map(person => [person.user, person]));
export const firstDate = data.activity.map(row => row.date).sort()[0];
export const lastDate = data.activity.map(row => row.date).sort().at(-1)!;
export const sum = <T>(rows: readonly T[], value: (row: T) => number) => rows.reduce((total, row) => total + value(row), 0);
export const unique = <T>(rows: readonly T[], value: (row: T) => string) => new Set(rows.map(value).filter(Boolean)).size;
export const ratio = (value: number, denominator: number) => denominator > 0 ? value / denominator : 0;
export const round = (value: number) => Math.round(value * 100) / 100;
export const nameOf = (column: string) => column.replace(/^.*\[/, "").replace(/\]$/, "");
export const project = (columns: readonly string[], rows: readonly RecordRow[]) =>
    rows.map(row => columns.map(column => row[column] ?? row[nameOf(column)] ?? null));

export function groups<T>(rows: readonly T[], key: (row: T) => string): [string, T[]][] {
    const result = new Map<string, T[]>();
    for (const row of rows) {
        const label = key(row);
        const bucket = result.get(label);
        if (bucket) bucket.push(row);
        else result.set(label, [row]);
    }
    return [...result];
}

export function literals(query: string, table: string, column: string): string[] | undefined {
    const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`TREATAS\\s*\\(\\s*\\{([^}]*)\\}\\s*,\\s*'?${escape(table)}'?\\[${escape(column)}\\]\\s*\\)`, "i").exec(query);
    return match ? [...match[1].matchAll(/"((?:[^"]|"")*)"/g)].map(value => value[1].replace(/""/g, '"')) : undefined;
}

export function dateRange(query: string, column = "'Calendar'[Date]") {
    const escaped = column.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`${escaped}\\s*>=\\s*DATE\\(\\s*(\\d+),\\s*(\\d+),\\s*(\\d+)\\s*\\)[\\s\\S]*?${escaped}\\s*<=\\s*DATE\\(\\s*(\\d+),\\s*(\\d+),\\s*(\\d+)\\s*\\)`, "i").exec(query);
    const iso = (index: number) => `${match![index]}-${match![index + 1].padStart(2, "0")}-${match![index + 2].padStart(2, "0")}`;
    return match ? { from: iso(1), to: iso(4) } : undefined;
}

export function orgAttribute(query: string): "org" | "country" | "job" {
    const attribute = literals(query, "Org Attribute Values", "Attribute")?.[0]
        ?? literals(query, "Org Attribute Source", "Attribute")?.[0]
        ?? /'Org Attribute Source'\[Attribute\]\s*=\s*"((?:[^"]|"")*)"/i.exec(query)?.[1] ?? "Organization";
    return /country/i.test(attribute) ? "country" : /job/i.test(attribute) ? "job" : "org";
}

export function selectedPeople(query: string) {
    const membership = /'Org Attribute Source'\[Value\]\s+IN\s*\{([^}]*)\}/i.exec(query);
    const values = literals(query, "Chat + Agent Org Data", "Organization") ?? literals(query, "Org Attribute Values", "Value")
        ?? (membership ? [...membership[1].matchAll(/"((?:[^"]|"")*)"/g)].map(value => value[1].replace(/""/g, '"')) : undefined);
    const attribute = orgAttribute(query);
    return data.people.filter(person => !values || values.includes(person[attribute]));
}

export function selectedActivity(query: string): Activity[] {
    const people = new Set(selectedPeople(query).map(person => person.user));
    const range = dateRange(query);
    const audiences = literals(query, "Chat + Agent Interactions (Audit Logs)", "Agent Filter (Normalized)");
    const licenses = literals(query, "Chat + Agent Interactions (Audit Logs)", "Environment");
    const agents = literals(query, "Chat + Agent Interactions (Audit Logs)", "AgentName");
    const types = literals(query, "Agents 365", "Agent Type Label");
    return data.activity.filter(row => people.has(row.user) && (!range || row.date >= range.from && row.date <= range.to)
        && (!audiences || audiences.includes(row.audience))
        && (!licenses || licenses.includes(row.licensed ? "Licensed" : "Unlicensed"))
        && (!agents || agents.includes(row.agent)) && (!types || types.includes(row.agentType)));
}

export function sessions(rows: readonly Activity[]) {
    return groups(rows.filter(row => row.observed), row => `${row.user}|${row.app}|${row.thread}`).map(([, values]) => values[0]);
}

export function timeFor(query: string, task: string, scenario = effortScenario(query)): number {
    const estimate = data.times.find(row => row.Behavior === task);
    const escaped = task.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const override = new RegExp(`"${escaped}", SWITCH\\(_scn, "Conservative", ([\\d.]+), "Optimistic", ([\\d.]+), ([\\d.]+)\\)`).exec(query);
    if (override) return Number(override[scenario === "Conservative" ? 1 : scenario === "Optimistic" ? 2 : 3]);
    return Number(estimate?.[scenario === "Conservative" ? "Min Low" : scenario === "Optimistic" ? "Min High" : "Min Typical"] ?? 0);
}

export function effortScenario(query: string) {
    return literals(query, "Effort Scenario", "Scenario")?.[0] ?? "Typical";
}

const resourceMeans = new Map(groups(data.activity.filter(row => row.prompt), row => row.behavior)
    .map(([behavior, rows]) => [behavior, ratio(rows.length, unique(rows, row => row.message))]));
const coworkMinutes: Record<string, readonly number[]> = {
    "Analysis & Research": [30, 67, 92, 5], "Document & content creation": [12, 24, 42, 0],
    "Email workflows": [3, 7, 12, 4], "Meeting workflows": [12, 31, 43, 3],
    "Communication workflows": [2, 4, 11, 4], "Specialized workflows": [10, 25, 40, 0],
    "Write or debug code": [30, 56, 96, 6], "General assistance / Other": [2, 5, 8, 0],
};

/** The shipped template's behavior/resource grain and Cowork thread/category hour rules. */
export function hours(rows: readonly Activity[], query: string, scenario = effortScenario(query)): number {
    const ordinary = sum(groups(rows.filter(row => row.prompt && !row.cowork), row => row.behavior), ([behavior, values]) => {
        const estimate = data.times.find(row => row.Behavior === behavior);
        const units = estimate?.["Effort Grain"] === "Per Resource"
            ? ratio(values.length, resourceMeans.get(behavior) ?? 0) : unique(values, row => row.message);
        return timeFor(query, behavior, scenario) * units / 60;
    });
    const cowork = sum(groups(rows.filter(row => row.cowork), row => `${row.thread}|${row.coworkCategory}`), ([, values]) => {
        const band = coworkMinutes[values[0].coworkCategory];
        if (!band) return 0;
        const reads = values.filter(row => row.resource && row.resource.toLowerCase() !== "message").length;
        const quotient = ratio(reads, band[3]);
        const whole = Math.floor(quotient);
        const fraction = quotient - whole;
        const rounded = fraction > 0.5 || fraction === 0.5 && whole % 2 !== 0 ? whole + 1 : whole;
        return Math.max(1, rounded) * band[scenario === "Conservative" ? 0 : scenario === "Optimistic" ? 2 : 1] / 60;
    });
    return ordinary + cowork;
}

export function weeks(rows: readonly Activity[]) {
    return unique(rows, row => row.week);
}

export function hourlyRate(query: string) {
    return Number(/TREATAS\s*\(\s*\{\s*(\d+(?:\.\d+)?)\s*\}\s*,\s*'Hourly Value'\[Hourly Value\]/i.exec(query)?.[1] ?? 50);
}

export function personGroup(row: Activity, query: string) {
    return peopleById.get(row.user)?.[orgAttribute(query)] ?? "(Unassigned)";
}

export function rollup(
    columns: readonly string[], rows: readonly Activity[], group: (row: Activity) => string, leaf: (row: Activity) => string,
    groupColumn: string, leafColumn: string, summarize: (rows: readonly Activity[]) => RecordRow,
) {
    const leaves = groups(rows, row => `${group(row)}\u0000${leaf(row)}`);
    const records: RecordRow[] = leaves.map(([, values]) => ({
        ...summarize(values), [groupColumn]: group(values[0]), [leafColumn]: leaf(values[0]), Total: leaves.length,
        "Is Grand Total": false, "Is Group Total": false,
    }));
    for (const [label, values] of groups(rows, group)) records.push({
        ...summarize(values), [groupColumn]: label, [leafColumn]: null, Total: leaves.length,
        "Is Grand Total": false, "Is Group Total": true,
    });
    records.push({ ...summarize(rows), [groupColumn]: null, [leafColumn]: null, Total: leaves.length,
        "Is Grand Total": true, "Is Group Total": true });
    return project(columns, records);
}

export function cuts(values: readonly number[]) {
    const sorted = values.filter(value => value > 0).sort((a, b) => b - a);
    const total = sum(sorted, value => value);
    let cumulative = 0;
    return sorted.map((value, i) => {
        cumulative += value;
        return { Count: i + 1, Cumulative: cumulative, People: sorted.length, Total: total };
    });
}
