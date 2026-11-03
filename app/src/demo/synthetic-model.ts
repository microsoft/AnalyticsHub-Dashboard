import type { CachedQueryResult } from "@microsoft/fabric-app-data";
import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { DEFAULT_HOURLY_RATE } from "@/hooks/value-assumptions.context";

type DemoQueryTable = Extract<CachedQueryResult, { status: "success" }>["table"];

const DATE_START = "2026-05-04";
const DATE_END = "2026-11-02";
const WINDOW_WEEKS = 26;
const EXECUTIVE_ORGANIZATIONS = [
    { name: "Engineering", seats: 88, seatsInUse: 64, people: 52, hours: 51, valueHours: 43, habitPct: 0.62 },
    { name: "Operations", seats: 74, seatsInUse: 54, people: 48, hours: 44, valueHours: 37, habitPct: 0.56 },
    { name: "Research", seats: 62, seatsInUse: 45, people: 45, hours: 38, valueHours: 32, habitPct: 0.58 },
    { name: "Customer Success", seats: 54, seatsInUse: 35, people: 42, hours: 32, valueHours: 26, habitPct: 0.51 },
] as const;
const ORGANIZATIONS = EXECUTIVE_ORGANIZATIONS.map(({ name }) => name);
const TASKS = ["Document summaries", "Meeting follow-ups", "Data analysis", "Drafting"];
const VALUE_TASK_GROUPS = ["Drafting", "Data analysis", "Meeting follow-ups", "Document summaries"];
const VALUE_TASK_FIXTURE = [
    { group: "Drafting", hours: 42, tasks: ["Email drafts", "Document drafts"] },
    { group: "Data analysis", hours: 36, tasks: ["Spreadsheet analysis", "Research synthesis"] },
    { group: "Meeting follow-ups", hours: 32, tasks: ["Action items", "Follow-up messages"] },
    { group: "Document summaries", hours: 28, tasks: ["Meeting notes", "Document summaries"] },
] as const;
const AGENTS = ["Knowledge Assistant", "Meeting Companion", "Research Helper"];
const ACTIVITIES = ["Copilot", "Agents", "Cowork"];
const PRODUCTS = ["Teams", "Outlook", "Word", "Excel"];
const HABITS = ["Power", "Habitual", "Developing", "Beginner"] as const;
const SHADOW_TOOLS = ["Research Assistant", "Writing Helper", "Code Companion"] as const;
const SHADOW_LAYERS = ["Ran", "Network", "Installed", "Cloud Discovery"] as const;
const SHADOW_PROBES = ["device_activity", "installed", "agents", "cloud_discovery"] as const;
const EVALUATION_OUTCOMES = ["Resolved", "Escalated by design", "Escalated after an error", "Abandoned"] as const;
const ROLLUP_FLAGS = ["[Is Grand Total]", "[Is Group Total]"];
const DEMO_RESULT_COUNT = 8;
const EXECUTIVE_HOURS = { Conservative: 156, Typical: 165, Optimistic: 176 } as const;
const VALUE_SCENARIO_FACTORS = { Conservative: 0.75, Typical: 1, Optimistic: 1.25 } as const;
const MONTHLY_EXECUTIVE_FIXTURE = [
    { month: "2026-05-01", hours: 19, tasks: 700, feedback: 42 },
    { month: "2026-06-01", hours: 26, tasks: 900, feedback: 48 },
    { month: "2026-07-01", hours: 27, tasks: 930, feedback: 50 },
    { month: "2026-08-01", hours: 25, tasks: 940, feedback: 51 },
    { month: "2026-09-01", hours: 26, tasks: 980, feedback: 54 },
    { month: "2026-10-01", hours: 24, tasks: 1020, feedback: 57 },
    { month: "2026-11-01", hours: 18, tasks: 1082, feedback: 58 },
] as const;

/** Produces a deterministic, local-only query result from its output schema and current DAX filters. */
export function syntheticQueryResult(query: string, metadata?: ColumnMetadataMap): CachedQueryResult {
    const columns = queryColumns(query, metadata);
    const parts = [...query.matchAll(/"Part"\s*,\s*"([^"]+)"/g)]
        .map((match) => match[1])
        .filter((part, index, all) => all.indexOf(part) === index);
    if (parts.length > 0 && !columns.includes("[Part]")) columns.push("[Part]");
    const rows = specialRows(query, columns) ?? genericRows(query, columns);
    const table: DemoQueryTable = {
        columns: columns.map((name, columnIndex) => ({
            name,
            dataType: columnDataType(rows, columnIndex),
        })),
        rows,
    };
    return { status: "success", table, requestId: `demo-${hash(query).toString(16)}`, fromCache: false };
}

function columnDataType(rows: readonly (readonly unknown[])[], index: number): string {
    const value = rows.find((row) => row[index] !== null && row[index] !== undefined)?.[index];
    if (typeof value === "number") return "Double";
    if (typeof value === "boolean") return "Boolean";
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value)) return "DateTime";
    return "String";
}

function queryColumns(query: string, metadata?: ColumnMetadataMap): string[] {
    const declared = Object.keys(metadata ?? {});
    if (declared.length > 0) return declared;
    if (query.includes('"Cardinality"') && query.includes('"Max Length"'))
        return ["[Column]", "[Cardinality]", "[Max Length]"];
    if (query.includes('"Kind"') && query.includes('"Value"'))
        return query.includes('"Sort"') ? ["[Kind]", "[Value]", "[Sort]"] : ["[Kind]", "[Value]"];
    if (query.includes('"Attribute"')) return ["[Attribute]"];
    if (query.includes('"Value"')) return ["[Value]"];

    const withoutComments = query
        .replace(/\/\/[^\r\n]*/g, "")
        .replace(/^[ \t]*--[^\r\n]*/gm, "")
        .replace(/\/\*[\s\S]*?\*\//g, "");
    const selectColumns = [...withoutComments.matchAll(/\bSELECTCOLUMNS\s*\(/gi)].at(-1);
    if (selectColumns?.index !== undefined) {
        const open = withoutComments.indexOf("(", selectColumns.index);
        const args = splitDaxArguments(withoutComments, open + 1);
        const aliases = args.slice(1).filter((_, index) => index % 2 === 0)
            .map((argument) => /^"((?:[^"]|"")*)"$/.exec(argument.trim())?.[1].replace(/""/g, '"'))
            .filter((name): name is string => name !== undefined);
        if (aliases.length > 0) return aliases.map((name) => name.startsWith("[") ? name : `[${name}]`);
    }
    const lastRow = [...withoutComments.matchAll(/\bROW\s*\(/gi)].at(-1);
    if (!lastRow || lastRow.index === undefined) return summarizeColumns(withoutComments);
    const aliases = [...withoutComments.slice(lastRow.index).matchAll(/"([^"]+)"\s*,/g)]
        .map((match) => match[1])
        .filter((name, index, all) => all.indexOf(name) === index);
    const rowColumns = aliases.map((name) => name.startsWith("[") ? name : `[${name}]`);
    if (rowColumns.length > 0) return rowColumns;
    return summarizeColumns(withoutComments);
}

function summarizeColumns(query: string): string[] {
    const call = /\bSUMMARIZECOLUMNS\s*\(/i.exec(query);
    if (!call || call.index === undefined) return [];
    const open = query.indexOf("(", call.index);
    const args = splitDaxArguments(query, open + 1);
    const columns: string[] = [];
    let measures = false;
    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index].trim();
        const groupBy = /^(?:'([^']+)'|([A-Za-z_][\w ]*))\[([^\]]+)\]$/.exec(argument);
        if (!measures && groupBy) {
            columns.push(`${groupBy[1] ?? groupBy[2]}[${groupBy[3]}]`);
            continue;
        }
        const alias = /^"((?:[^"]|"")*)"$/.exec(argument);
        if (alias) {
            measures = true;
            columns.push(`[${alias[1].replace(/""/g, '"')}]`);
        }
    }
    return columns;
}

