// @ts-check
/** The audit source: Auto (Sentinel, else the Office 365 Management Activity API) or Microsoft Graph. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { applyDataFlags, parseCli } from '../src/cli.js';
import { auditSource, AUDIT_SOURCES, graphHistoryOn, MANAGEMENT_API_APP_ID, MANAGEMENT_API_ROLE, NOTEBOOKS, permissionsFor, SENTINEL_PERMISSION } from '../src/catalog.js';
import { emptyConfig, loadConfig, saveConfig } from '../src/config.js';
import { notebookSettings } from '../src/steps/fabric.js';
import { adminPack, checkExistingApp, ensureApp, ensureConsent, managementRoles, reportAppCheck } from '../src/steps/identity.js';
import { AUDIT_SOURCE_CHOICES, GRAPH_HISTORY_CHOICES, planAuditSource, planGraphHistory } from '../src/steps/plan.js';
import { runPipeline } from '../src/steps/run.js';
import { runParameters } from '../src/steps/rerun.js';
import { fakeCtx, fakeFabric, fakeUi } from './fakes.js';
import { checkAuditAccess, checkAuditCommand, emptyAuditHelp, saveAuditCheck } from '../src/steps/audit-check.js';
import { auditSourcesApi } from '../src/clients/audit-sources.js';

const GRAPH_ROLES = [
  { id: 'r-audit', value: 'AuditLogsQuery.Read.All' },
  { id: 'r-reports', value: 'Reports.Read.All' },
  { id: 'r-hunt', value: 'ThreatHunting.Read.All' },
  { id: 'r-users', value: 'User.Read.All' },
];
const MGMT_SP = { id: 'mgmt-sp', appId: MANAGEMENT_API_APP_ID, appRoles: [{ id: 'r-feed', value: MANAGEMENT_API_ROLE }] };

/** A Fabric context on the Auto source. @param {Parameters<typeof fakeCtx>[0]} [o] */
function autoCtx(o = {}) {
  const t = fakeCtx(o);
  t.config.audit = { source: 'auto' };
  return t;
}

/**
 * Graph with its own service principal and the Management APIs'.
 * @param {{ mgmt?: any, createMgmt?: 'ok' | 'fail', have?: string[] }} [o]
 */
function fakeGraph(o = {}) {
  /** @type {string[]} */
  const calls = [];
  /** @type {[string, string][]} */
  const granted = [];
  /** @type {[string, string[]][]} */
  const declared = [];
  const api = {
    graphServicePrincipal: async () => ({ id: 'graph-sp', appRoles: GRAPH_ROLES }),
    findServicePrincipal: async (/** @type {string} */ appId) => {
      calls.push(`find ${appId}`);
      if (appId === MANAGEMENT_API_APP_ID) return o.mgmt === undefined ? MGMT_SP : o.mgmt;
      return { id: 'sp-1', appId };
    },
    createServicePrincipal: async (/** @type {string} */ appId) => {
      calls.push(`create ${appId}`);
      if (o.createMgmt === 'fail') throw new Error('403 Forbidden');
      return MGMT_SP;
    },
    appRoleAssignments: async () =>
      [...(o.have ?? []), ...granted.map(([r, id]) => `${r}/${id}`)].map((k) => {
        const [resourceId, appRoleId] = k.split('/');
        return { resourceId, appRoleId };
      }),
    grantAppRole: async (/** @type {string} */ resourceId, /** @type {string} */ _sp, /** @type {string} */ roleId) => {
      granted.push([resourceId, roleId]);
    },
    findApplication: async () => ({ id: 'obj-1', appId: 'app-1', displayName: 'Their app', requiredResourceAccess: [] }),
    ensureRequiredAccess: async (/** @type {any} */ _app, /** @type {{ value: string }[]} */ roles, resourceAppId = 'graph') => {
      declared.push([resourceAppId, roles.map((r) => r.value)]);
      return true;
    },
  };
  return { api, calls, granted, declared };
}

