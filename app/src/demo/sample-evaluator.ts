/** Offline Analytics-only Evaluator. All cells are reductions of invented source evidence. */
export interface EvaluatorPerson {
    user: string; org: string; job: string; country: string; licensed: boolean; active: boolean;
}
export interface EvaluatorSession {
    id: string; user: string; date: string; agent: string; theme: string; topic: string;
    outcome: string; impliedSuccess: boolean; knowledgeSearched: boolean; knowledgeAnswered: boolean;
    grounding: string; archetype: string;
}
export interface EvaluatorTurn {
    id: string; session: string; responseSeconds: number; feedbackVerdict: string; feedbackComment: string;
}
export interface EvaluatorPayload {
    provenance: { synthetic: boolean; seed: string; description: string; start: string; end: string; volumeBasis: string };
    people: EvaluatorPerson[];
    catalog: { agent: string; theme: string; topics: string[]; deflectionMinutes: number;
        sources: { id: string; label: string; uri: string }[] }[];
    sessions: EvaluatorSession[];
    turns: EvaluatorTurn[];
    errors: { session: string; turn: string; code: string; source: string }[];
    citations: { session: string; turn: string; source: string }[];
    status: { environment: string; lookbackDays: number };
}

const files = import.meta.glob<EvaluatorPayload>("./evaluator-data.generated.json", { eager: true, import: "default" });
const payload = files["./evaluator-data.generated.json"];
type RecordRow = Record<string, unknown>;
const outcomes = ["Resolved", "Escalated - Intended", "Escalated - Unintended", "Abandoned"];
const outcomeLabels = ["Resolved", "Escalated by design", "Escalated after an error", "Abandoned"];
const attributes = { Organization: "org", JobTitle: "job", country: "country" } as const;
const sum = <T>(rows: readonly T[], value: (row: T) => number) => rows.reduce((total, row) => total + value(row), 0);
const divide = (numerator: number, denominator: number) => denominator ? numerator / denominator : 0;
const unique = <T>(rows: readonly T[], key: (row: T) => string) => new Set(rows.map(key)).size;
const failing = (session: EvaluatorSession) => outcomes.indexOf(session.outcome) >= 2;
const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
const compareText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const strings = (value: string) => [...value.matchAll(/"((?:[^"]|"")*)"/g)].map(match => match[1].replace(/""/g, '"'));
const unquote = (value: string) => value.replace(/""/g, '"');

function groups<T>(rows: readonly T[], key: (row: T) => string): [string, T[]][] {
    const result = new Map<string, T[]>();
    for (const row of rows) {
        const label = key(row);
        const bucket = result.get(label);
        if (bucket) bucket.push(row);
        else result.set(label, [row]);
    }
    return [...result];
}

function selections(query: string, table: string, column: string): string[][] {
    const pattern = new RegExp(`TREATAS\\s*\\(\\s*\\{([^}]*)\\}\\s*,\\s*'${escape(table)}'\\[${escape(column)}\\]\\s*\\)`, "gi");
    return [...query.matchAll(pattern)].map(match => strings(match[1]));
}

function orgValue(person: EvaluatorPerson | undefined, attribute: string): string {
    return person?.[attributes[attribute as keyof typeof attributes]] ?? "";
}

