// A seeded, fully synthetic 91-day organisation. Each vendor keeps its native
// row shape; insights are derived from those rows, never from a blended feed.
import contract from "./contract.json";
import { DEMO_ORGANIZATIONS } from "@/demo/organizations";

export const SCENARIO_SEED = 20261025;
export const SCENARIO_RUN_ID = "synthetic-scenario-2026-10-25";
export const SCENARIO_PROVENANCE = "synthetic" as const;
const START_UTC = Date.UTC(2026, 6, 27); // Monday 27 July 2026
export const SCENARIO_DAYS = 91; // through Sunday 25 October 2026, inclusive
const DAY_MS = 86_400_000;

export type ToolId = "copilot" | "claude" | "chatgpt" | "cursor";
export type Task = "Coding" | "Writing & drafting" | "Research & analysis" | "Meetings & email";
type CopilotApp = "Teams" | "Outlook" | "Word" | "PowerPoint" | "Excel" | "Copilot Chat";

export const scenarioTools: readonly { id: ToolId; name: string; cadence: "daily" | "monthly"; source: string }[] = [
    { id: "copilot", name: "Microsoft 365 Copilot", cadence: "daily", source: "Scenario usage and credits extension (Microsoft source deferred in contract v1)" },
    { id: "claude", name: "Claude", cadence: "daily", source: "anthropic_enterprise_users and anthropic_grouped_cost shapes" },
    { id: "chatgpt", name: "ChatGPT / Codex", cadence: "monthly", source: "chatgpt_workspace_csv shape, monthly period-only rows" },
    { id: "cursor", name: "Cursor", cadence: "daily", source: "cursor_daily_usage shape; spend is a scenario extension" },
];
export const toolName = (id: ToolId) => scenarioTools.find(t => t.id === id)!.name;
export const tasks: readonly Task[] = ["Coding", "Writing & drafting", "Research & analysis", "Meetings & email"];

export const taskMapping: readonly { tool: ToolId; native: string; task: Task }[] = [
    { tool: "copilot", native: "Teams, Outlook", task: "Meetings & email" },
    { tool: "copilot", native: "Word, PowerPoint", task: "Writing & drafting" },
    { tool: "copilot", native: "Excel, Copilot Chat", task: "Research & analysis" },
    { tool: "claude", native: "chat", task: "Writing & drafting" },
    { tool: "claude", native: "cowork", task: "Research & analysis" },
    { tool: "claude", native: "claude_code", task: "Coding" },
    { tool: "chatgpt", native: "ChatGPT seat: plain and Canvas messages", task: "Writing & drafting" },
    { tool: "chatgpt", native: "ChatGPT seat: Search and Data analysis tool messages", task: "Research & analysis" },
    { tool: "chatgpt", native: "Codex seat", task: "Coding" },
    { tool: "cursor", native: "cursor", task: "Coding" },
];

const vendorPropensities: Record<string, [number, number, number]> = {
    Engineering: [0.72, 0.35, 0.7],
    Operations: [0.2, 0.3, 0.08],
    Research: [0.55, 0.5, 0.4],
    "Customer Success": [0.2, 0.6, 0.05],
};
const coders = new Set(["Engineering", "Research"]);
const firstNames = ["Avery", "Blake", "Casey", "Devon", "Emery", "Finley", "Harper", "Jordan", "Kendall", "Logan", "Morgan", "Parker", "Quinn", "Riley", "Rowan", "Sage", "Skyler", "Taylor", "Reese", "Sasha"];
const lastNames = ["Ashdown", "Brightwell", "Calloway", "Dunmore", "Ellery", "Fairbank", "Glenholm", "Hartwell", "Ingleby", "Kingsley", "Lockridge", "Merriweather", "Northcott", "Oakhurst", "Pemberton", "Ravenscroft", "Stanbury", "Thornbury", "Wexford", "Yardley"];

