import { WORK_WEIGHT_GRADES } from "@/lib/grading-method";
import {
    samples, type Activity, type RecordRow, cuts, dateRange, firstDate, groups, hours, hourlyRate,
    lastDate, literals, nameOf, orgAttribute, peopleById, personGroup, project, ratio, rollup,
    selectedActivity, selectedPeople, sessions, sum, timeFor, unique, weeks,
} from "./sample-data";

const GRADES = ["Strong fit", "Fair fit", "Worth a look"];
const OUTCOMES = ["Good match", "Lighter model may do", "Try stronger", "Not judged"];
const distinct = (rows: readonly Activity[]) => unique(rows, row => row.user);
const prompt = (rows: readonly Activity[]) => rows.filter(row => row.prompt);
const last = (values: readonly string[]) => [...values].sort().at(-1) ?? "";
const mean = (values: readonly number[]) => ratio(sum(values, value => value), values.length);
const median = (values: readonly number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length ? (sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2) : null;
};
const verdict = (row: Activity) => !GRADES.includes(row.grade) || !/Frontier|Workhorse/.test(row.sessionTier) ? "Not judged"
    : row.sessionTier.startsWith("Frontier") && row.grade === "Worth a look" ? "Lighter model may do"
    : row.sessionTier.startsWith("Workhorse") && row.grade === "Strong fit" ? "Try stronger" : "Good match";
const stage = (days: number) => days >= 16 ? "Power" : days >= 11 ? "Habitual" : days >= 6 ? "Developing" : days >= 1 ? "Beginner" : "Inactive";

function cohortMetrics(rows: readonly Activity[], query: string): RecordRow {
    const observed = sessions(rows);
    const count = distinct(rows);
    const weekCount = weeks(rows);
    return { Users: count, People: count, "Active Users": count, Sessions: observed.length,
        "Sessions Per User": ratio(observed.length, count), "Sessions Per User Per Week": ratio(observed.length, count * weekCount),
        Hours: hours(rows, query), Tasks: prompt(rows).length };
}

function modelMetrics(rows: readonly Activity[]) {
    const values = sessions(rows);
    const judged = values.filter(row => verdict(row) !== "Not judged");
    const counts = OUTCOMES.map(outcome => values.filter(row => verdict(row) === outcome).length);
    const top = groups(values.filter(row => row.model && row.tier !== "Not attributed"), row => row.model).sort((a, b) => b[1].length - a[1].length)[0];
    return { Sessions: values.length, "Judged Sessions": judged.length, "Judged Share": ratio(judged.length, values.length),
        "Well-matched Sessions": counts[0], "Over-specified Sessions": counts[1], "Under-specified Sessions": counts[2],
        "Well-matched Share": ratio(counts[0], judged.length), "Over-specified Share": ratio(counts[1], judged.length),
        "Under-specified Share": ratio(counts[2], judged.length), "Main Model": top?.[0] ?? "Not logged",
        "Main Reason": top?.[1][0].basis ?? "Insufficient evidence" };
}

function fitMetrics(rows: readonly Activity[]) {
    const graded = sessions(rows).filter(row => GRADES.includes(row.grade));
    const shares = GRADES.map(grade => ratio(graded.filter(row => row.grade === grade).length, graded.length));
    return { Sessions: graded.length, People: distinct(graded), Strong: shares[0], Fair: shares[1], "Worth A Look": shares[2],
        "Flagged People": groups(graded, row => row.user).filter(([, values]) =>
            ratio(values.filter(row => row.grade === "Worth a look").length, values.length) >= 0.5).length };
}

function feedbackDate(value: string) {
    const slash = /^(\d+)\/(\d+)\/(\d{4})/.exec(value);
    return slash ? `${slash[3]}-${slash[1].padStart(2, "0")}-${slash[2].padStart(2, "0")}` : value.slice(0, 10);
}
function feedback(query: string) {
    const range = dateRange(query);
    return samples.feedback.filter(row => ["Thumbs Up", "Thumbs Down"].includes(row["Feedback Type"]))
        .filter(row => !range || feedbackDate(row["Date Submitted UTC"]) >= range.from && feedbackDate(row["Date Submitted UTC"]) <= range.to);
}
function feedbackMetrics(rows: ReturnType<typeof feedback>) {
    const up = rows.filter(row => row["Feedback Type"] === "Thumbs Up").length;
    return { "Total Feedback": rows.length, "Thumbs Up": up, "Thumbs Down": rows.length - up, Satisfaction: ratio(up, rows.length) };
}

