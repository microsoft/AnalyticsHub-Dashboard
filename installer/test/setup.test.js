// @ts-check
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { archiveConfig, emptyConfig, loadConfig, removeFile, saveConfig } from '../src/config.js';
import { install } from '../src/install.js';
import { checkSetupChanges, restoreSetupDraft, reviewSetup, setupCategories, setupRecovery } from '../src/setup.js';
import { checkStaged, stageUpload, releaseStaged } from '../src/staging.js';
import { parseForm } from '../src/ui.js';
import { createWebUi } from '../src/web-ui.js';
import { HttpError } from '../src/http.js';
import { azureUninstall, planAzure } from '../src/steps/azure/index.js';
import { fakeArm, fakeAzureGraph, fakeCtx, fakeFabric, fakePowerBi, fakeUi } from './fakes.js';

/** @param {import('node:test').TestContext} t */
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'installer-setup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const arm = fakeArm();
  arm.regions.locations.push({ name: 'swedencentral', displayName: 'Sweden Central' });
  const fabric = fakeFabric();
  const graph = fakeAzureGraph();
  const powerBi = fakePowerBi();
  powerBi.setDatasources([{ datasourceType: 'Sql', gatewayId: 'gw', datasourceId: 'ds', connectionDetails: { server: 'vlens-sql.database.windows.net', database: 'valuelens' } }]);
  const ui = createWebUi();
  const config = emptyConfig();
  config.target = 'azure';
  config.tenantId = 'tenant-1';
  config.azure = {
    subscriptionId: 'sub-1', resourceGroup: 'rg', location: 'uksouth', namePrefix: 'vlens',
    installId: 'install-1', publicNetworkAccess: true, ask: { mode: 'off' }, outputs: {},
    powerBi: { workspaceId: 'ws-1' },
    deploymentConfig: { subscriptionId: 'sub-1', resourceGroup: 'rg', location: 'uksouth', namePrefix: 'vlens', publicNetworkAccess: true },
  };
  config.setup = { completed: setupCategories(config).map((cat) => cat.id), runFirstLoad: false };
  const { ctx } = fakeCtx({ config, ui, arm: arm.api, fabric: fabric.api, graph: {
      ...graph.api, myDirectoryRoles: async () => [], usersCanRegisterApps: async () => true,
    }, powerBi: powerBi.api });
  ctx.file = join(dir, 'record.json');
  ctx.save = () => saveConfig(ctx.file, config);
  ctx.save();
  return { ctx, config, ui, arm, fabric, graph, powerBi, draft: `${ctx.file}.draft.json` };
}

/** @param {import('../src/install.js').Ctx} ctx */
const pendingTokens = (ctx) => (ctx.pendingUploads ?? []).map((file) => file.token);

/**
 * Answer on the next tick so createWebUi has finished registering the open question.
 * @param {ReturnType<typeof createWebUi>} ui
 * @param {(event: import('../src/web-ui.js').UiEvent) => unknown} reply
 */
function respond(ui, reply) {
  /** @type {string[]} */
  const asked = [];
  ui.subscribe((e) => {
    if (e.type !== 'prompt') return;
    asked.push(e.message);
    setImmediate(() => {
      const value = reply(e);
      const result = ui.answer(e.id, value);
      assert.equal(result.ok, true, `${e.message}: ${result.error}`);
    });
  });
  return asked;
}

test('settings forms validate types, options, disabled choices and each field on the server', () => {
  const fields = [
    { id: 'region', label: 'Region', default: 'a', choices: [{ name: 'A', value: 'a' }, { name: 'B', value: 'b', disabled: true }] },
    { id: 'name', label: 'Name', default: '', validate: (/** @type {string} */ v) => v.trim() ? /** @type {const} */ (true) : 'Required' },
  ];
  assert.match(parseForm([], fields).error ?? '', /Fill in/);
  assert.match(parseForm({ region: 'b', name: 'ok' }, fields).error ?? '', /Region/);
  assert.match(parseForm({ region: 'a', name: '' }, fields).error ?? '', /Required/);
  assert.match(parseForm({ region: 1, name: 'ok' }, fields).error ?? '', /Region/);
  assert.deepEqual(parseForm({ region: 'a', name: 'ok', extra: 'ignored' }, fields).value, { region: 'a', name: 'ok' });
  assert.match(parseForm({ region: 'changed' }, [{ id: 'region', label: 'Region', default: 'original', readOnly: 'Already deployed' }]).error ?? '', /Already deployed/);
});

