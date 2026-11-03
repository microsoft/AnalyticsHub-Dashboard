// @ts-check
/**
 * Agent configuration and Foundry resources from Azure Resource Graph. The installer adds these
 * tables to the ValueLens and Consumption models at deploy time, so the templates stay as they are.
 * When the source is off, or before the first load, the tables are there but empty, so queries
 * against them never fail.
 */
import { createHash } from 'node:crypto';

/** @typedef {'date' | 'datetime' | 'text' | 'count' | 'flag'} ArgColumnKind */
/** @typedef {{ name: string, source: string, description: string, columns: { name: string, kind: ArgColumnKind }[] }} ArgTable */

/** @param {string} spec  Space-separated names; a suffix of `:date`, `:datetime`, `:flag` or `:count` sets the kind. */
export const cols = (spec) =>
  spec.split(/\s+/).filter(Boolean).map((s) => {
    const [name, kind = 'text'] = s.split(':');
    return { name, kind: /** @type {ArgColumnKind} */ (kind) };
  });

export const AGENT_CONFIG_TABLE = 'Agent Configuration';
export const ENVIRONMENTS_TABLE = 'Power Platform Environments';
export const AGENT_FLOWS_TABLE = 'Agent Flows';
export const FOUNDRY_TABLE = 'Foundry Resources';
export const ARG_STATUS_TABLE = 'Resource Graph Status';
export const AGENT_DETAIL_TABLE = 'Agent Detail';
export const REGISTRY_TABLE = 'Agents 365';
export const AUDIT_TABLE = 'Chat + Agent Interactions (Audit Logs)';

/** Written by Copilot_Resource_Graph_Ingester, or by the Azure jobs. Each load replaces the last. */
export const ARG_TABLES = /** @type {ArgTable[]} */ ([
  {
    name: AGENT_CONFIG_TABLE,
    source: 'arg_agent_config',
    description: 'One row per Copilot Studio agent: authentication, connectors, sharing, model and channels.',
    columns: cols(`SnapshotDate:date AgentResourceId BotId AgentName EntraAgentId EntraAppId TitleId MatchedOn EnvironmentId
      Authentication NoSignIn:flag IsQuarantined:flag IsManaged:flag WebSearchEnabled:flag ConnectorCount:count McpConnectorCount:count
      KnowledgeConnectorCount:count ConnectedAgentCount:count Connectors SharedUsers:count SharedGroups:count SharedEntireTenant:flag
      Orchestration Model Channels OwnerId CreatedIn LastPublishedAt Source`),
  },
  {
    name: ENVIRONMENTS_TABLE,
    source: 'arg_environments',
    description: 'One row per Power Platform environment.',
    columns: cols('SnapshotDate:date EnvironmentId EnvironmentName EnvironmentType IsDefault:flag IsManaged:flag Region Source'),
  },
  {
    name: AGENT_FLOWS_TABLE,
    source: 'arg_agent_flows',
    description: 'One row per agent flow.',
    columns: cols('SnapshotDate:date FlowId FlowName EnvironmentId OwnerId ConnectorCount:count Trigger CreatedAt LastModifiedAt Source'),
  },
  {
    name: FOUNDRY_TABLE,
    source: 'arg_foundry_resources',
    description: 'One row per Azure AI Foundry resource or project, with its network and sign-in settings.',
    columns: cols(`SnapshotDate:date ResourceId ResourceName ResourceType Kind Location SubscriptionId ResourceGroup Sku
      PublicNetworkAccess PublicNetwork:flag DisableLocalAuth:flag IsProject:flag AccountId`),
  },
  {
    name: AGENT_DETAIL_TABLE,
    source: 'arg_agent_detail',
    description: "One row per Copilot Studio agent: what it's built from, what knowledge it reads, and whether its owner's Entra account is still active.",
    columns: cols(`SnapshotDate:date AgentResourceId CreatedBy QuarantinedAt TopicCount:count ToolCount:count KnowledgeCount:count
      EditorUserCount:count EntraAgentBlueprintId Harness InstructionsCharCount:count KnowledgeTypes SharePointSiteCount:count
      GraphConnectorCount:count PublicSiteCount:count FileKnowledgeCount:count DataverseSourceCount:count OwnerAccount OwnerUpn Source`),
  },
  {
    name: ARG_STATUS_TABLE,
    source: 'arg_status',
    description: 'What each Resource Graph probe returned on the last load, in plain words.',
    columns: cols('SnapshotDate:date Probe Status Rows:count Source Detail'),
  },
]);