test('audit source: a new install reads the Management Activity API, an old record keeps Graph, and Azure always reads Graph', () => {
  assert.deepEqual(AUDIT_SOURCES, ['feed', 'auto', 'graph']);
  assert.equal(auditSource(emptyConfig()), 'feed');
  assert.equal(auditSource({ audit: { source: 'graph' } }), 'graph');
  assert.equal(auditSource({ audit: { source: 'auto' } }), 'auto');
  assert.equal(auditSource({}), 'graph');
  assert.equal(auditSource({ target: 'azure', audit: { source: 'auto' } }), 'graph');
  assert.equal(auditSource({ target: 'azure', audit: { source: 'feed' } }), 'graph');

  const dir = mkdtempSync(join(tmpdir(), 'vl-audit-'));
  try {
    const file = join(dir, 'valuelens-install.json');
    const old = /** @type {any} */ (emptyConfig());
    delete old.audit;
    writeFileSync(file, JSON.stringify(old));
    assert.deepEqual(loadConfig(file).config.audit, { source: 'graph' }, 'a record from before the audit source keeps Graph');

    const config = emptyConfig();
    saveConfig(file, config);
    assert.deepEqual(loadConfig(file).config.audit, { source: 'feed' });
    config.audit = { source: /** @type {any} */ ('sentinel') };
    saveConfig(file, config);
    assert.deepEqual(loadConfig(file).config.audit, { source: 'graph' }, 'anything else is Graph');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('audit source: Auto adds ThreatHunting.Read.All to the Graph permissions, Graph does not', () => {
  const modules = emptyConfig().modules;
  assert.ok(permissionsFor(modules, undefined, 'auto').includes(SENTINEL_PERMISSION));
  assert.ok(!permissionsFor(modules, undefined, 'graph').includes(SENTINEL_PERMISSION));
  assert.ok(permissionsFor(modules, undefined, 'auto').includes('AuditLogsQuery.Read.All'), 'Graph stays for a one-off history load');
});

test('audit source: the ingester notebook gets AUDIT_SOURCE, so a change redeploys it', () => {
  const nb = NOTEBOOKS.find((n) => n.key === 'auditIngester');
  assert.ok(nb);
  const auto = autoCtx({ fabric: fakeFabric().api });
  assert.equal(notebookSettings(auto.ctx, nb).values?.AUDIT_SOURCE, 'auto');
  const graph = fakeCtx({ fabric: fakeFabric().api });
  assert.equal(notebookSettings(graph.ctx, nb).values?.AUDIT_SOURCE, 'graph');
  assert.notDeepEqual(notebookSettings(auto.ctx, nb), notebookSettings(graph.ctx, nb));
  graph.config.target = 'azure';
  graph.config.audit = { source: 'auto' };
  assert.equal(notebookSettings(graph.ctx, nb).values?.AUDIT_SOURCE, 'graph');
});

test('audit source: --audit-source sets the record, for a Fabric install only', () => {
  const args = parseCli(['install', '--audit-source', 'GRAPH']);
  assert.equal(args.auditSource, 'graph');
  const config = emptyConfig();
  applyDataFlags(config, { ...args, dataSources: {} });
  assert.deepEqual(config.audit, { source: 'graph' });
  applyDataFlags(config, { ...parseCli(['install']), dataSources: {} });
  assert.deepEqual(config.audit, { source: 'graph' }, 'no flag leaves the record alone');
  assert.equal(parseCli(['preview', '--audit-source', 'auto']).auditSource, 'auto');

  assert.throws(() => parseCli(['install', '--audit-source', 'sentinel']), /--audit-source must be "feed" or "auto" or "graph"/);
  assert.throws(() => parseCli(['install', '--target', 'azure', '--audit-source', 'auto']), /Fabric target only/);
  assert.throws(() => parseCli(['update', '--audit-source', 'auto']), /go with install/);
  assert.throws(() => parseCli(['--ui', '--audit-source', 'auto']), /under Advanced settings/);
});

test('audit source: the plan asks, the Management Activity API first, Sentinel next, and looks the permissions up again after a change', async () => {
  assert.equal(AUDIT_SOURCE_CHOICES[0].value, 'feed');
  assert.match(AUDIT_SOURCE_CHOICES[0].name, /Management Activity API \(recommended\)/);
  assert.equal(AUDIT_SOURCE_CHOICES[1].value, 'auto');
  assert.match(AUDIT_SOURCE_CHOICES[1].name, /^Microsoft Sentinel/);
  const t = autoCtx({ ui: fakeUi({ answers: ['graph'] }).ui });
  t.ctx.graphRoles = /** @type {any} */ ({ sp: {}, roles: [] });
  t.ctx.managementRoles = /** @type {any} */ ({ sp: {}, roles: [] });
  await planAuditSource(t.ctx);
  assert.deepEqual(t.config.audit, { source: 'graph' });
  assert.equal(t.ctx.graphRoles, undefined);
  assert.equal(t.ctx.managementRoles, undefined);

  const same = fakeCtx({ ui: fakeUi({ answers: ['graph'] }).ui });
  same.ctx.graphRoles = /** @type {any} */ ({ sp: {}, roles: [] });
  await planAuditSource(same.ctx);
  assert.ok(same.ctx.graphRoles, 'no change, no new lookup');
});

test('management roles: only Auto looks them up, creates the service principal if needed, and warns when the role is missing', async () => {
  const graph = fakeGraph();
  const off = fakeCtx({ graph: graph.api });
  assert.equal(await managementRoles(off.ctx), null);
  assert.deepEqual(graph.calls, []);

  const on = autoCtx({ graph: graph.api });
  const found = await managementRoles(on.ctx);
  assert.deepEqual(found?.roles, [{ id: 'r-feed', value: MANAGEMENT_API_ROLE }]);
  await managementRoles(on.ctx);
  assert.deepEqual(graph.calls, [`find ${MANAGEMENT_API_APP_ID}`], 'looked up once per run');

  const absent = fakeGraph({ mgmt: null });
  const made = autoCtx({ graph: absent.api });
  assert.equal((await managementRoles(made.ctx))?.sp.id, 'mgmt-sp');
  assert.deepEqual(absent.calls, [`find ${MANAGEMENT_API_APP_ID}`, `create ${MANAGEMENT_API_APP_ID}`]);

  const ui = fakeUi();
  const refused = autoCtx({ graph: fakeGraph({ mgmt: null, createMgmt: 'fail' }).api, ui: ui.ui });
  assert.deepEqual((await managementRoles(refused.ctx))?.roles, []);
  assert.match(ui.text(), /Couldn't find the Office 365 Management APIs' ActivityFeed\.Read permission[^\n]*can only read Microsoft Sentinel/);
});

test('consent under Auto: an admin grants the Graph roles and ActivityFeed.Read on their own service principals', async () => {
  const graph = fakeGraph({ have: ['graph-sp/r-audit'] });
  const t = autoCtx({ graph: graph.api });
  assert.equal(await ensureConsent(t.ctx, { canConsent: true }), true);
  assert.deepEqual(graph.granted, [
    ['graph-sp', 'r-reports'],
    ['graph-sp', 'r-hunt'],
    ['graph-sp', 'r-users'],
    ['mgmt-sp', 'r-feed'],
  ]);

  const ui = fakeUi({ yes: true });
  const waiting = autoCtx({ graph: fakeGraph({ have: ['graph-sp/r-audit', 'graph-sp/r-reports', 'graph-sp/r-hunt', 'graph-sp/r-users'] }).api, ui: ui.ui });
  assert.equal(await ensureConsent(waiting.ctx, { canConsent: false }), false);
  assert.match(ui.text(), /needs to approve: ActivityFeed\.Read/);
  assert.match(ui.text(), /the audit load can only read Microsoft Sentinel/);
});

test('ensureApp under Auto: a brought app gets ActivityFeed.Read declared on the Management APIs', async () => {
  const graph = fakeGraph();
  const t = autoCtx({ graph: graph.api });
  t.config.app.existing = true;
  t.config.keyVault.mode = 'notebook';
  await ensureApp(t.ctx).catch(() => {});
  assert.deepEqual(graph.declared, [
    ['graph', ['AuditLogsQuery.Read.All', 'Reports.Read.All', 'ThreatHunting.Read.All', 'User.Read.All']],
    [MANAGEMENT_API_APP_ID, [MANAGEMENT_API_ROLE]],
  ]);
});

test('app check under Auto: ActivityFeed.Read is checked on the app and for consent', async () => {
  const t = autoCtx({ graph: fakeGraph({ have: ['graph-sp/r-audit', 'graph-sp/r-reports', 'graph-sp/r-hunt', 'graph-sp/r-users'] }).api });
  const check = await checkExistingApp(t.ctx);
  assert.ok(check.undeclared.includes(MANAGEMENT_API_ROLE));
  assert.deepEqual(check.unconsented, [MANAGEMENT_API_ROLE]);
  const ui = fakeUi();
  t.ctx.ui = ui.ui;
  reportAppCheck(t.ctx, check);
  assert.match(ui.text(), /These Graph and Office 365 Management APIs application permissions/);
});

test('admin pack under Auto: the script and the portal steps add ActivityFeed.Read', () => {
  const t = autoCtx();
  const pack = adminPack(t.ctx);
  const body = [...pack.script, ...pack.checklist].join('\n');
  assert.match(body, /for P in AuditLogsQuery\.Read\.All Reports\.Read\.All ThreatHunting\.Read\.All User\.Read\.All; do/);
  assert.match(body, new RegExp(`MGMT=${MANAGEMENT_API_APP_ID}`));
  assert.match(body, /az ad sp show --id \$MGMT -o none 2>\/dev\/null \|\| az ad sp create --id \$MGMT -o none/);
  assert.match(body, /Office 365 Management APIs > Application permissions\. Add: ActivityFeed\.Read\./);

  const plain = adminPack(fakeCtx().ctx);
  const graph = [...plain.script, ...plain.checklist].join('\n');
  assert.doesNotMatch(graph, /MGMT=|ActivityFeed|ThreatHunting/);
});

test('check-audit under Auto probes both sources without Graph audit search or starting a subscription', async () => {
  const ui = fakeUi();
  const t = autoCtx({ ui: ui.ui });
  t.ctx.appSecret = 'test-secret';
  const calls = [];
  t.ctx.api.appAuditSources = () => ({
    sentinel: async () => { calls.push('sentinel'); throw new Error('CopilotActivity is missing'); },
    feed: async (_start, _end, live) => { calls.push(`feed:${live}`); return { enabled: true, blobs: 3 }; },
  });
  t.ctx.api.appGraph = () => { throw new Error('Graph audit search must not be used'); };
  assert.equal(await checkAuditCommand(t.ctx), 'ok');
  assert.deepEqual(calls, ['sentinel', 'feed:true']);
  assert.equal(t.config.auditCheck?.source, 'auto');
  assert.match(ui.text(), /does not prove they contain Copilot/);
  assert.doesNotMatch(ui.text(), /has AuditLogsQuery/);
});

test('Auto access checks are provisional on failure and do not claim readiness for a disabled feed', async () => {
  const t = autoCtx();
  t.ctx.appSecret = 'test-secret';
  t.ctx.api.appAuditSources = () => ({
    sentinel: async () => { throw new Error('No Sentinel'); },
    feed: async () => ({ enabled: false }),
  });
  assert.equal(await checkAuditAccess(t.ctx, { provisional: true }), 'error');
  assert.equal(t.config.auditCheck, undefined);
  assert.equal(t.ctx.auditChecked, undefined);
  assert.equal(await checkAuditAccess(t.ctx), 'error');
  const saved = () => t.config.auditCheck;
  assert.match(saved()?.detail ?? '', /12 hours/);
});

test('a Graph finding cannot mask a later Auto access check or its empty-data guidance', () => {
  const t = autoCtx();
  t.config.auditCheck = { at: '2026-01-01', result: 'empty-log' };
  saveAuditCheck(t.ctx, { result: 'ok', detail: 'The feed is readable.' });
  assert.equal(t.config.auditCheck.source, 'auto');
  assert.equal(t.config.auditCheck.result, 'ok');
  const help = emptyAuditHelp(t.config);
  assert.match(help.causes.join(' '), /ActivityFeed.Read/);
  assert.doesNotMatch(help.causes.join(' '), /Admin consent for AuditLogsQuery/);
});

test('a provisional Auto check that finds records is a confirmed success', async () => {
  const ui = fakeUi();
  const t = autoCtx({ ui: ui.ui });
  t.ctx.appSecret = 'test-secret';
  t.ctx.api.appAuditSources = () => ({
    sentinel: async () => ({ records: 1 }),
    feed: async () => ({ enabled: true }),
  });
  assert.equal(await checkAuditAccess(t.ctx, { provisional: true }), 'records');
  assert.equal(t.config.auditCheck?.result, 'records');
  assert.equal(t.ctx.auditChecked, true);
  assert.doesNotMatch(ui.text(), /access isn't confirmed/);
});

test('feed: only ActivityFeed.Read is needed, Sentinel is never probed, and the guidance names the Management Activity API', async () => {
  const feedCtx = (/** @type {Parameters<typeof fakeCtx>[0]} */ o = {}) => {
    const t = fakeCtx(o);
    t.config.audit = { source: 'feed' };
    return t;
  };
  const modules = emptyConfig().modules;
  assert.ok(!permissionsFor(modules, undefined, 'feed').includes(SENTINEL_PERMISSION));
  assert.ok(permissionsFor(modules, undefined, 'feed').includes('AuditLogsQuery.Read.All'), 'Graph stays for a one-off history load');

  const graph = fakeGraph();
  const roles = await managementRoles(feedCtx({ graph: graph.api }).ctx);
  assert.deepEqual(roles?.roles, [{ id: 'r-feed', value: MANAGEMENT_API_ROLE }]);
  const refusedUi = fakeUi();
  await managementRoles(feedCtx({ graph: fakeGraph({ mgmt: null, createMgmt: 'fail' }).api, ui: refusedUi.ui }).ctx);
  assert.match(refusedUi.text(), /can't read the Management Activity API\./);
  assert.doesNotMatch(refusedUi.text(), /Sentinel/);

  const ui = fakeUi({ yes: true });
  const waiting = feedCtx({ graph: fakeGraph({ have: ['graph-sp/r-audit', 'graph-sp/r-reports', 'graph-sp/r-users'] }).api, ui: ui.ui });
  assert.equal(await ensureConsent(waiting.ctx, { canConsent: false }), false);
  assert.match(ui.text(), /needs to approve: ActivityFeed\.Read/);
  assert.match(ui.text(), /can't read Copilot interactions \(ActivityFeed\.Read/);

  const pack = adminPack(feedCtx().ctx);
  const body = [...pack.script, ...pack.checklist].join('\n');
  assert.match(body, /Add: ActivityFeed\.Read\./);
  assert.doesNotMatch(body, /ThreatHunting/);

  const checkUi = fakeUi();
  const t = feedCtx({ ui: checkUi.ui });
  t.ctx.appSecret = 'test-secret';
  const calls = [];
  t.ctx.api.appAuditSources = () => ({
    sentinel: async () => { calls.push('sentinel'); return { records: 1 }; },
    feed: async (_start, _end, live) => { calls.push(`feed:${live}`); return { enabled: true, blobs: 2 }; },
  });
  t.ctx.api.appGraph = () => { throw new Error('Graph audit search must not be used'); };
  assert.equal(await checkAuditCommand(t.ctx), 'ok');
  assert.deepEqual(calls, ['feed:true']);
  assert.equal(t.config.auditCheck?.source, 'feed');
  assert.match(checkUi.text(), /The Management Activity API is readable/);
  assert.doesNotMatch(checkUi.text(), /Sentinel/);
  const help = emptyAuditHelp(t.config);
  assert.match(help.lead, /Management Activity API/);
  assert.doesNotMatch(help.causes.join(' '), /Sentinel/);
});

test('Auto probe client uses separate token audiences, bounded read-only requests and valid results', async () => {
  /** @type {string[]} */
  const scopes = [];
  /** @type {{ url: string, method: string, body?: any }[]} */
  const calls = [];
  const replies = [{ results: [{ RecordId: 'r1' }] }, [{ contentType: 'Audit.General', status: 'enabled' }], []];
  const api = auditSourcesApi(async (scope) => { scopes.push(scope); return 'test-token'; }, 'tenant-1', {
    fetchImpl: /** @type {typeof fetch} */ (async (url, init) => {
      calls.push({ url: String(url), method: init?.method ?? '', body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify(replies.shift()), { status: 200 });
    }),
  });
  const start = new Date('2026-09-01T00:00:00Z'), end = new Date('2026-09-02T00:00:00Z');
  assert.deepEqual(await api.sentinel(start, end), { records: 1 });
  assert.deepEqual(await api.feed(start, end, true), { enabled: true, blobs: 0 });
  assert.deepEqual(scopes, ['https://graph.microsoft.com/.default', 'https://manage.office.com/.default', 'https://manage.office.com/.default']);
  assert.deepEqual(calls.map((c) => c.method), ['POST', 'GET', 'GET']);
  assert.match(calls[0].body.Query, /CopilotActivity.*take 1/);
  assert.ok(calls.every((c) => !c.url.includes('auditLog/queries') && !c.url.includes('subscriptions/start')));
  const bad = auditSourcesApi(async () => 'token', 'tenant-1', {
    fetchImpl: async () => new Response('{}', { status: 200 }),
  });
  await assert.rejects(bad.sentinel(start, end), /invalid result rows/);
  await assert.rejects(bad.feed(start, end, true), /no subscription list/);
  for (const payload of [{ results: null }, { results: [null] }, { results: [[]] }, { results: ['row'] }]) {
    const invalid = auditSourcesApi(async () => 'token', 'tenant-1', {
      fetchImpl: async () => new Response(JSON.stringify(payload), { status: 200 }),
    });
    await assert.rejects(invalid.sentinel(start, end), /invalid result rows/);
  }
});

test('graph history: off by default, saved by --graph-history on install, per run on run --backfill-days, and only for feed sources', async () => {
  assert.equal(graphHistoryOn(emptyConfig()), false);
  assert.equal(parseCli(['install', '--graph-history']).graphHistory, true);
  assert.equal(parseCli(['run', '--backfill-days', '90', '--graph-history']).graphHistory, true);
  assert.throws(() => parseCli(['run', '--graph-history']), /goes with --backfill-days/);
  assert.throws(() => parseCli(['install', '--audit-source', 'graph', '--graph-history']), /Leave out --graph-history/);
  assert.throws(() => parseCli(['install', '--target', 'azure', '--graph-history']), /Fabric target only/);
  assert.throws(() => parseCli(['--ui', '--graph-history']), /Advanced settings/);
  assert.throws(() => parseCli(['status', '--graph-history']), /goes with install/);

  const config = emptyConfig();
  applyDataFlags(config, { dataSources: {}, graphHistory: true, command: 'install' });
  assert.deepEqual(config.audit, { source: 'feed', graphHistory: true });
  assert.equal(graphHistoryOn(config), true);
  const perRun = emptyConfig();
  applyDataFlags(perRun, { dataSources: {}, graphHistory: true, command: 'run' });
  assert.equal(perRun.audit.graphHistory, undefined);
  assert.equal(graphHistoryOn({ ...config, audit: { source: 'graph', graphHistory: true } }), false);
  assert.equal(graphHistoryOn({ ...config, target: 'azure' }), false);

  const dir = mkdtempSync(join(tmpdir(), 'ah-graph-history-'));
  try {
    const file = join(dir, 'config.json');
    saveConfig(file, config);
    assert.deepEqual(loadConfig(file).config.audit, { source: 'feed', graphHistory: true });
    writeFileSync(file, JSON.stringify({ ...config, audit: { source: 'feed', graphHistory: 'yes' } }));
    assert.deepEqual(loadConfig(file).config.audit, { source: 'feed' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('graph history: the plan asks only for feed sources, and changing the source keeps the answer', async () => {
  const t = fakeCtx({});
  const ui = fakeUi({ answers: [true] });
  t.ctx.ui = ui.ui;
  t.config.audit = { source: 'feed' };
  await planGraphHistory(t.ctx);
  assert.deepEqual(t.config.audit, { source: 'feed', graphHistory: true });
  assert.equal(GRAPH_HISTORY_CHOICES[0].value, false);

  const kept = fakeUi({ answers: ['auto'] });
  t.ctx.ui = kept.ui;
  await planAuditSource(t.ctx);
  assert.deepEqual(t.config.audit, { source: 'auto', graphHistory: true });

  const g = fakeUi({ answers: [true] });
  t.ctx.ui = g.ui;
  t.config.audit = { source: 'graph', graphHistory: true };
  await planGraphHistory(t.ctx);
  assert.deepEqual(t.config.audit, { source: 'graph' });
  assert.deepEqual(g.asked, []);
});

test('graph history: backfill runs send AuditGraphHistory, usual runs and Graph installs never do', async () => {
  const fabric = fakeFabric();
  const { ctx, config } = fakeCtx({ fabric: fabric.api });
  config.fabric.pipelineId = 'pipe-1';
  config.audit = { source: 'feed', graphHistory: true };
  await runPipeline(ctx, { backfillDays: 90, wait: false, first: true });
  assert.match(fabric.calls.at(-1) ?? '', /"AuditGraphHistory":true/);
  assert.equal(config.firstRun?.graphHistory, true);
  assert.equal(runParameters({ properties: { parameters: { AuditGraphHistory: { defaultValue: false } } } }, config, String(config.firstRun?.jobId)).AuditGraphHistory, true);

  await runPipeline(ctx, { wait: false });
  assert.doesNotMatch(fabric.calls.at(-1) ?? '', /AuditGraphHistory/);
  await runPipeline(ctx, { backfillDays: 30, wait: false, graphHistory: false });
  assert.doesNotMatch(fabric.calls.at(-1) ?? '', /AuditGraphHistory/);

  config.audit = { source: 'feed' };
  await runPipeline(ctx, { backfillDays: 30, wait: false, graphHistory: true });
  assert.match(fabric.calls.at(-1) ?? '', /"AuditGraphHistory":true/);
  config.audit = { source: 'graph' };
  await runPipeline(ctx, { backfillDays: 30, wait: false, graphHistory: true });
  assert.doesNotMatch(fabric.calls.at(-1) ?? '', /AuditGraphHistory/);
});