test('web settings and forms expose no validators, reject invalid values and support category cancellation', async () => {
  const ui = createWebUi();
  const settings = ui.settings([{ id: 'placement', title: 'Placement', summary: 'UK South', complete: true }], { changes: [] });
  let event = ui.history().at(-1);
  assert.equal(ui.answer(event?.id, 'arbitrary').ok, false);
  ui.answer(event?.id, 'placement');
  assert.equal(await settings, 'placement');
  ui.beginSection();
  const form = ui.form('Placement', [{ id: 'region', label: 'Region', default: 'uk', validate: (v) => v ? true : 'Required' }]);
  event = ui.history().at(-1);
  assert.equal(event?.settingsBack, true);
  assert.equal('validate' in event?.fields[0], false);
  assert.equal(ui.answer(event?.id, { region: '' }).ok, false);
  assert.equal(ui.cancelSection(), true);
  await assert.rejects(form, { name: 'SettingsCancelled' });
  ui.endSection();
  assert.equal(ui.cancelSection(), false);
});

test('structured failure recovery recognises region, model, policy and unknown failures', () => {
  const config = emptyConfig();
  config.target = 'azure';
  const error = new HttpError('SQL capacity is locked', { method: 'POST', url: 'https://management.azure.com', status: 409,
    body: { error: { code: 'RegionDoesNotAllowProvisioning', message: 'SQL capacity is locked' } } });
  const region = setupRecovery(new Error('SQL region failed', { cause: error }), config);
  assert.equal(region.section, 'placement');
  assert.match(region.code ?? '', /RegionDoesNotAllowProvisioning/);
  assert.equal(setupRecovery(new Error('CognitiveServices deployment InsufficientQuota'), config).section, 'ask');
  assert.equal(setupRecovery(new Error('RequestDisallowedByPolicy'), config).section, 'networking');
  assert.equal(setupRecovery(new Error('Unknown failure'), config).section, undefined);
});

test('partial ARM success locks existing resources even without deployment outputs, but SQL can move before creation', async (t) => {
  const { ctx, config, arm } = fixture(t);
  assert.ok(config.azure);
  const before = structuredClone(config);
  config.azure.sqlLocation = 'swedencentral';
  arm.resources.push({ type: 'Microsoft.Storage/storageAccounts', tags: { 'valuelens-install-id': 'install-1' } });
  await checkSetupChanges(ctx, before);
  config.azure.location = 'swedencentral';
  await assert.rejects(checkSetupChanges(ctx, before), /Resources already exist/);
  config.azure.location = 'uksouth';
  arm.resources.push({ type: 'Microsoft.Sql/servers', tags: { 'valuelens-install-id': 'install-1' } });
  await assert.rejects(checkSetupChanges(ctx, before), /SQL server already exists/);
  config.azure.sqlLocation = undefined;
  config.azure.publicNetworkAccess = false;
  arm.resources.push({ type: 'Microsoft.App/managedEnvironments', tags: { 'valuelens-install-id': 'install-1' } });
  await assert.rejects(checkSetupChanges(ctx, before), /Networking cannot change/);
  config.azure.resourceGroup = 'different';
  await assert.rejects(checkSetupChanges(ctx, before), /Keep the subscription/);
});

test('a saved draft resumes without overwriting the deployed record; cancel restores the whole category', async (t) => {
  const { ctx, config, ui, draft } = fixture(t);
  assert.ok(config.azure);
  const original = readFileSync(ctx.file, 'utf8');
  let visits = 0;
  respond(ui, (e) => {
    if (e.kind === 'settings') return visits++ ? 'close' : 'networking';
    if (e.kind === 'form') return { access: 'private', dns: 'none', dnsGroup: '' };
    throw new Error(`Unexpected question: ${e.message}`);
  });
  assert.equal(await reviewSetup(ctx), false);
  assert.equal(config.azure.publicNetworkAccess, false);
  assert.equal(readFileSync(ctx.file, 'utf8'), original);
  assert.equal(loadConfig(draft).config.azure?.privateDns?.mode, 'none');

  const resumed = createWebUi();
  ctx.ui = resumed;
  let restored = false;
  respond(resumed, (e) => {
    if (e.kind === 'settings') {
      if (restored) return 'close';
      restored = true;
      assert.match(e.categories.find((/** @type {any} */ c) => c.id === 'networking').summary, /Private/);
      return 'networking';
    }
    if (e.kind === 'form') return null;
    throw new Error(`Unexpected question: ${e.message}`);
  });
  await reviewSetup(ctx);
  assert.equal(config.azure.privateDns?.mode, 'none');
  assert.ok(existsSync(draft));
});