function splitDaxArguments(query: string, start: number): string[] {
    const args: string[] = [];
    let depth = 0;
    let inString = false;
    let argumentStart = start;
    for (let index = start; index < query.length; index += 1) {
        const character = query[index];
        if (character === '"') {
            if (inString && query[index + 1] === '"') {
                index += 1;
            } else {
                inString = !inString;
            }
        } else if (!inString && character === "(") {
            depth += 1;
        } else if (!inString && character === ")") {
            if (depth === 0) {
                args.push(query.slice(argumentStart, index));
                return args;
            }
            depth -= 1;
        } else if (!inString && character === "," && depth === 0) {
            args.push(query.slice(argumentStart, index));
            argumentStart = index + 1;
        }
    }
    return [];
}

function specialRows(query: string, columns: readonly string[]): unknown[][] | undefined {
    const parts = [...query.matchAll(/"Part"\s*,\s*"([^"]+)"/g)]
        .map((match) => match[1])
        .filter((part, index, all) => all.indexOf(part) === index);
    if (parts.length > 0 && columns.includes("[Part]")) {
        const seed = hash(query);
        const scale = 0.9 + (seed % 21) / 100;
        return parts.flatMap((part) =>
            Array.from({ length: 6 }, (_, rowIndex) =>
                columns.map((column) =>
                    column === "[Part]" ? part : sampleValue(query, column, rowIndex, scale, seed),
                ),
            ),
        );
    }
    if (["[Hours]", "[Tasks]", "[People]", "[Licensed Seats]", "[Seats In Use]", "[Seats In Use Pct]"]
        .every((column) => columns.includes(column))) {
        return executiveSummaryRows(query, columns);
    }
    if (["[Hours Conservative]", "[Hours Optimistic]"].every((column) => columns.includes(column))) {
        return executiveHoursRangeRows(query, columns);
    }
    if (["[Month Start]", "[Copilot Hours]", "[Agent Hours]", "[Cowork Hours]"]
        .every((column) => columns.includes(column))) {
        return executiveMonthsRows(query, columns);
    }
    if (columns.some((column) => /organization/i.test(column)) &&
        ["[Licensed Seats]", "[Seats In Use Pct]", "[Habit Pct]", "[Hours]", "[People]", "[Hours Per Seat Month]"]
            .every((column) => columns.includes(column))) {
        return executiveDepartmentRows(query, columns);
    }
    if (["[Expert Equivalent Hours Per Week]", "[AI Assisted Value]", "[Projected Annualised Value]", "[AI Assisted Value Per Week]"]
        .every((column) => columns.includes(column))) {
        return valueSummaryRows(query, columns);
    }
    if (columns.some((column) => /organization/i.test(column)) &&
        ["[Active Users]", "[Expert Equivalent Hours Per Week]", "[AI Assisted Value]"]
            .every((column) => columns.includes(column))) {
        return organizationValueRows(query, columns);
    }
    if (["[Month]", "[Cohort]", "[People]", "[Hours]", "[Count]", "[Cumulative]", "[Total]"]
        .every((column) => columns.includes(column))) {
        return valueByHabitRows(query, columns);
    }
    if (["[Count]", "[Cumulative]", "[People]", "[Total]"].every((column) => columns.includes(column))) {
        return leaderboardConcentrationRows(columns);
    }
    if (columns.includes("[Is Grand Total]") && columns.includes("[Is Group Total]")) {
        if (["[Activity Share]", "[Expert Equivalent Hours Per Week]", "[AI Assisted Value Per Week]"]
            .every((column) => columns.includes(column))) {
            return valueTaskRows(query, columns);
        }
        const rows = rollupRows(query, columns);
        if (rows) return rows;
    }
    if (["[Dimension]", "[Category]", "[Tasks]", "[Share]"].every((column) => columns.includes(column))) {
        return taskBreakdownRows(query, columns);
    }
    if (["[Lens]", "[Category]", "[All Tasks]"].every((column) => columns.includes(column))) {
        return surfaceUsageRows(query, columns);
    }
    if (["[Source]", "[Licence]", "[Scenario]", "[Hours]", "[Value]"].every((column) => columns.includes(column))) {
        return costValueSourceRows(columns);
    }
    if (["[Agent]", "[Sessions]", "[Hours]", "[Value]"].every((column) => columns.includes(column))) {
        return costValueAgentRows(columns);
    }
    if (["[Product]", "[Credits]", "[Cost]", "[Cost Basis]", "[Coverage]"].every((column) => columns.includes(column))) {
        return consumptionProductRows(columns);
    }
    if (columns.includes("[Licensed Active]") && columns.includes("[Licensed Inactive]")) {
        return activationRows(query, columns);
    }
    if ([
        "[All Tasks]",
        "[Licensed Tasks]",
        "[Unlicensed Tasks]",
        "[Agent Tasks]",
        "[All Users]",
        "[Licensed Users]",
        "[Unlicensed Users]",
        "[Agent Users]",
        "[All Rate]",
        "[Licensed Rate]",
        "[Unlicensed Rate]",
        "[Agent Rate]",
        "[Licensed Utilisation]",
    ].every((column) => columns.includes(column))) {
        return workSummaryRows(columns);
    }
    if (["[Grounded Rate]", "[Knowledge Gap Rate]", "[Turns Per Conversation]", "[Friction Read]", "[Top Fix]"]
        .every((column) => columns.includes(column))) {
        return evaluationConversationSummaryRows(query, columns);
    }
    if (["[Theme]", "[Outcome]", "[Outcome Order]", "[Conversations]"].every((column) => columns.includes(column))) {
        return evaluationThemeRows(query, columns);
    }
    if ([
        "Agent Performance[Topic Theme]",
        "Agent Performance[Topic (resolved)]",
        "[Is Grand Total]",
        "[Is Group Total]",
        "[Resolved]",
        "[Failing]",
        "[Friction]",
        "[Knowledge Gaps]",
        "[Turns To Resolve]",
        "[CSAT]",
    ].every((column) => columns.includes(column))) {
        return evaluationTopicRows(columns);
    }
    if (["[Comment]", "[Verdict]", "[Times]"].every((column) => columns.includes(column))) {
        return evaluationCommentRows(columns);
    }
    if (["[Archetype]", "[Conversations]"].every((column) => columns.includes(column))) {
        return evaluationArchetypeRows(columns);
    }
    if (["[Source]", "[Citations]"].every((column) => columns.includes(column))) {
        return evaluationKnowledgeSourceRows(columns);
    }
    if (["[Month]", "[Cohort]", "[Cohort Order]", "[Licensed]", "[Unlicensed]"]
        .every((column) => columns.includes(column))) {
        return habitLicenceRows(columns);
    }
    if (["[Month]", "[Power]", "[Habitual]", "[Developing]", "[Beginner]", "[Inactive]"]
        .every((column) => columns.includes(column))) {
        return habitSummaryRows(query, columns);
    }
    if (columns.includes("[Probe]") && columns.includes("[Status]") && columns.includes("[Run At]")) {
        return shadowStatusRows(columns);
    }
    if (["[Tool]", "[Layer]", "[Posture]", "[Devices]", "[Users]"].every((column) => columns.includes(column))) {
        return shadowToolRows(columns);
    }
    if (columns.includes("[Verdict Performance]") && columns.includes("[Conversations]")) {
        return evaluationSummaryRows(query, columns);
    }
    if (leaderboardSummaryPrefix(columns)) {
        return leaderboardSummaryRows(query, columns);
    }
    if (["[Week Start]", "[Outcome]", "[Outcome Order]", "[Conversations]"]
        .every((column) => columns.includes(column))) {
        return evaluationWeeklyRows(columns);
    }
    if (["[Group]", "[Conversations]", "[People]", "[Resolution Rate]", "[CSAT]"]
        .every((column) => columns.includes(column))) {
        return evaluationGroupRows(columns);
    }
    if (["[Error Code]", "[Source]", "[Errors]"].every((column) => columns.includes(column))) {
        return evaluationErrorRows(columns);
    }
    if (columns.includes("[Kind]") && columns.includes("[Value]")) {
        return [
            ["agentType", "Declarative", 0],
            ["agentType", "Custom engine", 0],
            ["agentName", AGENTS[0], 0],
            ["agentName", AGENTS[1], 0],
            ...ACTIVITIES.map((value, index) => ["activity", value, index + 1]),
            ["firstDate", DATE_START, 0],
            ["lastDate", DATE_END, 0],
            ["people", "180", 180],
            ["First date", DATE_START, 0],
            ["Last date", DATE_END, 0],
            ...ORGANIZATIONS.map((value, index) => ["Department", value, 42 - index * 3]),
            ...AGENTS.map((value, index) => ["Agent", value, 24 - index * 3]),
            ...["agent", "theme", "topic", "department"].map((value, index) => ["Group by", value, 24 - index * 2]),
        ].map((row) => columns.map((column) =>
            column === "[Kind]" ? row[0] : column === "[Sort]" ? row[2] ?? 0 : row[1],
        ));
    }
    if (columns.includes("[Column]") && columns.includes("[Cardinality]")) {
        const rows = [
            ["Organization", 4, 24],
            ["Department", 4, 24],
            ["Region", 3, 16],
        ];
        return rows.map((row) => columns.map((column) => row[column === "[Column]" ? 0 : column === "[Cardinality]" ? 1 : 2]));
    }
    if (columns.length === 1 && columns[0] === "[Value]") {
        return ORGANIZATIONS.map((value) => [value]);
    }
    return undefined;
}