function selected(query: string, data: EvaluatorPayload): EvaluatorSession[] {
    const people = new Map(data.people.map(person => [person.user, person]));
    const departments = selections(query, "Chat + Agent Org Data", "Organization");
    const agents = selections(query, "Agent Performance", "BotFriendlyName");
    const identities = [
        ...selections(query, "Chat + Agent Org Data", "Org Join Key"),
        ...selections(query, "Chat + Agent Org Data", "PersonId_Normalized"),
    ];
    // Global organisation selection is a nested TREATAS of inventory keys. Keep
    // its attribute separate from the by-group bridge's own attribute filter.
    const orgSelections = [...query.matchAll(
        /'Org Attribute Source'\[Attribute\]\s*=\s*"((?:[^"]|"")*)"\s*,\s*'Org Attribute Source'\[Value\]\s+IN\s*\{([^}]*)\}/gi,
    )].map(match => ({ attribute: unquote(match[1]), values: strings(match[2]) }));
    const directValues = selections(query, "Org Attribute Source", "Value");
    const directAttribute = selections(query, "Org Attribute Source", "Attribute").at(-1)?.[0];
    if (directValues.length && directAttribute) {
        orgSelections.push(...directValues.map(values => ({ attribute: directAttribute, values })));
    }
    const bounds = [...query.matchAll(
        /'Calendar'\[Date\]\s*(>=|<=)\s*DATE\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/gi,
    )].map(match => ({
        operator: match[1],
        date: `${match[2]}-${match[3].padStart(2, "0")}-${match[4].padStart(2, "0")}`,
    }));
    return data.sessions.filter(session => {
        const person = people.get(session.user);
        return departments.every(values => values.includes(person?.org ?? ""))
            && agents.every(values => values.includes(session.agent))
            && identities.every(values => values.includes(session.user))
            && orgSelections.every(({ attribute, values }) => values.includes(orgValue(person, attribute)))
            && bounds.every(bound => bound.operator === ">=" ? session.date >= bound.date : session.date <= bound.date);
    });
}

