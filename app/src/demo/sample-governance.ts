import { groups, literals, nameOf, project, samples, unique, type RecordRow } from "./sample-data";

interface Configuration {
    id: string; agent: string; type: string; resource: string; snapshot: string;
    owner: string; ownerStatus: string; noSignIn: boolean; webSearch: boolean; quarantined: boolean;
    scope: string; access: string; users: number; tenant: boolean;
}
interface Finding { id: string; date: string; user: string; device: string; tool: string; layer: string }
interface GovernanceData {
    seed: string; description: string; config: Configuration[];
    foundry: { id: string; account: string; name: string; group: string; subscription: string;
        snapshot: string; public: boolean; project: boolean }[];
    watchlist: { tool: string; posture: string }[]; events: Finding[];
    billing: { date: string; product: string; credits: number; cost: number; currency: string; subscription: string }[];
}
const files = import.meta.glob<GovernanceData>("./governance-data.generated.json", { eager: true, import: "default" });
export const governanceData = files["./governance-data.generated.json"];
if (!governanceData) throw new Error("Generated governance sources are missing. Run npm run demo:data:analytics.");

const weights: Record<string, number> = {
    "No sign-in required": 3, "Owner has left": 3, "Org-wide with org data": 2,
    "No owner on record": 2, "Shared, no recorded use": 1,
};
const ownerStatus = (row: Configuration) => !row.owner ? "No owner on record"
    : row.ownerStatus === "Disabled" ? "Owner disabled" : row.ownerStatus === "Active" ? "Owner active" : "Not checked";
function flags(row: Configuration) {
    if (row.quarantined || !row.tenant) return [];
    return [
        ...(row.noSignIn ? ["No sign-in required"] : []),
        ...(ownerStatus(row) === "Owner disabled" ? ["Owner has left"] : []),
        ...(!row.owner ? ["No owner on record"] : []),
        ...(row.scope === "Whole organisation" && row.access === "Organisation content" ? ["Org-wide with org data"] : []),
        ...(row.scope !== "Not shared" && row.users === 0 ? ["Shared, no recorded use"] : []),
    ];
}
const scopes = ["Whole organisation", "Specific people or groups", "Not shared"];
const accesses = ["Organisation content", "Uploaded files only", "None declared"];
const statuses = ["Owner active", "Owner disabled", "Owner not found", "No owner on record", "Not checked"];

