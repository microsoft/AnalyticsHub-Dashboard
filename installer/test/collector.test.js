// @ts-check
/** The optional data-collector account for the delegated sign-ins. Offline only. */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { applyDataFlags, parseCli } from '../src/cli.js';
import { signedInAs } from '../src/clients/connections.js';
import { BILLING_ADMIN_ROLE, GLOBAL_ADMIN_ROLE, POWER_PLATFORM_ADMIN_ROLE } from '../src/clients/graph.js';
import { emptyConfig, saveConfig } from '../src/config.js';
import { checkPrereqs, preflightVerdict } from '../src/prereqs.js';
import {
  accountMatches,
  collectorAccount,
  collectorAdminSteps,
  collectorGrants,
  collectorSummary,
  delegatedSignIns,
  isUpn,
  planCollector,
  printSignIns,
} from '../src/steps/collector.js';
import { coworkSignInSteps } from '../src/steps/consumption.js';
import { connectionSteps } from '../src/steps/flows.js';
import { fakeCtx, fakeUi } from './fakes.js';

const UPN = 'analytics-collector@contoso.com';
const connected = (/** @type {string | undefined} */ who) => ({ name: 'c-1', properties: { statuses: [{ status: 'Connected' }], ...(who ? { authenticatedUser: { name: who } } : {}) } });

/** A Fabric config with the Studio flow and the Cowork Dataflow chosen. */
function bothConfig() {
  const config = emptyConfig();
  config.modules.consumption = true;
  config.dataSources.studioCredits = 'api';
  config.dataSources.coworkCredits = 'api';
  config.fabric.workspaceName = 'Analytics';
  return config;
}