test('a validation failure keeps the overview open and refreshes availability for the next retry', async (t) => {
  const { ctx, ui, arm } = fixture(t);
  ctx.setupRetry = true;
  arm.restrictedSqlRegions.add('uksouth');
  let visits = 0;
  respond(ui, (e) => {
    if (e.kind === 'settings') {
      assert.match(e.notice, /SQL/);
      visits++;
      arm.restrictedSqlRegions.clear();
      return 'deploy';
    }
    if (e.kind === 'confirm' && e.message === 'Go ahead?') return true;
    throw new Error(`Unrelated question: ${e.message}`);
  });
  assert.equal(await reviewSetup(ctx), true);
  assert.equal(visits, 1);
  assert.ok(arm.calls.filter((c) => c === 'sqlCapability uksouth').length >= 2);
});

test('failed deployment -> edit only SQL placement -> successful retry, without asking other categories', async (t) => {
  const { ctx, config, ui, arm, draft } = fixture(t);
  assert.ok(config.azure);
  ctx.setupRetry = true;
  let fail = true;
  const deploy = arm.api.deployTemplate;
  arm.api.deployTemplate = async (...args) => {
    if (fail) {
      fail = false;
      arm.resources.push({ type: 'Microsoft.Storage/storageAccounts', tags: { 'valuelens-install-id': 'install-1' } });
      throw new Error('RegionDoesNotAllowProvisioning: SQL capacity locked in UK South');
    }
    return deploy(...args);
  };
  respond(ui, (e) => {
    if (e.kind === 'confirm' && e.message === 'Go ahead?') return true;
    throw new Error(`Unexpected question: ${e.message}`);
  });
  await assert.rejects(install(ctx, { wait: false }), /SQL capacity locked/);
  assert.equal(existsSync(draft), false, 'approved draft must not be recreated');
  assert.equal(loadConfig(ctx.file).config.azure?.deploymentConfig?.location, 'uksouth');

  ctx.setupRetry = false;
  ctx.setupSection = 'placement';
  const retryUi = createWebUi();
  ctx.ui = retryUi;
  const unrelated = { schedule: structuredClone(config.schedule), modules: structuredClone(config.modules), access: structuredClone(config.access) };
  const asked = respond(retryUi, (e) => {
    if (e.kind === 'settings') return 'deploy';
    if (e.kind === 'select') return e.default;
    if (e.kind === 'input') return e.default;
    if (e.kind === 'form') return { location: 'uksouth', sqlLocation: 'swedencentral', namePrefix: 'vlens', tags: '' };
    if (e.kind === 'confirm') return e.message === 'Go ahead?' ? true : false;
    throw new Error(`Unrelated question: ${e.message}`);
  });
  assert.equal(await install(ctx, { wait: false }), true);
  assert.equal(config.azure.sqlLocation, 'swedencentral');
  assert.equal(config.azure.deploymentConfig?.sqlLocation, 'swedencentral');
  assert.deepEqual({ schedule: config.schedule, modules: config.modules, access: config.access }, unrelated);
  assert.ok(!asked.some((m) => /What to collect|How often|Who can view|advanced settings/i.test(m)));
  assert.equal(existsSync(draft), false);
  assert.ok(config.azure.outputs?.webUrl);
});

test('fresh setup refuses deployment until required categories have been reviewed', async (t) => {
  const { ctx, config, ui } = fixture(t);
  assert.ok(config.azure);
  delete config.azure.deploymentConfig;
  delete config.setup;
  ctx.setupRetry = true;
  respond(ui, (e) => {
    assert.equal(e.kind, 'settings');
    assert.match(e.notice, /Review these categories first/);
    return 'close';
  });
  assert.equal(await reviewSetup(ctx), false);
});

