// @ts-check
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { azureAgentEvaluatorOn, azurePlanReview, azurePreflight, azureRefresh, azureSemanticModels, azureStatus, azureViewerModels, installAzure } from '../src/steps/azure/index.js';
import { MODEL_UPDATE_NOTE, pendingReloads } from '../src/steps/model.js';
import { AZURE_ROLES_FILE } from '../src/steps/org-access.js';
import { buildAgentEvaluatorModel, loadTemplateModel, mParameter } from '../src/transform/model.js';
import { fakeArm, fakeAzureGraph, fakeCtx, fakeFabric, fakePowerBi, fakeUi, realSources } from './fakes.js';

const AE_MODEL = 'Analytics Hub Agent Evaluator Model';
const SERVER = 'vlens-sql.database.windows.net';
const DATABASE = 'valuelens';
const REPO = fileURLToPath(new URL('../../', import.meta.url));

/**
 * An Azure install with Agent Evaluator turned on directly, since the Azure module list doesn't offer it yet.
 * @param {{ private?: boolean, environments?: boolean, sources?: any, az?: Record<string, any> }} [o]
 */
async function aeInstall(o = {}) {
  const arm = fakeArm();
  /** @type {any[]} */
  const deployments = [];
  const deploy = /** @type {(...a: any[]) => Promise<any>} */ (arm.api.deployTemplate);
  arm.api.deployTemplate = async (/** @type {any[]} */ ...args) => {
    deployments.push(args[3]);
    return deploy(...args);
  };
  const graph = fakeAzureGraph();
  const fabric = fakeFabric();
  const powerBi = fakePowerBi();
  if (!o.private) powerBi.setDatasources([{ datasourceType: 'Sql', gatewayId: 'gw', datasourceId: 'ds', connectionDetails: { server: SERVER, database: DATABASE } }]);
  const ui = fakeUi();
  const { ctx, config } = fakeCtx({ arm: arm.api, graph: graph.api, fabric: fabric.api, powerBi: powerBi.api, ui: ui.ui, sources: o.sources });
  Object.assign(config, {
    target: 'azure',
    azure: {
      subscriptionId: 'sub-1',
      resourceGroup: 'rg',
      location: 'uksouth',
      namePrefix: 'vlens',
      installId: o.private ? '12345678-aaaa' : 'install-1',
      tags: {},
      deployments: [],
      outputs: {},
      graphRoles: { assigned: [], pending: [] },
      publicNetworkAccess: !o.private,
      workspaceName: 'Analytics Hub',
      ...(o.private ? { powerBi: { capacityId: 'cap-f' } } : {}),
      ...o.az,
    },
  });
  config.modules.agentEvaluator = true;
  if (o.environments !== false) config.agentEvaluator.environments = [{ url: 'https://env.example.com', id: 'env-1', name: 'Example' }];
  if (o.private) await azurePreflight(ctx);
  ctx.runFirstLoad = false;
  const ok = await installAzure(ctx, { wait: true });
  return { ctx, config, arm, graph, fabric, powerBi, ui, deployments, ok, az: /** @type {any} */ (config.azure) };
}

/** The model.bim a fake Fabric holds for a semantic model. @param {ReturnType<typeof fakeFabric>} fabric @param {string} id */
function deployedBim(fabric, id) {
  const item = /** @type {any} */ (fabric.items.find((i) => i.id === id));
  return JSON.parse(Buffer.from(item.content.parts.find((/** @type {any} */ p) => p.path === 'model.bim').payload, 'base64').toString('utf8'));
}

/** The web app's models, from the last deployment. @param {any[]} deployments */
const deployedAliases = (deployments) => Object.keys(JSON.parse(deployments.at(-1).properties.parameters.semanticModels.value)).sort();

test('Azure Agent Evaluator: its model is wanted with the module on, an environment to read and tenant data', () => {
  const { config } = fakeCtx();
  config.target = 'azure';
  config.azure = /** @type {any} */ ({ powerBi: { workspaceId: 'ws', datasetId: 'vl-1', consumptionDatasetId: 'cc-1', agentEvaluatorDatasetId: 'ae-1' } });
  assert.equal(azureAgentEvaluatorOn(config), false, 'off by default');
  config.modules.agentEvaluator = true;
  assert.equal(azureAgentEvaluatorOn(config), false, 'no environment to read transcripts from');
  config.agentEvaluator.environments = [{ url: 'https://env.example.com' }];
  assert.equal(azureAgentEvaluatorOn(config), true);
  /** @type {any} */ (config.azure).sampleData = true;
  assert.equal(azureAgentEvaluatorOn(config), false, 'demo mode publishes no Agent Evaluator tables');

  assert.deepEqual(azureSemanticModels(config), { vl: { workspaceId: 'ws', itemId: 'vl-1' }, ae: { workspaceId: 'ws', itemId: 'ae-1' } });
  assert.deepEqual(
    azureViewerModels(config).map((m) => `${m.datasetId} ${m.name}`),
    [`vl-1 ${config.semanticModel.name}`, `ae-1 ${AE_MODEL}`],
    'the viewer group gets Build on it, so the app can query it',
  );
});