/** Relationships from the agent configuration table. Ones to a table the template lacks are left out. */
export const ARG_RELATIONSHIPS = [
  { fromTable: AGENT_CONFIG_TABLE, fromColumn: 'TitleId', toTable: REGISTRY_TABLE, toColumn: 'Title ID' },
  { fromTable: AGENT_CONFIG_TABLE, fromColumn: 'EnvironmentId', toTable: ENVIRONMENTS_TABLE, toColumn: 'EnvironmentId' },
];

/**
 * @typedef {{ table: string, name: string, dataType: 'string' | 'int64', description: string, needs?: string[], expression: string[] }} ArgCalculatedColumn
 */

const AC = `'${AGENT_CONFIG_TABLE}'`;
const DETAIL = `'${AGENT_DETAIL_TABLE}'`;
const AUDIT = `'${AUDIT_TABLE}'`;
/** The agent's own row in Agent Detail: the same agent at the same load. */
const DETAIL_ROWS = `FILTER(${DETAIL}, ${DETAIL}[AgentResourceId] = ${AC}[AgentResourceId] && ${DETAIL}[SnapshotDate] = ${AC}[SnapshotDate])`;

/**
 * Governance's registry fields, worked out from Resource Graph so the Governance tabs run without
 * Agent 365. Each matches the registry column of the same name, in the same words. Only `Total
 * Users` uses CALCULATE: two columns on one table that both do would depend on each other.
 */
