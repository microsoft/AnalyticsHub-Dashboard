// @ts-check
/** The install's verdict when its app step failed and deploy-app deployed the app while it waited on the first load. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig, saveConfig } from '../src/config.js';
import { createCtx, install } from '../src/install.js';
import { fakeAzureGraph, fakeFabric, fakePowerBi, fakeUi, realSources } from './fakes.js';

const forbidden = async () => {
  throw new Error('Forbidden');
};

/**
 * A new Fabric install, run to the end through the real install record. Its app step fails, as the app has no deploy
 * tools. While it waits on the first load, deploy-app deploys the app from another window, as the step says to.
 * @param {import('node:test').TestContext} t
 * @param {{ report?: boolean, agent?: boolean }} [also]  Fail the report, or the data agent, too.
 */
async function lateApp(t, also = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'installer-late-app-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'valuelens-install.json');
  const config = loadConfig(file).config;
  config.target = 'fabric';
  config.tenantId = 'tenant-1';
  Object.assign(config.fabric, { workspaceId: 'ws-1', workspaceName: 'Analytics', lakehouseId: 'lh-1', lakehouseName: 'ValueLens' });
  Object.assign(config.app, { appId: 'app-1', objectId: 'obj-1', servicePrincipalId: 'sp-1' });
  config.keyVault.mode = 'notebook';
  config.semanticModel.enabled = true;
  config.fabricApp.enabled = true;
  saveConfig(file, config);

  // A prebuilt app without its node_modules: deploying it fails before anything is written.
  const appDir = join(dir, 'app');
  mkdirSync(join(appDir, 'rayfin'), { recursive: true });
  writeFileSync(join(appDir, 'prebuilt.json'), '{}\n');
  writeFileSync(join(appDir, 'rayfin', 'rayfin.yml'), 'name: Analytics Hub\n');

  const fabric = fakeFabric();
  // An F capacity, so the Ask data agent is set up too.
  fabric.api.listCapacities = async () => [{ id: 'cap-f', displayName: 'Analytics', sku: 'F64', region: 'West US 3', state: 'Active' }];
  if (also.report) fabric.failures.createReport = [new Error('Report publish failed')];
  if (also.agent) fabric.failures.createDataAgent = [new Error('Data agent create failed')];
  let deployed = false;
  fabric.api.getJob = async () => {
    if (!deployed) {
      // deploy-app, in another window.
      const other = loadConfig(file).config;
      Object.assign(other.fabricApp, { itemId: 'app-item-1', url: 'https://app.example.test/', name: 'Analytics Hub', deployedAt: '2026-06-01T13:00:00.000Z', models: ['vl'] });
      saveConfig(file, other);
      deployed = true;
    }
    return { id: 'job-1', status: 'Completed', startTimeUtc: '2026-06-01T12:01:00Z', endTimeUtc: '2026-06-01T14:00:00Z' };
  };
  fabric.api.queryActivityRuns = async () =>
    (fabric.items.find((i) => i.type === 'DataPipeline')?.content.properties.activities ?? []).map((/** @type {{ name: string }} */ a) => ({
      activityName: a.name,
      status: 'Succeeded',
      activityRunStart: '2026-06-01T12:01:00Z',
    }));
  const graph = fakeAzureGraph();
  graph.applications.push({ id: 'obj-1', appId: 'app-1', displayName: 'Analytics Hub' });
  const powerBi = fakePowerBi();
  const ui = fakeUi();
  let sleeps = 0;
  const ctx = createCtx({
    ui: ui.ui,
    config,
    file,
    api: /** @type {any} */ ({
      fabric: { ...fabric.api, tenantSettings: forbidden },
      graph: {
        ...graph.api,
        subscribedSkus: forbidden,
        myDirectoryRoles: async () => [],
        usersCanRegisterApps: async () => true,
        ensureRequiredAccess: async () => false,
        findGroupByName: async (/** @type {string} */ name) => ({ id: 'group-1', displayName: name }),
        appRoleAssignments: async () => (await graph.api.graphServicePrincipal()).appRoles.map((r) => ({ resourceId: 'graph-sp', appRoleId: r.id })),
      },
      powerBi: { ...powerBi.api, datasetUsers: async () => [], addDatasetUser: async () => null },
      arm: { listSubscriptions: async () => [] },
      keyVault: {},
      oneLake: { readJson: async () => null },
      discovery: {},
      powerPlatform: { billingPolicies: async () => [] },
    }),
    user: { id: 'user-1', upn: 'admin@contoso.com', tenantId: 'tenant-1' },
    sources: { ...realSources(), appDir },
    sleep: async () => {
      if (++sleeps > 300) throw new Error('The install is stuck waiting.');
    },
    now: () => new Date('2026-06-01T12:00:00Z'),
  });
  ctx.runFirstLoad = true;
  const ok = await install(ctx, { wait: true });
  const text = ui.text();
  assert.match(text, /The app wasn't deployed: .*missing its deploy tools/);
  assert.equal(deployed, true, 'deploy-app ran while the install waited on the first load');
  assert.equal(loadConfig(file).config.fabricApp.itemId, 'app-item-1', "the install's saves keep deploy-app's app");
  assert.equal(config.firstRun?.status, 'Completed');
  assert.match(text, /The app step above failed, but the app was deployed afterwards \(2026-06-01 13:00 UTC\)/);
  assert.doesNotMatch(text, /Deploy the Analytics Hub app/, 'the app is deployed, so there is no card to deploy it');
  return { ok, text };
}

test('install: an app deployed while the first load runs makes up for its failed step when nothing else failed', async (t) => {
  const { ok, text } = await lateApp(t);
  assert.equal(ok, true);
  assert.match(text, /Analytics Hub is set up/);
  assert.doesNotMatch(text, /partly set up/);
});

test("install: a late app doesn't make up for a report that failed too", async (t) => {
  const { ok, text } = await lateApp(t, { report: true });
  assert.match(text, /The ValueLens report wasn't published: Report publish failed/);
  assert.equal(ok, false);
  assert.match(text, /Analytics Hub is partly set up/);
  assert.doesNotMatch(text, /Analytics Hub is set up/);
});

test("install: a late app doesn't make up for the data agent failing too", async (t) => {
  const { ok, text } = await lateApp(t, { agent: true });
  assert.match(text, /The Analytics Hub Ask data agent wasn't set up: Data agent create failed/);
  assert.equal(ok, false);
  assert.match(text, /Analytics Hub is partly set up/);
  assert.doesNotMatch(text, /Analytics Hub is set up/);
});