interface DemoDateRange {
    from: string;
    to: string;
}

function queryDateRange(query: string): DemoDateRange | undefined {
    const match = /'Calendar'\[Date\]\s*>=\s*DATE\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)\s*&&\s*'Calendar'\[Date\]\s*<=\s*DATE\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/i.exec(query);
    const requested = match
        ? {
              from: `${match[1]}-${String(match[2]).padStart(2, "0")}-${String(match[3]).padStart(2, "0")}`,
              to: `${match[4]}-${String(match[5]).padStart(2, "0")}-${String(match[6]).padStart(2, "0")}`,
          }
        : { from: DATE_START, to: DATE_END };
    const from = requested.from > DATE_START ? requested.from : DATE_START;
    const to = requested.to < DATE_END ? requested.to : DATE_END;
    return from <= to ? { from, to } : undefined;
}

function weeksInQuery(query: string): number {
    const range = queryDateRange(query);
    if (!range) return 0;
    const days = Math.floor((Date.parse(`${range.to}T00:00:00Z`) - Date.parse(`${range.from}T00:00:00Z`)) / 86_400_000) + 1;
    return Math.min(WINDOW_WEEKS, Math.max(1, Math.ceil(days / 7)));
}

type DemoOrganization = (typeof EXECUTIVE_ORGANIZATIONS)[number];

function selectedOrganizations(query: string): DemoOrganization[] {
    const filter = /TREATAS\s*\(\s*\{([^}]*)\}\s*,\s*'Chat \+ Agent Org Data'\[Organization\]\s*\)/i.exec(query);
    if (!filter) return [...EXECUTIVE_ORGANIZATIONS];
    const literals = new Set(
        [...filter[1].matchAll(/"((?:[^"]|"")*)"/g)].map((match) => match[1].replace(/""/g, '"')),
    );
    return EXECUTIVE_ORGANIZATIONS.filter((organization) => literals.has(organization.name));
}

function scenarioInQuery(query: string): keyof typeof VALUE_SCENARIO_FACTORS {
    const scenario = /TREATAS\s*\(\s*\{\s*"(Conservative|Typical|Optimistic)"\s*\}\s*,\s*'Effort Scenario'\[Scenario\]\s*\)/i.exec(query)?.[1];
    return scenario === "Conservative" || scenario === "Optimistic" ? scenario : "Typical";
}

function hourlyRateInQuery(query: string): number {
    const rate = /TREATAS\s*\(\s*\{\s*(-?\d+(?:\.\d+)?)\s*\}\s*,\s*'Hourly Value'\[Hourly Value\]\s*\)/i.exec(query)?.[1];
    const value = rate === undefined ? DEFAULT_HOURLY_RATE : Number(rate);
    return Number.isFinite(value) && value >= 0 ? value : DEFAULT_HOURLY_RATE;
}

function round2(value: number): number {
    return Math.round(value * 100) / 100;
}

function executiveSummaryRows(query: string, columns: readonly string[]): unknown[][] {
    const organizations = selectedOrganizations(query);
    const seats = organizations.reduce<number>((sum, organization) => sum + organization.seats, 0);
    const seatsInUse = organizations.reduce<number>((sum, organization) => sum + organization.seatsInUse, 0);
    const people = organizations.reduce<number>((sum, organization) => sum + organization.people, 0);
    const hours = organizations.reduce<number>((sum, organization) => sum + organization.hours, 0);
    const weeks = weeksInQuery(query);
    const values: Record<string, unknown> = {
        "[Hours]": round2(hours * weeks / WINDOW_WEEKS),
        "[Tasks]": Math.round(6552 * people / 187 * weeks / WINDOW_WEEKS),
        "[People]": people,
        "[Weeks]": weeks,
        "[Skills Available]": 47,
        "[Licensed Seats]": seats,
        "[Seats In Use]": seatsInUse,
        "[Seats In Use Pct]": seats > 0 ? seatsInUse / seats : 0,
        "[Unlicensed Users]": 61,
        "[Habit Month]": "2026-10-01",
        "[Habitual Pct]": 0.42,
        "[Power Pct]": 0.21,
        "[Agent Users]": 42,
        "[Agent Hours]": round2(54 * hours / 165 * weeks / WINDOW_WEEKS),
        "[Agents In Use]": 9,
        "[Satisfaction]": 0.84,
        "[Feedback]": Math.round(360 * people / 187 * weeks / WINDOW_WEEKS),
        "[People With Organization]": people,
    };
    return [columns.map((column) => values[column] ?? null)];
}

function executiveHoursRangeRows(query: string, columns: readonly string[]): unknown[][] {
    const organizations = selectedOrganizations(query);
    const selectedHours = organizations.reduce<number>((sum, organization) => sum + organization.hours, 0);
    const weeks = weeksInQuery(query);
    const share = selectedHours / EXECUTIVE_HOURS.Typical * weeks / WINDOW_WEEKS;
    const values: Record<string, unknown> = {
        "[Hours Conservative]": round2(EXECUTIVE_HOURS.Conservative * share),
        "[Hours Optimistic]": round2(EXECUTIVE_HOURS.Optimistic * share),
    };
    return [columns.map((column) => values[column] ?? null)];
}

function executiveDepartmentRows(query: string, columns: readonly string[]): unknown[][] {
    const organizations = selectedOrganizations(query);
    const range = queryDateRange(query);
    const weeks = weeksInQuery(query);
    const days = range
        ? Math.floor((Date.parse(`${range.to}T00:00:00Z`) - Date.parse(`${range.from}T00:00:00Z`)) / 86_400_000) + 1
        : 0;
    const months = days / (365.25 / 12);
    const organizationColumn = columns.find((column) => /organization/i.test(column));
    if (!organizationColumn || months <= 0) return [];
    return organizations.map((organization) => {
        const values: Record<string, unknown> = {
            [organizationColumn]: organization.name,
            "[Licensed Seats]": organization.seats,
            "[Seats In Use Pct]": organization.seatsInUse / organization.seats,
            "[Habit Pct]": organization.habitPct,
            "[Hours]": round2(organization.hours * weeks / WINDOW_WEEKS),
            "[People]": organization.people,
            "[Hours Per Seat Month]": round2(organization.hours * weeks / WINDOW_WEEKS / organization.seats / months),
        };
        return columns.map((column) => values[column] ?? null);
    });
}