export interface ScenarioPerson { person_id: string; display_name: string; email: string; department: string; business_unit: string }
export interface ScenarioIdentity { person_id: string; m365_user_id: string; claude_user_id: string | null; chatgpt_public_id: string | null; cursor_user_id: string | null; match: "scenario_assigned" }
export interface CopilotDailyRow { reportDate: string; userId: string; isActive: true; appActions: Partial<Record<CopilotApp, number>>; copilotCredits: string }
export interface ClaudeUserDay {
    day: string;
    user: { type: "user"; id: string; email_address: string };
    chat_metrics?: { message_count: number };
    cowork_metrics?: { distinct_session_count: number; message_count: number };
    claude_code_metrics?: { core_metrics: { distinct_session_count: number; commit_count: number; pull_request_count: number; lines_of_code: { added_count: number; removed_count: number } } };
}
export interface ClaudeCostRow { starting_at: string; ending_at: string; group: { actor: { type: "user_actor"; user_id: string; email_address: string }; product: string; model: string }; cost: { amount: string; currency: "USD" } }
export interface ChatGptCsvRow { cadence: "monthly"; period_start: string; period_end: string; account_id: string; public_id: string; email: string; is_active: "true" | "false"; seat_type: "ChatGPT" | "Codex"; messages: string; gpt_messages: string; tool_messages: string; project_messages: string; model_to_messages: string; tool_to_messages: string }
export interface CursorDailyRow { userId: string; day: string; email: string; isActive: boolean; totalLinesAdded: number; totalLinesDeleted: number; acceptedLinesAdded: number; acceptedLinesDeleted: number; totalTabsShown: number; totalTabsAccepted: number; chatRequests: number; agentRequests: number; composerRequests: number; mostUsedModel?: string }
export interface CursorSpendCycle { subscriptionCycleStart: string; cycleEnd: string; teamMemberSpend: { userId: string; email: string; spendCents: number; fastPremiumRequests: number }[] }
export interface SeatChargeRow { period_start: string; period_end: string; seat_type: "ChatGPT" | "Codex"; seats: number; amount: string; currency: "USD"; basis: "scenario_seat_charge" }

export interface ScenarioMonth { id: string; label: string; start: number; end: number; days: number; toDate: boolean }
export interface ScenarioWeek { id: string; label: string; start: number; end: number }

export interface ScenarioData {
    run_id: string; seed: number; provenance: typeof SCENARIO_PROVENANCE;
    people: ScenarioPerson[]; identities: ScenarioIdentity[];
    copilotDaily: CopilotDailyRow[]; claudeUsers: ClaudeUserDay[]; claudeCost: ClaudeCostRow[];
    chatgptCsv: ChatGptCsvRow[]; chatgptSeatCharges: SeatChargeRow[];
    cursorDaily: CursorDailyRow[]; cursorSpend: CursorSpendCycle[];
}

export const dayIso = (day: number) => new Date(START_UTC + day * DAY_MS).toISOString().slice(0, 10);
const dayOf = (iso: string) => Math.round((Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) - START_UTC) / DAY_MS);
// Daily rows before 1 August belong to no complete or to-date month, so monthly views leave them out.
export const scenarioMonths: readonly ScenarioMonth[] = [
    { id: "2026-08", label: "Aug 2026", start: 5, end: 35, days: 31, toDate: false },
    { id: "2026-09", label: "Sep 2026", start: 36, end: 65, days: 30, toDate: false },
    { id: "2026-10", label: "Oct 1-25, 2026", start: 66, end: 90, days: 25, toDate: true },
];
export const latestMonth = scenarioMonths[scenarioMonths.length - 1];
export const scenarioWeeks: readonly ScenarioWeek[] = Array.from({ length: 13 }, (_, k) => ({ id: dayIso(k * 7), label: `w/c ${dayIso(k * 7)}`, start: k * 7, end: k * 7 + 6 }));
export const scenarioRange = `${dayIso(0)} to ${dayIso(SCENARIO_DAYS - 1)} (inclusive dates)`;

function mulberry32(seed: number) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function weighted<T extends string>(rand: () => number, options: readonly [T, number][]): T {
    let roll = rand() * options.reduce((sum, [, w]) => sum + w, 0);
    for (const [value, w] of options) if ((roll -= w) < 0) return value;
    return options[options.length - 1][0];
}

const pad = (n: number) => String(n).padStart(3, "0");
const cents = (milliCents: number) => (milliCents / 1000).toFixed(3);
const usd = (milliCents: number) => milliCents / 100_000;
const ILLUSTRATIVE_SEAT_CENTS: Record<"ChatGPT" | "Codex", number> = { ChatGPT: 3000, Codex: 3000 };
const CURSOR_SEAT_CENTS = 4000;