test('newer deployment IDs are never overwritten by an older draft; conflict resolution archives it', async (t) => {
  const { ctx, config, ui, draft } = fixture(t);
  respond(ui, () => 'close');
  await reviewSetup(ctx);
  config.fabric.workspaceId = 'new-workspace-from-terminal';
  config.fabric.lakehouseId = 'new-lakehouse-from-terminal';
  ctx.save();
  assert.equal(restoreSetupDraft(ctx), false);
  assert.equal(config.fabric.workspaceId, 'new-workspace-from-terminal');
  const conflictUi = createWebUi();
  ctx.ui = conflictUi;
  respond(conflictUi, (e) => {
    if (e.kind === 'select') {
      assert.match(e.message, /install record changed/);
      return 0;
    }
    return 'close';
  });
  await reviewSetup(ctx);
  assert.equal(config.fabric.lakehouseId, 'new-lakehouse-from-terminal');
  assert.ok(existsSync(draft), 'a new draft uses the latest deployment state');
});

test('an existing AI account permits disabling Ask or using another deployment, without moving it', async (t) => {
  const { ctx, config, arm } = fixture(t);
  assert.ok(config.azure);
  config.azure.ask = { mode: 'create', location: 'uksouth' };
  const before = structuredClone(config);
  arm.resources.push({ type: 'Microsoft.CognitiveServices/accounts', tags: { 'valuelens-install-id': 'install-1' } });
  config.azure.ask = { mode: 'off' };
  await checkSetupChanges(ctx, before);
  config.azure.ask = { mode: 'existing', endpoint: 'https://other.openai.azure.com', deployment: 'model' };
  await checkSetupChanges(ctx, before);
  config.azure.ask = { mode: 'create', location: 'swedencentral' };
  await assert.rejects(checkSetupChanges(ctx, before), /AI account already exists/);
});

test('switching demo to tenant data invalidates connections and governance even when modules do not change', async (t) => {
  const { ctx, config, ui } = fixture(t);
  assert.ok(config.azure);
  config.azure.sampleData = true;
  ctx.setupSection = 'data';
  respond(ui, (e) => {
    if (e.kind === 'checkbox') return e.choices.flatMap((/** @type {any} */ ch, /** @type {number} */ i) => ch.checked ? [i] : []);
    if (e.kind === 'select') return 0;
    if (e.kind === 'settings') {
      assert.equal(e.categories.find((/** @type {any} */ c) => c.id === 'sources').complete, false);
      assert.equal(e.categories.find((/** @type {any} */ c) => c.id === 'governance').complete, false);
      return 'close';
    }
    throw new Error(`Unexpected question: ${e.message}`);
  });
  await reviewSetup(ctx);
  assert.equal(config.azure.sampleData, false);
});

test('selected uploads survive Save and close, and missing staged files explicitly require reselection', async (t) => {
  const { ctx, config, ui } = fixture(t);
  config.target = 'fabric';
  config.dataSources.agent365 = 'csv';
  const upload = stageUpload('agents.csv', new TextEncoder().encode('Agent name,Title ID,Publisher type,Availability,Created by\nA,1,x,y,z\n'));
  t.after(() => releaseStaged(upload.token));
  const staged = checkStaged(upload.token, config.dataSources);
  assert.ok(staged.ok);
  ctx.pendingUploads = [staged.file];
  respond(ui, () => 'close');
  await reviewSetup(ctx);
  ctx.pendingUploads = undefined;
  const resumeUi = createWebUi();
  ctx.ui = resumeUi;
  respond(resumeUi, () => 'close');
  await reviewSetup(ctx);
  assert.deepEqual(pendingTokens(ctx), [upload.token]);
  releaseStaged(upload.token);
  ctx.pendingUploads = undefined;
  const missingUi = createWebUi();
  ctx.ui = missingUi;
  respond(missingUi, (e) => {
    assert.match(e.notice, /agents.csv.*select them again/);
    assert.equal(e.categories.find((/** @type {any} */ c) => c.id === 'data').complete, false);
    return 'close';
  });
  await reviewSetup(ctx);
});

const locked = () => Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });

