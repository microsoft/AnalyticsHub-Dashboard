import { describe, expect, it } from "vitest";
import { applyDaxFilters, dateBetween, treatAs } from "@/lib/dax-filters";
import consumptionByProductQuery from "../queries/consumption/consumption-by-product.dax?raw";
import executiveSummaryQuery from "../queries/executive/executive-summary.dax?raw";
import { executiveSummary } from "../queries/executive/executive-summary";
import { executiveDepartments } from "../queries/executive/executive-departments";
import { executiveHoursRange } from "../queries/executive/executive-hours-range";
import { executiveMonths } from "../queries/executive/executive-months";
import habitLicenceQuery from "../queries/licensing/habit-licence-matrix.dax?raw";
import { costValueAgents, costValueBySource } from "../queries/value/cost-vs-value";
import { toValueTaskTree, valueByTask } from "../queries/value/value-by-task";
import { organizationValue } from "../queries/value/organization-value";
import { valueSummary } from "../queries/value/value-summary";
import { taskBreakdown } from "../queries/work/task-breakdown";
import { workSummary } from "../queries/work/work-summary";
import { leaderboardPeople, toLeaderboardPeopleTree } from "../queries/work/leaderboard-people";
import { surfaceUsage } from "../queries/work/surface-usage";
import m365SummaryQuery from "../queries/work-patterns/m365-summary.dax?raw";
import {
    answerArchetypes,
    conversationsSummary,
    feedbackComments,
    knowledgeSources,
    themeOutcomes,
    toTopicTree,
    topicHealth,
} from "../queries/agent-evaluation/conversations";
import { toDataTable } from "../lib/to-data-table";
import { syntheticQueryResult } from "./synthetic-model";