test('--collector-account: install only, a user principal name, kept lower case; nothing else is stored', () => {
  assert.equal(parseCli(['install']).collectorAccount, undefined);
  assert.equal(parseCli(['install', '--collector-account', ' Analytics-Collector@Contoso.com ']).collectorAccount, UPN);
  assert.equal(parseCli(['preview', '--collector-account', UPN]).collectorAccount, UPN);
  assert.throws(() => parseCli(['install', '--collector-account', 'analytics-collector']), /--collector-account should be the account's user principal name/);
  assert.throws(() => parseCli(['update', '--collector-account', UPN]), /--collector-account go with install/);
  assert.throws(() => parseCli(['--ui', '--collector-account', UPN]), /With --ui, choose data sources/);

  const config = emptyConfig();
  applyDataFlags(config, { dataSources: {}, collectorAccount: UPN });
  assert.equal(config.collectorAccount, UPN);
  const dir = mkdtempSync(join(tmpdir(), 'collector-'));
  try {
    const file = join(dir, 'record.json');
    saveConfig(file, config);
    const saved = readFileSync(file, 'utf8');
    assert.match(saved, /"collectorAccount": "analytics-collector@contoso\.com"/);
    assert.doesNotMatch(saved, /password|refresh|token/i, 'only the name is kept');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const without = emptyConfig();
  applyDataFlags(without, { dataSources: {} });
  assert.equal('collectorAccount' in without, false, 'nothing changes without the flag');
});

test('isUpn, collectorAccount, signedInAs and accountMatches', () => {
  assert.equal(isUpn(UPN), true);
  for (const bad of ['', 'collector', 'a@b', 'a b@contoso.com', '@contoso.com']) assert.equal(isUpn(bad), false, bad);
  const config = emptyConfig();
  assert.equal(collectorAccount(config), undefined);
  config.collectorAccount = ' Analytics-Collector@Contoso.com';
  assert.equal(collectorAccount(config), UPN);

  assert.equal(signedInAs(connected('Analytics-Collector@Contoso.COM')), UPN);
  assert.equal(signedInAs(connected('Analytics collector')), undefined, 'a display name says nothing we can match');
  assert.equal(signedInAs(connected(undefined)), undefined);
  assert.equal(signedInAs(undefined), undefined);

  assert.equal(accountMatches(connected('someone@contoso.com'), undefined), true, 'no collector: anyone will do');
  assert.equal(accountMatches(connected(UPN), UPN), true);
  assert.equal(accountMatches(connected('Analytics-Collector@contoso.com'), UPN), true);
  assert.equal(accountMatches(connected('admin@contoso.com'), UPN), false);
  assert.equal(accountMatches(connected(undefined), UPN), undefined, 'Power Platform didn\'t say');
});

test('delegatedSignIns: the flows\' Power Platform API connection and the Cowork Dataflow, only for the sources chosen', () => {
  const none = emptyConfig();
  none.dataSources.studioCredits = 'skip';
  assert.deepEqual(delegatedSignIns(none), []);

  const both = bothConfig();
  const ids = delegatedSignIns(both).map((s) => s.id);
  assert.deepEqual(ids, ['ppApi', 'viva', 'lakehouse']);
  assert.match(delegatedSignIns(both)[0].needs, /Power Platform Administrator or Billing Administrator/);
  assert.match(delegatedSignIns(both)[2].needs, /Contributor on Analytics/);

  both.dataSources.resourceGraph = 'api';
  assert.match(delegatedSignIns(both)[0].needs, /^Power Platform Administrator, and/, 'the inventory API needs the Power Platform role');

  const csvCowork = bothConfig();
  csvCowork.dataSources.coworkCredits = 'csv';
  assert.deepEqual(delegatedSignIns(csvCowork).map((s) => s.id), ['ppApi']);

  const azure = bothConfig();
  azure.target = 'azure';
  assert.ok(!delegatedSignIns(azure).some((s) => s.id === 'viva'), 'no Dataflow on Azure');
});

test('planCollector: "you" by default changes nothing; a dedicated account is named, and its setup printed but never run', async () => {
  const mine = fakeUi();
  const one = fakeCtx({ ui: mine.ui });
  Object.assign(one.config, bothConfig());
  await planCollector(one.ctx);
  assert.deepEqual(mine.asked, ['Who signs in to them?']);
  assert.equal(one.config.collectorAccount, undefined);

  const { ui, asked, text } = fakeUi({ answers: ['collector', 'Analytics-Collector@contoso.com'] });
  const { ctx, config } = fakeCtx({ ui });
  Object.assign(config, bothConfig());
  await planCollector(ctx);
  assert.deepEqual(asked, ['Who signs in to them?', 'The data-collector account\'s user principal name']);
  assert.equal(config.collectorAccount, UPN);
  const out = text();
  assert.match(out, /The installer runs none of this: it doesn't create the account, assign roles or buy licences/);
  assert.ok(out.includes(`az ad user create --display-name "Analytics Hub data collector" --user-principal-name ${UPN}`));
  assert.ok(out.includes(POWER_PLATFORM_ADMIN_ROLE));
  assert.match(out, /Not Global Administrator/);
  assert.match(out, /Whether a smaller Power Platform role is enough is unverified/);
  assert.match(out, /Insights Analyst in Viva Insights/);
  assert.match(out, /Contributor on the Analytics Hub workspace/);
  assert.match(out, /90 days without a run, or a password reset, ends them/);

  const back = fakeUi({ answers: ['you'] });
  const again = fakeCtx({ ui: back.ui });
  Object.assign(again.config, bothConfig(), { collectorAccount: UPN });
  await planCollector(again.ctx);
  assert.equal(again.config.collectorAccount, undefined, 'choosing yourself clears it');

  const none = fakeUi();
  const skip = fakeCtx({ ui: none.ui });
  skip.config.dataSources.studioCredits = 'skip';
  await planCollector(skip.ctx);
  assert.deepEqual(none.asked, [], 'nothing to ask without a delegated sign-in');

  const bad = fakeCtx({ ui: fakeUi({ answers: ['collector', 'not-an-upn'] }).ui });
  Object.assign(bad.config, bothConfig());
  await assert.rejects(planCollector(bad.ctx), /Type a user principal name/);
});

test('collectorAdminSteps: four steps; only the parts the sources need', () => {
  const steps = collectorAdminSteps(UPN, delegatedSignIns(bothConfig()));
  assert.equal(steps.length, 4);
  const all = steps.flatMap((s) => [s.title, ...s.lines]).join('\n');
  assert.ok(all.includes(BILLING_ADMIN_ROLE));
  assert.match(all, /permanent \(active\) assignments for this account only/);
  assert.match(all, /--collector-account analytics-collector@contoso\.com/);
  assert.match(all, /private browser window/);

  const csv = bothConfig();
  csv.dataSources.coworkCredits = 'csv';
  const flowsOnly = collectorAdminSteps(UPN, delegatedSignIns(csv)).flatMap((s) => [s.title, ...s.lines]).join('\n');
  assert.doesNotMatch(flowsOnly, /Insights Analyst/);
  const coworkOnly = bothConfig();
  coworkOnly.dataSources.studioCredits = 'skip';
  const vivaOnly = collectorAdminSteps(UPN, delegatedSignIns(coworkOnly)).flatMap((s) => [s.title, ...s.lines]).join('\n');
  assert.doesNotMatch(vivaOnly, /Power Platform Administrator|Premium/);
  assert.match(vivaOnly, /Insights Analyst/);
});

test('collectorSummary and collectorGrants: only with an account named, and each says the installer doesn\'t grant it', () => {
  const config = bothConfig();
  assert.equal(collectorSummary(config), undefined);
  assert.deepEqual(collectorGrants(config, 'Workspace Analytics'), []);
  config.collectorAccount = UPN;
  assert.equal(collectorSummary(config), `${UPN} (data-collector account)`);
  const grants = collectorGrants(config, 'Workspace Analytics');
  assert.deepEqual(grants.map((g) => [g.what.split(',')[0], g.where]), [
    ['Power Platform Administrator or Billing Administrator', 'Your tenant (Entra ID and Microsoft 365 admin center)'],
    ['Insights Analyst', 'Viva Insights'],
    ['Contributor', 'Workspace Analytics'],
  ]);
  for (const g of grants) {
    assert.equal(g.who, `${UPN} (data-collector account)`);
    assert.match(g.detail ?? '', /Not granted by the installer/);
  }
  config.dataSources.studioCredits = 'skip';
  config.dataSources.coworkCredits = 'skip';
  assert.equal(collectorSummary(config), undefined, 'no delegated sign-ins, nothing to say');
});

test('sign-in steps name the data-collector account', () => {
  const config = bothConfig();
  assert.doesNotMatch(connectionSteps(config, 'studio')[0], /data-collector/);
  assert.doesNotMatch(coworkSignInSteps(config).join(' '), /data-collector/);
  config.collectorAccount = UPN;
  assert.match(connectionSteps(config, 'studio')[0], /Sign in as analytics-collector@contoso\.com, the data-collector account/);
  assert.match(coworkSignInSteps(config)[2], /sign in as analytics-collector@contoso\.com \(the data-collector account\).*"Use another account"/);
});

/**
 * Graph reads for the account's check.
 * @param {{ user?: any, roles?: string[] | Error, eligible?: string[], plans?: string[] | Error }} o
 */
function collectorApis(o) {
  return /** @type {any} */ ({
    graph: {
      myDirectoryRoles: async () => [],
      myEligibleRoles: async (/** @type {string} */ id) => (id === 'col-1' ? (o.eligible ?? []).map((roleDefinitionId) => ({ roleDefinitionId, principalId: id })) : []),
      myGroupIds: async () => [],
      myLicenseDetails: async () => [],
      subscribedSkus: async () => [],
      usersCanRegisterApps: async () => true,
      getUserDetails: async (/** @type {string} */ upn) => (o.user === null ? null : { id: 'col-1', displayName: 'Analytics Hub data collector', userPrincipalName: upn, accountEnabled: true, userType: 'Member', ...o.user }),
      directoryRoleAssignments: async () => {
        if (o.roles instanceof Error) throw o.roles;
        return (o.roles ?? []).map((roleDefinitionId) => ({ id: 'a', roleDefinitionId }));
      },
      userLicenseDetails: async () => {
        if (o.plans instanceof Error) throw o.plans;
        return [{ servicePlans: (o.plans ?? []).map((servicePlanName) => ({ servicePlanName, provisioningStatus: 'Success' })) }];
      },
    },
    arm: {
      listSubscriptions: async () => [],
      permissions: async () => [],
      myRoleAssignments: async () => [],
      myEligibleRoles: async () => [],
      getVault: async () => null,
      resourceGraph: async () => ({ data: [] }),
    },
    fabric: { listCapacities: async () => [], tenantSettings: async () => [] },
    discovery: { instances: async () => [] },
  });
}

const collectorRow = async (/** @type {any} */ o, /** @type {any} */ config = Object.assign(bothConfig(), { collectorAccount: UPN })) => {
  const items = await checkPrereqs({ api: collectorApis(o), user: /** @type {any} */ ({ id: 'user-1', upn: 'admin@contoso.com', tenantId: 't-1' }), config });
  return { items, row: items.find((i) => i.id === 'collector-account') };
};

test('prereqs: the data-collector account row, only when one is named', async () => {
  const { items } = await collectorRow({}, bothConfig());
  assert.ok(!items.some((i) => i.id === 'collector-account'), 'no row by default');

  let { row } = await collectorRow({ roles: [POWER_PLATFORM_ADMIN_ROLE], plans: ['POWER_AUTOMATE_ATTENDED_RPA'] });
  assert.equal(row?.status, 'met');
  assert.equal(row?.optional, true);
  assert.match(row?.label ?? '', /Data-collector account \(analytics-collector@contoso\.com\)/);
  assert.match(row?.detail ?? '', /Active: Power Platform Administrator\. Licence: Power Automate Premium\. Insights Analyst and its workspace access can't be checked/);

  ({ row } = await collectorRow({ roles: [BILLING_ADMIN_ROLE], plans: ['FLOW_PER_USER'] }));
  assert.equal(row?.status, 'met', 'Billing Administrator is enough for Studio credits');

  const agents = Object.assign(bothConfig(), { collectorAccount: UPN });
  agents.dataSources.resourceGraph = 'api';
  ({ row } = await collectorRow({ roles: [BILLING_ADMIN_ROLE], plans: ['FLOW_PER_USER'] }, agents));
  assert.equal(row?.status, 'missing', 'but not for the agent inventory');

  ({ row } = await collectorRow({ user: null }));
  assert.equal(row?.status, 'missing');
  assert.match(row?.detail ?? '', /wasn't found in this tenant\. An admin creates it; the installer doesn't/);

  ({ row } = await collectorRow({ user: { accountEnabled: false } }));
  assert.match(row?.detail ?? '', /blocked from signing in/);

  ({ row } = await collectorRow({ roles: [GLOBAL_ADMIN_ROLE, POWER_PLATFORM_ADMIN_ROLE], plans: ['FLOW_P2'] }));
  assert.equal(row?.status, 'missing');
  assert.match(row?.detail ?? '', /It has Global Administrator: give it only the role it needs instead/);

  ({ row } = await collectorRow({ eligible: [POWER_PLATFORM_ADMIN_ROLE], plans: ['FLOW_P2'] }));
  assert.equal(row?.status, 'eligible');
  assert.match(row?.detail ?? '', /Only eligible for Power Platform Administrator: make it a permanent \(active\) assignment for this account/);

  ({ row } = await collectorRow({ roles: [POWER_PLATFORM_ADMIN_ROLE] }));
  assert.equal(row?.status, 'missing');
  assert.match(row?.detail ?? '', /No Power Automate Premium/);

  ({ row } = await collectorRow({ roles: new Error('403 Forbidden'), plans: ['FLOW_P2'], user: { onPremisesSyncEnabled: true } }));
  assert.equal(row?.status, 'unknown');
  assert.match(row?.detail ?? '', /Couldn't read its roles/);
  assert.match(row?.detail ?? '', /synced from on-premises: a cloud-only account is safer/);

  const verdict = preflightVerdict([/** @type {any} */ ({ id: 'collector-account', status: 'missing', optional: true, label: 'x' })], { config: Object.assign(bothConfig(), { collectorAccount: UPN }) });
  assert.equal(verdict.warn.length, 1, 'shown in preflight, never blocking');
  assert.equal(verdict.block.length, 0);
});

test('printSignIns (status): who the connections are signed in as, which need a new sign-in, and never a throw', async () => {
  /** @param {any} conn @param {string | undefined} meta */
  const statusCtx = (conn, meta, upn = UPN) => {
    const made = fakeUi();
    const { ctx, config } = fakeCtx({ ui: made.ui });
    Object.assign(config, bothConfig());
    if (upn) config.collectorAccount = upn;
    config.fabric.workspaceId = 'ws-1';
    config.consumption = /** @type {any} */ ({ dataflowId: 'df-1' });
    config.uploads = { flowEnvironment: { url: 'https://org1.crm.dynamics.com', id: 'env-1', name: 'Default' }, flowIds: { studio: 'flow-1' }, flowConnections: { shared_webcontents: 'pp-1' } };
    const api = /** @type {any} */ (ctx.api);
    api.flow = { getFlowDetails: async () => ({ properties: { connectionReferences: { shared_webcontents: { connectionName: 'pp-1' } } } }) };
    api.connections = { get: async () => conn };
    api.fabric = { ...api.fabric, getDataflowDefinition: async () => {
      if (meta === undefined) throw new Error('403');
      return { 'queryMetadata.json': meta };
    } };
    return { ctx, text: made.text };
  };
  const pp = (/** @type {string | undefined} */ who, status = 'Connected') => ({ name: 'pp-1', properties: { displayName: 'Analytics Hub - Power Platform API', statuses: [{ status }], ...(who ? { authenticatedUser: { name: who } } : {}) } });
  const bound = JSON.stringify({ connections: [{ path: 'VivaInsights' }, { path: 'Lakehouse' }] });

  let s = statusCtx(pp(UPN), bound);
  await printSignIns(s.ctx);
  assert.match(s.text(), /Data-collector account: analytics-collector@contoso\.com/);
  assert.match(s.text(), /Flows \(Analytics Hub - Power Platform API\): signed in as analytics-collector@contoso\.com/);
  assert.match(s.text(), /Cowork credits Dataflow: saved with its connections\. Fabric doesn't say who signed in/);
  assert.match(s.text(), /A password reset, or 90 days without a run, ends these sign-ins/);

  s = statusCtx(pp('admin@contoso.com'), JSON.stringify({ connections: [] }));
  await printSignIns(s.ctx);
  assert.match(s.text(), /signed in as admin@contoso\.com, not analytics-collector@contoso\.com\. Run ".*update" for a link to sign in again/);
  assert.match(s.text(), /Cowork credits Dataflow: needs its sign-ins, as analytics-collector@contoso\.com\. Open https:\/\/app\.fabric\.microsoft\.com\/groups\/ws-1\/dataflows-gen2\/df-1/);

  s = statusCtx(pp(undefined, 'Error'), undefined);
  await printSignIns(s.ctx);
  assert.match(s.text(), /needs a new sign-in\. Open https:\/\/make\.powerautomate\.com\/environments\/env-1\/connections, find it and click Fix connection, signing in as analytics-collector@contoso\.com/);
  assert.match(s.text(), /couldn't tell whether it's signed in/);

  s = statusCtx(pp(undefined), bound, '');
  await printSignIns(s.ctx);
  assert.match(s.text(), /signed in\. Power Platform doesn't say as whom/);
  assert.doesNotMatch(s.text(), /Data-collector account|90 days/, 'no account named: just who is signed in');

  s = statusCtx(pp(UPN), bound);
  /** @type {any} */ (s.ctx.api).connections = { get: async () => { throw new Error('boom'); } };
  /** @type {any} */ (s.ctx.api).fabric.getDataflowDefinition = undefined;
  await assert.doesNotReject(printSignIns(s.ctx));
});