function executiveMonthsRows(query: string, columns: readonly string[]): unknown[][] {
    const organizations = selectedOrganizations(query);
    const orgHours = organizations.reduce<number>((sum, organization) => sum + organization.hours, 0);
    const orgPeople = organizations.reduce<number>((sum, organization) => sum + organization.people, 0);
    const orgSeats = organizations.reduce<number>((sum, organization) => sum + organization.seats, 0);
    const orgSeatsInUse = organizations.reduce<number>((sum, organization) => sum + organization.seatsInUse, 0);
    const range = queryDateRange(query);
    const weeks = weeksInQuery(query);
    const months = range
        ? MONTHLY_EXECUTIVE_FIXTURE.filter(({ month }) => {
              const nextMonth = new Date(`${month}T00:00:00Z`);
              nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
              const monthEnd = nextMonth.toISOString().slice(0, 10);
              return month <= range.to && monthEnd > range.from;
          })
        : [];
    const monthHours = months.reduce<number>((sum, month) => sum + month.hours, 0);
    const monthTasks = months.reduce<number>((sum, month) => sum + month.tasks, 0);
    const targetHours = orgHours * weeks / WINDOW_WEEKS;
    const targetTasks = 6552 * orgPeople / 187 * weeks / WINDOW_WEEKS;
    const scaleHours = monthHours > 0 ? targetHours / monthHours : 0;
    const scaleTasks = monthTasks > 0 ? targetTasks / monthTasks : 0;
    const monthCount = months.length;
    return months.map((month, index) => {
        const hours = round2(month.hours * scaleHours);
        const tasks = Math.round(month.tasks * scaleTasks);
        const values: Record<string, unknown> = {
            "[Month Start]": month.month,
            "[Copilot Hours]": round2(hours * 0.65),
            "[Agent Hours]": round2(hours * 0.25),
            "[Cowork Hours]": round2(hours - round2(hours * 0.65) - round2(hours * 0.25)),
            "[Hours]": hours,
            "[Tasks]": tasks,
            "[Seats In Use Pct]": orgSeats > 0 ? orgSeatsInUse / orgSeats : 0,
            "[Habit Pct]": 0.48 + index * 0.015,
            "[Satisfaction]": 0.82 + index * 0.01,
            "[Feedback]": monthCount > 0 ? Math.round(360 * orgPeople / 187 * weeks / WINDOW_WEEKS / monthCount) : 0,
        };
        return columns.map((column) => values[column] ?? null);
    });
}

function organizationValueRows(query: string, columns: readonly string[]): unknown[][] {
    const organizations = selectedOrganizations(query);
    const scenarioFactor = VALUE_SCENARIO_FACTORS[scenarioInQuery(query)];
    const hourlyRate = hourlyRateInQuery(query);
    const organizationColumn = columns.find((column) => /organization/i.test(column));
    if (!organizationColumn) return [];
    return organizations.map((organization) => {
        const hours = round2(organization.valueHours * scenarioFactor);
        const values: Record<string, unknown> = {
            [organizationColumn]: organization.name,
            "[Active Users]": organization.people,
            "[Expert Equivalent Hours Per Week]": hours,
            "[AI Assisted Value]": round2(hours * hourlyRate),
        };
        return columns.map((column) => values[column] ?? null);
    });
}

function valueSummaryRows(query: string, columns: readonly string[]): unknown[][] {
    const organizations = selectedOrganizations(query);
    const weeklyHours = organizations.reduce<number>((sum, organization) => sum + organization.valueHours, 0)
        * VALUE_SCENARIO_FACTORS[scenarioInQuery(query)];
    const hourlyRate = hourlyRateInQuery(query);
    const weeklyValue = round2(weeklyHours * hourlyRate);
    const values: Record<string, unknown> = {
        "[Expert Equivalent Hours Per Week]": round2(weeklyHours),
        "[AI Assisted Value]": round2(weeklyValue * weeksInQuery(query)),
        "[Projected Annualised Value]": round2(weeklyValue * 52),
        "[AI Assisted Value Per Week]": weeklyValue,
        "[Currency Symbol]": "$",
    };
    return [columns.map((column) => values[column] ?? null)];
}

function valueByHabitRows(query: string, columns: readonly string[]): unknown[][] {
    const scale = 0.9 + (hash(query) % 21) / 100;
    const basePeople = [12, 18, 24, 30].map((value) => Math.max(3, Math.round(value * scale)));
    const baseHours = [180, 200, 220, 160].map((value) => Math.round(value * scale * 100) / 100);
    const people = basePeople.reduce((sum, count) => sum + count, 0);
    const total = baseHours.reduce((sum, hours) => sum + hours, 0);
    const values = Array.from({ length: people }, (_, index) =>
        ((people - index) / ((people * (people + 1)) / 2)) * total,
    );
    const cumulative: number[] = [];
    values.forEach((value, index) => {
        cumulative[index] = (cumulative[index - 1] ?? 0) + value;
    });
    cumulative[people - 1] = total;
    const cohorts = HABITS.map((habit, index) => ({
        month: "2026-10-01",
        habit,
        people: basePeople[index],
        hours: baseHours[index],
    }));
    const rows = [
        ...cohorts.map((cohort) => ({
            "[Month]": cohort.month,
            "[Cohort]": cohort.habit,
            "[People]": cohort.people,
            "[Hours]": cohort.hours,
            "[Count]": null,
            "[Cumulative]": null,
            "[Total]": null,
        })),
        ...cumulative.map((sum, index) => ({
            "[Month]": "2026-10-01",
            "[Cohort]": null,
            "[People]": people,
            "[Hours]": null,
            "[Count]": index + 1,
            "[Cumulative]": sum,
            "[Total]": total,
        })),
    ];
    return rows.map((row) => columns.map((column) => row[column as keyof typeof row] ?? null));
}

function leaderboardConcentrationRows(columns: readonly string[]): unknown[][] {
    const people = 180;
    const total = 9000;
    const cuts = [
        [2, 610],
        [9, 1850],
        [45, 5050],
    ];
    return cuts.map(([count, cumulative]) => {
        const row: Record<string, unknown> = {
            "[Count]": count,
            "[Cumulative]": cumulative,
            "[People]": people,
            "[Total]": total,
        };
        return columns.map((column) => row[column]);
    });
}

type LeaderboardPrefix = "All" | "Licensed" | "Unlicensed" | "Agent" | "Cowork";

function leaderboardSummaryPrefix(columns: readonly string[]): LeaderboardPrefix | undefined {
    return (["All", "Licensed", "Unlicensed", "Agent", "Cowork"] as const).find((prefix) =>
        columns.includes(`[${prefix} Users]`) && columns.includes(`[${prefix} Sessions]`),
    );
}

function leaderboardSummaryRows(query: string, columns: readonly string[]): unknown[][] {
    const prefix = leaderboardSummaryPrefix(columns);
    if (!prefix) return [];
    const scale = 0.9 + (hash(query) % 21) / 100;
    const base = {
        All: { users: 180, sessions: 3200 },
        Licensed: { users: 126, sessions: 2600 },
        Unlicensed: { users: 54, sessions: 600 },
        Agent: { users: 96, sessions: 1700 },
        Cowork: { users: 42, sessions: 850 },
    }[prefix];
    const users = Math.max(1, Math.round(base.users * scale));
    const sessions = Math.max(1, Math.round(base.sessions * scale));
    const values: Record<string, unknown> = {
        [`[${prefix} Users]`]: users,
        [`[${prefix} Sessions]`]: sessions,
        [`[${prefix} Per User]`]: sessions / users,
        [`[${prefix} Per Week]`]: sessions / users / 26,
        "[Licence Utilisation]": 0.72,
        "[Unlicensed Tasks]": 420,
        "[Agent Tasks]": 1680,
        "[Cowork Tasks]": 840,
    };
    return [columns.map((column) => values[column] ?? null)];
}

function valueTaskRows(query: string, columns: readonly string[]): unknown[][] {
    const totalHours = VALUE_TASK_FIXTURE.reduce<number>((sum, group) => sum + group.hours, 0);
    const selectedHours = selectedOrganizations(query).reduce<number>((sum, organization) => sum + organization.valueHours, 0);
    const scale = VALUE_SCENARIO_FACTORS[scenarioInQuery(query)] * selectedHours / totalHours;
    const hourlyRate = hourlyRateInQuery(query);
    const groupColumn = columns.find((column) => /task breakdown group/i.test(column));
    const leafColumn = columns.find((column) => /task breakdown category/i.test(column));
    if (!groupColumn || !leafColumn) return [];
    const row = (group: unknown, leaf: unknown, grand: boolean, subtotal: boolean, share: number, weekHours: number) => {
        const valuesByColumn: Record<string, unknown> = {
            [groupColumn]: group,
            [leafColumn]: leaf,
            "[Is Grand Total]": grand,
            "[Is Group Total]": subtotal,
            "[Activity Share]": share,
            "[Expert Equivalent Hours Per Week]": round2(weekHours),
            "[AI Assisted Value Per Week]": round2(weekHours * hourlyRate),
        };
        return columns.map((column) => valuesByColumn[column] ?? null);
    };
    const rows = VALUE_TASK_FIXTURE.flatMap(({ group, hours, tasks }) => {
        const split = [0.56, 0.44];
        const groupShare = hours / totalHours;
        const groupHours = hours * scale;
        const leaves = tasks.map((leaf, leafIndex) =>
            row(group, leaf, false, false, groupShare * split[leafIndex], groupHours * split[leafIndex]),
        );
        return [...leaves, row(group, null, false, true, groupShare, groupHours)];
    });
    rows.push(row(null, null, true, false, 1, totalHours * scale));
    return rows;
}