describe("synthetic demo model", () => {
    function metadata(...names: string[]) {
        return Object.fromEntries(names.map((name) => [name, { name: name.slice(1, -1) }]));
    }

    it("returns deterministic results for the supplied output schema", () => {
        const query = 'EVALUATE ROW("Hours", 100, "People", 20)';
        const metadata = {
            "[Hours]": { name: "Hours" },
            "[People]": { name: "People" },
        };
        const first = syntheticQueryResult(query, metadata);
        const second = syntheticQueryResult(query, metadata);

        expect(first).toEqual(second);
        expect(first.status).toBe("success");
        if (first.status !== "success") return;
        expect(first.table.columns.map(({ name }) => name)).toEqual(["[Hours]", "[People]"]);
        expect(first.table.rows).toHaveLength(1);
    });

    it("changes sample metrics when the app adds different filters to a query", () => {
        const metadata = { "[Hours]": { name: "Hours" } };
        const allTeams = syntheticQueryResult('EVALUATE ROW("Hours", 100) // all teams', metadata);
        const oneTeam = syntheticQueryResult('EVALUATE ROW("Hours", 100) // one team', metadata);

        expect(allTeams.status).toBe("success");
        expect(oneTeam.status).toBe("success");
        if (allTeams.status !== "success" || oneTeam.status !== "success") return;
        expect(allTeams.table.rows[0]).not.toEqual(oneTeam.table.rows[0]);
    });

    it("provides synthetic options and labels without personal or tenant identifiers", () => {
        const options = syntheticQueryResult('EVALUATE UNION("Kind", "Value")');
        const attributes = syntheticQueryResult('EVALUATE SELECTCOLUMNS("Column", "Cardinality", "Max Length")');
        const serialized = JSON.stringify([options, attributes]);

        expect(options.status).toBe("success");
        expect(attributes.status).toBe("success");
        expect(serialized).not.toMatch(/@|[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/i);
        if (options.status !== "success") return;
        expect(options.table.rows).toContainEqual(["agentName", "Knowledge Assistant"]);
    });

    it("keeps metric values numeric and supplies a dated habit range", () => {
        const result = syntheticQueryResult('EVALUATE ROW("Tasks", 0, "People", 0, "Weeks", 0, "Habit Month", BLANK())', {
            "[Tasks]": { name: "Tasks" },
            "[People]": { name: "People" },
            "[Weeks]": { name: "Weeks" },
            "[Habit Month]": { name: "Habit Month" },
            "[Overall Top Outcome]": { name: "Overall Top Outcome" },
        });

        expect(result.status).toBe("success");
        if (result.status !== "success") return;
        const [tasks, people, weeks, month, outcome] = result.table.rows[0];
        expect(tasks).toEqual(expect.any(Number));
        expect(people).toEqual(expect.any(Number));
        expect(weeks).toEqual(expect.any(Number));
        expect(month).toMatch(/^2026-\d{2}-\d{2}$/);
        expect(outcome).toEqual(expect.stringContaining(" "));
    });

    it("infers grouped columns and aliased measures from a trend query without metadata", () => {
        const query = `EVALUATE
            SUMMARIZECOLUMNS(
                'Synthetic Activity'[WeekStart],
                "Licensed", [Licensed Sessions per User],
                "All Sessions", [Observed Sessions]
            )`;
        const result = syntheticQueryResult(query);

        expect(result.status).toBe("success");
        if (result.status !== "success") return;
        expect(result.table.columns.map(({ name }) => name)).toEqual([
            "Synthetic Activity[WeekStart]",
            "[Licensed]",
            "[All Sessions]",
        ]);
        expect(result.table.rows).toHaveLength(8);
        expect(result.table.rows[0][0]).toMatch(/^2026-\d{2}-\d{2}$/);
        expect(result.table.rows[0][1]).toEqual(expect.any(Number));
        expect(result.table.rows[0][1]).toBeLessThan(10);
    });

    it("keeps split query parts available for synthetic monthly credit charts", () => {
        const query = `EVALUATE
            UNION(
                ADDCOLUMNS(SUMMARIZECOLUMNS('Synthetic'[Month Start], "Studio Credits", [Credits]), "Part", "trend"),
                ADDCOLUMNS(SUMMARIZECOLUMNS('Synthetic'[Month Start], "Studio Credits", [Credits]), "Part", "range")
            )`;
        const result = syntheticQueryResult(query, {
            "[Month Start]": { name: "Month Start" },
            "[Studio Credits]": { name: "Studio Credits" },
        });

        expect(result.status).toBe("success");
        if (result.status !== "success") return;
        const part = result.table.columns.findIndex(({ name }) => name === "[Part]");
        expect(part).toBeGreaterThanOrEqual(0);
        expect(new Set(result.table.rows.map((row) => row[part]))).toEqual(new Set(["trend", "range"]));
        expect(result.table.rows).toHaveLength(12);
    });

    it("returns all habit cohorts with a complete, monotonic concentration curve", () => {
        const columns = ["[Month]", "[Cohort]", "[People]", "[Hours]", "[Count]", "[Cumulative]", "[Total]"];
        const result = syntheticQueryResult("EVALUATE VALUE BY HABIT", metadata(...columns));

        expect(result.status).toBe("success");
        if (result.status !== "success") return;
        const at = (name: string) => result.table.columns.findIndex((column) => column.name === name);
        const cohorts = result.table.rows.filter((row) => row[at("[Cohort]")] != null);
        const cuts = result.table.rows.filter((row) => row[at("[Count]")] != null);
        expect(cohorts.map((row) => row[at("[Cohort]")])).toEqual(["Power", "Habitual", "Developing", "Beginner"]);
        expect(cuts.length).toBeGreaterThan(20);
        expect(cuts.at(-1)?.[at("[Cumulative]")]).toBe(cuts.at(-1)?.[at("[Total]")]);
        expect(cuts.every((row, index) => index === 0 || Number(row[at("[Cumulative]")]) >= Number(cuts[index - 1][at("[Cumulative]")]))).toBe(true);
    });

    it("returns coherent leaderboard rollups and the concentration cuts they require", () => {
        const rollupColumns = [
            "Chat + Agent Org DataOrganization",
            "Chat + Agent Interactions (Audit Logs)Audit_UserId",
            "[Is Grand Total]",
            "[Is Group Total]",
            "[Active Users]",
            "[Sessions]",
            "[Sessions Per User Per Week]",
        ];
        const leaderboard = syntheticQueryResult("EVALUATE LEADERBOARD", metadata(...rollupColumns));
        const concentration = syntheticQueryResult("EVALUATE CONCENTRATION", metadata("[Count]", "[Cumulative]", "[People]", "[Total]"));

        expect(leaderboard.status).toBe("success");
        expect(concentration.status).toBe("success");
        if (leaderboard.status !== "success" || concentration.status !== "success") return;
        expect(leaderboard.table.rows.some((row) => row[leaderboard.table.columns.findIndex((column) => column.name === "[Is Grand Total]")] === true)).toBe(true);
        expect(leaderboard.table.rows.filter((row) => row[leaderboard.table.columns.findIndex((column) => column.name === "[Is Group Total]")] === true)).toHaveLength(4);
        expect(concentration.table.rows.map((row) => row[0])).toEqual([2, 9, 45]);
    });

    it("keeps the leaderboard organization groups when adapting the real query", () => {
        const query = leaderboardPeople();
        const result = syntheticQueryResult(query.query, query.columnMetadata);

        expect(result.status).toBe("success");
        if (result.status !== "success") return;
        const tree = toLeaderboardPeopleTree(toDataTable(result.table, query.columnMetadata!), "Unassigned organization");
        expect(tree.rows.map((row) => row.Who)).toEqual([
            "Engineering",
            "Operations",
            "Research",
            "Customer Success",
        ]);
        expect(tree.rows.every((row) => Array.isArray(row._children) && row._children.length > 0)).toBe(true);
    });

    it("infers SELECTCOLUMNS schemas when no semantic metadata is supplied", () => {
        const query = `EVALUATE
            SELECTCOLUMNS(
                FILTER('Synthetic People', [Active] = TRUE()),
                "Month", DATE(2026, 10, 1),
                "Cohort", "Power",
                "Cohort Order", 1,
                "Licensed", 18,
                "Unlicensed", 2
            )`;
        const result = syntheticQueryResult(query);

        expect(result.status).toBe("success");
        if (result.status !== "success") return;
        expect(result.table.columns.map((column) => column.name)).toEqual([
            "[Month]", "[Cohort]", "[Cohort Order]", "[Licensed]", "[Unlicensed]",
        ]);
        expect(result.table.rows).toHaveLength(4);
    });

    it("builds the real habit-licence query as four populated cohort rows", () => {
        const result = syntheticQueryResult(habitLicenceQuery);

        expect(result.status).toBe("success");
        if (result.status !== "success") return;
        expect(result.table.columns.map((column) => column.name)).toEqual([
            "[Month]", "[Cohort]", "[Cohort Order]", "[Licensed]", "[Unlicensed]",
        ]);
        expect(result.table.rows.map((row) => row[1])).toEqual(["Power", "Habitual", "Developing", "Beginner"]);
    });

    it("populates consumption product totals for every product card", () => {
        const result = syntheticQueryResult(consumptionByProductQuery);

        expect(result.status).toBe("success");
        if (result.status !== "success") return;
        const columns = result.table.columns.map((column) => column.name);
        const product = columns.indexOf("[Product]");
        const cost = columns.indexOf("[Cost]");
        const coverage = columns.indexOf("[Coverage]");
        expect(result.table.rows.map((row) => row[product])).toEqual(["Cowork / Work IQ", "Copilot Studio", "Azure AI Foundry"]);
        expect(result.table.rows.every((row) => typeof row[cost] === "number" && String(row[coverage]).startsWith("Date span covered"))).toBe(true);
    });

    it("keeps M365 weekly summary metrics numeric and leaderboard ratios defined", () => {
        const summary = syntheticQueryResult(m365SummaryQuery);
        const leaderboard = syntheticQueryResult("EVALUATE LEADERBOARD SUMMARY", metadata(
            "[All Users]", "[All Sessions]", "[All Per User]", "[All Per Week]",
        ));

        expect(summary.status).toBe("success");
        expect(leaderboard.status).toBe("success");
        if (summary.status !== "success" || leaderboard.status !== "success") return;
        const m365Columns = summary.table.columns.map((column) => column.name);
        for (const column of ["[Active Days Per Week]", "[Meetings Per Week]", "[Call Hours Per Week]", "[Emails Sent Per Week]", "[Chats Per Week]"]) {
            expect(typeof summary.table.rows[0][m365Columns.indexOf(column)]).toBe("number");
        }
        const row = leaderboard.table.rows[0];
        const sessions = Number(row[leaderboard.table.columns.findIndex((column) => column.name === "[All Sessions]")]);
        const users = Number(row[leaderboard.table.columns.findIndex((column) => column.name === "[All Users]")]);
        expect(row[leaderboard.table.columns.findIndex((column) => column.name === "[All Per Week]")]).toBeCloseTo(sessions / users / 26);
    });

    it("populates the executive summary measures", () => {
        const result = syntheticQueryResult(executiveSummaryQuery, executiveSummary().columnMetadata);

        expect(result.status).toBe("success");
        if (result.status !== "success") return;
        const columns = result.table.columns.map((column) => column.name);
        for (const column of ["[Hours]", "[Tasks]", "[People]", "[Habitual Pct]", "[Satisfaction]"]) {
            expect(result.table.rows[0][columns.indexOf(column)], column).toEqual(expect.any(Number));
        }
    });

    it("keeps executive headline, range, organization, and monthly charts on one fixture", () => {
        const summary = executiveSummary();
        const range = executiveHoursRange();
        const departments = executiveDepartments();
        const months = executiveMonths();
        const summaryResult = syntheticQueryResult(summary.query, summary.columnMetadata);
        const rangeResult = syntheticQueryResult(range.query, range.columnMetadata);
        const departmentResult = syntheticQueryResult(departments.query, departments.columnMetadata);
        const monthResult = syntheticQueryResult(months.query, months.columnMetadata);

        for (const result of [summaryResult, rangeResult, departmentResult, monthResult]) {
            expect(result.status).toBe("success");
            if (result.status === "success") expect(result.table.rows.length).toBeGreaterThan(0);
        }
        if (
            summaryResult.status !== "success" ||
            rangeResult.status !== "success" ||
            departmentResult.status !== "success" ||
            monthResult.status !== "success"
        ) return;

        const at = (result: { table: { columns: readonly { name: string }[] } }, name: string) =>
            result.table.columns.findIndex((column) => column.name === name);
        const summaryRow = summaryResult.table.rows[0];
        const hours = Number(summaryRow[at(summaryResult, "[Hours]")]);
        const seats = Number(summaryRow[at(summaryResult, "[Licensed Seats]")]);
        const seatsInUse = Number(summaryRow[at(summaryResult, "[Seats In Use]")]);
        expect(hours).toBe(165);
        expect(summaryRow[at(summaryResult, "[Seats In Use Pct]")]).toBeCloseTo(seatsInUse / seats);
        expect(Number(rangeResult.table.rows[0][at(rangeResult, "[Hours Conservative]")])).toBeLessThanOrEqual(hours);
        expect(Number(rangeResult.table.rows[0][at(rangeResult, "[Hours Optimistic]")])).toBeGreaterThanOrEqual(hours);

        const organizationColumn = at(departmentResult, "Chat + Agent Org Data[Organization]");
        const departmentHoursColumn = at(departmentResult, "[Hours]");
        const seatsColumn = at(departmentResult, "[Licensed Seats]");
        const hoursPerSeatColumn = at(departmentResult, "[Hours Per Seat Month]");
        expect(new Set(departmentResult.table.rows.map((row) => row[organizationColumn])).size).toBe(4);
        expect(departmentResult.table.rows.reduce((sum, row) => sum + Number(row[departmentHoursColumn]), 0)).toBeCloseTo(hours);
        expect(departmentResult.table.rows.every((row) =>
            Number(row[hoursPerSeatColumn]) < Number(row[departmentHoursColumn]) / Number(row[seatsColumn]),
        )).toBe(true);

        const monthHoursColumn = at(monthResult, "[Hours]");
        const monthTasksColumn = at(monthResult, "[Tasks]");
        const copilotColumn = at(monthResult, "[Copilot Hours]");
        const agentColumn = at(monthResult, "[Agent Hours]");
        const coworkColumn = at(monthResult, "[Cowork Hours]");
        expect(monthResult.table.rows.reduce((sum, row) => sum + Number(row[monthHoursColumn]), 0)).toBeCloseTo(hours);
        expect(monthResult.table.rows.reduce((sum, row) => sum + Number(row[monthTasksColumn]), 0))
            .toBe(Number(summaryRow[at(summaryResult, "[Tasks]")]));
        expect(monthResult.table.rows.every((row) =>
            Number(row[copilotColumn]) + Number(row[agentColumn]) + Number(row[coworkColumn])
                === Number(row[monthHoursColumn]),
        )).toBe(true);
    });

    it("populates the value-by-task rollup at every level", () => {
        const query = valueByTask();
        const result = syntheticQueryResult(query.query, query.columnMetadata);

        expect(result.status).toBe("success");
        if (result.status !== "success") return;
        const tree = toValueTaskTree(toDataTable(result.table, query.columnMetadata));
        expect(tree.rows).toHaveLength(4);
        expect(tree.rows.every((row) => typeof row["Activity Share"] === "number" && typeof row["Expert Equivalent Hours Per Week"] === "number")).toBe(true);
        expect(tree.rows.every((row) => Array.isArray(row._children) && row._children.length === 2)).toBe(true);
        expect(tree.total?.rows[0].slice(1)).toEqual([1, 138, 6900]);
    });

    it("keeps the value headline, task breakdown, and organization rows on one fixture", () => {
        const summary = valueSummary();
        const tasks = valueByTask();
        const organizations = organizationValue();
        const summaryResult = syntheticQueryResult(summary.query, summary.columnMetadata);
        const taskResult = syntheticQueryResult(tasks.query, tasks.columnMetadata);
        const organizationResult = syntheticQueryResult(organizations.query, organizations.columnMetadata);

        for (const result of [summaryResult, taskResult, organizationResult]) {
            expect(result.status).toBe("success");
            if (result.status === "success") expect(result.table.rows.length).toBeGreaterThan(0);
        }
        if (
            summaryResult.status !== "success" ||
            taskResult.status !== "success" ||
            organizationResult.status !== "success"
        ) return;

        const summaryAt = (name: string) => summaryResult.table.columns.findIndex((column) => column.name === name);
        expect(summaryResult.table.rows[0][summaryAt("[Expert Equivalent Hours Per Week]")]).toBe(138);
        expect(summaryResult.table.rows[0][summaryAt("[AI Assisted Value Per Week]")]).toBe(6900);
        expect(summaryResult.table.rows[0][summaryAt("[AI Assisted Value]")]).toBe(6900 * 26);
        expect(summaryResult.table.rows[0][summaryAt("[Projected Annualised Value]")]).toBe(6900 * 52);

        const tree = toValueTaskTree(toDataTable(taskResult.table, tasks.columnMetadata));
        expect(tree.total?.rows[0].slice(1)).toEqual([1, 138, 6900]);
        const orgAt = (name: string) => organizationResult.table.columns.findIndex((column) => column.name === name);
        expect(new Set(organizationResult.table.rows.map((row) => row[orgAt("Chat + Agent Org Data[Organization]")])).size).toBe(4);
        expect(organizationResult.table.rows.reduce((sum, row) => sum + Number(row[orgAt("[Expert Equivalent Hours Per Week]")]), 0))
            .toBe(138);
        expect(organizationResult.table.rows.reduce((sum, row) => sum + Number(row[orgAt("[AI Assisted Value]")]), 0))
            .toBe(6900);
    });

    it("applies synthetic value assumptions and date filters consistently", () => {
        const summary = valueSummary();
        const tasks = valueByTask();
        const filters = [
            treatAs("'Hourly Value'[Hourly Value]", [75]),
            treatAs("'Effort Scenario'[Scenario]", ["Conservative"]),
            treatAs("'Chat + Agent Org Data'[Organization]", ["Engineering"]),
        ];
        const filteredSummary = syntheticQueryResult(applyDaxFilters(summary.query, filters), summary.columnMetadata);
        const filteredTasks = syntheticQueryResult(applyDaxFilters(tasks.query, filters), tasks.columnMetadata);
        const dateFilters = [dateBetween("'Calendar'[Date]", "2026-06-01", "2026-06-14")];
        const dateSummary = syntheticQueryResult(applyDaxFilters(summary.query, dateFilters), summary.columnMetadata);
        const dateMonths = executiveMonths();
        const dateMonthResult = syntheticQueryResult(applyDaxFilters(dateMonths.query, dateFilters), dateMonths.columnMetadata);

        expect(filteredSummary.status).toBe("success");
        expect(filteredTasks.status).toBe("success");
        expect(dateSummary.status).toBe("success");
        expect(dateMonthResult.status).toBe("success");
        if (
            filteredSummary.status !== "success" ||
            filteredTasks.status !== "success" ||
            dateSummary.status !== "success" ||
            dateMonthResult.status !== "success"
        ) return;

        const valueAt = (name: string) => filteredSummary.table.columns.findIndex((column) => column.name === name);
        expect(filteredSummary.table.rows[0][valueAt("[Expert Equivalent Hours Per Week]")]).toBe(43 * 0.75);
        expect(filteredSummary.table.rows[0][valueAt("[AI Assisted Value Per Week]")]).toBe(43 * 0.75 * 75);
        const filteredTree = toValueTaskTree(toDataTable(filteredTasks.table, tasks.columnMetadata));
        expect(filteredTree.total?.rows[0].slice(1)).toEqual([1, 43 * 0.75, 43 * 0.75 * 75]);

        const dateValue = (name: string) => dateSummary.table.columns.findIndex((column) => column.name === name);
        expect(dateSummary.table.rows[0][dateValue("[AI Assisted Value]")]).toBe(6900 * 2);
        expect(dateMonthResult.table.rows).toHaveLength(1);
        expect(dateMonthResult.table.rows[0][dateMonthResult.table.columns.findIndex((column) => column.name === "[Month Start]")])
            .toBe("2026-06-01");
    });

    it("provides surface and model categories that match their chart filters", () => {
        const query = surfaceUsage({ lens: "surface" });
        const result = syntheticQueryResult(query.query, query.columnMetadata);

        expect(result.status).toBe("success");
        if (result.status !== "success") return;
        const lens = result.table.columns.findIndex((column) => column.name === "[Lens]");
        const category = result.table.columns.findIndex((column) => column.name === "[Category]");
        const tasks = result.table.columns.findIndex((column) => column.name === "[All Tasks]");
        expect(new Set(result.table.rows.map((row) => row[lens]))).toEqual(new Set(["Surface", "Model"]));
        expect(result.table.rows.every((row) => typeof row[tasks] === "number")).toBe(true);
        expect(result.table.rows.some((row) => row[lens] === "Surface" && row[category] === "Teams")).toBe(true);
    });

    it("provides categories for each task-breakdown lens", () => {
        const query = taskBreakdown();
        const result = syntheticQueryResult(query.query, query.columnMetadata);

        expect(result.status).toBe("success");
        if (result.status !== "success") return;
        const dimension = result.table.columns.findIndex((column) => column.name === "[Dimension]");
        const share = result.table.columns.findIndex((column) => column.name === "[Share]");
        expect(new Set(result.table.rows.map((row) => row[dimension]))).toEqual(new Set(["Behaviour", "Workflow action", "Value outcome"]));
        expect(result.table.rows).toHaveLength(12);
        expect(result.table.rows.every((row) => typeof row[share] === "number")).toBe(true);
    });

    it("keeps task and user cohort totals consistent", () => {
        const query = workSummary();
        const result = syntheticQueryResult(query.query, query.columnMetadata);

        expect(result.status).toBe("success");
        if (result.status !== "success") return;
        const at = (name: string) => result.table.columns.findIndex((column) => column.name === name);
        const row = result.table.rows[0];
        expect(row[at("[All Tasks]")]).toBe(
            Number(row[at("[Licensed Tasks]")]) + Number(row[at("[Unlicensed Tasks]")]) + Number(row[at("[Agent Tasks]")]),
        );
        expect(row[at("[All Users]")]).toBe(Number(row[at("[Licensed Users]")]) + Number(row[at("[Unlicensed Users]")]));
        for (const [rate, tasks, users] of [
            ["[All Rate]", "[All Tasks]", "[All Users]"],
            ["[Licensed Rate]", "[Licensed Tasks]", "[Licensed Users]"],
            ["[Unlicensed Rate]", "[Unlicensed Tasks]", "[Unlicensed Users]"],
            ["[Agent Rate]", "[Agent Tasks]", "[Agent Users]"],
        ]) {
            expect(row[at(rate)]).toBeCloseTo(Number(row[at(tasks)]) / Number(row[at(users)]));
        }
    });

    it("returns matching synthetic source and agent values for cost comparisons", () => {
        const sources = costValueBySource();
        const sourceResult = syntheticQueryResult(sources.query, sources.columnMetadata);
        const agents = costValueAgents();
        const agentResult = syntheticQueryResult(agents.query, agents.columnMetadata);

        expect(sourceResult.status).toBe("success");
        expect(agentResult.status).toBe("success");
        if (sourceResult.status !== "success" || agentResult.status !== "success") return;
        const sourceColumn = sourceResult.table.columns.findIndex((column) => column.name === "[Source]");
        const scenarioColumn = sourceResult.table.columns.findIndex((column) => column.name === "[Scenario]");
        const valueColumn = sourceResult.table.columns.findIndex((column) => column.name === "[Value]");
        expect(new Set(sourceResult.table.rows.map((row) => row[sourceColumn]))).toEqual(new Set(["Copilot", "Agents", "Cowork"]));
        expect(new Set(sourceResult.table.rows.map((row) => row[scenarioColumn]))).toEqual(new Set(["Conservative", "Typical", "Optimistic"]));
        expect(sourceResult.table.rows.every((row) => typeof row[valueColumn] === "number")).toBe(true);
        expect(agentResult.table.rows.map((row) => row[0])).toEqual(["Knowledge Assistant", "Meeting Companion", "Research Helper"]);
    });

    it("keeps evaluator headline rates within bounds and uses readable synthetic verdicts", () => {
        const columns = [
            "[Conversations]", "[People]", "[Conversations Per Person]", "[Resolution Rate]", "[Implied Success]",
            "[True Failure Rate]", "[Failing Conversations]", "[Hours Lost]", "[Unintended Escalation Rate]",
            "[Intended Share]", "[Abandonment Rate]", "[CSAT]", "[Thumbs Up]", "[Thumbs Down]", "[Error Rate]",
            "[Median Response]", "[Slow Replies]", "[Reporting Window]", "[Verdict Performance]", "[Verdict Quality]",
            "[Verdict Adoption]",
        ];
        const result = syntheticQueryResult("EVALUATE PERFORMANCE SUMMARY", metadata(...columns));

        expect(result.status).toBe("success");
        if (result.status !== "success") return;
        const row = result.table.rows[0];
        for (const column of ["[Resolution Rate]", "[Implied Success]", "[True Failure Rate]", "[CSAT]", "[Error Rate]"]) {
            const value = row[result.table.columns.findIndex((entry) => entry.name === column)];
            expect(value).toEqual(expect.any(Number));
            expect(Number(value)).toBeGreaterThanOrEqual(0);
            expect(Number(value)).toBeLessThanOrEqual(1);
        }
        expect(row[result.table.columns.findIndex((entry) => entry.name === "[Verdict Performance]")]).toBe("Improving");
    });

    it("populates evaluator conversation outcomes, topic rollups, comments, archetypes, and sources", () => {
        const summary = conversationsSummary();
        const summaryResult = syntheticQueryResult(summary.query, summary.columnMetadata);
        const theme = themeOutcomes();
        const themeResult = syntheticQueryResult(theme.query, theme.columnMetadata);
        const topics = topicHealth();
        const topicResult = syntheticQueryResult(topics.query, topics.columnMetadata);
        const comments = feedbackComments();
        const commentResult = syntheticQueryResult(comments.query, comments.columnMetadata);
        const archetypes = answerArchetypes();
        const archetypeResult = syntheticQueryResult(archetypes.query, archetypes.columnMetadata);
        const sources = knowledgeSources();
        const sourceResult = syntheticQueryResult(sources.query, sources.columnMetadata);

        for (const result of [summaryResult, themeResult, topicResult, commentResult, archetypeResult, sourceResult]) {
            expect(result.status).toBe("success");
            if (result.status === "success") expect(result.table.rows.length).toBeGreaterThan(0);
        }
        if (summaryResult.status === "success") {
            const at = (name: string) => summaryResult.table.columns.findIndex((column) => column.name === name);
            expect(summaryResult.table.rows[0][at("[Grounded Rate]")]).toBeGreaterThan(0);
            expect(summaryResult.table.rows[0][at("[Grounded Rate]")]).toBeLessThan(1);
            expect(summaryResult.table.rows[0][at("[Knowledge Gap Rate]")]).toBeLessThan(0.25);
            expect(summaryResult.table.rows[0][at("[Turns Per Conversation]")]).toBeLessThan(5);
            expect(summaryResult.table.rows[0][at("[Friction Read]")]).toContain("Moderate");
        }
        if (themeResult.status === "success") {
            const themes = themeResult.table.columns.findIndex((column) => column.name === "[Theme]");
            const outcomes = themeResult.table.columns.findIndex((column) => column.name === "[Outcome]");
            expect(new Set(themeResult.table.rows.map((row) => row[themes])).size).toBe(4);
            expect(new Set(themeResult.table.rows.map((row) => row[outcomes]))).toEqual(new Set([
                "Resolved", "Escalated by design", "Escalated after an error", "Abandoned",
            ]));
        }
        if (topicResult.status === "success") {
            const tree = toTopicTree(toDataTable(topicResult.table, topics.columnMetadata));
            const grandTotal = topicResult.table.rows.find((row) =>
                row[topicResult.table.columns.findIndex((column) => column.name === "[Is Grand Total]")] === true,
            );
            expect(tree.rows).toHaveLength(4);
            expect(tree.rows.every((row) => Array.isArray(row._children) && row._children.length === 2)).toBe(true);
            expect(grandTotal).toBeDefined();
            expect(grandTotal?.every((value) => typeof value !== "number" || Number.isFinite(value))).toBe(true);
        }
        if (commentResult.status === "success") {
            expect(commentResult.table.rows.some((row) => String(row[0]).includes("helpful answer"))).toBe(true);
        }
        if (archetypeResult.status === "success") {
            expect(archetypeResult.table.rows.map((row) => row[0])).toContain("Knowledge-grounded answer");
        }
        if (sourceResult.status === "success") {
            expect(sourceResult.table.rows.map((row) => row[0])).toContain("Product guide");
        }
    });

    it("populates activation, habit, evaluation, and shadow AI result schemas", () => {
        const activation = syntheticQueryResult(
            "EVALUATE ACTIVATION",
            metadata("[Licensed Active]", "[Licensed Inactive]", "[Licensed Total]", "[Licensed Active Pct]", "[All Active]", "[All Inactive]", "[All Total]", "[All Active Pct]", "[Agent Active]", "[Agent NotUsing]", "[Agent Active Pct]"),
        );
        const matrix = syntheticQueryResult(
            "EVALUATE HABIT LICENCE",
            metadata("[Month]", "[Cohort]", "[Cohort Order]", "[Licensed]", "[Unlicensed]"),
        );
        const evaluator = syntheticQueryResult(
            "EVALUATE EVALUATION OPTIONS",
            metadata("[Kind]", "[Value]", "[Sort]"),
        );
        const shadowStatus = syntheticQueryResult(
            "EVALUATE SHADOW STATUS",
            metadata("[Probe]", "[Status]", "[Source]", "[Rows]", "[Message]", "[Run At]"),
        );
        const shadowTools = syntheticQueryResult(
            "EVALUATE SHADOW TOOLS",
            metadata("[Tool]", "[Layer]", "[Posture]", "[Devices]", "[Users]"),
        );

        for (const result of [activation, matrix, evaluator, shadowStatus, shadowTools]) {
            expect(result.status).toBe("success");
            if (result.status === "success") expect(result.table.rows.length).toBeGreaterThan(0);
        }
        if (evaluator.status === "success") {
            expect(evaluator.table.rows.some((row) => row[0] === "First date")).toBe(true);
            expect(evaluator.table.rows.some((row) => row[0] === "Agent")).toBe(true);
        }
        if (shadowStatus.status === "success") expect(shadowStatus.table.rows.every((row) => row[1] === "ok")).toBe(true);
        if (shadowTools.status === "success") expect(new Set(shadowTools.table.rows.map((row) => row[1]))).toEqual(new Set(["Ran", "Network", "Installed", "Cloud Discovery"]));
    });
});