test('Azure install with Agent Evaluator: a third model, reading Azure SQL, bound, scheduled and given to the app as ae', async () => {
  const t = await aeInstall();
  assert.equal(t.ok, true);
  const ae = t.config.agentEvaluator.model;
  assert.ok(t.fabric.calls.includes(`createSemanticModel ${AE_MODEL}`));
  assert.ok(ae.id && ae.id !== t.az.powerBi.datasetId);
  assert.equal(t.az.powerBi.agentEvaluatorDatasetId, ae.id);

  const bim = deployedBim(t.fabric, ae.id);
  assert.equal(mParameter(bim.model, 'Fabric SQL Endpoint'), SERVER);
  assert.equal(mParameter(bim.model, 'Lakehouse Name'), DATABASE);
  assert.equal(mParameter(bim.model, 'Source Mode'), 'Fabric');
  assert.ok(bim.model.tables.some((/** @type {any} */ tb) => tb.name === 'Evaluator Status'));
  assert.ok(!bim.model.roles?.length, 'no roles without org-scoped access');

  assert.equal(t.powerBi.calls.filter((c) => c === 'updateDatasource gw ds ServicePrincipal').length, 2, 'the main model and Agent Evaluator are bound');
  assert.ok(t.powerBi.calls.includes(`setRefreshSchedule ${t.az.powerBi.workspaceId} ${ae.id}`));
  assert.deepEqual(deployedAliases(t.deployments), ['ae', 'vl'], 'the app can query it, and the jobs refresh it');
  assert.ok(t.ui.text().includes(`Evaluator:  model ${ae.id}`));

  // A repair leaves it as it is.
  t.fabric.calls.length = 0;
  assert.equal(await installAzure(t.ctx, { wait: true }), true);
  assert.ok(!t.fabric.calls.some((c) => c.startsWith('createSemanticModel') || c.startsWith('updateSemanticModel')));
  assert.equal(t.az.powerBi.agentEvaluatorDatasetId, ae.id);
});

test('Azure install with Agent Evaluator: no model in demo mode, without an environment or without its template', async () => {
  /** @type {[string, Parameters<typeof aeInstall>[0]][]} */
  const cases = [
    ['demo mode', { az: { sampleData: true } }],
    ['no environment', { environments: false }],
  ];
  for (const [label, o] of cases) {
    const t = await aeInstall(o);
    assert.ok(!t.fabric.calls.includes(`createSemanticModel ${AE_MODEL}`), label);
    assert.equal(t.az.powerBi?.agentEvaluatorDatasetId, undefined, label);
    assert.equal(t.config.agentEvaluator.model.id, undefined, label);
  }

  const bare = await aeInstall({ sources: { ...realSources(), agentEvaluatorModelFile: undefined } });
  assert.equal(bare.ok, true);
  assert.match(bare.ui.text(), /This checkout has no Agent Evaluator report, so only the jobs collect the transcripts\./);
  assert.equal(bare.az.powerBi.agentEvaluatorDatasetId, undefined);
  assert.deepEqual(deployedAliases(bare.deployments), ['vl']);
});

test('Azure install with Agent Evaluator and private networking: its model is bound through the VNet data gateway too', async () => {
  const t = await aeInstall({ private: true });
  const pbi = t.az.powerBi;
  assert.ok(pbi.agentEvaluatorDatasetId);
  assert.ok(t.powerBi.calls.includes(`bindToGateway ${pbi.datasetId} ${pbi.gatewayId} ${pbi.connectionId}`));
  assert.ok(t.powerBi.calls.includes(`bindToGateway ${pbi.agentEvaluatorDatasetId} ${pbi.gatewayId} ${pbi.connectionId}`));
  assert.ok(!t.powerBi.calls.some((c) => c.startsWith('updateDatasource')), 'no cloud credential binding in private mode');
});