/** Match actual evaluator query identities, never a generic requested column name. */
function identity(query: string): string | undefined {
    if (/'Evaluator Status'\[Environment\]/i.test(query)) return "status";
    if (/'Agent Performance'\[InteractionDate\]/i.test(query) && /ROW\s*\(\s*"Last Date"\s*,\s*MAX\s*\(/i.test(query)) return "freshness";
    if (/'Agent Performance'\[InteractionDate\]/i.test(query) && /"Kind"\s*,\s*"First date"/i.test(query)) return "options";
    if (/"Kind"\s*,\s*"Group by"[\s\S]*?\[Total Conversations\]/i.test(query)) return "eligibility";
    if (query.includes("Evaluator's row bridge") && /VALUES\s*\(\s*'Org Attribute Source'\[Attribute\]/i.test(query)) return "attributes";
    if (/"Verdict Performance"\s*,\s*\[⭐ Verdict: Performance\]/u.test(query)) return "performance";
    if (/"Knowledge Story"\s*,\s*\[📚 Knowledge Story \(Live\)\]/u.test(query)) return "conversations";
    if (/'Agent Performance'\[Outcome \(Detailed\)\]/i.test(query) && /"Week Start"/i.test(query)) return "weekly";
    if (/'Agent Performance'\[Outcome \(Detailed\)\]/i.test(query) && /"Theme"/i.test(query)) return "themes";
    if (/ROLLUPADDISSUBTOTAL\s*\(\s*'Agent Performance'\[Topic Theme\]/i.test(query)) return "topics";
    if (/'Agent Errors'\[error_code\]/i.test(query)) return "errors";
    if (/'Agent Sessions'\[Conversation Archetype\]/i.test(query)) return "archetypes";
    if (/'Knowledge Citations'\[source_label\]/i.test(query)) return "sources";
    if (/'Agent Turns'\[feedback_comment\]/i.test(query)) return "comments";
    if (/"Group"\s*,\s*'(?:Agent Performance|Org Attribute Source)'\[/i.test(query)
        && /"@Conversations"\s*,\s*\[Total Conversations\]/i.test(query)) return "groups";
    return undefined;
}

/** A pure adapter factory also lets focused tests reconcile custom source records. */
export function createEvaluatorRows(data: EvaluatorPayload) {
    const people = new Map(data.people.map(person => [person.user, person]));
    const catalog = new Map(data.catalog.map(agent => [agent.agent, agent]));
    const sources = new Map(data.catalog.flatMap(agent => agent.sources.map(source => [source.id, source] as const)));
    const turnsBySession = new Map(groups(data.turns, turn => turn.session));
    const errorsBySession = new Map(groups(data.errors, error => error.session));
    const citationsBySession = new Map(groups(data.citations, citation => citation.session));
    const sessionTurns = (rows: readonly EvaluatorSession[]) => rows.flatMap(row => turnsBySession.get(row.id) ?? []);
    const sessionCitations = (rows: readonly EvaluatorSession[]) => rows.flatMap(row => citationsBySession.get(row.id) ?? []);

    function metrics(rows: readonly EvaluatorSession[]): RecordRow {
        const turns = sessionTurns(rows);
        const replies = turns.map(turn => turn.responseSeconds).sort((a, b) => a - b);
        const middle = Math.floor(replies.length / 2);
        const median = replies.length ? (replies.length % 2 ? replies[middle] : (replies[middle - 1] + replies[middle]) / 2) : null;
        const resolved = rows.filter(row => row.outcome === outcomes[0]);
        const intended = rows.filter(row => row.outcome === outcomes[1]).length;
        const unintended = rows.filter(row => row.outcome === outcomes[2]).length;
        const abandoned = rows.filter(row => row.outcome === outcomes[3]).length;
        const up = turns.filter(turn => turn.feedbackVerdict === "Positive").length;
        const down = turns.filter(turn => turn.feedbackVerdict === "Negative").length;
        const count = rows.length;
        const gap = rows.filter(row => row.knowledgeSearched && !row.knowledgeAnswered).length;
        const avgTurns = divide(turns.length, count);
        return {
            Conversations: count, People: unique(rows, row => row.user),
            "Conversations Per Person": divide(count, unique(rows, row => row.user)),
            "Resolution Rate": divide(resolved.length, count),
            "Implied Success": divide(rows.filter(row => row.impliedSuccess).length, count),
            "True Failure Rate": divide(unintended + abandoned, count),
            "Failing Conversations": unintended + abandoned,
            "Hours Lost": sum(rows.filter(failing), row => catalog.get(row.agent)?.deflectionMinutes ?? 0) / 60,
            "Unintended Escalation Rate": divide(unintended, count),
            "Intended Share": divide(intended, intended + unintended),
            "Abandonment Rate": divide(abandoned, count), CSAT: up + down ? up / (up + down) : null,
            "Thumbs Up": up, "Thumbs Down": down,
            "Error Rate": divide(rows.filter(row => errorsBySession.has(row.id)).length, count),
            "Median Response": median, "Slow Replies": divide(replies.filter(value => value > 10).length, replies.length),
            Topics: unique(rows, row => row.topic),
            "Grounded Rate": divide(rows.filter(row => row.grounding === "Internal").length, count),
            "Answered From Knowledge": rows.filter(row => row.knowledgeAnswered).length,
            Citations: sessionCitations(rows).length,
            "Knowledge Gap Rate": divide(gap, rows.filter(row => row.knowledgeSearched).length),
            "Knowledge Gap Conversations": gap,
            "Turns Per Conversation": avgTurns,
            "Single Turn Rate": divide(rows.filter(row => (turnsBySession.get(row.id)?.length ?? 0) <= 1).length, count),
            "Turns To Resolve": resolved.length ? sessionTurns(resolved).length / resolved.length : null,
            Friction: Math.round((divide(abandoned, count) * 0.6 + Math.min(avgTurns / 10, 1) * 0.4) * 100),
        };
    }

    function narrative(rows: readonly EvaluatorSession[], measured: RecordRow): RecordRow {
        const count = rows.length;
        const failed = rows.filter(failing);
        const gaps = rows.filter(row => row.knowledgeSearched && !row.knowledgeAnswered);
        const abandoned = rows.filter(row => row.outcome === outcomes[3]);
        const rank = (values: readonly EvaluatorSession[], key: (row: EvaluatorSession) => string) =>
            groups(values, key).sort((a, b) => b[1].length - a[1].length || compareText(a[0], b[0]))[0];
        const weakest = groups(rows, row => row.agent).sort((a, b) =>
            divide(b[1].filter(failing).length, b[1].length) - divide(a[1].filter(failing).length, a[1].length)
            || compareText(a[0], b[0]))[0];
        const gapLeader = rank(gaps, row => row.topic);
        const giveUp = rank(abandoned, row => row.topic);
        const fix = rank(failed, row => row.topic);
        const leadingTheme = rank(rows, row => row.theme);
        const resolution = measured["Resolution Rate"] as number;
        const csat = measured.CSAT as number | null;
        const sourceCounts = groups(sessionCitations(rows), citation => sources.get(citation.source)?.label ?? "");
        const leadingSource = sourceCounts.sort((a, b) => b[1].length - a[1].length || compareText(a[0], b[0]))[0];
        const dates = rows.map(row => row.date).sort();
        const feedback = sessionTurns(rows).filter(turn => turn.feedbackComment);
        return {
            "Reporting Window": `${dates[0]} to ${dates.at(-1)} · ${count} synthetic conversations`,
            "Verdict Performance": `${percent(resolution)} resolved · ${resolution >= 0.8 ? "🟢 On track" : resolution >= 0.6 ? "🟡 Room to improve" : "🔴 Needs attention"}`,
            "Verdict Quality": `${csat === null ? "No feedback" : `${percent(csat)} satisfied`} · ${csat === null ? "Not measured" : csat >= 0.8 ? "🟢 Positive feedback" : "🟡 Review feedback"}`,
            "Verdict Adoption": `${measured.People} people · ${count} synthetic conversations`,
            "Focus Agent": weakest ? `${weakest[0]}: ${weakest[1].filter(failing).length} failures in ${weakest[1].length} conversations.` : "",
            "Focus Knowledge": gapLeader ? `${gapLeader[0]}: ${gapLeader[1].length} conversations searched without an answer.` : "No unanswered searches in this selection.",
            "Focus Give Up": giveUp ? `${giveUp[0]}: ${giveUp[1].length} abandoned conversations.` : "No abandoned conversations in this selection.",
            "Escalation Verdict": `${rows.filter(row => row.outcome === outcomes[1]).length} hand-offs by design; ${rows.filter(row => row.outcome === outcomes[2]).length} after an error.`,
            "Error Story": `${sum(rows, row => errorsBySession.get(row.id)?.length ?? 0)} errors across ${rows.filter(row => errorsBySession.has(row.id)).length} conversations.`,
            "Response Read": `${Number(measured["Median Response"]).toFixed(1)}s median reply; ${percent(measured["Slow Replies"] as number)} over 10s.`,
            "Friction Read": `${measured.Friction} out of 100 · ${Number(measured.Friction) < 25 ? "🟢 Low friction" : "🟡 Review conversation depth"}`,
            "Theme Verdict": leadingTheme ? `${leadingTheme[0]} leads with ${leadingTheme[1].length} conversations.` : "",
            "Theme Coverage": `${unique(rows, row => row.theme)} themes and ${measured.Topics} topics in this selection.`,
            "Top Fix": fix ? `${fix[0]}: review ${fix[1].length} failing conversations.` : "No failing conversations in this selection.",
            "Backlog Summary": `${failed.length} failures across ${unique(failed, row => row.topic)} topics.`,
            "Topic Insight": `${measured.Topics} topics; ${percent(resolution)} of conversations resolved.`,
            "Knowledge Story": leadingSource ? `${measured.Citations} citations; ${leadingSource[0]} leads with ${leadingSource[1].length}.` : "No knowledge citations in this selection.",
            "Knowledge Gap Read": `${gaps.length} conversations searched without an answer (${percent(measured["Knowledge Gap Rate"] as number)} of searches).`,
            "Depth Read": `${Number(measured["Turns Per Conversation"]).toFixed(1)} turns per conversation; ${percent(measured["Single Turn Rate"] as number)} answered in one turn.`,
            "Feedback Insight": `${feedback.length} written synthetic feedback entries.`,
            "CSAT Story": `${measured["Thumbs Up"]} thumbs up and ${measured["Thumbs Down"]} thumbs down${csat === null ? "; satisfaction not measured." : `; ${percent(csat)} satisfied.`}`,
        };
    }

    function dimension(query: string): (row: EvaluatorSession) => string {
        if (/"Group"\s*,\s*'Org Attribute Source'\[Value\]/i.test(query)) {
            const attribute = selections(query, "Org Attribute Source", "Attribute").at(-1)?.[0] ?? "";
            return row => orgValue(people.get(row.user), attribute);
        }
        const column = /"Group"\s*,\s*'Agent Performance'\[([^\]]+)\]/i.exec(query)?.[1];
        return column === "Topic Theme" ? row => row.theme : column === "Topic (resolved)" ? row => row.topic : row => row.agent;
    }

    function eligibility(query: string): RecordRow[] {
        // Each generated ROW has its own attribute scope, not the last scope
        // in a UNION of several independently requested grouping columns.
        return [...query.matchAll(/"Kind"\s*,\s*"Group by"\s*,\s*"Value"\s*,\s*"((?:[^"]|"")*)"([\s\S]*?)(?="Kind"\s*,\s*"Group by"|$)/gi)]
            .map(match => {
                const id = unquote(match[1]);
                const body = match[2];
                const attribute = selections(body, "Org Attribute Source", "Attribute")[0]?.[0];
                const key = attribute ? (row: EvaluatorSession) => orgValue(people.get(row.user), attribute)
                    : body.includes("[Topic Theme]") ? (row: EvaluatorSession) => row.theme
                    : body.includes("[Topic (resolved)]") ? (row: EvaluatorSession) => row.topic
                    : (row: EvaluatorSession) => row.agent;
                const populated = new Set(data.sessions.map(key).filter(value => value.trim()));
                return { Kind: "Group by", Value: id, Sort: Math.min(2, populated.size) };
            });
    }

    return (query: string, columns: readonly string[]): unknown[][] | undefined => {
        const kind = identity(query);
        if (!kind) return undefined;
        let records: RecordRow[] = [];
        const rows = selected(query, data);
        if (kind === "status") {
            records = [{ Environment: data.status.environment, "Lookback Days": data.status.lookbackDays,
                Transcripts: data.sessions.length, Status: data.sessions.length ? "ok" : "empty" }];
        } else if (kind === "freshness") {
            records = [{ "Last Date": rows.map(row => row.date).sort().at(-1) ?? null }];
        } else if (kind === "attributes") {
            records = Object.keys(attributes).filter(attribute => data.people.some(person => orgValue(person, attribute).trim()))
                .map(Column => ({ Column }));
        } else if (kind === "options") {
            const dates = data.sessions.map(row => row.date).sort();
            if (dates.length) records.push({ Kind: "First date", Value: dates[0], Sort: 0 },
                { Kind: "Last date", Value: dates.at(-1), Sort: 0 });
            for (const [Kind, key] of [
                ["Department", (row: EvaluatorSession) => people.get(row.user)?.org ?? ""],
                ["Agent", (row: EvaluatorSession) => row.agent],
            ] as const) {
                records.push(...groups(data.sessions, key).filter(([value]) => value.trim())
                    .map(([Value, values]) => ({ Kind, Value, Sort: values.length })));
            }
            records.push(...eligibility(query));
            records.sort((a, b) => compareText(String(a.Kind), String(b.Kind)) || Number(b.Sort) - Number(a.Sort)
                || compareText(String(a.Value), String(b.Value)));
        } else if (kind === "eligibility") {
            records = eligibility(query);
        } else if (rows.length === 0) {
            // A real empty selection must not fall through to the legacy fixtures.
            records = [];
        } else if (kind === "performance" || kind === "conversations") {
            const measured = metrics(rows);
            records = [{ ...measured, ...narrative(rows, measured) }];
        } else if (kind === "groups") {
            records = groups(rows, dimension(query)).map(([Group, values]) => ({ Group, ...metrics(values) }));
            records.sort((a, b) => Number(b.Conversations) - Number(a.Conversations) || compareText(String(a.Group), String(b.Group)));
        } else if (kind === "weekly" || kind === "themes") {
            const key = kind === "weekly" ? "Week Start" : "Theme";
            const label = (row: EvaluatorSession) => {
                if (kind !== "weekly") return row.theme;
                const date = new Date(`${row.date}T00:00:00Z`);
                date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
                return date.toISOString().slice(0, 10);
            };
            records = groups(rows, row => `${label(row)}\u0000${row.outcome}`).map(([, values]) => {
                const index = outcomes.indexOf(values[0].outcome);
                return { [key]: label(values[0]), Outcome: outcomeLabels[index], "Outcome Order": index + 1, Conversations: values.length };
            });
            records.sort((a, b) => compareText(String(a[key]), String(b[key])) || Number(a["Outcome Order"]) - Number(b["Outcome Order"]));
        } else if (kind === "topics") {
            const topicMetrics = (values: EvaluatorSession[]) => {
                const measured = metrics(values);
                return { Conversations: values.length, Resolved: measured["Resolution Rate"],
                    Failing: measured["Failing Conversations"], Friction: measured.Friction,
                    "Knowledge Gaps": measured["Knowledge Gap Conversations"], "Turns To Resolve": measured["Turns To Resolve"], CSAT: measured.CSAT };
            };
            const record = (values: EvaluatorSession[], theme: string | null, topic: string | null, grand: boolean, group: boolean) => ({
                "Agent Performance[Topic Theme]": theme, "Agent Performance[Topic (resolved)]": topic,
                "Is Grand Total": grand, "Is Group Total": group, ...topicMetrics(values),
            });
            records = [record(rows, null, null, true, true)];
            for (const [theme, values] of groups(rows, row => row.theme)) {
                records.push(record(values, theme, null, false, true));
                for (const [topic, leaves] of groups(values, row => row.topic)) records.push(record(leaves, theme, topic, false, false));
            }
            records.sort((a, b) => Number(b["Is Grand Total"]) - Number(a["Is Grand Total"])
                || Number(b["Is Group Total"]) - Number(a["Is Group Total"])
                || Number(b.Failing) - Number(a.Failing) || Number(b.Conversations) - Number(a.Conversations));
        } else if (kind === "errors") {
            const errors = rows.flatMap(row => errorsBySession.get(row.id) ?? []);
            records = groups(errors, error => `${error.code}\u0000${error.source}`).map(([, values]) => ({
                "Error Code": values[0].code, Source: values[0].source, Errors: values.length,
            })).sort((a, b) => b.Errors - a.Errors || compareText(a["Error Code"], b["Error Code"])).slice(0, 10);
        } else if (kind === "archetypes") {
            records = groups(rows, row => row.archetype).map(([Archetype, values]) => ({ Archetype, Conversations: values.length }))
                .sort((a, b) => b.Conversations - a.Conversations || compareText(a.Archetype, b.Archetype));
        } else if (kind === "sources") {
            records = groups(sessionCitations(rows), citation => sources.get(citation.source)?.label ?? "")
                .filter(([label]) => label.trim()).map(([Source, values]) => ({ Source, Citations: values.length }))
                .sort((a, b) => b.Citations - a.Citations || compareText(a.Source, b.Source)).slice(0, 10);
        } else if (kind === "comments") {
            records = groups(sessionTurns(rows).filter(turn => turn.feedbackComment.trim()),
                turn => `${turn.feedbackComment}\u0000${turn.feedbackVerdict}`)
                .map(([, values]) => ({ Comment: values[0].feedbackComment, Verdict: values[0].feedbackVerdict, Times: values.length }))
                .sort((a, b) => b.Times - a.Times || compareText(a.Comment, b.Comment)).slice(0, 25);
        }
        return records.map(row => columns.map(column => row[column] ?? row[column.replace(/^\[|\]$/g, "")] ?? null));
    };
}

const generatedRows = payload ? createEvaluatorRows(payload) : undefined;

/** Parent's Analytics dispatcher calls this before legacy routing; ordinary demos never do. */
export function sampleEvaluatorRows(query: string, columns: readonly string[]): unknown[][] | undefined {
    return generatedRows?.(query, columns);
}