function surfaceUsageRows(query: string, columns: readonly string[]): unknown[][] {
    const scale = 0.9 + (hash(query) % 21) / 100;
    const indexes: Record<string, number> = {
        "[Lens]": 0,
        "[Category]": 1,
        "[All Tasks]": 2,
        "[Licensed Tasks]": 3,
        "[Unlicensed Tasks]": 4,
        "[Agent Tasks]": 5,
    };
    const rows = [
        ["Surface", "Teams", 1120, 760, 240, 120],
        ["Surface", "Outlook", 860, 590, 190, 80],
        ["Surface", "Word", 720, 480, 150, 90],
        ["Surface", "Excel", 510, 350, 105, 55],
        ["Model", "Advanced model", 980, 670, 210, 100],
        ["Model", "Balanced model", 870, 600, 180, 90],
        ["Model", "Fast model", 760, 510, 170, 80],
        ["Model", "Other models", 600, 400, 125, 75],
    ];
    return rows.map((row) => columns.map((column) => {
        const value = row[indexes[column]];
        return typeof value === "number" ? Math.round(value * scale) : value;
    }));
}

function taskBreakdownRows(query: string, columns: readonly string[]): unknown[][] {
    const dimensions = [
        { name: "Behaviour", categories: VALUE_TASK_GROUPS },
        { name: "Workflow action", categories: ["Draft", "Analyze", "Summarize", "Follow up"] },
        { name: "Value outcome", categories: ["Time saved", "Faster response", "Better decisions", "Improved quality"] },
    ];
    const shares = [0.34, 0.27, 0.22, 0.17];
    const scale = 0.9 + (hash(query) % 21) / 100;
    return dimensions.flatMap(({ name, categories }) =>
        categories.map((category, index) => {
            const values: Record<string, unknown> = {
                "[Dimension]": name,
                "[Category]": category,
                "[Tasks]": Math.round(6552 * shares[index] * scale),
                "[Share]": shares[index],
            };
            return columns.map((column) => values[column] ?? null);
        }),
    );
}

function costValueSourceRows(columns: readonly string[]): unknown[][] {
    const sources = [
        ["Copilot", "Licensed", 420, 320, 540],
        ["Copilot", "Unlicensed", 180, 140, 230],
        ["Agents", "Licensed", 240, 185, 310],
        ["Cowork", "Licensed", 160, 125, 210],
    ] as const;
    const scenarios = [
        ["Conservative", 0.75],
        ["Typical", 1],
        ["Optimistic", 1.25],
    ] as const;
    return sources.flatMap(([source, licence, baseHours]) =>
        scenarios.map(([scenario, multiplier]) => {
            const hours = Math.round(baseHours * multiplier * 100) / 100;
            const values: Record<string, unknown> = {
                "[Source]": source,
                "[Licence]": licence,
                "[Scenario]": scenario,
                "[Hours]": hours,
                "[Value]": hours * 50,
            };
            return columns.map((column) => values[column] ?? null);
        }),
    );
}

function costValueAgentRows(columns: readonly string[]): unknown[][] {
    return AGENTS.map((agent, index) => {
        const sessions = [320, 265, 210][index];
        const hours = [82, 67, 51][index];
        const values: Record<string, unknown> = {
            "[Agent]": agent,
            "[Sessions]": sessions,
            "[Hours]": hours,
            "[Value]": hours * 50,
        };
        return columns.map((column) => values[column] ?? null);
    });
}

function consumptionProductRows(columns: readonly string[]): unknown[][] {
    const products = [
        { name: "Cowork / Work IQ", sort: 1, credits: 48000, cost: 25.2, basis: "Credits at the saved rate" },
        { name: "Copilot Studio", sort: 2, credits: 2400000, cost: 1260, basis: "Prepaid and pay-as-you-go credits" },
        { name: "Azure AI Foundry", sort: 3, credits: 0, cost: 864.32, basis: "Azure bill in USD" },
    ];
    return products.map((product) => {
        const values: Record<string, unknown> = {
            "[Product]": product.name,
            "[Product Sort]": product.sort,
            "[Credits]": product.credits,
            "[Cost]": product.cost,
            "[Cost Basis]": product.basis,
            "[Coverage]": `Date span covered | source ${DATE_START} to ${DATE_END}`,
        };
        return columns.map((column) => values[column] ?? null);
    });
}

function rollupRows(query: string, columns: readonly string[]): unknown[][] | undefined {
    const groupColumn = columns.find((column) => /organization|apphost|task breakdown group/i.test(column));
    const leafColumn = columns.find((column) => /audit_userid|task breakdown category|behavior_enriched_full/i.test(column));
    if (!groupColumn || !leafColumn) return undefined;
    const taskCategory = /task breakdown group/i.test(groupColumn);
    const groups = taskCategory ? TASKS : /apphost/i.test(groupColumn) ? PRODUCTS : ORGANIZATIONS;
    const leaves = /audit_userid/i.test(leafColumn) ? ["Viewer 01", "Viewer 02", "Viewer 03"] : TASKS;
    const groupSize = Math.round(45 * (0.9 + (hash(query) % 21) / 100));
    const sessionsPerGroup = Math.round(800 * (0.9 + (hash(query) % 21) / 100));
    const leafShares = leaves.length === 3 ? [0.375, 0.3375, 0.2875] : [0.3, 0.28, 0.24, 0.18];
    const rows: unknown[][] = [];
    const makeRow = (group: unknown, leaf: unknown, grand: boolean, subtotal: boolean, users: number, sessions: number) =>
        columns.map((column) => {
            const name = column.toLowerCase();
            if (column === groupColumn) return group;
            if (column === leafColumn) return leaf;
            if (column === "[Is Grand Total]") return grand;
            if (column === "[Is Group Total]") return subtotal;
            if (/active users/.test(name)) return users;
            if (/sessions per user per week/.test(name)) return users > 0 ? sessions / users / 26 : 0;
            if (/sessions/.test(name)) return sessions;
            if (/total column/.test(name)) return sessions;
            return null;
        });
    for (const group of groups) {
        const leafSessions = leafShares.map((share) => Math.round(sessionsPerGroup * share));
        const adjustedSessions = leafSessions[2] + sessionsPerGroup - leafSessions.reduce((sum, value) => sum + value, 0);
        leafSessions[2] = adjustedSessions;
        leaves.forEach((leaf, index) =>
            rows.push(makeRow(group, leaf, false, false, Math.ceil(groupSize / leaves.length), leafSessions[index % leafSessions.length])),
        );
        rows.push(makeRow(group, null, false, true, groupSize, sessionsPerGroup));
    }
    rows.push(makeRow(null, null, true, false, groupSize * groups.length, sessionsPerGroup * groups.length));
    return rows;
}

