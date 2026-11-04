import { samples, type RecordRow, cuts, dateRange, groups, literals, nameOf, orgAttribute, project, ratio, sum, unique } from "./sample-data";

type NativeRow = Record<string, string>;
const source = samples.consumption;
const number = (row: NativeRow, field: string) => Number(row[field] || 0);
const credits = (row: NativeRow) => number(row, "Total Copilot Credits used");
const userCredits = (row: NativeRow) => number(row, "Credits used");
const agentCredits = (row: NativeRow) => number(row, "Billed credit") + number(row, "Non-billed credit");
const directionWords = ["inp", "inpt", "input", "inputs", "opt", "outp", "outpt", "output", "outputs", "cach", "cachd", "cache", "cached", "cd", "cchd"];
function meterParts(meter: string) {
    const words = meter.toLowerCase().split(/[-_ ]+/).filter(Boolean);
    const index = words.findIndex(word => directionWords.includes(word));
    const model = words.slice(0, index);
    const label = index <= 0 ? meter || "Not provided" : model[0] === "gpt" ? ["GPT", ...model.slice(1)].join("-")
        : /^\d/.test(model[0]) ? ["GPT", ...model].join("-") : /^o\d/.test(model[0]) ? model.join("-")
        : model.map(word => word[0].toUpperCase() + word.slice(1)).join(" ");
    const has = (choices: string[]) => words.some(word => choices.includes(word));
    return { model: label, direction: has(["cach", "cachd", "cache", "cached", "cd", "cchd"]) ? "Cached"
        : has(["inp", "inpt", "input", "inputs"]) ? "Input" : has(["opt", "outp", "outpt", "output", "outputs"]) ? "Output" : "Other" };
}

export function nativeDate(value: string) {
    const slash = /^(\d+)\/(\d+)\/(\d{4})/.exec(value);
    return slash ? `${slash[3]}-${slash[1].padStart(2, "0")}-${slash[2].padStart(2, "0")}` : value.slice(0, 10);
}
const allDates = [
    ...source.PersonServiceCreditsMetrics.map(row => nativeDate(row.MetricDate)),
    ...source.StudioTenantDaily.map(row => nativeDate(row["Usage Date"])),
    ...source.AzureSolutionSpend.map(row => nativeDate(row.UsageDate)),
].sort();
export const consumptionFirst = allDates[0];
export const consumptionLast = allDates.at(-1)!;