export const ARG_CALCULATED_COLUMNS = /** @type {ArgCalculatedColumn[]} */ ([
  {
    table: AGENT_CONFIG_TABLE,
    name: 'Owner account',
    dataType: 'string',
    description: "Whether the owner's Entra account is Active, Disabled or Not found, from Microsoft Graph. Blank when it wasn't checked.",
    needs: [AGENT_DETAIL_TABLE],
    expression: [`VAR _Account = MAXX(${DETAIL_ROWS}, ${DETAIL}[OwnerAccount])`, 'RETURN IF(_Account <> "", _Account)'],
  },
  {
    table: AGENT_CONFIG_TABLE,
    name: 'Owner UPN',
    dataType: 'string',
    description: "The owner's user principal name, from Microsoft Graph. Blank when it wasn't checked or the account is gone.",
    needs: [AGENT_DETAIL_TABLE],
    expression: [`VAR _Upn = MAXX(${DETAIL_ROWS}, ${DETAIL}[OwnerUpn])`, 'RETURN IF(_Upn <> "", _Upn)'],
  },
  {
    table: AGENT_CONFIG_TABLE,
    name: 'Sharing Scope',
    dataType: 'string',
    description: 'Who can use the agent: Whole organisation, Specific people or groups, or Not shared.',
    expression: [
      'SWITCH(TRUE(),',
      `    ${AC}[SharedEntireTenant] = TRUE(), "Whole organisation",`,
      `    COALESCE(${AC}[SharedUsers], 0) + COALESCE(${AC}[SharedGroups], 0) > 0, "Specific people or groups",`,
      '    "Not shared")',
    ],
  },
  {
    table: AGENT_CONFIG_TABLE,
    name: 'Data Access',
    dataType: 'string',
    description:
      'What the agent can read: Organisation content (SharePoint, Graph connectors, Dataverse or knowledge connectors), Uploaded files only, None declared, or Not reported when Resource Graph gave no knowledge details.',
    needs: [AGENT_DETAIL_TABLE],
    expression: [
      `VAR _Detail = ${DETAIL_ROWS}`,
      `VAR _Org    = SUMX(_Detail, ${DETAIL}[SharePointSiteCount] + ${DETAIL}[GraphConnectorCount] + ${DETAIL}[DataverseSourceCount])`,
      `VAR _Files  = SUMX(_Detail, ${DETAIL}[FileKnowledgeCount])`,
      'RETURN SWITCH(TRUE(),',
      `    _Org > 0 || COALESCE(${AC}[KnowledgeConnectorCount], 0) > 0, "Organisation content",`,
      '    _Files > 0, "Uploaded files only",',
      '    NOT ISEMPTY(_Detail), "None declared",',
      '    "Not reported")',
    ],
  },
  {
    table: AGENT_CONFIG_TABLE,
    name: 'Agent Type Label',
    dataType: 'string',
    description: 'Where the agent was built, in the registry\'s words: Maker: Copilot Studio, Agent Builder, SharePoint or Foundry, or Maker-built.',
    expression: [
      `VAR _C = LOWER(TRIM(COALESCE(${AC}[CreatedIn], "")))`,
      'RETURN SWITCH(TRUE(),',
      '    CONTAINSSTRING(_C, "agent builder"), "Maker: Agent Builder",',
      '    CONTAINSSTRING(_C, "copilot studio"), "Maker: Copilot Studio",',
      '    CONTAINSSTRING(_C, "sharepoint"), "Maker: SharePoint",',
      '    CONTAINSSTRING(_C, "foundry"), "Maker: Foundry",',
      '    "Maker-built")',
    ],
  },
  {
    table: AGENT_CONFIG_TABLE,
    name: 'Total Users',
    dataType: 'int64',
    description: "Distinct people the audit log records using the agent, matched by name as the registry's Total Users is.",
    needs: [AUDIT_TABLE],
    // The audit table filters Agents 365 both ways, so the row's own filters would reach it through
    // the Title ID relationship. Only the name should count.
    expression: [
      `VAR _Name = ${AC}[AgentName]`,
      'RETURN',
      '    IF(_Name <> "",',
      `        CALCULATE(DISTINCTCOUNT(${AUDIT}[Audit_UserId]), ${AUDIT}[AgentName] = _Name, REMOVEFILTERS(${AC})))`,
    ],
  },
  {
    table: AGENT_CONFIG_TABLE,
    name: 'Governance Flags',
    dataType: 'string',
    description:
      "Why an agent that isn't quarantined needs review, separated by '; ': No sign-in required, Owner has left, No owner on record, Org-wide with org data, Shared, no recorded use. Blank when none apply.",
    needs: [AGENT_DETAIL_TABLE, AUDIT_TABLE],
    expression: [
      `VAR _Live   = NOT (${AC}[IsQuarantined] = TRUE())`,
      `VAR _Owner  = LOWER(TRIM(COALESCE(${AC}[Owner account], "")))`,
      `VAR _Scope  = ${AC}[Sharing Scope]`,
      `VAR _Unused = COALESCE(${AC}[Total Users], 0) = 0`,
      'VAR _List =',
      `    IF(${AC}[NoSignIn] = TRUE(), "; No sign-in required")`,
      '    & IF(_Owner IN {"disabled", "not found"}, "; Owner has left")',
      `    & IF(TRIM(COALESCE(${AC}[OwnerId], "")) = "", "; No owner on record")`,
      `    & IF(_Scope = "Whole organisation" && ${AC}[Data Access] = "Organisation content", "; Org-wide with org data")`,
      '    & IF(_Scope IN {"Whole organisation", "Specific people or groups"} && _Unused, "; Shared, no recorded use")',
      'RETURN IF(_Live && _List <> "", MID(_List, 3, 500))',
    ],
  },
  {
    table: REGISTRY_TABLE,
    name: 'Owner account (Resource Graph)',
    dataType: 'string',
    description:
      "The owner check from Resource Graph for the same agent, matched on Title ID: Active, Disabled or Not found. Governance Flags falls back to it when the registry's own Owner account is blank.",
    needs: [AGENT_DETAIL_TABLE],
    expression: [
      `VAR _Id   = '${REGISTRY_TABLE}'[Title ID]`,
      `VAR _Date = MAX(${AC}[SnapshotDate])`,
      'RETURN',
      '    IF(_Id <> "",',
      `        MAXX(FILTER(${AC}, ${AC}[TitleId] = _Id && ${AC}[SnapshotDate] = _Date), ${AC}[Owner account]))`,
    ],
  },
]);

