import { describe, expect, it } from "vitest";
import { destinations } from "@/components/destinations";
import contract from "./contract.json";
import { DEMO_ORGANIZATIONS } from "@/demo/organizations";
import { buildInsights, dayIso, generateScenario, getScenarioInsights, latestMonth, scenarioMonths, scenarioObservations, SCENARIO_DAYS, SCENARIO_RUN_ID } from "./scenario";

describe("seeded cross-vendor scenario", () => {
    const data = generateScenario();

    it("matches the Cross-vendor view header data range", () => {
        const view = destinations.find(d => d.id === "cross-vendor");
        expect(view && "dataRange" in view ? view.dataRange : undefined).toBe("27 Jul – 25 Oct 2026");
        expect([dayIso(0), dayIso(SCENARIO_DAYS - 1)]).toEqual(["2026-07-27", "2026-10-25"]);
    });

    it("is deterministic for its seed and differs for another", () => {
        expect(JSON.stringify(generateScenario())).toBe(JSON.stringify(data));
        expect(JSON.stringify(generateScenario(7).claudeUsers.slice(0, 5))).not.toBe(JSON.stringify(data.claudeUsers.slice(0, 5)));
    });

    it("uses the existing demo cohort over 91 days, with multi-tool users", () => {
        expect(data.people).toHaveLength(278);
        expect(new Set(data.people.map(p => p.display_name)).size).toBe(278);
        expect(SCENARIO_DAYS).toBe(91);
        expect(new Set(data.people.map(p => p.department))).toEqual(new Set(DEMO_ORGANIZATIONS.map(o => o.name)));
        expect(new Set(data.copilotDaily.map(row => row.userId)).size).toBe(198);
        for (const organization of DEMO_ORGANIZATIONS) {
            const identities = data.identities.filter(identity => data.people.some(person =>
                person.person_id === identity.person_id && person.department === organization.name,
            ));
            const ids = new Set(identities.map(identity => identity.m365_user_id));
            expect(identities).toHaveLength(organization.seats);
            expect(new Set(data.copilotDaily.filter(row => ids.has(row.userId)).map(row => row.userId)).size)
                .toBe(organization.seatsInUse);
        }
        const insights = buildInsights(data);
        expect(insights.multiToolPeople).toBeGreaterThan(20);
        expect(insights.copilotPlus.every(p => p.People > 0)).toBe(true);
        expect(data.people.every(p => p.email.endsWith("@example.invalid"))).toBe(true);
    });

    it("emits contract v1 observations with synthetic provenance, decimal strings and native units", () => {
        const observations = scenarioObservations(data);
        const definitions = contract.metric_definitions as Record<string, { unit: string }>;
        expect(observations.length).toBeGreaterThan(1000);
        for (const o of observations.filter((_, i) => i % 97 === 0)) {
            expect(o.provenance).toBe("synthetic");
            expect(o.run_id).toBe(SCENARIO_RUN_ID);
            expect(o.contract_version).toBe(contract.contract_version);
            expect(definitions[o.metric].unit).toBe(o.unit);
            expect(typeof o.value).toBe("string");
            if (o.unit !== "boolean") expect(o.value).toMatch(/^\d+(\.\d+)?$/);
        }
        expect(observations.filter(o => o.source_id === "scenario-chatgpt-users").every(o => o.period.cadence === "monthly")).toBe(true);
        expect(observations.some(o => o.source_id === "scenario-claude-cost" && o.currency === "USD" && o.cost_basis === "reported_charge")).toBe(true);
    });

    it("keeps ChatGPT period-only and every monthly figure inside one month", () => {
        expect(data.chatgptCsv.every(r => r.cadence === "monthly")).toBe(true);
        expect(new Set(data.chatgptCsv.map(r => `${r.period_start}/${r.period_end}`))).toEqual(new Set(["2026-08-01/2026-08-31", "2026-09-01/2026-09-30", "2026-10-01/2026-10-25"]));
        const insights = getScenarioInsights();
        expect(insights.weeklyActive.some(r => r.Tool === "ChatGPT / Codex")).toBe(false);
        expect(new Set(insights.spend.map(r => r.Month))).toEqual(new Set(scenarioMonths.map(m => m.label)));
        expect(latestMonth.label).toBe("Oct 1-25, 2026");
    });

    it("never invents missing Claude Code accept rates and ranks leaders by tools then active days", () => {
        const { coding, leaders } = getScenarioInsights();
        expect(coding.claude).not.toHaveProperty("acceptRate");
        expect(coding.cursor.tabsAccepted).toBeLessThanOrEqual(coding.cursor.tabsShown);
        expect(leaders).toHaveLength(10);
        for (let i = 1; i < leaders.length; i++) expect(leaders[i - 1].tools.length).toBeGreaterThanOrEqual(leaders[i].tools.length);
    });
});