/** Counts and lists are reduced from simulated records, not independent chart fixtures. */
export function sampleGovernanceRows(query: string, columns: readonly string[]): unknown[][] | undefined {
    const names = columns.map(nameOf);
    const has = (...fields: string[]) => fields.every(field => names.includes(field));
    const output = (...rows: RecordRow[]) => project(columns, rows);
    const selectedNames = literals(query, "Agents 365", "Agent name") ?? literals(query, "Agent Configuration", "AgentName");
    const selectedTypes = literals(query, "Agents 365", "Agent Type Label") ?? literals(query, "Agent Configuration", "Agent Type Label");
    const config = governanceData.config.filter(row => (!selectedNames || selectedNames.includes(row.agent))
        && (!selectedTypes || selectedTypes.includes(row.type)));
    const tenant = config.filter(row => row.tenant);
    const live = tenant.filter(row => !row.quarantined);
    const standalone = !query.includes("'Agents 365'") && query.includes("'Agent Configuration'");
    const governed = standalone ? config : tenant;
    const active = standalone ? config.filter(row => !row.quarantined) : live;

    if (has("Configured Agents", "Agent Status") && query.includes("'Agent Configuration'")) {
        return output({
            "Configured Agents": config.length, "Matched Agents": config.filter(row => row.id).length,
            "No Sign In": live.filter(row => row.noSignIn).length,
            "No Sign In Configured": config.filter(row => row.noSignIn && !row.quarantined).length,
            "Web Search": live.filter(row => row.webSearch).length,
            "Web Search Configured": config.filter(row => row.webSearch && !row.quarantined).length,
            "Foundry Resources": governanceData.foundry.length,
            "Foundry Public": governanceData.foundry.filter(row => row.public).length,
            "Foundry Public Projects": governanceData.foundry.filter(row => row.public && row.project).length,
            "Agent Status": "ok", "Foundry Status": "ok",
        });
    }
    if (/Governance Flags|Sharing Scope|Owner account/.test(query) && /'Agents 365'|'Agent Configuration'/.test(query)) {
        if (has("Tenant Agents", "Needs Review")) return output({
            "Tenant Agents": governed.length, "Needs Review": governed.filter(row => flags(row).length).length,
            "Seen In Use": governed.filter(row => row.users > 0).length,
            "No Sign In": governed.filter(row => flags(row).includes("No sign-in required")).length,
            "Owner Left": governed.filter(row => flags(row).includes("Owner has left")).length,
            "No Owner": governed.filter(row => flags(row).includes("No owner on record")).length,
            "Org Wide Org Data": governed.filter(row => flags(row).includes("Org-wide with org data")).length,
            "Shared Unused": governed.filter(row => flags(row).includes("Shared, no recorded use")).length,
            "Org Wide": governed.filter(row => row.scope === "Whole organisation").length,
            "Owners Checked": governed.filter(row => row.ownerStatus !== "Not checked").length,
        });
        if (has("Owner Status", "Agents")) return output(...groups(active, ownerStatus).map(([status, rows]) => ({
            "Status Order": statuses.indexOf(status) + 1, "Owner Status": status, Agents: rows.length,
        })).sort((a, b) => a["Status Order"] - b["Status Order"]));
        if (has("Flags", "Priority")) {
            const queue = governed.filter(row => flags(row).length);
            return output(...queue.map(row => ({
                Agent: row.agent, "Registry Id": row.id, "Agent Id": row.resource, Type: row.type,
                Creator: row.owner || "No owner on record", "Sharing Scope": row.scope, "Data Access": row.access,
                Users: row.users, "Owner Account": row.ownerStatus, "Flag Count": flags(row).length,
                Priority: flags(row).reduce((total, flag) => total + weights[flag], 0), Flags: flags(row).join("; "),
                Total: queue.length,
            })).sort((a, b) => b.Priority - a.Priority || b["Flag Count"] - a["Flag Count"] || b.Users - a.Users
                || a.Agent.localeCompare(b.Agent)).slice(0, 1000));
        }
        if (has("Sharing Scope", "Data Access", "Unused Agents")) {
            const web = query.includes('"Public web"');
            const rows = web ? active.filter(row => row.webSearch) : active;
            return output(...groups(rows, row => `${row.scope}|${web ? "Public web" : row.access}`).map(([, values]) => ({
                "Scope Order": scopes.indexOf(values[0].scope) + 1, "Sharing Scope": values[0].scope,
                "Access Order": web ? 5 : accesses.indexOf(values[0].access) + 1,
                "Data Access": web ? "Public web" : values[0].access, Agents: values.length,
                "Unused Agents": values.filter(row => row.users === 0).length,
            })).sort((a, b) => a["Scope Order"] - b["Scope Order"] || a["Access Order"] - b["Access Order"]));
        }
    }
    if (has("Tool", "Posture") || has("Tools Watched", "Tools Found") || has("Probe", "Run At")) {
        const posture = new Map(governanceData.watchlist.map(row => [row.tool, row.posture]));
        const recent = governanceData.events.filter(row => row.date >= "2026-08-02");
        const shadow = recent.filter(row => posture.get(row.tool) !== "Sanctioned");
        if (has("Tool", "Posture") && query.includes("'Shadow AI Daily'")) {
            return output(...groups(shadow, row => `${row.tool}|${row.layer}`).map(([, rows]) => ({
                Tool: rows[0].tool, Layer: rows[0].layer, Posture: posture.get(rows[0].tool),
                Devices: unique(rows, row => row.device),
                Users: rows[0].layer === "Installed" ? null : unique(rows, row => row.user),
            })).sort((a, b) => a.Layer.localeCompare(b.Layer) || b.Devices - a.Devices || a.Tool.localeCompare(b.Tool)));
        }
        if (has("Tools Watched", "Tools Found") && query.includes("[Shadow AI Tools Found]")) return output({
            "Tools Watched": governanceData.watchlist.length,
            "Unsanctioned Tools": governanceData.watchlist.filter(row => row.posture === "Unsanctioned").length,
            "Tools Found": unique(shadow, row => row.tool),
            "Tools This Week": unique(shadow.filter(row => row.date >= "2026-08-25"), row => row.tool),
            Devices: unique(shadow.filter(row => row.layer !== "Cloud Discovery"), row => row.device),
            Users: unique(shadow.filter(row => row.layer !== "Installed" && row.layer !== "Cloud Discovery"), row => row.user),
            "Cloud Users": unique(shadow.filter(row => row.layer === "Cloud Discovery"), row => row.user), Status: "ok",
        });
        if (has("Probe", "Run At") && query.includes("'Defender Status'")) return output(...[
            ["device_activity", recent.filter(row => row.layer === "Ran" || row.layer === "Network").length],
            ["installed", recent.filter(row => row.layer === "Installed").length],
            ["agents", config.length],
            ["cloud_discovery", recent.filter(row => row.layer === "Cloud Discovery").length],
        ].map(([Probe, Rows]) => ({
            Probe, Rows, Status: "ok", Source: "Deterministic generated synthetic scenario",
            Message: "Simulated findings only; no Defender request was made.", "Run At": "2026-08-31",
        })));
    }
    if (has("Registry Agents", "Unmatched Sessions")) {
        const activity = samples.activity.filter(row => row.audience === "Agents");
        const registry = new Set(samples.agents.map(row => row["Agent name"]));
        return output({
            "Registry Agents": samples.agents.length, "Tenant Built": governanceData.config.filter(row => row.tenant).length,
            "Seen In Use": unique(activity.filter(row => registry.has(row.agent)), row => row.agent),
            "Unmatched Sessions": unique(activity.filter(row => !registry.has(row.agent)), row => `${row.user}|${row.app}|${row.thread}`),
            "Registry Updated": [...samples.agents.map(row => row["Last updated"])].sort().at(-1),
        });
    }
    return undefined;
}