export function generateScenario(seed = SCENARIO_SEED): ScenarioData {
    const rand = mulberry32(seed);
    const int = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));
    const people: ScenarioPerson[] = [];
    const identities: ScenarioIdentity[] = [];
    const copilotDaily: CopilotDailyRow[] = [];
    const claudeUsers: ClaudeUserDay[] = [];
    const claudeCost: ClaudeCostRow[] = [];
    const chatgptCsv: ChatGptCsvRow[] = [];
    const cursorDaily: CursorDailyRow[] = [];
    const cursorUsage = new Map<string, { email: string; agent: number[] }>();
    const chatgptSeats: { seat: "ChatGPT" | "Codex"; from: number; to: number }[] = [];

    let n = 0;
    for (const organization of DEMO_ORGANIZATIONS) {
        const { name: department, seats: count, seatsInUse } = organization;
        const business_unit = department;
        const [pClaude, pChatgpt, pCursor] = vendorPropensities[department];
        for (let i = 0; i < count; i++) {
            n++;
            const id = pad(n);
            const email = `person-${id}@example.invalid`;
            const person: ScenarioPerson = { person_id: `syn-person-${id}`, display_name: `${firstNames[(n - 1) % firstNames.length]} ${lastNames[Math.floor((n - 1) / firstNames.length)]}`, email, department, business_unit };
            people.push(person);
            const coder = coders.has(department);
            // Enrolment day, daily propensity on working days and an optional stop day.
            const plan = (p: number, early: boolean) => {
                if (rand() >= p) return null;
                const from = early && rand() < 0.8 ? 0 : Math.floor(rand() ** 2 * 70);
                const to = rand() < 0.07 ? int(from + 10, SCENARIO_DAYS - 1) : SCENARIO_DAYS - 1;
                return { from, to: Math.min(to, SCENARIO_DAYS - 1), intensity: 0.25 + rand() * 0.6 };
            };
            const copilot = i < seatsInUse ? plan(1, true) : null;
            const claude = plan(pClaude, false);
            const chatgpt = plan(pChatgpt, false);
            const cursor = plan(pCursor, false);
            const active = (span: { from: number; to: number; intensity: number } | null, day: number) => {
                if (!span || day < span.from || day > span.to) return false;
                const weekend = day % 7 >= 5;
                return rand() < (weekend ? span.intensity * 0.08 : span.intensity);
            };
            identities.push({
                person_id: person.person_id, m365_user_id: `syn-m365-${id}`,
                claude_user_id: claude ? `syn-claude-${id}` : null,
                chatgpt_public_id: chatgpt ? `syn-chatgpt-${id}` : null,
                cursor_user_id: cursor ? `syn-cursor-${id}` : null,
                match: "scenario_assigned",
            });
            const appWeights: [CopilotApp, number][] = coder
                ? [["Teams", 3], ["Outlook", 2], ["Word", 1], ["PowerPoint", 0.5], ["Excel", 1.5], ["Copilot Chat", 3]]
                : [["Teams", 3], ["Outlook", 3], ["Word", 2], ["PowerPoint", 1], ["Excel", 1.5], ["Copilot Chat", 2]];
            const seat: "ChatGPT" | "Codex" = coder && rand() < 0.4 ? "Codex" : "ChatGPT";
            const acceptRate = 0.25 + rand() * 0.2;
            const lineAccept = 0.45 + rand() * 0.25;
            const chatgptDays = scenarioMonths.map(() => 0);
            const cursorAgent = scenarioMonths.map(() => 0);

            for (let day = 0; day < SCENARIO_DAYS; day++) {
                const date = dayIso(day);
                if (active(copilot, day) || (copilot && day === copilot.from)) {
                    const appActions: Partial<Record<CopilotApp, number>> = {};
                    for (let k = int(1, 3); k > 0; k--) {
                        const app = weighted(rand, appWeights);
                        appActions[app] = (appActions[app] ?? 0) + int(1, 6);
                    }
                    const actions = Object.values(appActions).reduce((s, v) => s + (v ?? 0), 0);
                    copilotDaily.push({ reportDate: date, userId: `syn-m365-${id}`, isActive: true, appActions, copilotCredits: (Math.round(actions * (3 + rand() * 4)) / 10).toFixed(1) });
                }
                if (active(claude, day)) {
                    const row: ClaudeUserDay = { day: date, user: { type: "user", id: `syn-claude-${id}`, email_address: email } };
                    const useCode = coder ? rand() < 0.7 : rand() < 0.02;
                    const useCowork = rand() < (coder ? 0.25 : 0.4);
                    const useChat = rand() < (coder ? 0.55 : 0.9) || (!useCode && !useCowork);
                    const charge = (product: string, model: string, milliCents: number) => claudeCost.push({
                        starting_at: `${date}T00:00:00Z`, ending_at: `${dayIso(day + 1)}T00:00:00Z`,
                        group: { actor: { type: "user_actor", user_id: row.user.id, email_address: email }, product, model },
                        cost: { amount: cents(milliCents), currency: "USD" },
                    });
                    if (useChat) {
                        const messages = int(3, 25);
                        row.chat_metrics = { message_count: messages };
                        charge("chat", weighted(rand, [["Sonnet-class", 60], ["Haiku-class", 25], ["Opus-class", 15]]), messages * int(1500, 4500));
                    }
                    if (useCowork) {
                        const messages = int(2, 15);
                        row.cowork_metrics = { distinct_session_count: int(1, 3), message_count: messages };
                        charge("cowork", weighted(rand, [["Sonnet-class", 80], ["Opus-class", 20]]), messages * int(4000, 9000));
                    }
                    if (useCode) {
                        const sessions = int(1, 4);
                        const added = int(20, 420);
                        row.claude_code_metrics = { core_metrics: { distinct_session_count: sessions, commit_count: int(0, 3), pull_request_count: rand() < 0.25 ? 1 : 0, lines_of_code: { added_count: added, removed_count: int(5, Math.max(6, Math.round(added / 3))) } } };
                        charge("claude_code", weighted(rand, [["Sonnet-class", 70], ["Opus-class", 30]]), sessions * int(60_000, 180_000) + added * 300);
                    }
                    claudeUsers.push(row);
                }
                if (active(chatgpt, day)) {
                    const m = scenarioMonths.findIndex(mo => day >= mo.start && day <= mo.end);
                    if (m >= 0) chatgptDays[m]++;
                }
                if (cursor && day >= cursor.from && day <= cursor.to && day % 7 < 5) {
                    const on = active(cursor, day);
                    const shown = on ? int(20, 200) : 0;
                    const added = on ? int(50, 800) : 0;
                    const agent = on ? int(0, 15) : 0;
                    cursorDaily.push({
                        userId: `syn-cursor-${id}`, day: date, email, isActive: on,
                        totalLinesAdded: added, totalLinesDeleted: on ? int(5, Math.round(added / 3) + 5) : 0,
                        acceptedLinesAdded: Math.round(added * lineAccept), acceptedLinesDeleted: on ? int(0, 30) : 0,
                        totalTabsShown: shown, totalTabsAccepted: Math.round(shown * acceptRate),
                        chatRequests: on ? int(0, 10) : 0, agentRequests: agent, composerRequests: on ? int(0, 5) : 0,
                        ...(on ? { mostUsedModel: weighted(rand, [["Auto", 45], ["Claude-class", 35], ["GPT-class", 20]]) } : {}),
                    });
                    const m = scenarioMonths.findIndex(mo => day >= mo.start && day <= mo.end);
                    if (m >= 0) cursorAgent[m] += agent;
                }
            }

            if (chatgpt) {
                chatgptSeats.push({ seat, from: chatgpt.from, to: chatgpt.to });
                scenarioMonths.forEach((mo, m) => {
                    if (chatgpt.from > mo.end || chatgpt.to < mo.start) return;
                    const d = chatgptDays[m];
                    const messages = d * int(4, 18);
                    const tool = Math.round(messages * (0.1 + rand() * 0.15));
                    const search = Math.round(tool * 0.6);
                    const analysis = tool - search;
                    const canvas = seat === "ChatGPT" ? Math.round(messages * 0.08) : 0;
                    const models = seat === "Codex"
                        ? { "Codex-class": Math.round(messages * 0.8), "GPT flagship": messages - Math.round(messages * 0.8) }
                        : { "GPT flagship": Math.round(messages * 0.55), "GPT mini": Math.round(messages * 0.25), "Reasoning-class": messages - Math.round(messages * 0.55) - Math.round(messages * 0.25) };
                    chatgptCsv.push({
                        cadence: "monthly", period_start: dayIso(mo.start), period_end: dayIso(mo.end), account_id: "syn-workspace",
                        public_id: `syn-chatgpt-${id}`, email, is_active: d > 0 ? "true" : "false", seat_type: seat,
                        messages: String(messages), gpt_messages: String(Math.round(messages * 0.2)), tool_messages: String(tool),
                        project_messages: String(Math.round(messages * 0.1)),
                        model_to_messages: JSON.stringify(Object.fromEntries(Object.entries(models).filter(([, v]) => v > 0))),
                        tool_to_messages: JSON.stringify(Object.fromEntries(Object.entries({ Search: search, "Data analysis": analysis, Canvas: canvas }).filter(([, v]) => v > 0))),
                    });
                });
            }
            if (cursor) cursorUsage.set(`syn-cursor-${id}`, { email, agent: cursorAgent.map((a, m) => (cursor.from > scenarioMonths[m].end || cursor.to < scenarioMonths[m].start ? -1 : a)) });
        }
    }

    // Seat charges accrue per enrolled day in this scenario, so to-date months stay comparable.
    const chatgptSeatCharges: SeatChargeRow[] = scenarioMonths.flatMap(mo => (["ChatGPT", "Codex"] as const).map(seatType => {
        const seats = chatgptSeats.filter(s => s.seat === seatType && s.from <= mo.end && s.to >= mo.start);
        const milli = seats.reduce((sum, s) => sum + Math.round((ILLUSTRATIVE_SEAT_CENTS[seatType] * 1000 * (Math.min(s.to, mo.end) - Math.max(s.from, mo.start) + 1)) / 31), 0);
        return { period_start: dayIso(mo.start), period_end: dayIso(mo.end), seat_type: seatType, seats: seats.length, amount: cents(milli), currency: "USD" as const, basis: "scenario_seat_charge" as const };
    })).filter(r => r.seats > 0);
    const cursorSpend: CursorSpendCycle[] = scenarioMonths.map((mo, m) => ({
        subscriptionCycleStart: dayIso(mo.start), cycleEnd: dayIso(mo.end),
        teamMemberSpend: [...cursorUsage].filter(([, u]) => u.agent[m] >= 0).map(([userId, u]) => ({
            userId, email: u.email, fastPremiumRequests: u.agent[m],
            spendCents: Math.round((CURSOR_SEAT_CENTS * mo.days) / 31) + u.agent[m] * 4,
        })),
    }));

    return { run_id: SCENARIO_RUN_ID, seed, provenance: SCENARIO_PROVENANCE, people, identities, copilotDaily, claudeUsers, claudeCost, chatgptCsv, chatgptSeatCharges, cursorDaily, cursorSpend };
}