test('Azure plan with Agent Evaluator: its model is listed, as new or updated in place', async () => {
  const t = await aeInstall();
  const row = () => azurePlanReview(t.ctx).creates.find((r) => r.name === AE_MODEL);
  assert.deepEqual(row(), { kind: 'Semantic model', name: AE_MODEL, isNew: false, detail: `Agent Evaluator, reading Azure SQL like the main model. ${MODEL_UPDATE_NOTE}` });
  delete t.az.powerBi.agentEvaluatorDatasetId;
  assert.deepEqual(row(), { kind: 'Semantic model', name: AE_MODEL, isNew: true, detail: 'Agent Evaluator, reading Azure SQL like the main model.' });
  t.ctx.sources = /** @type {any} */ ({ ...realSources(), agentEvaluatorModelFile: undefined });
  assert.equal(row(), undefined, 'not without its template');
  t.ctx.sources = realSources();
  t.config.modules.agentEvaluator = false;
  assert.equal(row(), undefined, 'not with the module off');
});

test('Azure refresh and status cover the Agent Evaluator model', async () => {
  const t = await aeInstall();
  const id = t.az.powerBi.agentEvaluatorDatasetId;
  t.powerBi.calls.length = 0;
  await azureRefresh(t.ctx);
  assert.ok(t.powerBi.calls.includes(`refresh ${t.az.powerBi.datasetId} full`));
  assert.ok(t.powerBi.calls.includes(`refresh ${id} full`));
  assert.ok(t.ui.text().includes(`Started a refresh of ${AE_MODEL}`));
  await azureStatus(t.ctx);
  assert.ok(t.ui.text().includes(`Evaluator:      ${id}`));
});

test('Azure: a replaced Agent Evaluator model is refreshed, and owed a reload until it is', async () => {
  const t = await aeInstall();
  const ae = t.config.agentEvaluator.model;
  ae.signature = 'from an older version';
  t.fabric.calls.length = 0;
  t.powerBi.calls.length = 0;
  assert.equal(await installAzure(t.ctx, { wait: true }), true);
  assert.deepEqual(t.fabric.calls.filter((c) => c.startsWith('updateSemanticModel')), [`updateSemanticModel ${AE_MODEL}`]);
  assert.equal(t.powerBi.calls.filter((c) => c.startsWith(`refresh ${ae.id} `)).length, 1);
  assert.ok(t.ui.text().includes(`${AE_MODEL} may show old data or miss new columns until it reloads after its update, so refreshing it now`));
  assert.deepEqual(pendingReloads(t.config), [], 'reloaded');

  // Owed a reload, it stays owed on Azure even with the module turned off, like the consumption model.
  t.config.modules.agentEvaluator = false;
  ae.reload = { since: '2026-01-01T00:00:00.000Z' };
  assert.deepEqual(pendingReloads(t.config), [ae]);
});

test('Azure install with Agent Evaluator and org-scoped access: its model gets the roles, and the roles file covers it', async () => {
  const t = await aeInstall();
  const id = t.az.powerBi.agentEvaluatorDatasetId;
  t.config.access = /** @type {any} */ ({ ...t.config.access, groupId: 'group-1', groupName: 'Analytics Hub Viewers', rls: { enabled: true, orgAttribute: 'department', applied: [] } });
  Object.assign(t.graph.api, { getGroup: async (/** @type {string} */ gid) => ({ id: gid, displayName: 'Analytics Hub Viewers' }) });
  Object.assign(t.powerBi.api, { datasetUsers: async () => [], addDatasetUser: async () => null });
  t.az.powerBi.capacityId = 'cap-1';
  /** @type {Map<string, string>} */
  const files = new Map();
  t.ctx.api.dataLake = /** @type {any} */ (() => ({
    readText: async (/** @type {string} */ container, /** @type {string} */ path) => files.get(`${container}/${path}`) ?? null,
    writeFile: async (/** @type {string} */ container, /** @type {string} */ path, /** @type {Uint8Array} */ bytes) => {
      files.set(`${container}/${path}`, Buffer.from(bytes).toString('utf8'));
    },
  }));
  t.fabric.jobs.push({ status: 'Completed' });
  t.fabric.calls.length = 0;

  assert.equal(await installAzure(t.ctx, { wait: true }), true);
  assert.ok(t.fabric.calls.includes(`updateSemanticModel ${AE_MODEL}`), 'updated to add the roles');
  assert.ok(deployedBim(t.fabric, id).model.roles?.length, 'with roles');
  const items = JSON.parse(files.get(`landing/${AZURE_ROLES_FILE}`) ?? '[]');
  assert.ok(items.some((/** @type {any} */ i) => i.datasetId === id && i.dataset === AE_MODEL), 'in the roles file');
  assert.deepEqual([...(t.config.access?.rls?.applied ?? [])].sort(), [t.az.powerBi.datasetId, id].sort());
  assert.match(t.ui.text(), new RegExp(`Org-scoped access applied to .*${AE_MODEL}`));
});