/** The registry flags' owner line, as the template has it, and what it becomes with the Resource Graph fallback. */
export const REGISTRY_OWNER_LINE = `VAR _Owner   = LOWER(TRIM(COALESCE('${REGISTRY_TABLE}'[Owner account], "")))`;
export const REGISTRY_OWNER_FALLBACK = [
  `VAR _Owner   = LOWER(TRIM(IF(TRIM(COALESCE('${REGISTRY_TABLE}'[Owner account], "")) = "",`,
  `    COALESCE('${REGISTRY_TABLE}'[Owner account (Resource Graph)], ""), '${REGISTRY_TABLE}'[Owner account])))`,
].join('\n');

/**
 * A stable GUID for an object the installer adds, so redeploys don't churn lineage.
 * @param {string} key
 */
export function stableGuid(key) {
  const h = createHash('sha1').update(`valuelens:arg:${key}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const M_TYPES = /** @type {Record<ArgColumnKind, string>} */ ({ date: 'type date', datetime: 'type datetime', text: 'type text', count: 'Int64.Type', flag: 'type logical' });

/**
 * The partition's Power Query. `source` is the M that reads the Lakehouse table; without it the table is empty.
 * @param {ArgTable} t
 * @param {string[] | null} source
 */
function partitionExpression(t, source) {
  const names = `{${t.columns.map((c) => `"${c.name}"`).join(', ')}}`;
  const types = t.columns.map((c) => `{"${c.name}", ${M_TYPES[c.kind]}}`).join(', ');
  return [
    'let',
    `    Columns = ${names},`,
    ...(source ?? ['    Source = #table(Columns, {}),']),
    '    Kept = Table.SelectColumns(Source, Columns, MissingField.UseNull),',
    `    Typed = Table.TransformColumnTypes(Kept, {${types}})`,
    'in',
    '    Typed',
  ];
}

/**
 * For the ValueLens model, which reads tables with FabricTable.
 * @param {ArgTable} t
 * @param {boolean} on
 */
export const valueLensExpression = (t, on) =>
  partitionExpression(t, on ? [`    Source = try FabricTable("${t.source}") otherwise EmptyTable(Columns),`] : null);

/**
 * For the Consumption model, which reads tables with GetTable.
 * @param {ArgTable} t
 * @param {boolean} on
 */
export const consumptionExpression = (t, on) =>
  partitionExpression(t, on ? [`    Raw = GetTable("${t.source}"),`, '    Source = if Raw = null then #table(Columns, {}) else Raw,'] : null);

/**
 * @param {string} table
 * @param {{ name: string, kind: ArgColumnKind }} c
 */
function column(table, c) {
  const base = { name: c.name, sourceColumn: c.name, lineageTag: stableGuid(`column:${table}:${c.name}`) };
  /** @type {{ name: string, value: string }[]} */
  const annotations = [{ name: 'SummarizationSetBy', value: 'Automatic' }];
  if (c.kind === 'date') {
    annotations.push({ name: 'UnderlyingDateTimeDataType', value: 'Date' });
    return { ...base, dataType: 'dateTime', formatString: 'Long Date', summarizeBy: 'none', annotations };
  }
  if (c.kind === 'datetime') return { ...base, dataType: 'dateTime', formatString: 'General Date', summarizeBy: 'none', annotations };
  if (c.kind === 'flag') return { ...base, dataType: 'boolean', formatString: '"TRUE";"TRUE";"FALSE"', summarizeBy: 'none', annotations };
  if (c.kind === 'count') return { ...base, dataType: 'int64', formatString: '#,0', summarizeBy: 'sum', annotations };
  return { ...base, dataType: 'string', summarizeBy: 'none', annotations };
}

/**
 * @param {import('./model.js').ModelBim['model']} model
 * @param {ArgTable} t
 * @param {string[]} expression
 * @param {string} [from]  Ends the table's description.
 */
export function addTable(model, t, expression, from = 'From Azure Resource Graph.') {
  model.tables.push({
    name: t.name,
    description: `${t.description} ${from}`,
    lineageTag: stableGuid(`table:${t.name}`),
    columns: t.columns.map((c) => column(t.name, c)),
    partitions: [{ name: t.name, mode: 'import', source: { type: 'm', expression } }],
    annotations: [{ name: 'PBI_ResultType', value: 'Table' }],
  });
}

/**
 * Adds the Resource Graph tables and their relationships to the ValueLens model. Tables the
 * template already has are left alone.
 * @param {import('./model.js').ModelBim['model']} model
 * @param {boolean} on
 */
export function addResourceGraph(model, on) {
  const added = new Set();
  for (const t of ARG_TABLES) {
    if (model.tables.some((x) => x.name === t.name)) continue;
    addTable(model, t, valueLensExpression(t, on));
    added.add(t.name);
  }
  const tables = new Set(model.tables.map((t) => t.name));
  model.relationships = model.relationships ?? [];
  for (const r of ARG_RELATIONSHIPS) {
    if (!added.has(r.fromTable) || !tables.has(r.toTable)) continue;
    model.relationships.push({
      name: stableGuid(`relationship:${r.fromTable}:${r.fromColumn}:${r.toTable}`),
      fromTable: r.fromTable,
      fromColumn: r.fromColumn,
      toTable: r.toTable,
      toColumn: r.toColumn,
    });
  }
  if (added.has(AGENT_CONFIG_TABLE)) addGovernanceColumns(model);
}

/**
 * Adds the Resource Graph governance columns, then points the registry's `Governance Flags` at
 * the Resource Graph owner check for agents the registry has none for. A column whose name is
 * taken, or that needs a table the template lacks, is left out, with the columns built on it.
 * The flags are only changed when their owner line is exactly the one this was written against.
 * @param {import('./model.js').ModelBim['model']} model
 * @returns {{ columns: string[], ownerFallback: boolean }}  What was added.
 */
export function addGovernanceColumns(model) {
  const tables = new Map(model.tables.map((t) => [t.name, t]));
  /** @type {string[]} */
  const columns = [];
  const skipped = new Set();
  for (const c of ARG_CALCULATED_COLUMNS) {
    const table = tables.get(c.table);
    const uses = ARG_CALCULATED_COLUMNS.filter((u) => u !== c && c.expression.join('\n').includes(`'${u.table}'[${u.name}]`));
    if (
      !table ||
      table.columns.some((/** @type {any} */ x) => x.name === c.name) ||
      (c.needs ?? []).some((n) => !tables.has(n)) ||
      uses.some((u) => skipped.has(u))
    ) {
      skipped.add(c);
      continue;
    }
    table.columns.push({
      type: 'calculated',
      name: c.name,
      dataType: c.dataType,
      isDataTypeInferred: true,
      expression: c.expression,
      description: c.description,
      summarizeBy: 'none',
      ...(c.dataType === 'int64' ? { formatString: '#,0' } : {}),
      lineageTag: stableGuid(`column:${c.table}:${c.name}`),
      annotations: [{ name: 'SummarizationSetBy', value: 'Automatic' }],
    });
    columns.push(`${c.table}[${c.name}]`);
  }
  return { columns, ownerFallback: columns.includes(`${REGISTRY_TABLE}[Owner account (Resource Graph)]`) && useOwnerFallback(tables.get(REGISTRY_TABLE)) };
}

/**
 * Swaps the registry flags' owner line for one that falls back to the Resource Graph check.
 * @param {any} registry
 */
function useOwnerFallback(registry) {
  const flags = registry?.columns.find((/** @type {any} */ c) => c.name === 'Governance Flags' && c.type === 'calculated');
  if (!flags) return false;
  const lines = Array.isArray(flags.expression) ? [...flags.expression] : String(flags.expression).split('\n');
  const at = lines.findIndex((l) => l.trim() === REGISTRY_OWNER_LINE);
  if (at < 0 || lines.filter((l) => l.trim() === REGISTRY_OWNER_LINE).length !== 1) return false;
  lines.splice(at, 1, ...REGISTRY_OWNER_FALLBACK.split('\n'));
  flags.expression = lines;
  return true;
}

/**
 * Adds the Foundry resources table to the Consumption model, with no relationships. A template
 * that already has it is left alone.
 * @param {import('./model.js').ModelBim['model']} model
 * @param {boolean} on
 */
export function addFoundryResources(model, on) {
  const t = /** @type {ArgTable} */ (ARG_TABLES.find((x) => x.name === FOUNDRY_TABLE));
  if (model.tables.some((x) => x.name === t.name)) return;
  if (on && !model.expressions?.some((e) => e.name === 'GetTable')) throw new Error('The credit consumption model template has no "GetTable" function.');
  addTable(model, t, consumptionExpression(t, on));
}
