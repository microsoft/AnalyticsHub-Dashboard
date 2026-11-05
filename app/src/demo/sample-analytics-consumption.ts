import { dateRange, groups, literals, nameOf, project, samples, sum, unique, type RecordRow } from "./sample-data";
import { governanceData } from "./sample-governance";
import { nativeDate } from "./sample-consumption";

/** New synthetic configuration/billing evidence; published consumption exports remain unchanged. */
export function sampleGeneratedConsumptionRows(query: string, columns: readonly string[]): unknown[][] | undefined {
    const names = columns.map(nameOf);
    const output = (...rows: RecordRow[]) => project(columns, rows);
    if (query.includes("'Foundry Resources'") && names.includes("Cost Export")) {
        const range = dateRange(query, "'Reporting Date'[Date]") ?? dateRange(query);
        const amortized = literals(query, "Azure Cost Basis", "Cost Basis")?.[0] === "Amortized";
        const spend = samples.consumption.AzureSolutionSpend.filter(row => !range || row.UsageDate >= range.from && row.UsageDate <= range.to);
        const subscriptions = new Set(spend.map(row => row.SubscriptionId));
        return output(...governanceData.foundry.filter(row => !row.project).map(row => {
            const costs = spend.filter(item => {
                const id = item.ResourceId.toLowerCase();
                return id === row.id || id.startsWith(`${row.id}/`);
            });
            return {
                Resource: row.name, Kind: "Synthetic Foundry account", "Resource Group": row.group, Subscription: row.subscription,
                Projects: governanceData.foundry.filter(project => project.project && project.account === row.id).length,
                Network: row.public ? "Public" : "Private", "Cost Export": subscriptions.has(row.subscription) ? "Covered" : "Not covered",
                Cost: costs.length ? sum(costs, item => Number(item[amortized ? "AmortizedCost" : "ActualCost"])) : null,
            };
        }));
    }
    if (!query.includes("'CopilotPaygSpend'")) return undefined;
    const range = dateRange(query, "'Reporting Date'[Date]") ?? dateRange(query);
    const period = literals(query, "Studio Period", "Period")?.[0];
    const exportLast = samples.consumption.StudioTenantDaily.map(row => nativeDate(row["Usage Date"])).sort().at(-1)!;
    const high = period === "Last 7 days" ? exportLast : "2026-08-31";
    const low = period === "Last 7 days" ? new Date(Date.parse(high) - 6 * 86400000).toISOString().slice(0, 10) : "2026-06-01";
    const rows = governanceData.billing.filter(row => row.date >= low && row.date <= high
        && (!range || row.date >= range.from && row.date <= range.to));
    if (names.includes("Usage Date") && names.includes("Product")) return output(...groups(rows, row => `${row.date}|${row.product}`).map(([, values]) => ({
        "Usage Date": values[0].date, Product: values[0].product,
        "Product Sort": values[0].product === "Copilot Studio" ? 1 : values[0].product === "Cowork" ? 2 : 3,
        Cost: sum(values, row => row.cost), Credits: sum(values, row => row.credits),
    })));
    if (names.includes("Studio Cost") && names.includes("Subscriptions")) return output({
        "Studio Cost": sum(rows.filter(row => row.product === "Copilot Studio"), row => row.cost),
        "Studio Credits": sum(rows.filter(row => row.product === "Copilot Studio"), row => row.credits),
        "Cowork Cost": sum(rows.filter(row => row.product === "Cowork"), row => row.cost),
        "Cowork Credits": sum(rows.filter(row => row.product === "Cowork"), row => row.credits),
        "Other Cost": sum(rows.filter(row => !["Copilot Studio", "Cowork"].includes(row.product)), row => row.cost),
        "Total Cost": sum(rows, row => row.cost), Currency: "USD", Currencies: "USD",
        Subscriptions: unique(rows, row => row.subscription), "First Date": rows[0]?.date ?? null,
        "Last Date": rows.at(-1)?.date ?? null, Rows: rows.length,
    });
    return undefined;
}