export interface ScenarioObservation {
    contract_version: string; provenance: typeof SCENARIO_PROVENANCE; run_id: string;
    source_id: string; product: string; metric: string; unit: string; native_unit: string; native_value: string; value: string;
    period: { start: string; end: string; boundary: "exclusive_end" | "inclusive_dates"; cadence: "daily" | "source_range" | "monthly" };
    identity_key: string; dimensions: Record<string, string>; cost_basis: string | null; currency: string | null; source_row: number;
}

/** Contract v1 observations for the three v1 adapters. Copilot, Cursor spend and seat charges stay scenario extensions. */
export function scenarioObservations(data: ScenarioData = getScenario()): ScenarioObservation[] {
    const out: ScenarioObservation[] = [];
    const unitOf = (metric: string) => (contract.metric_definitions as Record<string, { unit: string }>)[metric].unit;
    const push = (o: Omit<ScenarioObservation, "contract_version" | "provenance" | "run_id" | "unit" | "value" | "cost_basis" | "currency"> & Partial<Pick<ScenarioObservation, "value" | "cost_basis" | "currency">>) =>
        out.push({ contract_version: contract.contract_version, provenance: SCENARIO_PROVENANCE, run_id: data.run_id, unit: unitOf(o.metric), value: o.value ?? o.native_value, cost_basis: o.cost_basis ?? null, currency: o.currency ?? null, ...o });
    data.claudeUsers.forEach((r, i) => {
        const period = { start: `${r.day}T00:00:00Z`, end: `${dayIso(dayOf(r.day) + 1)}T00:00:00Z`, boundary: "exclusive_end" as const, cadence: "daily" as const };
        const base = { source_id: "scenario-claude-engagement", identity_key: r.user.id, dimensions: {}, period, source_row: i + 1 };
        if (r.chat_metrics) push({ ...base, product: "chat", metric: "messages", native_unit: "messages", native_value: String(r.chat_metrics.message_count) });
        if (r.cowork_metrics) {
            push({ ...base, product: "cowork", metric: "sessions", native_unit: "sessions", native_value: String(r.cowork_metrics.distinct_session_count) });
            push({ ...base, product: "cowork", metric: "messages", native_unit: "messages", native_value: String(r.cowork_metrics.message_count) });
        }
        const code = r.claude_code_metrics?.core_metrics;
        if (code) {
            const metrics: [string, number][] = [["sessions", code.distinct_session_count], ["commits", code.commit_count], ["pull_requests", code.pull_request_count], ["lines_added", code.lines_of_code.added_count], ["lines_removed", code.lines_of_code.removed_count]];
            for (const [metric, v] of metrics) push({ ...base, product: "claude_code", metric, native_unit: unitOf(metric), native_value: String(v) });
        }
    });
    data.claudeCost.forEach((r, i) => push({
        source_id: "scenario-claude-cost", product: r.group.product, metric: "reported_charge", native_unit: "cents", native_value: r.cost.amount,
        value: (Number(r.cost.amount) / 100).toFixed(5).replace(/0+$/, "").replace(/\.$/, ""), cost_basis: "reported_charge", currency: r.cost.currency,
        period: { start: r.starting_at, end: r.ending_at, boundary: "exclusive_end", cadence: "source_range" },
        identity_key: r.group.actor.user_id, dimensions: { model: r.group.model }, source_row: i + 1,
    }));
    data.chatgptCsv.forEach((r, i) => {
        const base = { source_id: "scenario-chatgpt-users", product: r.seat_type, identity_key: r.public_id, dimensions: {}, source_row: i + 1, period: { start: r.period_start, end: r.period_end, boundary: "inclusive_dates" as const, cadence: "monthly" as const } };
        push({ ...base, metric: "is_active", native_unit: "boolean", native_value: r.is_active });
        for (const metric of ["messages", "gpt_messages", "tool_messages", "project_messages"] as const) push({ ...base, metric, native_unit: "messages", native_value: r[metric] });
    });
    data.cursorDaily.forEach((r, i) => {
        const base = { source_id: "scenario-cursor-daily", product: "cursor", identity_key: r.userId, dimensions: (r.mostUsedModel ? { model: r.mostUsedModel } : {}) as Record<string, string>, source_row: i + 1, period: { start: `${r.day}T00:00:00Z`, end: `${dayIso(dayOf(r.day) + 1)}T00:00:00Z`, boundary: "exclusive_end" as const, cadence: "daily" as const } };
        push({ ...base, metric: "is_active", native_unit: "boolean", native_value: String(r.isActive) });
        const metrics: [string, number][] = [["lines_added", r.totalLinesAdded], ["lines_removed", r.totalLinesDeleted], ["accepted_lines_added", r.acceptedLinesAdded], ["accepted_lines_removed", r.acceptedLinesDeleted], ["tabs_shown", r.totalTabsShown], ["tabs_accepted", r.totalTabsAccepted], ["chat_requests", r.chatRequests], ["agent_requests", r.agentRequests], ["composer_requests", r.composerRequests]];
        for (const [metric, v] of metrics) push({ ...base, metric, native_unit: unitOf(metric), native_value: String(v) });
    });
    return out;
}