/** Native query outputs reduced from the very same published CSV records, never query hashes. */
export function sampleQueryRows(query: string, columns: readonly string[]): unknown[][] | undefined {
    const names = columns.map(nameOf);
    const has = (...keys: string[]) => keys.every(key => names.includes(key));
    const output = (...records: RecordRow[]) => project(columns, records);
    const rows = selectedActivity(query);
    const people = selectedPeople(query);
    const observed = sessions(rows);
    const licensed = rows.filter(row => row.licensed);
    const unlicensed = rows.filter(row => !row.licensed);
    const agents = rows.filter(row => row.audience === "Agents");
    const cowork = rows.filter(row => row.cowork);
    const seats = people.filter(person => person.licensed);
    const metric = cohortMetrics(rows, query);
    const weekCount = weeks(rows);
    const groupColumn = columns.find(column => /Organization|Org Attribute (?:Source|Values)\[Value\]/.test(column)) ?? "Organization";
    const userColumn = columns.find(column => /Audit_UserId/.test(column)) ?? "User";
    const lastMonth = last(rows.map(row => row.month));
    const monthRows = rows.filter(row => row.month === lastMonth);
    const habit = people.map(person => ({ ...person,
        days: unique(monthRows.filter(row => row.user === person.user), row => row.date) }));
    const feedbackRows = feedback(query);
    const ratings = feedbackMetrics(feedbackRows);
    const yes = (value: string) => /^(true|yes|1)$/i.test(value);
    const selectedNames = literals(query, "Agents 365", "Agent name");
    const selectedTypes = literals(query, "Agents 365", "Agent Type Label");
    const registry = samples.agents.filter(agent => (!selectedNames || selectedNames.includes(agent["Agent name"]))
        && (!selectedTypes || selectedTypes.includes(agent["Agent type (A365)"])));
    const liveRegistry = registry.filter(agent => agent["Created in"] && agent["Created in"].toLowerCase() !== "not available" && !yes(agent["Is Blocked"]));
    const scope = (agent: typeof registry[number]) => agent.Availability === "Everyone" ? "Whole organisation"
        : /specific/i.test(agent.Availability) ? "Specific people or groups" : "Not shared";
    const access = (agent: typeof registry[number]) => yes(agent["Can read OneDrive and Sharepoint items"]) || yes(agent["Can extend to Graph connector"])
        ? "Organisation content" : yes(agent["Contains uploaded files"]) ? "Uploaded files only" : "None declared";
    const owner = (agent: typeof registry[number]) => agent["Agent creator source"].toLowerCase() === "unattributed" || !agent["Agent creator"]
        ? "No owner on record" : !agent["Agent creator UPN"] ? "Not checked"
        : !peopleById.has(agent["Agent creator UPN"].toLowerCase()) ? "Owner not found"
        : peopleById.get(agent["Agent creator UPN"].toLowerCase())!.active ? "Owner active" : "Owner disabled";
    const inUse = (agent: typeof registry[number]) => agents.filter(row => row.agent === agent["Agent name"]);
    const flags = (agent: typeof registry[number]) => [
        ...(owner(agent) === "No owner on record" ? ["No owner on record"] : []),
        ...(["Owner not found", "Owner disabled"].includes(owner(agent)) ? ["Owner has left"] : []),
        ...(scope(agent) === "Whole organisation" && access(agent) === "Organisation content" ? ["Org-wide with org data"] : []),
        ...(scope(agent) !== "Not shared" && !inUse(agent).length ? ["Shared, no recorded use"] : []),
    ];

    if (has("Kind", "Value")) {
        const options: RecordRow[] = [
            { Kind: "firstDate", Value: firstDate }, { Kind: "lastDate", Value: lastDate }, { Kind: "people", Value: String(distinct(samples.activity)) },
            ...[...new Set(samples.activity.map(row => row.audience))].sort().map(Value => ({ Kind: "activity", Value })),
            ...[...new Set(samples.people.map(person => person.org))].sort().map(Value => ({ Kind: "organization", Value })),
            ...[...new Set(samples.activity.map(row => row.agent).filter(Boolean))].sort().map(Value => ({ Kind: "agentName", Value })),
            ...[...new Set(samples.activity.map(row => row.agentType).filter(Boolean))].sort().map(Value => ({ Kind: "agentType", Value })),
        ];
        return project(columns, options.map((option, Sort) => ({ ...option, Sort })));
    }
    if (has("Column", "Cardinality")) return output(
        ...(["Organization", "country", "JobTitle"] as const).map((Column, i) => {
            const field = (["org", "country", "job"] as const)[i];
            return { Column, Cardinality: unique(samples.people, row => row[field]), "Max Length": Math.max(...samples.people.map(row => row[field].length)) };
        }));
    if (names.length === 1 && has("Attribute")) return output(...["Organization", "country", "JobTitle"].map(Attribute => ({ Attribute })));
    if (names.length === 1 && has("Value")) return output(...[...new Set(people.map(person => person[orgAttribute(query)]))].sort().map(Value => ({ Value })));
    if (has("Activity", "Source", "Status", "Reason")) return output(...[
        "Audit log", "Copilot licensed users", "Agent 365 registry", "Product feedback", "Consumption Central",
    ].map(Activity => ({ Activity, Source: "Published synthetic CSV samples", Status: "Loaded", Reason: "Offline; no tenant connection" })));
    if (has("Last Date") && names.length === 1) {
        if (/M365 Activity|Agent Performance|Evaluation|Conversations|EvaluationDate/i.test(query)) return output({ "Last Date": null });
        const date = /ProductFeedback/.test(query) ? last(samples.feedback.map(row => feedbackDate(row["Date Submitted UTC"])))
            : /Agents 365|Agent Registry Freshness/.test(query) ? last(samples.agents.map(row => row["Last updated"])) : lastDate;
        return output({ "Last Date": date });
    }

    if (has("Hours", "Licensed Seats", "Skills Available")) return output({
        ...metric, Hours: hours(rows, query, "Typical"), Weeks: weekCount, "Skills Available": samples.times.length,
        "Licensed Seats": seats.length, "Seats In Use": distinct(licensed), "Seats In Use Pct": ratio(distinct(licensed), seats.length),
        "Unlicensed Users": distinct(unlicensed), "Habit Month": lastMonth,
        "Habitual Pct": ratio(habit.filter(person => person.licensed && stage(person.days) === "Habitual").length, seats.length),
        "Power Pct": ratio(habit.filter(person => person.licensed && stage(person.days) === "Power").length, seats.length),
        "Agent Users": distinct(agents), "Agent Hours": hours(agents, query, "Typical"),
        "Agents In Use": unique(agents, row => row.agent), Satisfaction: ratings.Satisfaction, Feedback: ratings["Total Feedback"],
        "People With Organization": distinct(rows.filter(row => Boolean(peopleById.get(row.user)?.org))),
    });
    if (has("Hours Conservative", "Hours Optimistic")) return output({ "Hours Conservative": hours(rows, query, "Conservative"),
        "Hours Optimistic": hours(rows, query, "Optimistic") });
    if (has("First Date", "Last Date", "Licensed Users")) return output({
        "First Date": rows.length ? [...rows.map(row => row.date)].sort()[0] : null, "Last Date": last(rows.map(row => row.date)) || null,
        "Licensed Users": seats.length, "Currency Symbol": "$",
    });
    if (has("Source", "Licence", "Scenario", "Value")) return output(...groups(rows, row => `${row.audience}|${row.licensed}`).flatMap(([, values]) =>
        ["Conservative", "Typical", "Optimistic"].map(Scenario => ({
            Source: values[0].audience, Licence: values[0].licensed ? "Licensed" : "Unlicensed", Scenario,
            Hours: hours(values, query, Scenario), Value: hours(values, query, Scenario) * hourlyRate(query),
        }))));
    if (has("Agent", "Sessions", "Hours", "Value")) return output(...groups(agents, row => row.agent).map(([Agent, values]) => ({
        Agent, Sessions: sessions(values).length, Hours: hours(values, query), Value: hours(values, query) * hourlyRate(query),
    })));
    if (has("Lens", "Category", "All Tasks")) return output(...(["Surface", "Model"] as const).flatMap(Lens =>
        groups(prompt(rows), row => Lens === "Surface" ? row.app : row.model || "Not recorded").map(([Category, values]) => ({
            Lens, Category, "All Tasks": values.length, "Licensed Tasks": values.filter(row => row.licensed).length,
            "Unlicensed Tasks": values.filter(row => !row.licensed).length, "Agent Tasks": values.filter(row => row.audience === "Agents").length,
        }))));
    if (has("Month", "Cohort", "Hours", "Cumulative")) {
        const byPerson = groups(monthRows, row => row.user).map(([user, values]) => ({
            user, days: unique(values, row => row.date), hours: hours(values, query),
        }));
        return output(...groups(byPerson, person => stage(person.days)).map(([Cohort, values]) => ({
            Month: lastMonth, Cohort, People: values.length, Hours: sum(values, person => person.hours),
        })), ...cuts(byPerson.map(person => person.hours)).map(cut => ({ ...cut, Month: lastMonth })));
    }
    if (has("Licensed Seats", "Hours Per Seat Month")) return output(...groups(rows, row => personGroup(row, query)).map(([label, values]) => {
        const seatCount = selectedPeople(query).filter(person => person[orgAttribute(query)] === label && person.licensed).length;
        const used = distinct(values.filter(row => row.licensed));
        return { [groupColumn]: label, "Licensed Seats": seatCount, "Seats In Use Pct": ratio(used, seatCount),
            "Habit Pct": ratio(habit.filter(person => person[orgAttribute(query)] === label && person.licensed && person.days >= 11).length, seatCount),
            Hours: hours(values, query), People: distinct(values),
            "Hours Per Seat Month": ratio(hours(values, query), seatCount * unique(values, row => row.month)) };
    }));
    if (has("Month Start", "Copilot Hours", "Agent Hours")) return output(...groups(rows, row => row.month).sort().map(([month, values]) => ({
        "Month Start": month, Hours: hours(values, query),
        "Copilot Hours": hours(values.filter(row => row.audience === "Copilot"), query),
        "Agent Hours": hours(values.filter(row => row.audience === "Agents"), query), "Cowork Hours": hours(values.filter(row => row.cowork), query),
        Tasks: prompt(values).length, "Seats In Use Pct": ratio(distinct(values.filter(row => row.licensed)), seats.length),
        "Habit Pct": ratio(seats.filter(person => unique(values.filter(row => row.user === person.user), row => row.date) >= 11).length, seats.length),
        Satisfaction: feedbackMetrics(feedbackRows.filter(row => feedbackDate(row["Date Submitted UTC"]).startsWith(month.slice(0, 7)))).Satisfaction,
        Feedback: feedbackRows.filter(row => feedbackDate(row["Date Submitted UTC"]).startsWith(month.slice(0, 7))).length,
    })));
    if (has("Hours", "Tasks", "People") && columns.some(column => /Task Breakdown Category/.test(column))) {
        const column = columns.find(column => /Task Breakdown Category/.test(column))!;
        return output(...groups(rows, row => row.category).map(([label, values]) => ({ [column]: label, ...cohortMetrics(values, query) })));
    }
    if (has("All Tasks", "All Users")) {
        const result: RecordRow = { "Licensed Utilisation": ratio(distinct(licensed), seats.length) };
        for (const [prefix, values] of [["All", rows], ["Licensed", licensed], ["Unlicensed", unlicensed], ["Agent", agents]] as const) {
            result[`${prefix} Tasks`] = prompt(values).length; result[`${prefix} Users`] = distinct(values);
            result[`${prefix} Rate`] = ratio(prompt(values).length, distinct(values) * weeks(values));
        }
        return output(result);
    }
    const prefix = ["All", "Licensed", "Unlicensed", "Agent", "Cowork"].find(value => has(`${value} Users`, `${value} Sessions`, `${value} Per User`));
    if (prefix) {
        const values = { All: rows, Licensed: licensed, Unlicensed: unlicensed, Agent: agents, Cowork: cowork }[prefix]!;
        const count = sessions(values).length;
        return output({ [`${prefix} Users`]: distinct(values), [`${prefix} Sessions`]: count,
            [`${prefix} Per User`]: ratio(count, distinct(values)), [`${prefix} Per Week`]: ratio(count, distinct(values) * weeks(values)),
            "Licence Utilisation": ratio(distinct(licensed), seats.length), "Unlicensed Tasks": prompt(unlicensed).length,
            "Agent Tasks": prompt(agents).length, "Cowork Tasks": prompt(cowork).length });
    }
    if (has("Overall Users", "Overall Hours Wk")) return output({
        "Overall Users": distinct(rows), "Overall Sessions": observed.length, "Overall Hours Wk": ratio(hours(rows, query), weekCount),
        "Overall Top Outcome": groups(rows, row => row.outcome).sort((a, b) => hours(b[1], query) - hours(a[1], query))[0]?.[0],
        "Licensed Users": distinct(licensed), "Unlicensed Users": distinct(unlicensed), "Agent Users": distinct(agents),
        "Cowork Users": distinct(cowork), "Cowork Hours Wk": ratio(hours(cowork, query), weeks(cowork)), "Cowork Top Outcome": "Workflow Automation",
    });
    if (has("Overall SPUW")) return output(Object.fromEntries(
        [["Overall", rows], ["Licensed", licensed], ["Unlicensed", unlicensed], ["Agent", agents], ["Cowork", cowork]].map(([label, values]) => {
            const cohort = typeof values === "string" ? [] : values;
            return [`${label} SPUW`, ratio(sessions(cohort).length, distinct(cohort) * weeks(cohort))];
        })));
    if (has("All Sessions", "Licensed", "Unlicensed", "Agents")) {
        const weekColumn = columns.find(column => /WeekStart/.test(column))!;
        return output(...groups(rows, row => row.week).sort().map(([week, values]) => ({
            [weekColumn]: week, "All Sessions": sessions(values).length, Hours: hours(values, query),
            Licensed: ratio(sessions(values.filter(row => row.licensed)).length, distinct(values.filter(row => row.licensed))),
            Unlicensed: ratio(sessions(values.filter(row => !row.licensed)).length, distinct(values.filter(row => !row.licensed))),
            Agents: ratio(sessions(values.filter(row => row.audience === "Agents")).length, distinct(values.filter(row => row.audience === "Agents"))),
        })));
    }
    if (has("Active Users Headline")) return output({ "Active Users Headline": distinct(rows),
        "Active Days Headline": ratio(unique(rows, row => `${row.user}|${row.date}`), distinct(rows) * weekCount),
        "Expert Hours Headline": ratio(hours(rows, query), distinct(rows) * weekCount),
        "Sessions Headline": ratio(observed.length, distinct(rows) * weekCount) });
    if (has("Active Days Per User", "Expert Hours Per User")) {
        const weekColumn = columns.find(column => /WeekStart/.test(column))!;
        return output(...groups(rows, row => row.week).flatMap(([week, weekly]) => groups(weekly, row => personGroup(row, query)).map(([label, values]) => ({
            [weekColumn]: week, [groupColumn]: label, "Active Users": distinct(values),
            "Active Days Per User": ratio(unique(values, row => `${row.user}|${row.date}`), distinct(values)),
            "Expert Hours Per User": ratio(hours(values, query), distinct(values)), "Sessions Per User": ratio(sessions(values).length, distinct(values)),
        }))));
    }
    if (has("Licensed Active", "Licensed Inactive")) {
        const population = (members: typeof people, values: readonly Activity[]) => {
            const lic = members.filter(person => person.licensed);
            const used = distinct(values.filter(row => row.licensed));
            const unlic = distinct(values.filter(row => !row.licensed));
            const agentUsers = distinct(values.filter(row => row.audience === "Agents"));
            const all = distinct(values);
            return { "Licensed Active": used, "Licensed Inactive": lic.length - used, "Licensed Total": lic.length,
                "Licensed Active Pct": ratio(used, lic.length), "Unlicensed Active": unlic,
                "Unlicensed Inactive": members.filter(person => !person.licensed).length - unlic,
                "Unlicensed Total": members.filter(person => !person.licensed).length,
                "Unlicensed Active Pct": ratio(unlic, members.filter(person => !person.licensed).length),
                "All Active": all, "All Inactive": members.length - all, "All Total": members.length,
                "All Active Pct": ratio(all, members.length), "Agent Active": agentUsers, "Agent NotUsing": members.length - agentUsers,
                "Agent Active Pct": ratio(agentUsers, members.length) };
        };
        return columns.some(column => /Organization|Org Attribute (?:Source|Values)\[Value\]/.test(column))
            ? output(...groups(people, person => person.org).map(([label, members]) => ({ [groupColumn]: label,
                ...population(members, rows.filter(row => members.some(person => person.user === row.user))) })))
            : output(population(people, rows));
    }
    if (has("Power", "Habitual", "Inactive", "Month")) {
        const result: RecordRow = { Month: lastMonth };
        for (const value of [...["Power", "Habitual", "Developing", "Beginner"], "Inactive"]) {
            result[value] = habit.filter(person => person.licensed && stage(person.days) === value).length;
            result[`${value} Pct`] = ratio(Number(result[value]), seats.length);
        }
        return output(result);
    }
    if (has("Stage", "Users", "MonthStart")) {
        const monthColumn = columns.find(column => /MonthStart/.test(column))!;
        const stageColumn = columns.find(column => nameOf(column) === "Stage")!;
        return output(...groups(rows, row => row.month).flatMap(([month, values]) =>
            ["Inactive", "Beginner", "Developing", "Habitual", "Power"].map((value, i) => ({
                [monthColumn]: month, [stageColumn]: `${i} - ${value}`,
                Users: seats.filter(person => stage(unique(values.filter(row => row.user === person.user), row => row.date)) === value).length,
            }))));
    }
    if (has("Month", "Cohort Order", "Licensed", "Unlicensed")) return output(
        ...["Power", "Habitual", "Developing", "Beginner"].map((value, i) => ({ Month: lastMonth, Cohort: value, "Cohort Order": i + 1,
            Licensed: habit.filter(person => person.licensed && stage(person.days) === value).length,
            Unlicensed: habit.filter(person => !person.licensed && stage(person.days) === value).length })));

    if (has("Cowork Sessions", "Fit Notice")) {
        const fit = fitMetrics(cowork);
        return output({ "Cowork Sessions": sessions(cowork).length, "Tasks Completed": prompt(cowork).length,
            "Active Days Per User": ratio(unique(cowork, row => `${row.user}|${row.date}`), distinct(cowork)),
            "Expert Hours": hours(cowork, query), "Strong Fit Share": fit.Strong, "Worth A Look Share": fit["Worth A Look"],
            "Fit Notice": [...WORK_WEIGHT_GRADES.slice(0, 3).map(grade => `${grade.name} · ${grade.rule}`),
                `${fit.Sessions} graded sessions. Shares exclude sessions too light to grade. Balanced setting.`].join("   ") });
    }
    if (has("Task", "Grade", "Task Sessions")) return output(...groups(sessions(cowork).filter(row => GRADES.includes(row.grade)), row => row.category)
        .flatMap(([Task, values]) => GRADES.map((Grade, i) => ({ Task, Grade, "Grade Order": i,
            Share: ratio(values.filter(row => row.grade === Grade).length, values.length),
            Sessions: values.filter(row => row.grade === Grade).length, "Task Sessions": values.length }))));
    if (has("Work Weight Grade", "Work Shape")) {
        const gradeColumn = columns.find(column => nameOf(column) === "Work Weight Grade")!;
        const shapeColumn = columns.find(column => nameOf(column) === "Work Shape")!;
        const graded = sessions(cowork).filter(row => GRADES.includes(row.grade));
        return rollup(columns, graded, row => row.grade, row => row.shape, gradeColumn, shapeColumn, values => ({
            Sessions: values.length, "Share Of Work": ratio(values.length, graded.length),
            "Source Items": median(values.map(row => row.refs)), "Source Types": median(values.map(row => row.types)),
            "Decided By": [...new Set(values.map(row => row.basis))].join("; "), "Could Have Used": values.every(row => row.grade === "Worth a look") ? "Copilot Chat" : "",
        }));
    }
    if (has("Flagged People", "Strong", "Fair", "Worth A Look")) return rollup(columns, cowork, row => personGroup(row, query),
        row => row.user, groupColumn, userColumn, fitMetrics);
    if (has("Logged Share", "Coverage Notice")) return output({ ...modelMetrics(rows),
        "Logged Share": ratio(observed.filter(row => row.model && row.tier !== "Not attributed").length, observed.length),
        "Coverage Notice": "Source-backed synthetic sessions; verdict shares divide by judged sessions, not all sessions." });
    if (has("Model", "Cost Tier", "Usage Share")) {
        const logged = observed.filter(row => row.model && row.tier !== "Not attributed");
        return output(...groups(logged, row => row.model).map(([Model, values]) => ({
            Model, "Cost Tier": values[0].tier, "Tier Sort": values[0].tier.startsWith("Frontier") ? 1 : 2,
            Sessions: values.length, "Usage Share": ratio(values.length, logged.length),
        })));
    }
    if (has("Activity", "Outcome", "Outcome Order", "Share")) return output(...groups(observed, row => row.audience)
        .flatMap(([Activity, values]) => OUTCOMES.map((Outcome, i) => ({
            Activity, Outcome, "Outcome Order": i + 1, Sessions: values.filter(row => verdict(row) === Outcome).length,
            Share: ratio(values.filter(row => verdict(row) === Outcome).length, values.length),
        }))));
    if (has("Segment", "Judged Sessions", "Main Model")) {
        const grouping = /SUMMARIZECOLUMNS\(\s*([^,\n]+)/i.exec(query)?.[1] ?? "";
        return output(...groups(rows, row => /Audit_UserId/.test(grouping) ? row.user
            : /Task Breakdown/.test(grouping) ? row.group : personGroup(row, query)).map(([Segment, values]) => ({
                Segment, ...modelMetrics(values),
            })).sort((a, b) => b.Sessions - a.Sessions).slice(0, 25));
    }
    if (has("Active Users", "Sessions", "Is Grand Total")) {
        const byPeople = columns.some(column => /Audit_UserId/.test(column));
        const group = byPeople ? groupColumn : columns.find(column => /AppHost/.test(column))!;
        const leaf = byPeople ? userColumn : columns.find(column => /Behavior_Enriched/.test(column))!;
        return rollup(columns, rows, row => byPeople ? personGroup(row, query) : row.app,
            row => byPeople ? row.user : row.behavior, group, leaf, values => cohortMetrics(values, query));
    }
    if (has("Count", "Cumulative", "People", "Total") && !has("Cohort")) return output(
        ...cuts(groups(rows, row => row.user).map(([, values]) => sessions(values).length)));

    if (has("Expert Equivalent Hours Per Week", "AI Assisted Value", "Projected Annualised Value")) {
        const total = hours(rows, query);
        return output({ "Expert Equivalent Hours Per Week": ratio(total, weekCount), "AI Assisted Value": total * hourlyRate(query),
            "AI Assisted Value Per Week": ratio(total * hourlyRate(query), weekCount),
            "Projected Annualised Value": ratio(total * hourlyRate(query), weekCount) * 52, "Currency Symbol": "$" });
    }
    if (has("Activity Share", "Expert Equivalent Hours Per Week")) {
        const group = columns.find(column => /Task Breakdown Group/.test(column))!;
        const leaf = columns.find(column => /Task Breakdown Category/.test(column))!;
        return rollup(columns, rows, row => row.group, row => row.category, group, leaf, values => ({
            "Activity Share": ratio(prompt(values).length, prompt(rows).length),
            "Expert Equivalent Hours Per Week": ratio(hours(values, query), weekCount),
            "AI Assisted Value Per Week": ratio(hours(values, query) * hourlyRate(query), weekCount),
        }));
    }
    if (has("Active Users", "Expert Equivalent Hours Per Week")) return output(...groups(rows, row => personGroup(row, query)).map(([label, values]) => ({
        [groupColumn]: label, "Active Users": distinct(values), "Expert Equivalent Hours Per Week": ratio(hours(values, query), weekCount),
        "AI Assisted Value": hours(values, query) * hourlyRate(query),
    })));
    if (has("Active Agent Users", "Observed Agent Sessions")) {
        const agentColumn = columns.find(column => /AgentName/.test(column))!;
        return output(...groups(agents, row => row.agent).map(([label, values]) => ({ [agentColumn]: label,
            "Active Agent Users": distinct(values), "Observed Agent Sessions": sessions(values).length,
            "Expert Equivalent Hours": hours(values, query), "AI Assisted Value": hours(values, query) * hourlyRate(query) })));
    }
    if (has("Dimension", "Category", "Tasks", "Share")) {
        return output(...([["Behaviour", "behavior"], ["Workflow action", "workflow"], ["Value outcome", "outcome"]] as const)
            .flatMap(([Dimension, field]) => groups(prompt(rows), row => row[field]).map(([Category, values]) => ({
                Dimension, Category: Category || "Unclassified", Tasks: values.length, Share: ratio(values.length, prompt(rows).length),
            }))));
    }
    if (has("Page", "Metric", "Description")) return output(...samples.glossary.map(row => ({
        ...row, "Page Description": row.PageDescription, "Page Order": Number(row.PageOrder), "Metric Order": Number(row.MetricOrder),
    })));
    if (has("Top Value Outcome")) return output({ "Top Value Outcome": groups(rows, row => row.outcome)
        .sort((a, b) => hours(b[1], query) - hours(a[1], query))[0]?.[0] });

    if (has("Low", "Typical", "High", "Grain")) return output(...samples.times.map(row => ({
        Task: row.Behavior, Category: row.Category, Grain: row["Effort Grain"], Low: Number(row["Min Low"]),
        Typical: Number(row["Min Typical"]), High: Number(row["Min High"]), Source: row["Primary Source"],
        "Source URL": row["Source URL"], Confidence: row.Confidence,
    })));
    if (has("Hours Per Minute")) {
        const behavior = columns.find(column => /Behavior/.test(column))!;
        return output(...groups(rows.filter(row => !row.cowork), row => row.behavior).map(([task, values]) => ({
            [behavior]: task, "Hours Per Minute": ratio(hours(values, "", "Typical"), timeFor("", task, "Typical")),
        })));
    }
    if (has("Signal", "AI Tasks", "Human Equivalent (Minutes)")) return output(...samples.signals.map(row => {
        const time = samples.times.find(time => time.Behavior === row.Behavior);
        return { Signal: row.Signal, "AI Tasks": row.Behavior, "Use Case": row["Use Case"], "Value Outcome": row["Value Outcome"],
            "Human Equivalent (Minutes)": time ? Number(time["Min Typical"]) : null, "Research Source": time?.["Primary Source"],
            "Source URL": time?.["Source URL"], Confidence: time?.Confidence, Category: time?.Category };
    }));
    if (has("Total Feedback", "Theme Summary")) return output({ ...ratings,
        "Theme Summary": "Ratings and comments come from the published synthetic product-feedback export; other survey types are excluded." });
    if (has("Feedback Type", "Comment")) return output(...feedbackRows.filter(row => row.Comment)
        .sort((a, b) => feedbackDate(b["Date Submitted UTC"]).localeCompare(feedbackDate(a["Date Submitted UTC"]))).slice(0, 100).map(row => ({
            "Date Submitted": feedbackDate(row["Date Submitted UTC"]), "Feedback Type": row["Feedback Type"], "Feedback Emoji": row["Feedback Type"],
            Category: row.App, "Surface / Agent": row.App, Comment: row.Comment,
        })));
    if (has("Feedback Type", "Count")) {
        const weekly = has("Week Start");
        const key = (row: (typeof feedbackRows)[number]) => {
            const date = new Date(`${feedbackDate(row["Date Submitted UTC"])}T00:00:00Z`);
            date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
            return weekly ? date.toISOString().slice(0, 10) : row.App;
        };
        return output(...groups(feedbackRows, key).flatMap(([label, values]) => ["Thumbs Up", "Thumbs Down"].map(type => ({
            [weekly ? "Week Start" : "Category"]: label, "Feedback Type": type, Count: values.filter(row => row["Feedback Type"] === type).length,
            "Signed Count": values.filter(row => row["Feedback Type"] === type).length * (type === "Thumbs Up" ? 1 : -1),
            ...feedbackMetrics(values),
        }))));
    }
    if (has("Surface / Agent", "Thumbs Up", "Thumbs Down")) return output(
        ...groups(feedbackRows, row => row.App).map(([label, values]) => ({ "Surface / Agent": label, ...feedbackMetrics(values) })));

    if (has("Total Licensed Users", "License Inventory Usable")) return output({
        "Total Licensed Users": seats.length, "Avg Days Since Last Active": mean(seats.map(person => {
            const date = last(rows.filter(row => row.user === person.user).map(row => row.date));
            return date ? (Date.parse(lastDate) - Date.parse(date)) / 86400000 : 92;
        })), "License Inventory Usable": true, "License Evidence Notice": "Published synthetic user/license inventory.",
        "Reclaim Cost Notice": "Idle seats are candidates for review, not confirmed savings.",
    });
    if (has("Dormancy Bucket", "Licensed Users")) {
        const counts = [0, 0, 0, 0];
        for (const person of seats) {
            const latest = last(rows.filter(row => row.user === person.user).map(row => row.date));
            const days = latest ? (Date.parse(lastDate) - Date.parse(latest)) / 86400000 : 999;
            counts[days < 8 ? 0 : days < 30 ? 1 : days < 60 ? 2 : 3]++;
        }
        return output(...["Active in last 7 days", "8-29 days idle", "30-59 days idle", "60+ days idle"].map((label, i) => ({
            "Dormancy Bucket": label, "Dormancy Bucket Order": i + 1, "Licensed Users": counts[i] })));
    }
    if (has("Active Unlicensed Users", "Unlicensed Share")) return output({
        "Active Unlicensed Users": distinct(unlicensed), "Unlicensed Share": ratio(distinct(unlicensed), distinct(rows)),
        "Median Sessions Per User Per Week": median(groups(unlicensed, row => row.user).map(([, values]) => ratio(sessions(values).length, weeks(values)))),
        "Observed Sessions Per User Per Week": ratio(sessions(unlicensed).length, distinct(unlicensed) * weeks(unlicensed)),
    });
    if (has("Priority Score", "User") || has("Active Days", "Cohort", "User")) {
        const candidates = groups(unlicensed, row => row.user).sort((a, b) => sessions(b[1]).length - sessions(a[1]).length);
        return output(...candidates.map(([User, values], i) => {
            const days = unique(monthRows.filter(row => row.user === User), row => row.date);
            return { Rank: i + 1, User, Organization: personGroup(values[0], query), "Priority Score": sessions(values).length,
                "Sessions Per Week": ratio(sessions(values).length, weeks(values)),
                "Active Days Per Week": ratio(unique(values, row => row.date), weeks(values)),
                "Workloads Per Day": ratio(unique(values, row => `${row.app}|${row.date}`), unique(values, row => row.date)),
                "Active Days": days, Cohort: stage(days), Total: candidates.length };
        }));
    }
    if (has("Active Unlicensed Users", "Organization")) return output(...groups(unlicensed, row => personGroup(row, query)).map(([Organization, values]) => ({
        Organization, "Active Unlicensed Users": distinct(values),
        "Active Days Per Week": ratio(unique(values, row => `${row.user}|${row.date}`), distinct(values) * weeks(values)),
        "Sessions Per User Per Week": ratio(sessions(values).length, distinct(values) * weeks(values)),
    })));
    if (has("Eligible Users", "Surfaces Per Day") || has("Surfaces Per Day", "Uses Agents")) {
        const triedCowork = new Set(samples.activity.filter(row => row.cowork).map(row => row.user));
        const candidates = groups(rows.filter(row => !row.cowork && !triedCowork.has(row.user)), row => row.user).map(([User, values]) => ({
            User, Organization: personGroup(values[0], query),
            "Surfaces Per Day": ratio(unique(values, row => `${row.date}|${row.app}`), unique(values, row => row.date)),
            "Prompts Per Session": ratio(prompt(values).length, sessions(values).length),
            "Uses Agents": values.some(row => row.audience === "Agents"), Depths: unique(values, row => row.app),
        })).sort((a, b) => b["Surfaces Per Day"] - a["Surfaces Per Day"]);
        const summarize = (values: typeof candidates) => ({ "Eligible Users": values.length,
            "Surfaces Per Day": mean(values.map(row => row["Surfaces Per Day"])),
            "Prompts Per Session": mean(values.map(row => row["Prompts Per Session"])),
            "Agent User Share": ratio(values.filter(row => row["Uses Agents"]).length, values.length) });
        if (has("Rank")) {
            const maxBreadth = Math.max(0, ...candidates.map(row => row["Surfaces Per Day"]));
            const maxDepth = Math.max(0, ...candidates.map(row => row["Prompts Per Session"]));
            const scored = candidates.map(row => ({ ...row, score: Math.round(45 * ratio(row["Surfaces Per Day"], maxBreadth)
                + 35 * ratio(row["Prompts Per Session"], maxDepth) + 20 * Number(row["Uses Agents"])) }));
            return output(...scored.sort((a, b) => b.score - a.score).map(row => ({
                ...row, "Uses Agents": row["Uses Agents"] ? "Yes" : "No",
                Rank: new Set(scored.filter(other => other.score > row.score).map(other => other.score)).size + 1,
                Depths: new Set(candidates.map(value => value["Prompts Per Session"])).size, Total: candidates.length,
            })));
        }
        return has("Organization") ? output(...groups(candidates, row => row.Organization).map(([Organization, values]) => ({
            Organization, ...summarize(values),
        }))) : output(summarize(candidates));
    }
    if (has("Agent Users", "Agent User Share", "Agent Sessions")) return output({
        "Agent Users": distinct(agents), "Agent User Share": ratio(distinct(agents), distinct(rows)),
        "Agent Sessions": sessions(agents).length, "Sessions Per User": ratio(sessions(agents).length, distinct(agents)),
    });
    if (has("Registry Agents", "Unmatched Sessions")) return output({
        "Registry Agents": samples.agents.length, "Tenant Built": samples.agents.length,
        "Seen In Use": unique(agents, row => row.agent), "Unmatched Sessions": sessions(agents.filter(row => !samples.agents.some(agent => agent["Agent name"] === row.agent))).length,
        "Registry Updated": last(samples.agents.map(row => row["Last updated"])),
    });
    if (has("Agent Key") || has("Agent", "Sessions", "Users") || has("Functions") || has("In Use", "Registered")) {
        const activity = groups(agents, row => row.agent).sort((a, b) => sessions(b[1]).length - sessions(a[1]).length);
        const entries = activity.map(([Agent, values]) => {
            const registry = samples.agents.find(row => row["Agent name"] === Agent);
            const functions = unique(values, row => peopleById.get(row.user)?.job ?? "");
            return { Agent, "Agent Key": Agent, "Registry Id": registry?.["Title ID"] ?? Agent, "In Registry": Boolean(registry),
                Type: registry?.["Agent type (A365)"] ?? values[0].agentType, Creator: registry?.["Agent creator"] ?? "Not in registry",
                Users: distinct(values), Sessions: sessions(values).length, "Sessions Per User": ratio(sessions(values).length, distinct(values)),
                "Orgs Reached": unique(values, row => personGroup(row, query)), "Last Activity": last(values.map(row => row.date)),
                Features: registry?.["Supported in"], Lifecycle: registry?.Status ?? "Not in registry", Adoption: "In use",
                Description: registry?.["Agent description"], Functions: functions, Total: activity.length };
        });
        const most = entries[0]?.Sessions ?? 0;
        const mostOrgs = Math.max(0, ...entries.map(row => row["Orgs Reached"]));
        const mostFunctions = Math.max(0, ...entries.map(row => row.Functions));
        const sessionLeaders = entries.filter(row => row.Sessions === most);
        const orgLeaders = entries.filter(row => row["Orgs Reached"] === mostOrgs);
        const functionLeaders = entries.filter(row => row.Functions === mostFunctions);
        const phrase = (values: typeof entries) => values.length <= 2 ? values.map(row => row.Agent).join(" and ")
            : `${values[0].Agent}, ${values[1].Agent} and ${values.length - 2} ${values.length === 3 ? "other" : "others"}`;
        return output(...(has("Functions") ? functionLeaders.slice(0, 2) : entries).map(row => ({
            ...row, "Top Sessions": most, "Session Leaders": phrase(sessionLeaders), "Session Leader Count": sessionLeaders.length,
            "Top Orgs": mostOrgs, "Org Leaders": phrase(orgLeaders), "Org Leader Count": orgLeaders.length,
            "Leader Count": functionLeaders.length, "In Use": entries.length, Registered: samples.agents.length,
        })));
    }
    if (has("Needs Review", "Tenant Agents")) return output({
        "Tenant Agents": liveRegistry.length, "Needs Review": liveRegistry.filter(agent => flags(agent).length).length, "No Sign In": null,
        "Owner Left": liveRegistry.filter(agent => ["Owner disabled", "Owner not found"].includes(owner(agent))).length,
        "No Owner": liveRegistry.filter(agent => owner(agent) === "No owner on record").length,
        "Org Wide Org Data": liveRegistry.filter(agent => flags(agent).includes("Org-wide with org data")).length,
        "Shared Unused": liveRegistry.filter(agent => flags(agent).includes("Shared, no recorded use")).length,
        "Org Wide": liveRegistry.filter(agent => scope(agent) === "Whole organisation").length,
        "Owners Checked": liveRegistry.filter(agent => owner(agent) !== "Not checked").length,
        "Seen In Use": liveRegistry.filter(agent => inUse(agent).length).length,
    });
    if (has("Sharing Scope", "Data Access", "Unused Agents")) return output(
        ...groups(liveRegistry, row => `${scope(row)}|${access(row)}`).map(([, values], i) => ({ "Scope Order": i + 1, "Sharing Scope": scope(values[0]),
            "Access Order": i + 1, "Data Access": access(values[0]), Agents: values.length, "Unused Agents": values.filter(agent => !inUse(agent).length).length })));
    if (has("Owner Status", "Agents")) return output(...groups(liveRegistry, owner).map(([label, values], i) => ({
        "Status Order": i + 1, "Owner Status": label, Agents: values.length,
    })));
    if (has("Flags", "Priority")) {
        const queue = liveRegistry.filter(agent => flags(agent).length);
        return output(...queue.map(agent => ({
            Agent: agent["Agent name"], "Registry Id": agent["Title ID"], Type: agent["Agent type (A365)"], Creator: agent["Agent creator"],
            "Sharing Scope": scope(agent), "Data Access": access(agent), Users: distinct(inUse(agent)), "Owner Account": owner(agent),
            "Flag Count": flags(agent).length, Priority: sum(flags(agent), flag => flag === "Owner has left" ? 3 : flag === "Shared, no recorded use" ? 1 : 2),
            Flags: flags(agent).join("; "), Total: queue.length,
        })).sort((a, b) => b.Priority - a.Priority || b.Users - a.Users));
    }
    if (has("Lifecycle", "Agents")) return output(...groups(registry, row => row.Status || "Not recorded").map(([Lifecycle, values], i) => ({
        "Lifecycle Order": i + 1, Lifecycle, Type: "Registry", Agents: values.length,
    })));

    // The published sample pack has no M365 telemetry, evaluation transcripts, Defender or Resource Graph data.
    if (has("Rows", "Concealed Share")) return output({ Rows: 0, People: 0, "First Date": null, "Last Date": null, "Concealed Share": null });
    if (has("Transcripts", "Lookback Days")) return output({ Environment: "Offline sample pack", "Lookback Days": 0, Transcripts: 0, Status: "Not loaded" });
    if (has("Configured Agents", "Agent Status")) return output({ "Configured Agents": 0, "Matched Agents": 0, "No Sign In": 0,
        "No Sign In Configured": 0, "Web Search": 0, "Web Search Configured": 0, "Foundry Resources": 0,
        "Foundry Public": 0, "Foundry Public Projects": 0, "Agent Status": "not_loaded", "Foundry Status": "not_loaded" });
    if (has("Tools Watched", "Tools Found")) return output({ "Tools Watched": 0, "Unsanctioned Tools": 0, "Tools Found": 0,
        "Tools This Week": 0, Devices: 0, Users: 0, "Cloud Users": 0, Status: "not_loaded" });
    if (has("Probe", "Run At")) return output(...["device_activity", "installed", "agents", "cloud_discovery"].map(Probe => ({
        Probe, Status: "not_loaded", Source: "Published synthetic sample pack", Rows: 0,
        Message: "This source is not included in the published sample files.", "Run At": null,
    })));
    if (names.some(name => /M365 People|Workloads Per Active Day|Apps Used|Copilot Reach|Configured Agents/.test(name))
        || has("Platform", "Reach") || has("App", "Reach") || has("Workload", "People") || has("Metric", "Index")
        || has("Conversations", "Resolution Rate") || has("Theme", "Conversations") || has("Topics", "Theme Summary")
        || has("Tool", "Posture")) return [];
    return undefined;
}