function activationRows(query: string, columns: readonly string[]): unknown[][] {
    const scale = 0.9 + (hash(query) % 21) / 100;
    const organizations = ORGANIZATIONS;
    const distributions: Record<string, number[]> = {
        "[Licensed Active]": [36, 33, 31, 28],
        "[Licensed Inactive]": [20, 18, 17, 17],
        "[Unlicensed Active]": [12, 11, 10, 9],
        "[Unlicensed Inactive]": [16, 15, 14, 13],
        "[All Active]": [48, 44, 41, 37],
        "[All Inactive]": [36, 33, 31, 30],
        "[Agent Active]": [18, 17, 16, 15],
        "[Agent NotUsing]": [30, 27, 25, 22],
    };
    const totals: Record<string, number> = Object.fromEntries(
        Object.entries(distributions).map(([column, values]) => [column, Math.round(values.reduce((sum, value) => sum + value, 0) * scale)]),
    );
    totals["[Licensed Total]"] = totals["[Licensed Active]"] + totals["[Licensed Inactive]"];
    totals["[Unlicensed Total]"] = totals["[Unlicensed Active]"] + totals["[Unlicensed Inactive]"];
    totals["[All Total]"] = totals["[All Active]"] + totals["[All Inactive]"];
    const summary = !columns.some((column) => /organization/i.test(column));
    if (summary) {
        return [columns.map((column) => {
            if (column === "[Agent Active Pct]") return totals["[Agent Active]"] / totals["[All Active]"];
            if (column.endsWith("Pct]")) {
                const stem = column.replace(" Pct]", "");
                const active = totals[`${stem}]`] ?? 0;
                const cohort = stem.slice(1).split(" ")[0];
                const total = totals[`[${cohort} Total]`] ?? 0;
                return total > 0 ? active / total : 0;
            }
            return totals[column] ?? null;
        })];
    }
    return organizations.map((organization, index) => columns.map((column) => {
        if (/organization/i.test(column)) return organization;
        const values = distributions[column];
        return values ? Math.round(values[index] * scale) : null;
    }));
}

function habitLicenceRows(columns: readonly string[]): unknown[][] {
    const values = [
        ["Power", 1, 18, 2],
        ["Habitual", 2, 26, 4],
        ["Developing", 3, 21, 7],
        ["Beginner", 4, 12, 9],
    ];
    return values.map(([habit, order, licensed, unlicensed]) => {
        const row: Record<string, unknown> = {
            "[Month]": "2026-10-01",
            "[Cohort]": habit,
            "[Cohort Order]": order,
            "[Licensed]": licensed,
            "[Unlicensed]": unlicensed,
        };
        return columns.map((column) => row[column] ?? null);
    });
}

function habitSummaryRows(query: string, columns: readonly string[]): unknown[][] {
    const scale = 0.9 + (hash(query) % 21) / 100;
    const people = { Power: 12, Habitual: 28, Developing: 42, Beginner: 38, Inactive: 80 };
    const total = Object.values(people).reduce((sum, count) => sum + count, 0);
    return [columns.map((column) => {
        if (column === "[Month]") return "2026-10-01";
        const stage = column.match(/^\[(Power|Habitual|Developing|Beginner|Inactive)(?: Pct)?\]$/)?.[1];
        if (!stage) return null;
        const count = Math.round(people[stage as keyof typeof people] * scale);
        return column.endsWith("Pct]") ? count / Math.round(total * scale) : count;
    })];
}

function shadowStatusRows(columns: readonly string[]): unknown[][] {
    return SHADOW_PROBES.map((probe) => {
        const row: Record<string, unknown> = {
            "[Probe]": probe,
            "[Status]": "ok",
            "[Source]": "synthetic",
            "[Rows]": 18,
            "[Message]": "",
            "[Run At]": `${DATE_END}T12:00:00Z`,
        };
        return columns.map((column) => row[column] ?? null);
    });
}

function shadowToolRows(columns: readonly string[]): unknown[][] {
    return SHADOW_TOOLS.flatMap((tool, toolIndex) =>
        SHADOW_LAYERS.map((layer, layerIndex) => {
            const row: Record<string, unknown> = {
                "[Tool]": tool,
                "[Layer]": layer,
                "[Posture]": toolIndex === 0 ? "Unsanctioned" : "Not reviewed",
                "[Devices]": Math.max(1, 18 - toolIndex * 5 - layerIndex * 2),
                "[Users]": Math.max(1, 12 - toolIndex * 3 - layerIndex),
            };
            return columns.map((column) => row[column] ?? null);
        }),
    );
}

function evaluationSummaryRows(query: string, columns: readonly string[]): unknown[][] {
    const scale = 0.9 + (hash(query) % 21) / 100;
    const values: Record<string, unknown> = {
        "[Conversations]": Math.round(840 * scale),
        "[People]": Math.round(176 * scale),
        "[Conversations Per Person]": 4.77,
        "[Resolution Rate]": 0.72,
        "[Implied Success]": 0.86,
        "[True Failure Rate]": 0.07,
        "[Failing Conversations]": Math.round(59 * scale),
        "[Hours Lost]": Math.round(52 * scale),
        "[Unintended Escalation Rate]": 0.04,
        "[Intended Share]": 0.12,
        "[Abandonment Rate]": 0.09,
        "[CSAT]": 0.84,
        "[Thumbs Up]": Math.round(385 * scale),
        "[Thumbs Down]": Math.round(43 * scale),
        "[Error Rate]": 0.13,
        "[Median Response]": 3.2,
        "[Slow Replies]": 0.08,
        "[Reporting Window]": "4 May – 2 Nov 2026",
        "[Verdict Performance]": "Improving",
        "[Verdict Quality]": "Mostly resolved",
        "[Verdict Adoption]": "Growing steadily",
        "[Focus Agent]": AGENTS[1],
        "[Focus Knowledge]": "Policy and product guidance",
        "[Focus Give Up]": "Multi-step requests",
        "[Escalation Verdict]": "Most escalations are by design",
        "[Error Story]": "Failures cluster around a small set of recurring issues",
        "[Response Read]": "Most replies arrive quickly",
    };
    return [columns.map((column) => values[column] ?? null)];
}

function evaluationWeeklyRows(columns: readonly string[]): unknown[][] {
    const totals = [82, 88, 96, 101, 109, 117, 124, 132];
    const shares = [0.72, 0.1, 0.05, 0.13];
    return totals.flatMap((total, week) =>
        EVALUATION_OUTCOMES.map((outcome, outcomeIndex) => {
            const row: Record<string, unknown> = {
                "[Week Start]": new Date(Date.UTC(2026, 8, 7 + week * 7)).toISOString().slice(0, 10),
                "[Outcome]": outcome,
                "[Outcome Order]": outcomeIndex + 1,
                "[Conversations]": Math.round(total * shares[outcomeIndex]),
            };
            return columns.map((column) => row[column] ?? null);
        }),
    );
}

function evaluationGroupRows(columns: readonly string[]): unknown[][] {
    const metrics = [
        { group: AGENTS[0], conversations: 332, people: 74, resolution: 0.76, failure: 0.06, escalation: 0.03, abandon: 0.08, csat: 0.87, errors: 0.11, response: 2.8 },
        { group: AGENTS[1], conversations: 278, people: 59, resolution: 0.71, failure: 0.08, escalation: 0.04, abandon: 0.1, csat: 0.83, errors: 0.14, response: 3.4 },
        { group: AGENTS[2], conversations: 230, people: 43, resolution: 0.68, failure: 0.07, escalation: 0.05, abandon: 0.12, csat: 0.81, errors: 0.15, response: 3.7 },
    ];
    return metrics.map((metric) => {
        const values: Record<string, unknown> = {
            "[Group]": metric.group,
            "[Conversations]": metric.conversations,
            "[People]": metric.people,
            "[Resolution Rate]": metric.resolution,
            "[True Failure Rate]": metric.failure,
            "[Unintended Escalation Rate]": metric.escalation,
            "[Abandonment Rate]": metric.abandon,
            "[CSAT]": metric.csat,
            "[Error Rate]": metric.errors,
            "[Median Response]": metric.response,
        };
        return columns.map((column) => values[column] ?? null);
    });
}

function evaluationErrorRows(columns: readonly string[]): unknown[][] {
    const errors = [
        ["Service timeout", "System fault", 24],
        ["Missing context", "Agent fault", 19],
        ["Unsupported request", "User fault", 16],
        ["Knowledge gap", "Agent fault", 14],
        ["Dependency unavailable", "System fault", 11],
        ["Conversation cancelled", "User fault", 8],
        ["Policy check", "System fault", 6],
        ["Other", "User fault", 4],
    ];
    return errors.map(([error, source, count]) => {
        const values: Record<string, unknown> = { "[Error Code]": error, "[Source]": source, "[Errors]": count };
        return columns.map((column) => values[column] ?? null);
    });
}