/** Source-native totals deliberately keep dated tenant exports separate from undated user snapshots. */
export function sampleConsumptionRows(query: string, columns: readonly string[]): unknown[][] | undefined {
    const names = columns.map(nameOf);
    const has = (...keys: string[]) => keys.every(key => names.includes(key));
    const output = (...records: RecordRow[]) => project(columns, records);
    const range = dateRange(query, "'Reporting Date'[Date]") ?? dateRange(query, "'CreditsWeekly'[MetricDate]") ?? dateRange(query);
    const inside = (value: string) => !range || nativeDate(value) >= range.from && nativeDate(value) <= range.to;
    const orgs = literals(query, "Org Attribute Source", "Value");
    const agentNames = literals(query, "Agent Bridge", "Agent Name");
    const costBasis = literals(query, "Azure Cost Basis", "Cost Basis")?.[0] ?? "Actual";
    const solutionCost = (row: NativeRow) => number(row, /amortized/i.test(costBasis) ? "AmortizedCost" : "ActualCost");
    const attribute = orgAttribute(query);
    const orgByEmail = new Map(source.entra_org.map(row => [row.userPrincipalName.toLowerCase(),
        row[attribute === "country" ? "country" : attribute === "job" ? "jobTitle" : "department"]]));
    const policies = new Map(source.SpendingPolicyMetadata.map(row => [row.SpendingPolicyId, row]));
    const policyPeople = new Map(source.PersonPolicyMap.map(row => [row.PersonId, row]));
    const selected = (email: string) => !orgs || orgs.includes(orgByEmail.get(email.toLowerCase()) ?? "(Unassigned)");
    const weekDates = [...new Set(source.PersonServiceCreditsMetrics.map(row => row.MetricDate))].sort();
    const cwPeriod = literals(query, "Cowork Period", "Period")?.[0];
    const cwWindow = has("Credits Used", "Consuming Users") || has("Allowance Used", "Is Grand Total") || has("Prepaid Credits", "Cost");
    const cwWeeks = cwPeriod ? Number(/\d+/.exec(cwPeriod)?.[0] ?? weekDates.length) : cwWindow ? 4 : weekDates.length;
    const cwFirst = weekDates[Math.max(0, weekDates.length - cwWeeks)];
    const stPeriod = literals(query, "Studio Period", "Period")?.[0];
    const stLast = [...source.StudioTenantDaily.map(row => nativeDate(row["Usage Date"]))].sort().at(-1)!;
    const stFirst = stPeriod === "Last 7 days" ? new Date(Date.parse(stLast) - 6 * 86400000).toISOString().slice(0, 10) : "";
    const service = literals(query, "CreditsWeekly", "ServiceName")?.[0];
    const cowork = source.PersonServiceCreditsMetrics.filter(row => inside(row.MetricDate) && row.MetricDate >= cwFirst && (!service || row.ServiceName === service)
        && selected(policyPeople.get(row.PersonId)?.userPrincipalName ?? ""));
    const studio = source.StudioTenantDaily.filter(row => inside(row["Usage Date"]) && nativeDate(row["Usage Date"]) >= stFirst);
    const users = source.StudioPerUser.filter(row => selected(row["User Email"]) && (!agentNames || agentNames.includes(row["Agent Name"])));
    const agents = source.StudioPerAgent.filter(row => !agentNames || agentNames.includes(row["Agent Name"]));
    const azure = source.AzureSolutionSpend.filter(row => inside(row.UsageDate));
    const foundry = source.AzureAiSpendDaily.filter(row => inside(row.UsageDate));
    const tokens = source.AzureAiTokensDaily.filter(row => inside(row.Date) && ["InputTokens", "OutputTokens"].includes(row.Metric));
    const override = (name: string, fallback: number) => Number(new RegExp(`MEASURE\\s+'[^']+'\\[${name}\\]\\s*=\\s*(\\d+(?:\\.\\d+)?)`, "i").exec(query)?.[1] ?? fallback);
    const rate = override("Cowork PAYG Rate Value", samples.terms.credit_rate);
    const prepaidRate = override("Cowork Prepaid Rate Value", samples.terms.prepaid_credit_rate);
    const balance = override("Cowork Capacity Pack Balance Value", samples.terms.prepaid_credit_balance);
    const cw = sum(cowork, credits);
    const prepaid = Math.min(balance, cw);
    const cwCost = prepaid * prepaidRate + (cw - prepaid) * rate;
    const stPrepaid = sum(studio, row => number(row, "Prepaid Consumed Quantity"));
    const stPayg = sum(studio, row => number(row, "Pay as you go Consumed Quantity"));
    const st = stPrepaid + stPayg;
    const stCost = stPrepaid * prepaidRate + stPayg * rate;
    const snapshotTotal = sum(users, userCredits);
    const azureCost = sum(azure, solutionCost);
    const foundryCost = sum(foundry, row => number(row, "Cost"));
    const period = `${range?.from ?? consumptionFirst} - ${range?.to ?? consumptionLast}`;
    const note = {
        "Period Label": period, "Billing Period": period, "Billing Basis": "Published synthetic CSV credits; saved demo terms",
        "Snapshot Note": "User and agent exports are separate undated snapshots, not the dated tenant export. Totals can differ.",
        "Org Match Rate": ratio(users.filter(row => orgByEmail.has(row["User Email"].toLowerCase())).length, users.length),
        "Org Filter Status": "Consumption uses the organization directory supplied with its own synthetic exports.",
    };
    if (has("Kind", "Value") && query.includes("'Cowork Period'")) return output(...[
        ...["Current period (4 weeks)", "Last 8 weeks", `All history (${weekDates.length} weeks)`].map((Value, Sort) => ({ Kind: "Cowork period", Value, Sort })),
        ...["Last 7 days", "All available days"].map((Value, Sort) => ({ Kind: "Studio period", Value, Sort })),
        ...["All users", "Department", "Country", "Job Title"].map(Value => ({ Kind: "Group by", Value, Sort: 0 })),
        ...[...new Set(source.PersonServiceCreditsMetrics.map(row => row.ServiceName))].map(Value => ({ Kind: "Service", Value, Sort: 0 })),
        ...["Actual", "Amortized"].map(Value => ({ Kind: "Cost basis", Value, Sort: 0 })),
    ]);
    if (names.length === 1 && has("Attribute") && query.includes("'Org Attribute Source'")) {
        return output(...["Department", "Country", "Job Title"].map(Attribute => ({ Attribute })));
    }
    if (has("Credit Rate", "Prepaid Credit Balance")) return output({
        "Credit Rate": rate, "Prepaid Credit Rate": prepaidRate, "Prepaid Credit Balance": balance,
    });
    if (has("Cowork Last Date", "Studio Last Date")) return output({
        "Cowork Last Date": [...source.PersonServiceCreditsMetrics.map(row => row.MetricDate)].sort().at(-1),
        "Studio Last Date": [...source.StudioTenantDaily.map(row => nativeDate(row["Usage Date"]))].sort().at(-1),
        "Azure Last Date": [...source.AzureSolutionSpend.map(row => row.UsageDate)].sort().at(-1),
    });
    if (has("First Date", "Last Date") && names.length === 2) return output({ "First Date": consumptionFirst, "Last Date": consumptionLast });
    if (has("Cowork Rows", "Studio Rows", "Azure Rows") && names.length === 3) return output({
        "Cowork Rows": cowork.length, "Studio Rows": studio.length, "Azure Rows": azure.length,
    });
    if (has("Credits Used", "Consuming Users")) {
        const byUser = groups(cowork, row => row.PersonId);
        const allowance = (values: typeof cowork) => sum(groups(values, row => `${row.SpendingPolicyId}|${row.MetricDate.slice(0, 7)}`),
            ([, rows]) => number(rows[0], "User limit"));
        return output({ ...note, "Period Label": `${cwFirst} - ${weekDates.at(-1)}`, "Credits Used": cw, "Consuming Users": byUser.length,
            "Weekly Active Users": unique(cowork.filter(row => row.MetricDate === [...cowork.map(row => row.MetricDate)].sort().at(-1)), row => row.PersonId),
            "Avg Credits Per User": ratio(cw, byUser.length), "Allowance Used": ratio(cw, sum(byUser, ([, values]) => allowance(values))),
            "Users Over Limit": ratio(byUser.filter(([, values]) => sum(values, credits) > allowance(values)).length, byUser.length),
            Policies: unique(cowork, row => row.SpendingPolicyId), "Total Cost": cwCost, "Prepaid Cost": prepaid * prepaidRate,
            "PAYG Cost": (cw - prepaid) * rate, "Blended Rate": ratio(cwCost, cw), "Avg Cost Per User": ratio(cwCost, byUser.length),
            "Policy Headroom": sum(byUser, ([, values]) => allowance(values)) - cw });
    }
    if (has("Credits Consumed", "Agents With Credits")) return output({ ...note, "Credits Consumed": st,
        "Active Users": unique(users, row => row["User Email"]), "Agents With Credits": unique(users, row => row["Agent Name"]),
        "Avg Credits Per User": ratio(snapshotTotal, unique(users, row => row["User Email"])),
        "Avg Agents Per User": ratio(unique(users, row => `${row["User Email"]}|${row["Agent Name"]}`), unique(users, row => row["User Email"])),
        "Total Cost": stCost, "Prepaid Cost": stPrepaid * prepaidRate, "PAYG Cost": stPayg * rate, "PAYG Share": ratio(stPayg, st),
        "Effective Rate": ratio(stCost, st), "Avg Cost Per User": ratio(sum(users, row => number(row, "Billable credit used")) * rate, unique(users, row => row["User Email"])),
        Concentration: "Concentration is calculated from the complete published user snapshot.",
    });
    if (has("Week Index", "Credits", "Active Users")) return output(
        ...groups(cowork, row => row.MetricDate).sort().map(([date, values], i) => ({
            "Week Index": i + 1, "Week Start": date, Credits: sum(values, credits), "Active Users": unique(values, row => row.PersonId),
            "Prepaid Cost": ratio(sum(values, credits), cw) * prepaid * prepaidRate, "PAYG Cost": ratio(sum(values, credits), cw) * (cw - prepaid) * rate,
            "Credits WoW": null,
        })));
    if (has("Credits", "Prepaid Credits", "Cost") && !has("Usage Date")) return output({ Credits: cw, "Prepaid Credits": prepaid, Cost: cwCost });
    if (has("Studio Cost", "Cowork Cost", "Subscriptions")) return output({ Rows: 0 });
    if (has("Usage Date", "Product", "Credits", "Cost")) return [];
    if (has("Credits Used", "Is Grand Total", "Policy")) {
        const coworkTable = has("Allowance Used");
        const groupColumn = columns.find(column => /Group By\[Group\]/.test(column))!;
        const userColumn = columns.find(column => /DisplayName|User Name/.test(column))!;
        const loginColumn = columns.find(column => /UserPrincipalName/.test(column));
        const groupBy = literals(query, "Group By", "Attribute")?.[0] ?? "All users";
        const nativeAttribute = /country/i.test(groupBy) ? "country" : /job/i.test(groupBy) ? "jobTitle" : "department";
        const nativeOrg = new Map(source.entra_org.map(row => [row.userPrincipalName.toLowerCase(), row[nativeAttribute]]));
        const labelFor = (email: string) => groupBy === "All users" ? "All users" : nativeOrg.get(email.toLowerCase()) ?? "(Unassigned)";
        const records: RecordRow[] = coworkTable ? groups(cowork, row => row.PersonId).map(([id, values]) => {
            const person = policyPeople.get(id);
            const amount = sum(values, credits);
            const allowance = sum(groups(values, row => `${row.SpendingPolicyId}|${row.MetricDate.slice(0, 7)}`),
                ([, rows]) => number(rows[0], "User limit"));
            const cost = ratio(amount, cw) * cwCost;
            return { [groupColumn]: labelFor(person?.userPrincipalName ?? ""),
                [userColumn]: person?.displayName ?? id, ...(loginColumn ? { [loginColumn]: person?.userPrincipalName } : {}),
                Users: 1, Allowance: allowance, "Credits Used": amount, "Credit Share": ratio(amount, cw), "Allowance Used": ratio(amount, allowance),
                Policy: policies.get(values[0].SpendingPolicyId)?.Name ?? "Outside policy", "Billing Name": policies.get(values[0].SpendingPolicyId)?.Name,
                "Billable Credits": amount, "Estimated Cost": cost, "Total Cost": cost,
                "Prepaid Cost": ratio(amount, cw) * prepaid * prepaidRate, "PAYG Cost": ratio(amount, cw) * (cw - prepaid) * rate };
        }) : groups(users, row => row["User Email"]).map(([email, values]) => ({
            [groupColumn]: labelFor(email), [userColumn]: email,
            Users: 1, "Credits Used": sum(values, userCredits), "Credit Share": ratio(sum(values, userCredits), snapshotTotal),
            "Billable Credits": sum(values, row => number(row, "Billable credit used")),
            "Estimated Cost": sum(values, row => number(row, "Billable credit used")) * rate, Policy: "Source user snapshot",
        }));
        const summary = (values: typeof records): RecordRow => {
            const policyNames = [...new Set(values.map(row => String(row.Policy)))];
            const result: RecordRow = { Users: values.length, Policy: policyNames.length === 1 ? policyNames[0] : `${policyNames.length} policies`, Total: records.length };
            for (const key of ["Credits Used", "Credit Share", "Billable Credits", "Estimated Cost", "Total Cost", "Prepaid Cost", "PAYG Cost"]) {
                result[key] = sum(values, row => Number(row[key] ?? 0));
            }
            result["Allowance Used"] = ratio(sum(values, row => Number(row["Credits Used"])), sum(values, row => Number(row.Allowance ?? 0)));
            return result;
        };
        return output(...records.map(row => ({ ...row, "Is Grand Total": false, "Is Group Total": false, Total: records.length })),
            ...groups(records, row => String(row[groupColumn])).map(([label, values]) => ({
                ...summary(values), [groupColumn]: label, [userColumn]: null, "Is Grand Total": false, "Is Group Total": true,
            })), { ...summary(records), [groupColumn]: null, [userColumn]: null, "Is Grand Total": true, "Is Group Total": true });
    }
    if (has("Count", "Cumulative", "People", "Total") && query.includes("'Credit Consumption (User)'[User Name]")) {
        return output(...cuts(groups(users, row => row["User Email"]).map(([, values]) => sum(values, userCredits))));
    }
    if (has("Agent", "Credit Share")) return output(...groups(users, row => row["Agent Name"]).map(([Agent, values], _, all) => ({
        Agent, "Credits Used": sum(values, userCredits), "Credit Share": ratio(sum(values, userCredits), snapshotTotal),
        "Billable Credits": sum(values, row => number(row, "Billable credit used")),
        "Estimated Cost": sum(values, row => number(row, "Billable credit used")) * rate, Total: all.length,
    })));
    if (has("Breakdown", "Item", "Credits")) return output(...["Model", "Feature"].flatMap(Breakdown =>
        groups(agents, row => row[Breakdown === "Model" ? "LLM Model" : "AI Feature/Billable Feature"] || "(Not recorded)").map(([Item, values]) => ({
            Breakdown, Item, Credits: sum(values, agentCredits), Cost: sum(values, row => number(row, "Billed credit")) * rate,
        }))));
    if (has("Usage Date", "Prepaid Credits", "PAYG Credits")) return output(...groups(studio, row => nativeDate(row["Usage Date"])).sort().map(([date, values]) => ({
        "Usage Date": date, "Prepaid Credits": sum(values, row => number(row, "Prepaid Consumed Quantity")),
        "PAYG Credits": sum(values, row => number(row, "Pay as you go Consumed Quantity")),
        Credits: sum(values, row => number(row, "Prepaid Consumed Quantity") + number(row, "Pay as you go Consumed Quantity")),
        "Prepaid Cost": sum(values, row => number(row, "Prepaid Consumed Quantity")) * prepaidRate,
        "PAYG Cost": sum(values, row => number(row, "Pay as you go Consumed Quantity")) * rate,
    })));
    if (has("Reporting Window", "Rates In Use")) return output({
        "Reporting Window": period, "Reporting Caveat": "Published synthetic samples without live data or date shifting. Dated exports and undated snapshots retain their native totals.",
        "Rates In Use": `Sample seeder terms: PAYG $${rate}, prepaid $${prepaidRate}`, "Azure Currency": "USD",
        "Cowork Rows": cowork.length, "Studio Rows": studio.length, "Azure Rows": azure.length,
    });
    if (has("Solution Rows", "Foundry Rows")) return output({ "Solution Rows": azure.length, "Solution Currencies": "USD",
        "Foundry Rows": foundry.length, "Foundry Currency": "USD" });
    if (has("Selected Cost", "Tagged Allocation")) {
        const models = azure.filter(row => row.ServiceCategory === "Model");
        return output({ "Selected Cost": azureCost, "Model Share": ratio(sum(models, solutionCost), azureCost),
            "Supporting Cost": sum(azure.filter(row => row.ServiceCategory !== "Model"), solutionCost),
            "AI Requests": sum(azure, row => number(row, "Requests")), "Tagged Allocation": ratio(sum(azure.filter(row => row.AllocationStatus === "Tagged"), solutionCost), azureCost),
            "Tokens M": sum(azure, row => number(row, "TotalTokensM")), "Speech Hours": sum(azure, row => number(row, "SpeechHours")),
            "Document Pages": sum(azure, row => number(row, "DocumentPages")), "Generated Images": sum(azure, row => number(row, "Images")),
            "Cost Per 1M Tokens": ratio(sum(models, solutionCost), sum(models, row => number(row, "TotalTokensM"))),
            "Spend Context": "Published synthetic solution export, USD" });
    }
    if (has("PTU Verdict", "Input Cost")) {
        const input = foundry.filter(row => meterParts(row.Meter).direction === "Input");
        const outputRows = foundry.filter(row => meterParts(row.Meter).direction === "Output");
        const tokenTotal = sum(tokens, row => number(row, "Value")) / 1e6;
        const days = unique(foundry, row => row.UsageDate);
        return output({ Cost: foundryCost, "Input Cost": sum(input, row => number(row, "Cost")), "Output Cost": sum(outputRows, row => number(row, "Cost")),
            "Output Share": ratio(sum(outputRows, row => number(row, "Cost")), foundryCost), "Tokens M": tokenTotal,
            "Cost Per 1M Tokens": ratio(foundryCost, tokenTotal), "AI Requests": sum(azure, row => number(row, "Requests")),
            "Tokens Per Request": ratio(tokenTotal * 1e6, sum(azure, row => number(row, "Requests"))),
            "Daily Run Rate": ratio(foundryCost, days), "Cost Per Month": ratio(foundryCost, days) * 30, "Days Observed": days,
            "PTU Verdict": "Illustrative source costs; not a live capacity recommendation." });
    }
    if (has("Component", "Usage Date") && query.includes("'AzureAiSpend'")) return output(
        ...groups(foundry, row => row.UsageDate).sort().flatMap(([date, values]) => ["Input", "Output"].map((direction, i) => ({
            "Usage Date": date, Component: `${direction} tokens`, "Component Sort": i + 1,
            Cost: sum(values.filter(row => meterParts(row.Meter).direction === direction), row => number(row, "Cost")),
        }))));
    if (has("Component", "Usage Date")) return output(...groups(azure, row => row.UsageDate).flatMap(([date, values]) =>
        groups(values, row => row.ServiceCategory).map(([Component, rows], i) => ({
            "Usage Date": date, Component, "Component Sort": i + 1, Cost: sum(rows, solutionCost),
        }))));
    if (has("Resource", "Application", "Service")) return output(...groups(azure, row => `${row.ResourceName}|${row.Application}|${row.ServiceName}`).map(([, values]) => ({
        Resource: values[0].ResourceName, Application: values[0].Application, Service: values[0].ServiceName,
        "Department Tag": values[0].DepartmentTag, Cost: sum(values, solutionCost),
    })));
    if (has("Item", "Cost") && query.includes("'AzureAiSpend'")) return output(...groups(foundry, row => meterParts(row.Meter).model).map(([Item, values]) => ({
        Item, Cost: sum(values, row => number(row, "Cost")), "Tokens M": sum(values, row => number(row, "UsageQuantity")),
    })));
    if (has("Item", "Cost") && !has("Credits")) return output(...groups(azure, row => row.ServiceName).map(([Item, values]) => ({
        Item, Cost: sum(values, solutionCost), "Tokens M": sum(values, row => number(row, "TotalTokensM")),
    })));
    if (has("Resource", "Model", "Cost")) return output(...groups(foundry, row => `${row.ResourceName}|${row.Meter}`).map(([, values]) => ({
        Resource: values[0].ResourceName, "Resource Group": values[0].ResourceGroup, Model: meterParts(values[0].Meter).model,
        "Department Tag": values[0].DepartmentTag, Cost: sum(values, row => number(row, "Cost")),
        "Tokens M": sum(values, row => number(row, "UsageQuantity")),
    })));
    if (has("Usage Date", "Cost") && !has("Product")) return output(...groups(foundry, row => row.UsageDate).sort().map(([date, values]) => ({
        "Usage Date": date, Cost: sum(values, row => number(row, "Cost")),
        "Tokens M": sum(tokens.filter(row => row.Date === date), row => number(row, "Value")) / 1e6,
    })));
    if (has("Resource", "Projects", "Network")) return [];
    if (has("Product", "Coverage", "Cost Basis")) return output(
        { Product: "Cowork / Work IQ", "Product Sort": 1, Credits: cw, Cost: cwCost, "Cost Basis": "Published weekly credit export at seeder terms", Coverage: `Date span covered | source ${consumptionFirst} to ${consumptionLast}` },
        { Product: "Copilot Studio", "Product Sort": 2, Credits: st, Cost: stCost, "Cost Basis": "Published daily tenant export at seeder terms", Coverage: `Date span covered | source ${consumptionFirst} to ${consumptionLast}` },
        { Product: "Azure AI Foundry", "Product Sort": 3, Credits: null, Cost: azureCost, "Cost Basis": "Published solution export, USD", Coverage: `Date span covered | source ${consumptionFirst} to ${consumptionLast}` });
    if (has("Month Start", "Studio Credits", "Cowork Credits")) {
        const parts = [...query.matchAll(/ADDCOLUMNS\([\s\S]*?"Part", "(trend|range)"/g)];
        const records = (expression: string, Part?: string): RecordRow[] => {
            const window = dateRange(expression, "'Reporting Date'[Date]");
            const keep = (date: string) => !window || nativeDate(date) >= window.from && nativeDate(date) <= window.to;
            const months = [...new Set([...source.StudioTenantDaily.filter(row => keep(row["Usage Date"])).map(row => nativeDate(row["Usage Date"]).slice(0, 7)),
                ...source.PersonServiceCreditsMetrics.filter(row => keep(row.MetricDate)).map(row => row.MetricDate.slice(0, 7))])].sort();
            return months.map(month => ({
                "Month Start": `${month}-01`, Part,
                "Studio Credits": sum(source.StudioTenantDaily.filter(row => keep(row["Usage Date"]) && nativeDate(row["Usage Date"]).startsWith(month)),
                    row => number(row, "Prepaid Consumed Quantity") + number(row, "Pay as you go Consumed Quantity")),
                "Cowork Credits": sum(source.PersonServiceCreditsMetrics.filter(row => keep(row.MetricDate) && row.MetricDate.startsWith(month)), credits),
            }));
        };
        return output(...(parts.length ? parts.flatMap(part => records(part[0], part[1])) : records(query)));
    }
    return undefined;
}
