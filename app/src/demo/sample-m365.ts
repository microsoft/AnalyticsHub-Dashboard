import {
    dateRange, groups, literals, orgAttribute, peopleById, project, selectedActivity,
    selectedPeople, sessions, sum, unique, type RecordRow,
} from "./sample-data";

export interface M365Activity {
    UPN_Normalized: string;
    ActivityDate: string;
    WeekStart: string;
    WorkloadsActive: number;
    TeamsActive: number;
    EmailActive: number;
    SharePointActive: number;
    OneDriveActive: number;
    AppsActive: number;
    VivaEngageActive: number;
    TeamsMeetings: number;
    TeamsAudioSeconds: number;
    EmailSent: number;
    TeamsChatMessages: number;
    TeamsPrivateChatMessages: number;
    SharePointFilesViewedOrEdited: number;
    OneDriveFilesViewedOrEdited: number;
    AppOutlook: number;
    AppTeams: number;
    AppWord: number;
    AppExcel: number;
    AppPowerPoint: number;
    AppOneNote: number;
    PlatformWindows: number;
    PlatformMac: number;
    PlatformWeb: number;
    PlatformMobile: number;
}

export interface M365Payload {
    activity: M365Activity[];
    provenance: {
        description: string; classification: string; generator: string; seed: string;
        firstDate: string; lastDate: string; people: number; rules: string[];
    };
}

const files = import.meta.glob<M365Payload>("./m365-data.generated.json", { eager: true, import: "default" });
const payload = files["./m365-data.generated.json"];
const apps = ["Outlook", "Teams", "Word", "Excel", "PowerPoint", "OneNote"] as const;
const platforms = ["Windows", "Mac", "Web", "Mobile"] as const;
const workloads = [
    ["Teams", "TeamsActive"], ["Email", "EmailActive"], ["SharePoint", "SharePointActive"],
    ["OneDrive", "OneDriveActive"], ["Office apps", "AppsActive"], ["Viva Engage", "VivaEngageActive"],
] as const;
const distinct = (rows: readonly M365Activity[]) => unique(rows, row => row.UPN_Normalized);
const active = (rows: readonly M365Activity[]) => rows.filter(row => row.WorkloadsActive > 0);
const divide = (value: number, denominator: number) => denominator > 0 ? value / denominator : null;
const dates = (rows: readonly M365Activity[]) => [...new Set(rows.map(row => row.ActivityDate))].sort();