function workSummaryRows(columns: readonly string[]): unknown[][] {
    const values: Record<string, unknown> = {
        "[All Tasks]": 6552,
        "[Licensed Tasks]": 4800,
        "[Unlicensed Tasks]": 1200,
        "[Agent Tasks]": 552,
        "[All Users]": 187,
        "[Licensed Users]": 126,
        "[Unlicensed Users]": 61,
        "[Agent Users]": 42,
        "[All Rate]": 6552 / 187,
        "[Licensed Rate]": 4800 / 126,
        "[Unlicensed Rate]": 1200 / 61,
        "[Agent Rate]": 552 / 42,
        "[Licensed Utilisation]": 0.76,
    };
    return [columns.map((column) => values[column] ?? null)];
}

function evaluationConversationSummaryRows(query: string, columns: readonly string[]): unknown[][] {
    const scale = 0.9 + (hash(query) % 21) / 100;
    const values: Record<string, unknown> = {
        "[Topics]": 8,
        "[Grounded Rate]": Math.min(0.82, 0.74 + (scale - 1) * 0.2),
        "[Answered From Knowledge]": Math.round(670 * scale),
        "[Citations]": Math.round(952 * scale),
        "[Knowledge Gap Rate]": Math.min(0.24, 0.18 + (scale - 1) * 0.1),
        "[Knowledge Gap Conversations]": Math.round(212 * scale),
        "[Turns Per Conversation]": Math.round(3.2 * scale * 100) / 100,
        "[Single Turn Rate]": Math.min(0.62, 0.56 + (scale - 1) * 0.15),
        "[Turns To Resolve]": Math.round(2.7 * scale * 100) / 100,
        "[Friction]": Math.round(35 * scale),
        "[Friction Read]": `${Math.round(35 * scale)}/100 · 🟡 Moderate`,
        "[Theme Verdict]": "72% resolved · 🟡 More coverage needed",
        "[Theme Coverage]": 0.82,
        "[Top Fix]": "Add coverage for common product-guidance questions.",
        "[Backlog Summary]": "Three recurring themes need clearer source coverage.",
        "[Topic Insight]": "Product guidance resolves more consistently than policy questions.",
        "[Knowledge Story]": "Product guides and policy references account for most cited answers.",
        "[Knowledge Gap Read]": "A small set of recurring questions accounts for most gaps.",
        "[Depth Read]": "Most conversations resolve within three turns.",
        "[Feedback Insight]": "Helpful summaries receive the most positive feedback.",
        "[CSAT Story]": "Satisfaction is strongest when answers include a cited source.",
    };
    return [columns.map((column) => values[column] ?? null)];
}

function evaluationThemeRows(query: string, columns: readonly string[]): unknown[][] {
    const themes = ["Information lookup", "Content creation", "Data analysis", "Meeting follow-up"];
    const outcomes = [
        { name: "Resolved", share: 0.72, order: 1 },
        { name: "Escalated by design", share: 0.12, order: 2 },
        { name: "Escalated after an error", share: 0.06, order: 3 },
        { name: "Abandoned", share: 0.1, order: 4 },
    ];
    const scale = 0.9 + (hash(query) % 21) / 100;
    return themes.flatMap((theme, themeIndex) => {
        const total = Math.round((250 - themeIndex * 32) * scale);
        return outcomes.map((outcome) => {
            const values: Record<string, unknown> = {
                "[Theme]": theme,
                "[Outcome]": outcome.name,
                "[Outcome Order]": outcome.order,
                "[Conversations]": Math.round(total * outcome.share),
            };
            return columns.map((column) => values[column] ?? null);
        });
    });
}

function evaluationTopicRows(columns: readonly string[]): unknown[][] {
    const topics = [
        { theme: "Information lookup", topic: "Product guidance", conversations: 240, resolved: 0.79, failing: 32, friction: 38, gaps: 18, turns: 2.8, csat: 0.86 },
        { theme: "Information lookup", topic: "Policy questions", conversations: 195, resolved: 0.74, failing: 29, friction: 44, gaps: 22, turns: 3.1, csat: 0.83 },
        { theme: "Content creation", topic: "Drafting messages", conversations: 220, resolved: 0.82, failing: 25, friction: 34, gaps: 12, turns: 2.5, csat: 0.88 },
        { theme: "Content creation", topic: "Summarizing documents", conversations: 180, resolved: 0.77, failing: 28, friction: 41, gaps: 16, turns: 2.9, csat: 0.85 },
        { theme: "Data analysis", topic: "Spreadsheet analysis", conversations: 205, resolved: 0.76, failing: 31, friction: 43, gaps: 20, turns: 3.2, csat: 0.82 },
        { theme: "Data analysis", topic: "Research synthesis", conversations: 170, resolved: 0.73, failing: 27, friction: 46, gaps: 19, turns: 3.4, csat: 0.81 },
        { theme: "Meeting follow-up", topic: "Action items", conversations: 190, resolved: 0.8, failing: 24, friction: 36, gaps: 14, turns: 2.7, csat: 0.87 },
        { theme: "Meeting follow-up", topic: "Follow-up messages", conversations: 155, resolved: 0.75, failing: 23, friction: 42, gaps: 15, turns: 3, csat: 0.84 },
    ];
    const groups = [...new Set(topics.map((topic) => topic.theme))];
    const rows: unknown[][] = [];
    const row = (topic: (typeof topics)[number] | undefined, theme: string | null, grand: boolean, subtotal: boolean) => {
        const groupTopics = topic ? [topic] : theme ? topics.filter((candidate) => candidate.theme === theme) : topics;
        const totalConversations = topic
            ? topic.conversations
            : groupTopics.reduce((sum, candidate) => sum + candidate.conversations, 0);
        const weighted = (pick: (item: (typeof topics)[number]) => number) =>
            groupTopics.reduce((sum, candidate) => sum + pick(candidate) * candidate.conversations, 0) / totalConversations;
        const values: Record<string, unknown> = {
            "Agent Performance[Topic Theme]": theme,
            "Agent Performance[Topic (resolved)]": topic?.topic ?? null,
            "[Is Grand Total]": grand,
            "[Is Group Total]": subtotal,
            "[Conversations]": grand ? topics.reduce((sum, candidate) => sum + candidate.conversations, 0) : totalConversations,
            "[Resolved]": weighted((item) => item.resolved),
            "[Failing]": topic ? topic.failing : groupTopics.reduce((sum, item) => sum + item.failing, 0),
            "[Friction]": weighted((item) => item.friction),
            "[Knowledge Gaps]": topic ? topic.gaps : groupTopics.reduce((sum, item) => sum + item.gaps, 0),
            "[Turns To Resolve]": weighted((item) => item.turns),
            "[CSAT]": weighted((item) => item.csat),
        };
        return columns.map((column) => values[column] ?? null);
    };
    for (const theme of groups) {
        rows.push(...topics.filter((topic) => topic.theme === theme).map((topic) => row(topic, theme, false, false)));
        rows.push(row(undefined, theme, false, true));
    }
    rows.push(row(undefined, null, true, false));
    return rows;
}

function evaluationCommentRows(columns: readonly string[]): unknown[][] {
    const comments = [
        ["Clear and helpful answer", "Thumbs up", 42],
        ["Good summary of the key points", "Thumbs up", 36],
        ["Please include more detail", "Thumbs down", 18],
        ["The source link was useful", "Thumbs up", 15],
        ["I still need a more direct answer", "Thumbs down", 11],
    ];
    return comments.map((comment) => {
        const values: Record<string, unknown> = {
            "[Comment]": comment[0],
            "[Verdict]": comment[1],
            "[Times]": comment[2],
        };
        return columns.map((column) => values[column] ?? null);
    });
}

function evaluationArchetypeRows(columns: readonly string[]): unknown[][] {
    const archetypes = [
        ["Knowledge-grounded answer", 320],
        ["Model-only answer", 214],
        ["Human hand-off", 148],
        ["No answer", 86],
    ];
    return archetypes.map((archetype) => {
        const values: Record<string, unknown> = {
            "[Archetype]": archetype[0],
            "[Conversations]": archetype[1],
        };
        return columns.map((column) => values[column] ?? null);
    });
}