test('draft delete and archive retry while a synced folder holds the file, and give up without throwing', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'installer-lock-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'record.json.draft.json');
  let tries = 0;
  /** @type {number[]} */
  const waits = [];
  const wait = (/** @type {number} */ ms) => { waits.push(ms); };
  assert.equal(removeFile(file, { unlink: () => { if (++tries < 3) throw locked(); }, wait }), true);
  assert.equal(tries, 3);
  assert.equal(removeFile(file, { unlink: () => { throw locked(); }, wait, tries: 4 }), false);
  assert.equal(removeFile(file), true, 'a file that is already gone is removed');
  assert.throws(() => removeFile(file, { unlink: () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }); } }), /EIO/);
  tries = 0;
  /** @type {string[]} */
  const moved = [];
  const to = archiveConfig(file, new Date(2026, 0, 2, 3, 4, 5), { rename: (_from, dest) => { if (++tries < 2) throw locked(); moved.push(dest); }, wait });
  assert.deepEqual(moved, [to]);
  assert.match(to, /record\.json\.draft\.20260102-030405\.json$/);
});

test('a locked draft after approval does not block the next deployment with a false record conflict', async (t) => {
  const { ctx, ui, draft } = fixture(t);
  ctx.setupRetry = true;
  const realUnlink = fs.unlinkSync;
  const lockDraft = t.mock.method(fs, 'unlinkSync', (/** @type {fs.PathLike} */ path) => {
    if (String(path) === draft) throw locked();
    return realUnlink(path);
  });
  syncBuiltinESMExports();
  t.after(() => { lockDraft.mock.restore(); syncBuiltinESMExports(); });
  respond(ui, (e) => {
    if (e.kind === 'confirm' && e.message === 'Go ahead?') return true;
    throw new Error(`Unexpected question: ${e.message}`);
  });
  assert.equal(await reviewSetup(ctx), true);
  assert.equal(existsSync(draft), true, 'the locked draft stays behind');
  assert.equal(loadConfig(draft).config.setup?.approved, true);
  lockDraft.mock.restore();
  syncBuiltinESMExports();

  const nextUi = createWebUi();
  ctx.ui = nextUi;
  ctx.setupRetry = true;
  respond(nextUi, (e) => {
    if (e.kind === 'confirm' && e.message === 'Go ahead?') return true;
    throw new Error(`Unexpected question: ${e.message}`);
  });
  assert.equal(await reviewSetup(ctx), true, 'no "install record changed" loop and no conflict prompt');
  assert.equal(existsSync(draft), false);
});

test('re-running setup into an existing resource group means uninstall deletes only tagged resources, never that group', async () => {
  const arm = fakeArm();
  const u = fakeUi();
  const select = u.ui.select;
  u.ui.select = async (message, choices, def) => message === 'Resource group' ? /** @type {any} */ ('rg-shared') : select(message, choices, def);
  const { ctx, config } = fakeCtx({ ui: u.ui, arm: arm.api, fabric: fakeFabric().api, powerBi: fakePowerBi().api });
  delete config.fabric.workspaceId;
  config.target = 'azure';
  // An earlier install created its own group.
  config.azure = { subscriptionId: 'sub-1', resourceGroup: 'rg-analytics-hub', resourceGroupMode: 'new', createdResourceGroup: true, location: 'uksouth', installId: 'install-1' };
  await arm.api.ensureResourceGroup('sub-1', 'rg-analytics-hub', 'uksouth', { 'valuelens-install-id': 'install-1' });
  await arm.api.ensureResourceGroup('sub-1', 'rg-shared', 'uksouth');
  arm.resources.push({ id: '/subscriptions/sub-1/resourceGroups/rg-shared/providers/Microsoft.Storage/storageAccounts/ours', type: 'Microsoft.Storage/storageAccounts', tags: { 'valuelens-install-id': 'install-1' } });
  arm.resources.push({ id: '/subscriptions/sub-1/resourceGroups/rg-shared/providers/Microsoft.Storage/storageAccounts/theirs', type: 'Microsoft.Storage/storageAccounts', tags: {} });
  await planAzure(ctx, { subscriptions: [{ subscriptionId: 'sub-1', displayName: 'Sub' }], capacities: [] });
  assert.equal(config.azure.resourceGroup, 'rg-shared');
  assert.equal(config.azure.createdResourceGroup, false);
  await azureUninstall(ctx);
  assert.ok(!arm.calls.some((c) => c.startsWith('deleteResourceGroup')), 'the existing group is never deleted');
  assert.ok(arm.calls.includes('deleteResource /subscriptions/sub-1/resourceGroups/rg-shared/providers/Microsoft.Storage/storageAccounts/ours'));
  assert.ok(!arm.calls.some((c) => c.endsWith('/theirs')));
});