/** Separate entry point makes source reconciliation possible without a checked-in payload. */
export function createM365Adapter(data: M365Payload) {
    return (query: string, columns: readonly string[]): unknown[][] | undefined => {
        // Never dispatch on generic output names: other sources have People, Reach and Last Date too.
        if (!/'M365 Activity'\s*(?:\[|\))/i.test(query)) return undefined;
        const output = (rows: RecordRow[]) => project(columns, rows);
        const range = dateRange(query) ?? dateRange(query, "'M365 Activity'[ActivityDate]");
        const calendarDates = literals(query, "Calendar", "Date");
        // The readiness DAX also has a symbolic per-row TREATAS on this key;
        // that is a join expression, not an empty literal user selection.
        const userFilter = /TREATAS\s*\(\s*\{([^}]*)\}\s*,\s*'M365 Activity'\[UPN_Normalized\]/i.exec(query);
        const users = userFilter && userFilter[1].replace(/"(?:[^"]|"")*"|[\s,]/g, "") === ""
            ? literals(query, "M365 Activity", "UPN_Normalized") : undefined;
        const all = data.activity.filter(row => (!range || row.ActivityDate >= range.from && row.ActivityDate <= range.to)
            && (!calendarDates || calendarDates.includes(row.ActivityDate))
            && (!users || users.includes(row.UPN_Normalized)));
        const members = new Set(selectedPeople(query).map(person => person.user));
        const rows = all.filter(row => members.has(row.UPN_Normalized));
        const using = active(rows);
        const people = distinct(using);
        // REMOVEFILTERS(org) in the contracts leaves date selection intact.
        const loadedDates = dates(all);
        const weeks = loadedDates.length / 7;
        const personWeeks = people * weeks;
        const copilot = new Set(selectedActivity(query).map(row => row.user));
        const m365People = new Set(using.map(row => row.UPN_Normalized));
        const copilotPeople = [...m365People].filter(user => copilot.has(user));
        const matches = (signature: string) => query.includes(signature);

        if (/ROW\s*\(\s*"Rows"\s*,\s*COUNTROWS\s*\(\s*'M365 Activity'\s*\)\s*\)/i.test(query)) {
            return output([{ Rows: rows.length }]);
        }
        if (matches('"Concealed Share"')) return output([{
            Rows: rows.length, People: distinct(rows), "First Date": dates(rows)[0] ?? null,
            "Last Date": dates(rows).at(-1) ?? null,
            "Concealed Share": divide([...new Set(rows.map(row => row.UPN_Normalized))].filter(user => !user.includes("@")).length, distinct(rows)),
        }]);
        if (matches('"Workloads Per Active Day"')) return output([{
            "People Active": people, "Days Loaded": loadedDates.length,
            "First Date": loadedDates[0] ?? null, "Last Date": loadedDates.at(-1) ?? null,
            "Active Days Per Week": divide(using.length, personWeeks),
            "Workloads Per Active Day": divide(sum(using, row => row.WorkloadsActive), using.length),
            "Meetings Per Week": divide(sum(rows, row => row.TeamsMeetings), personWeeks),
            "Call Hours Per Week": divide(sum(rows, row => row.TeamsAudioSeconds) / 3600, personWeeks),
            "Emails Sent Per Week": divide(sum(rows, row => row.EmailSent), personWeeks),
            "Chats Per Week": divide(sum(rows, row => row.TeamsChatMessages + row.TeamsPrivateChatMessages), personWeeks),
        }]);
        if (matches("VAR _workloads")) {
            if (matches("'M365 Activity'[WeekStart]")) {
                return output(groups(all, row => row.WeekStart).sort(([a], [b]) => a.localeCompare(b)).flatMap(([week, global]) => {
                    if (dates(global).length !== 7) return [];
                    const selected = rows.filter(row => row.WeekStart === week);
                    const denominator = distinct(active(selected));
                    return workloads.flatMap(([Workload, field]) => {
                        const count = distinct(selected.filter(row => row[field] === 1));
                        return count ? [{ "Week Start": week, Workload, People: count, Share: divide(count, denominator) }] : [];
                    });
                }));
            }
            return output(workloads.flatMap(([Workload, field]) => {
                const values = rows.filter(row => row[field] === 1);
                const count = distinct(values);
                return count ? [{ Workload, People: count, Reach: divide(count, people), "Days Per Week": divide(values.length, count * weeks) }] : [];
            }).sort((a, b) => (b.Reach ?? 0) - (a.Reach ?? 0) || a.Workload.localeCompare(b.Workload)));
        }
        if (/VAR\s+_apps\s*=\s*DATATABLE/i.test(query)) return output(apps.flatMap(App => {
            const count = distinct(rows.filter(row => row[`App${App}`] === 1));
            return count ? [{ App, People: count, Reach: divide(count, people) }] : [];
        }).sort((a, b) => (b.Reach ?? 0) - (a.Reach ?? 0) || a.App.localeCompare(b.App)));
        if (matches("VAR _buckets")) {
            if (!people) return [];
            const depths = groups(rows.filter(row => m365People.has(row.UPN_Normalized)), row => row.UPN_Normalized)
                .map(([, values]) => apps.filter(app => values.some(row => row[`App${app}`] === 1)).length);
            return output(Array.from({ length: 7 }, (_, Apps) => {
                const count = depths.filter(depth => depth === Apps).length;
                return { Apps, "Apps Used": Apps === 0 ? "No app use reported" : Apps === 6 ? "All 6 apps" : `${Apps} app${Apps === 1 ? "" : "s"}`,
                    People: count, Share: divide(count, people) };
            }));
        }
        if (matches("VAR _platforms")) return output(platforms.flatMap(Platform => {
            const values = rows.filter(row => row[`Platform${Platform}`] === 1);
            const count = distinct(values);
            return count ? [{ Platform, People: count, Reach: divide(count, people), "Days Per Week": divide(values.length, count * weeks) }] : [];
        }).sort((a, b) => (b.Reach ?? 0) - (a.Reach ?? 0) || a.Platform.localeCompare(b.Platform)));
        if (matches('"Licensed Idle Share"')) {
            const licensed = [...m365People].filter(user => peopleById.get(user)?.licensed);
            const idle = licensed.filter(user => !copilot.has(user)).length;
            return output([{
                "M365 People": people, "Copilot People": copilotPeople.length, "Copilot Reach": divide(copilotPeople.length, people),
                "Not Using": people - copilotPeople.length, "Licensed People": licensed.length, "Licensed Not Using": idle,
                "Licensed Idle Share": divide(idle, licensed.length),
            }]);
        }
        if (matches("VAR _metrics")) {
            const cohort = (included: boolean) => rows.filter(row => m365People.has(row.UPN_Normalized) && copilot.has(row.UPN_Normalized) === included);
            const metricValues = (values: M365Activity[]) => [
                active(values).length, sum(values, row => row.TeamsMeetings), sum(values, row => row.TeamsAudioSeconds) / 3600,
                sum(values, row => row.EmailSent), sum(values, row => row.TeamsChatMessages + row.TeamsPrivateChatMessages),
                sum(values, row => row.SharePointFilesViewedOrEdited + row.OneDriveFilesViewedOrEdited),
            ].map(value => divide(value, distinct(values) * weeks));
            const yes = metricValues(cohort(true));
            const no = metricValues(cohort(false));
            return output(["Active days", "Meetings", "Call and meeting hours", "Emails sent", "Chat messages", "Files viewed or edited"]
                .flatMap((Metric, i) => (yes[i] ?? 0) > 0 && (no[i] ?? 0) > 0
                    ? [{ Metric, "Copilot Users": yes[i], Others: no[i], Index: yes[i]! / no[i]! }] : [])
                .sort((a, b) => b.Index - a.Index || a.Metric.localeCompare(b.Metric)));
        }
        if (matches("VAR _minPeople")) {
            const attribute = orgAttribute(query);
            const orgs = groups(using, row => peopleById.get(row.UPN_Normalized)?.[attribute] ?? "").filter(([name]) => name);
            const small = orgs.filter(([, values]) => distinct(values) < 5);
            const visible = orgs.filter(([, values]) => distinct(values) >= 5)
                .map(([Organization, values]) => ({ Organization, values, pooled: 0 }));
            if (small.length) visible.push({ Organization: "Smaller groups", values: small.flatMap(([, values]) => values), pooled: small.length });
            return output(visible.map(({ Organization, values, pooled }) => {
                const count = distinct(values);
                const copilotCount = new Set(values.filter(row => copilot.has(row.UPN_Normalized)).map(row => row.UPN_Normalized)).size;
                return { Organization, "Pooled Groups": pooled, "People Active": count, "Copilot Users": copilotCount,
                    "Copilot Reach": divide(copilotCount, count), "Active Days Per Week": divide(values.length, count * weeks),
                    "Meetings Per Week": divide(sum(values, row => row.TeamsMeetings), count * weeks),
                    "Emails Sent Per Week": divide(sum(values, row => row.EmailSent), count * weeks) };
            }).sort((a, b) => a["Pooled Groups"] - b["Pooled Groups"] || b["People Active"] - a["People Active"] || a.Organization.localeCompare(b.Organization)));
        }
        if (matches("[Median Unlicensed AI Tasks Per User Per Week]") && matches('"Workloads Per Day"')) {
            const candidates = groups(selectedActivity(query).filter(row => !row.licensed), row => row.user).flatMap(([User, values]) => {
                const observed = sessions(values).length;
                const prompts = values.filter(row => row.prompt);
                const promptWeeks = unique(prompts, row => row.week);
                // The model's MEDIANX iterates people. At this per-user grain
                // its value is total prompt rows / distinct prompt weeks.
                const tasks = promptWeeks ? prompts.length / promptWeeks : 0;
                const days = promptWeeks ? unique(prompts, row => row.date) / promptWeeks : 0;
                if (!observed || !tasks || !days) return [];
                const reports = using.filter(row => row.UPN_Normalized === User);
                const breadth = divide(sum(reports, row => row.WorkloadsActive), reports.length);
                const volume = Math.min(tasks / 30, 1);
                const frequency = Math.min(days / 5, 1);
                const score = Math.round(breadth === null ? 60 * volume + 40 * frequency
                    : 50 * volume + 30 * frequency + 20 * Math.min(breadth / 4, 1));
                const weekly = groups(values, row => row.week);
                return [{ User, Organization: peopleById.get(User)?.[orgAttribute(query)] ?? null, "Priority Score": score,
                    "Sessions Per Week": sum(weekly, ([, week]) => sessions(week).length) / weekly.length,
                    "Active Days Per Week": days, "Workloads Per Day": breadth }];
            }).sort((a, b) => b["Priority Score"] - a["Priority Score"] || b["Sessions Per Week"] - a["Sessions Per Week"] || a.User.localeCompare(b.User));
            const scores = [...new Set(candidates.map(row => row["Priority Score"]))].sort((a, b) => b - a);
            return output(candidates.slice(0, 1000).map(row => ({ ...row, Rank: scores.indexOf(row["Priority Score"]) + 1, Total: candidates.length })));
        }
        if (columns.length === 1 && columns[0] === "[Last Date]" && /MAX\s*\(\s*'M365 Activity'\[ActivityDate\]\s*\)/i.test(query)
            && !/'(?:Agent Performance|Chat \+ Agent Interactions \(Audit Logs\)|ProductFeedback|Agents 365)'\[/i.test(query)) {
            return output([{ "Last Date": dates(rows).at(-1) ?? null }]);
        }
        return undefined;
    };
}

const adapter = payload ? createM365Adapter(payload) : undefined;
export function sampleM365Rows(query: string, columns: readonly string[]): unknown[][] | undefined {
    return adapter?.(query, columns);
}