function evaluationKnowledgeSourceRows(columns: readonly string[]): unknown[][] {
    const sources = [
        ["Product guide", 214],
        ["Policy reference", 178],
        ["How-to collection", 146],
        ["Service catalogue", 121],
        ["Troubleshooting guide", 98],
        ["Team handbook", 76],
        ["Release notes", 54],
        ["Training material", 39],
    ];
    return sources.map((source) => {
        const values: Record<string, unknown> = {
            "[Source]": source[0],
            "[Citations]": source[1],
        };
        return columns.map((column) => values[column] ?? null);
    });
}

function genericRows(query: string, columns: readonly string[]): unknown[][] {
    if (columns.length === 0) return [];
    const seed = hash(query);
    const scale = 0.9 + (seed % 21) / 100;
    return Array.from({ length: isSummary(query) ? 1 : DEMO_RESULT_COUNT }, (_, rowIndex) =>
        columns.map((column) => sampleValue(query, column, rowIndex, scale, seed)),
    );
}

function isSummary(query: string): boolean {
    return /\bEVALUATE\s+(?:CALCULATETABLE\s*\(\s*)?ROW\s*\(/i.test(query);
}

function sampleValue(query: string, column: string, rowIndex: number, scale: number, seed: number): unknown {
    const normalized = column.toLowerCase();
    if (ROLLUP_FLAGS.includes(column)) return rowIndex === 0;
    if (/^(is|has|was|include|exclude|valid|active)\b/.test(normalized)) return rowIndex % 2 === 0;
    if (/pct|percent|rate|share|probability|satisfaction|csat|success|escalation|abandonment|index|score/.test(normalized)) {
        let base = 0.52;
        if (/habitual/.test(normalized)) base = 0.38;
        else if (/power/.test(normalized)) base = 0.17;
        else if (/satisfaction/.test(normalized)) base = 0.84;
        else if (/seats in use/.test(normalized)) base = 0.71;
        else if (/active/.test(normalized)) base = 0.64;
        else if (/inactive/.test(normalized)) base = 0.24;
        else if (/share/.test(normalized)) base = 0.36;
        return Math.min(0.98, Math.round((base + (rowIndex % 3) * 0.015) * scale * 1000) / 1000);
    }
    if (normalized === "[status]") return "Synthetic sample";
    if (/last date|last activity|latest date/.test(normalized)) return DATE_END;
    if (/first date|first activity|earliest date/.test(normalized)) return DATE_START;
    if (/habit month/.test(normalized)) return "2026-10-01";
    if (/monthstart|month start|^\[month\]$/.test(normalized)) {
        return `2026-${String(6 + (rowIndex % 6)).padStart(2, "0")}-01`;
    }
    if (/weekstart|week start|^\[week\]$/.test(normalized)) {
        const date = new Date(Date.UTC(2026, 8, 7 + rowIndex * 7));
        return date.toISOString().slice(0, 10);
    }
    if (/date|timestamp/.test(normalized)) {
        const date = new Date(Date.UTC(2026, 8, 3 + rowIndex * 7));
        return date.toISOString().slice(0, 10);
    }
    if (/per user|per person|per task|spuw/.test(normalized)) {
        const base = /minutes/.test(normalized) ? 4 : /per task/.test(normalized) ? 1.5 : /hours|expert/.test(normalized) ? 1.2 : /days/.test(normalized) ? 3.4 : 4.8;
        return Math.round((base + rowIndex * 0.13) * scale * 100) / 100;
    }
    if (/active days per week/.test(normalized)) return 3.8;
    if (/active days/.test(normalized)) return 16 + (rowIndex % 7);
    if (/expert.*hours.*per week|hours per week/.test(normalized)) return Math.round(138 * scale);
    if (/value.*per week/.test(normalized)) return Math.round(6900 * scale);
    if (/meetings per week/.test(normalized)) return 5.2;
    if (/call hours per week/.test(normalized)) return 4.3;
    if (/emails sent per week/.test(normalized)) return 62;
    if (/chats per week/.test(normalized)) return 88;
    if (/per week/.test(normalized)) return 0.7;
    if (/median response/.test(normalized)) return 3.2;
    if (/workloads per active day/.test(normalized)) return Math.round((1.8 + (rowIndex % 4) * 0.2) * 100) / 100;
    if (/outcome order|cohort order|rank/.test(normalized)) return rowIndex + 1;
    if (["[licensed]", "[unlicensed]", "[agents]"].includes(normalized) && /sessions per user/i.test(query)) {
        const base = normalized === "[licensed]" ? 4.8 : normalized === "[unlicensed]" ? 3.1 : 1.6;
        return Math.round((base + rowIndex * 0.08) * scale * 100) / 100;
    }
    if (/tasks|people|users|seats|sessions|hours|weeks|credits|feedback|ratings|count|total|skills available|agents in use|records|value|cost|spend/.test(normalized)) {
        let base = 24;
        if (/hours/.test(normalized)) base = 154;
        if (/agent hours/.test(normalized)) base = 54;
        else if (/tasks/.test(normalized)) base = 6300;
        else if (/licensed seats/.test(normalized)) base = 260;
        else if (/seats in use/.test(normalized)) base = 185;
        else if (/people|users|seats/.test(normalized)) base = 180;
        else if (/weeks/.test(normalized)) base = 12;
        else if (/sessions/.test(normalized)) base = 3200;
        else if (/credits|cost|spend/.test(normalized)) base = 840;
        else if (/feedback|ratings/.test(normalized)) base = 360;
        else if (/skills available/.test(normalized)) base = 47;
        else if (/agents in use/.test(normalized)) base = 9;
        else if (/value/.test(normalized)) base = 77000;
        return Math.round((base + rowIndex * Math.max(3, base * 0.07)) * scale * 100) / 100;
    }
    if (/audit_userid|userprincipalname|user key|user id|email|viewer/.test(normalized)) {
        return `Viewer ${String(rowIndex + 1).padStart(2, "0")}`;
    }
    if (normalized === "[user]" || normalized === "[user name]") {
        return `Viewer ${String(rowIndex + 1).padStart(2, "0")}`;
    }
    if (/organization|department|team|region|org\b/.test(normalized)) return ORGANIZATIONS[rowIndex % ORGANIZATIONS.length];
    if (/attribute/.test(normalized)) return ["Organization", "Department", "Region"][rowIndex % 3];
    if (/agent.*name|agentname|assistant/.test(normalized)) return AGENTS[rowIndex % AGENTS.length];
    if (/activity|audience|product|surface|platform|workload|app\b|^\[tool\]$/.test(normalized)) {
        const choices = /activity|audience/.test(normalized) ? ACTIVITIES : /workload/.test(normalized) ? ["Email", "Meetings", "Documents", "Spreadsheets"] : PRODUCTS;
        return choices[rowIndex % choices.length];
    }
    if (/stage/.test(normalized)) return ["Power", "Habitual", "Developing", "Beginner", "Inactive"][rowIndex % 5];
    if (/cohort/.test(normalized)) return HABITS[rowIndex % HABITS.length];
    if (normalized === "[overall top outcome]") return "Resolved successfully";
    if (/outcome/.test(normalized)) return ["Resolved", "Unresolved", "Failed", "Abandoned"][rowIndex % 4];
    if (/task|category|skill|behavior|topic|theme/.test(normalized)) return TASKS[rowIndex % TASKS.length];
    if (/owner/.test(normalized)) return `Demo owner ${rowIndex + 1}`;
    if (/currency symbol/.test(normalized)) return "$";
    if (/currency/.test(normalized)) return "USD";
    if (/id|guid|key/.test(normalized)) return `SAMPLE-${String(rowIndex + 1).padStart(4, "0")}`;
    if (/name|label|type|group|model|source|status|verdict|segment/.test(normalized)) {
        return `${titleWord(column)} ${rowIndex + 1}`;
    }
    if (/rank/.test(normalized)) return rowIndex + 1;
    const amount = 24 + ((seed >>> (rowIndex % 24)) % 177) + rowIndex * 19;
    return Math.round(amount * scale * 100) / 100;
}

function titleWord(column: string): string {
    return column
        .replace(/^.*\[/, "")
        .replace(/\]$/, "")
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .trim() || "Sample";
}

function hash(value: string): number {
    let result = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
        result ^= value.charCodeAt(index);
        result = Math.imul(result, 16777619);
    }
    return result >>> 0;
}