/** The Agent Evaluator model as deployed on Azure, with org-scoped access so it reads the access tables too. */
const azureEvaluatorModel = () =>
  buildAgentEvaluatorModel(loadTemplateModel(/** @type {string} */ (realSources().agentEvaluatorModelFile)), { server: SERVER, database: DATABASE, access: { orgAttribute: 'department' } }).model;

/** @param {any} e */
const mText = (e) => (Array.isArray(e) ? e.join('\n') : String(e ?? ''));

/** The tables Azure SQL has: the migrations' and the ones the jobs create when they first publish. */
function azureSqlTables() {
  const dir = join(REPO, 'azure', 'sql', 'migrations');
  const tables = new Set();
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.sql'))) {
    for (const m of readFileSync(join(dir, f), 'utf8').matchAll(/CREATE TABLE dbo\.(\w+)/g)) tables.add(m[1].toLowerCase());
  }
  for (const m of readFileSync(join(REPO, 'azure', 'jobs', 'valuelens_jobs', 'publish.py'), 'utf8').matchAll(/Target\("(\w+)"/g)) tables.add(m[1].toLowerCase());
  return tables;
}

test('Azure Agent Evaluator model: every table it reads is in Azure SQL, apart from one it has a fallback for', () => {
  const model = azureEvaluatorModel();
  const tables = azureSqlTables();
  const m = [...(model.expressions ?? []).map((e) => mText(e.expression)), ...model.tables.flatMap((tb) => (tb.partitions ?? []).map((p) => mText(p.source?.expression)))].join('\n');
  const reads = new Set([...m.matchAll(/FabricTable\("(\w+)"\)/g)].map((r) => r[1].toLowerCase()));
  for (const t of ['agent_sessions', 'agent_turns', 'agent_errors', 'agent_subagents', 'agent_performance', 'evaluator_status', 'copilot_org_data', 'access_scope', 'access_people']) {
    assert.ok(reads.has(t), `reads ${t}`);
  }
  assert.deepEqual([...reads].filter((t) => !tables.has(t)), ['agent_variables'], 'Agent Variables is the only table Azure SQL lacks');
  assert.match(m, /try FabricTable\("agent_variables"\) otherwise/, 'and it reads as empty without it');
  // Credit consumption: a direct export table is optional, and the Studio tables it falls back to are in Azure SQL.
  assert.match(m, /try FabricTable\("credit_consumption_" & name\) otherwise null/);
  for (const t of ['studio_agent', 'studio_user', 'studio_tenant_daily']) {
    assert.ok(m.includes(`"${t}"`), `reads ${t}`);
    assert.ok(tables.has(t), `${t} is in Azure SQL`);
  }
});

test("Azure Agent Evaluator model: the transcript tables' columns are in Azure SQL, or the template adds them", () => {
  const model = azureEvaluatorModel();
  const sql = readFileSync(join(REPO, 'azure', 'sql', 'migrations', 'V008__agent_evaluator.sql'), 'utf8');
  /** @param {string} table */
  const sqlColumns = (table) => {
    const body = new RegExp(`CREATE TABLE dbo\\.${table}\\s*\\(([\\s\\S]*?)\\n\\);`).exec(sql)?.[1];
    assert.ok(body, `V008 creates ${table}`);
    return new Set(body.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('--') && !/^(CONSTRAINT|PRIMARY|INDEX)\b/i.test(l)).map((l) => l.replace(/^\[?(\w+)\]?.*$/, '$1').toLowerCase()));
  };
  /** @type {[string, string, string[]][]} The model's table, the Azure SQL table, and the columns its M adds itself. */
  const pairs = [
    ['Agent Sessions', 'agent_sessions', ['Org Join Key']],
    ['Agent Turns', 'agent_turns', ['topic_derived', 'role_inferred', 'role_mismatch']],
    ['Agent Errors', 'agent_errors', []],
    ['Agent Sub-Agent Calls', 'agent_subagents', []],
    ['Agent Performance', 'agent_performance', ['InteractionDate', 'weekstart']],
    ['Evaluator Status', 'evaluator_status', []],
  ];
  for (const [name, table, added] of pairs) {
    const tb = model.tables.find((x) => x.name === name);
    assert.ok(tb, name);
    const columns = new Set(sqlColumns(table));
    const loaded = (tb.columns ?? []).filter((c) => c.type !== 'calculated' && c.sourceColumn).map((c) => /** @type {string} */ (c.sourceColumn));
    assert.ok(loaded.length, name);
    assert.deepEqual(loaded.filter((c) => !columns.has(c.toLowerCase())), added, name);
    const partitions = (tb.partitions ?? []).map((p) => mText(p.source?.expression)).join('\n');
    for (const c of added) assert.ok(partitions.includes(`"${c}"`), `${name}'s M adds ${c}`);
  }
});