let cached: ScenarioData | undefined;
export function getScenario(): ScenarioData {
    return (cached ??= generateScenario());
}

// ---- Insights. Every figure is computed inside one tool and one period; nothing crosses periods. ----

export interface ScenarioInsights {
    population: number;
    weeklyActive: { Week: string; Tool: string; Users: number }[];
    monthlyReach: { Month: string; Tool: string; Users: number; Reach: number }[];
    spend: { Month: string; Tool: string; USD: number; Basis: string; Active: number; PerActive: number | null }[];
    copilotCredits: { Month: string; Credits: number; Active: number; PerActive: number | null }[];
    topModels: { Tool: string; Model: string; Value: number; Unit: string }[];
    codingWeekly: { Week: string; Tool: string; Lines: number }[];
    coding: {
        claude: { sessions: number; linesAdded: number; linesRemoved: number; commits: number; pullRequests: number; activeCoders: number };
        cursor: { linesAdded: number; acceptedLinesAdded: number; tabsShown: number; tabsAccepted: number; agentRequests: number; activeCoders: number };
    };
    departmentHeat: { Department: string; Tool: string; Reach: number; Active: number; Headcount: number }[];
    toolCounts: { Tools: string; People: number }[];
    copilotPlus: { Pair: string; People: number }[];
    multiToolPeople: number;
    taskMix: { Task: Task; Tool: string; People: number }[];
    leaders: { name: string; department: string; tools: ToolId[]; activeDays: number; copilotDays: number; claudeDays: number; cursorDays: number; chatgptActive: boolean }[];
}

function addTo<K>(map: Map<K, Set<string>>, key: K, person: string) {
    let set = map.get(key);
    if (!set) map.set(key, (set = new Set()));
    set.add(person);
}

let cachedInsights: ScenarioInsights | undefined;
export function getScenarioInsights(): ScenarioInsights {
    return (cachedInsights ??= buildInsights(getScenario()));
}

export function buildInsights(data: ScenarioData): ScenarioInsights {
    const byNative = new Map<string, string>();
    for (const i of data.identities) {
        byNative.set(i.m365_user_id, i.person_id);
        if (i.claude_user_id) byNative.set(i.claude_user_id, i.person_id);
        if (i.chatgpt_public_id) byNative.set(i.chatgpt_public_id, i.person_id);
        if (i.cursor_user_id) byNative.set(i.cursor_user_id, i.person_id);
    }
    const personOf = (nativeId: string) => byNative.get(nativeId)!;
    const people = new Map(data.people.map(p => [p.person_id, p]));
    const monthOf = (day: number) => scenarioMonths.find(m => day >= m.start && day <= m.end);
    const weekOf = (day: number) => scenarioWeeks[Math.floor(day / 7)];
    const L = latestMonth;
    const inLatest = (day: number) => day >= L.start && day <= L.end;

    const weekly = new Map<string, Set<string>>();
    const monthly = new Map<string, Set<string>>();
    const latestDays = new Map<ToolId, Map<string, Set<number>>>(scenarioTools.map(t => [t.id, new Map()]));
    const latestTask = new Map<string, Set<string>>();
    const credits = new Map<string, number>();
    const codingWeekly = new Map<string, number>();
    const models = new Map<string, number>();
    const dailyActivity = (tool: ToolId, person: string, day: number) => {
        addTo(weekly, `${weekOf(day).id}|${tool}`, person);
        const m = monthOf(day);
        if (m) addTo(monthly, `${m.id}|${tool}`, person);
        if (inLatest(day)) {
            const map = latestDays.get(tool)!;
            if (!map.has(person)) map.set(person, new Set());
            map.get(person)!.add(day);
        }
    };

    for (const r of data.copilotDaily) {
        const day = dayOf(r.reportDate), person = personOf(r.userId);
        dailyActivity("copilot", person, day);
        const m = monthOf(day);
        if (m) credits.set(m.id, (credits.get(m.id) ?? 0) + Math.round(Number(r.copilotCredits) * 10));
        if (inLatest(day)) for (const app of Object.keys(r.appActions) as CopilotApp[]) {
            const task: Task = app === "Teams" || app === "Outlook" ? "Meetings & email" : app === "Word" || app === "PowerPoint" ? "Writing & drafting" : "Research & analysis";
            addTo(latestTask, `${task}|copilot`, person);
        }
    }
    const claude = { sessions: 0, linesAdded: 0, linesRemoved: 0, commits: 0, pullRequests: 0, coders: new Set<string>() };
    for (const r of data.claudeUsers) {
        const day = dayOf(r.day), person = personOf(r.user.id);
        dailyActivity("claude", person, day);
        const code = r.claude_code_metrics?.core_metrics;
        if (code) codingWeekly.set(`${weekOf(day).id}|Claude Code`, (codingWeekly.get(`${weekOf(day).id}|Claude Code`) ?? 0) + code.lines_of_code.added_count);
        if (inLatest(day)) {
            if (r.chat_metrics) addTo(latestTask, "Writing & drafting|claude", person);
            if (r.cowork_metrics) addTo(latestTask, "Research & analysis|claude", person);
            if (code) {
                addTo(latestTask, "Coding|claude", person);
                claude.sessions += code.distinct_session_count; claude.linesAdded += code.lines_of_code.added_count; claude.linesRemoved += code.lines_of_code.removed_count;
                claude.commits += code.commit_count; claude.pullRequests += code.pull_request_count; claude.coders.add(person);
            }
        }
    }
    const cursor = { linesAdded: 0, acceptedLinesAdded: 0, tabsShown: 0, tabsAccepted: 0, agentRequests: 0, coders: new Set<string>() };
    for (const r of data.cursorDaily) {
        if (!r.isActive) continue;
        const day = dayOf(r.day), person = personOf(r.userId);
        dailyActivity("cursor", person, day);
        codingWeekly.set(`${weekOf(day).id}|Cursor`, (codingWeekly.get(`${weekOf(day).id}|Cursor`) ?? 0) + r.totalLinesAdded);
        if (inLatest(day)) {
            addTo(latestTask, "Coding|cursor", person);
            cursor.linesAdded += r.totalLinesAdded; cursor.acceptedLinesAdded += r.acceptedLinesAdded; cursor.tabsShown += r.totalTabsShown;
            cursor.tabsAccepted += r.totalTabsAccepted; cursor.agentRequests += r.agentRequests; cursor.coders.add(person);
            if (r.mostUsedModel) models.set(`Cursor|${r.mostUsedModel}`, (models.get(`Cursor|${r.mostUsedModel}`) ?? 0) + 1);
        }
    }
    const chatgptLatest = new Set<string>();
    for (const r of data.chatgptCsv) {
        if (r.is_active !== "true") continue;
        const m = scenarioMonths.find(mo => dayIso(mo.start) === r.period_start && dayIso(mo.end) === r.period_end)!;
        const person = personOf(r.public_id);
        addTo(monthly, `${m.id}|chatgpt`, person);
        if (m === L) {
            chatgptLatest.add(person);
            const toolMsgs = JSON.parse(r.tool_to_messages) as Record<string, number>;
            if (r.seat_type === "Codex") addTo(latestTask, "Coding|chatgpt", person);
            else {
                addTo(latestTask, "Writing & drafting|chatgpt", person);
                if (toolMsgs.Search || toolMsgs["Data analysis"]) addTo(latestTask, "Research & analysis|chatgpt", person);
            }
            for (const [model, v] of Object.entries(JSON.parse(r.model_to_messages) as Record<string, number>)) models.set(`ChatGPT / Codex|${model}`, (models.get(`ChatGPT / Codex|${model}`) ?? 0) + v);
        }
    }
    const claudeMilli = new Map<string, number>();
    for (const r of data.claudeCost) {
        const day = dayOf(r.starting_at), m = monthOf(day);
        const milli = Math.round(Number(r.cost.amount) * 1000);
        if (m) claudeMilli.set(m.id, (claudeMilli.get(m.id) ?? 0) + milli);
        if (inLatest(day)) models.set(`Claude|${r.group.model}`, (models.get(`Claude|${r.group.model}`) ?? 0) + milli);
    }

    const active = (month: string, tool: ToolId) => monthly.get(`${month}|${tool}`)?.size ?? 0;
    const spend: ScenarioInsights["spend"] = scenarioMonths.flatMap(m => {
        const rows: [ToolId, number, string][] = [
            ["claude", usd(claudeMilli.get(m.id) ?? 0), "Scenario-reported usage charge"],
            ["chatgpt", data.chatgptSeatCharges.filter(c => c.period_start === dayIso(m.start)).reduce((s, c) => s + usd(Math.round(Number(c.amount) * 1000)), 0), "Scenario seat charge (illustrative price)"],
            ["cursor", data.cursorSpend.find(c => c.subscriptionCycleStart === dayIso(m.start))!.teamMemberSpend.reduce((s, u) => s + u.spendCents, 0) / 100, "Scenario-reported seat and usage charge"],
        ];
        return rows.map(([tool, amount, Basis]) => {
            const n = active(m.id, tool);
            return { Month: m.label, Tool: toolName(tool), USD: Math.round(amount * 100) / 100, Basis, Active: n, PerActive: n ? Math.round((amount / n) * 100) / 100 : null };
        });
    });
    const copilotCredits = scenarioMonths.map(m => {
        const total = (credits.get(m.id) ?? 0) / 10, n = active(m.id, "copilot");
        return { Month: m.label, Credits: total, Active: n, PerActive: n ? Math.round((total / n) * 10) / 10 : null };
    });

    const latestPeople = new Map<ToolId, Set<string>>(scenarioTools.map(t => [t.id, t.id === "chatgpt" ? chatgptLatest : new Set(latestDays.get(t.id)!.keys())]));
    const toolsByPerson = new Map<string, ToolId[]>();
    for (const t of scenarioTools) for (const p of latestPeople.get(t.id)!) toolsByPerson.set(p, [...(toolsByPerson.get(p) ?? []), t.id]);
    const counts = [1, 2, 3, 4].map(k => ({ Tools: k === 1 ? "1 tool" : `${k} tools`, People: [...toolsByPerson.values()].filter(t => t.length === k).length }));
    const copilotUsers = latestPeople.get("copilot")!;
    const copilotPlus = (["claude", "chatgpt", "cursor"] as const).map(t => ({ Pair: `Copilot + ${toolName(t)}`, People: [...latestPeople.get(t)!].filter(p => copilotUsers.has(p)).length }));

    const headcount = new Map<string, number>();
    for (const p of data.people) headcount.set(p.department, (headcount.get(p.department) ?? 0) + 1);
    const departmentHeat = [...headcount.keys()].flatMap(department => scenarioTools.map(t => {
        const n = [...latestPeople.get(t.id)!].filter(p => people.get(p)!.department === department).length;
        const h = headcount.get(department)!;
        return { Department: department, Tool: t.name, Reach: Math.round((n / h) * 1000) / 1000, Active: n, Headcount: h };
    }));

    const topModels = [...models].map(([key, Value]) => {
        const [Tool, Model] = key.split("|");
        return { Tool, Model, Value: Tool === "Claude" ? usd(Value) : Value, Unit: Tool === "Claude" ? "USD charge" : Tool === "Cursor" ? "most-used-model days" : "messages" };
    }).sort((a, b) => a.Tool.localeCompare(b.Tool) || b.Value - a.Value);

    const leaders = [...toolsByPerson].map(([person, tools]) => {
        const days = (t: ToolId) => latestDays.get(t)!.get(person) ?? new Set<number>();
        const union = new Set([...days("copilot"), ...days("claude"), ...days("cursor")]);
        const p = people.get(person)!;
        return { name: p.display_name, department: p.department, tools, activeDays: union.size, copilotDays: days("copilot").size, claudeDays: days("claude").size, cursorDays: days("cursor").size, chatgptActive: chatgptLatest.has(person) };
    }).sort((a, b) => b.tools.length - a.tools.length || b.activeDays - a.activeDays || a.name.localeCompare(b.name)).slice(0, 10);

    return {
        population: data.people.length,
        weeklyActive: scenarioWeeks.flatMap(w => scenarioTools.filter(t => t.cadence === "daily").map(t => ({ Week: w.id, Tool: t.name, Users: weekly.get(`${w.id}|${t.id}`)?.size ?? 0 }))),
        monthlyReach: scenarioMonths.flatMap(m => scenarioTools.map(t => ({ Month: m.label, Tool: t.name, Users: active(m.id, t.id), Reach: Math.round((active(m.id, t.id) / data.people.length) * 1000) / 1000 }))),
        spend, copilotCredits, topModels,
        codingWeekly: scenarioWeeks.flatMap(w => ["Claude Code", "Cursor"].map(Tool => ({ Week: w.id, Tool, Lines: codingWeekly.get(`${w.id}|${Tool}`) ?? 0 }))),
        coding: {
            claude: { sessions: claude.sessions, linesAdded: claude.linesAdded, linesRemoved: claude.linesRemoved, commits: claude.commits, pullRequests: claude.pullRequests, activeCoders: claude.coders.size },
            cursor: { linesAdded: cursor.linesAdded, acceptedLinesAdded: cursor.acceptedLinesAdded, tabsShown: cursor.tabsShown, tabsAccepted: cursor.tabsAccepted, agentRequests: cursor.agentRequests, activeCoders: cursor.coders.size },
        },
        departmentHeat,
        toolCounts: counts,
        copilotPlus,
        multiToolPeople: [...toolsByPerson.values()].filter(t => t.length > 1).length,
        taskMix: tasks.flatMap(task => scenarioTools.map(t => ({ Task: task, Tool: t.name, People: latestTask.get(`${task}|${t.id}`)?.size ?? 0 }))),
        leaders,
    };
}
