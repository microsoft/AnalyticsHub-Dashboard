// @ts-check
// The "Create workspaces" tenant setting, which large tenants often restrict. Where the installer can read it (only a
// Fabric administrator can), it counts you in or out, security groups and all. Each workspace choice says what it
// takes. The workspace is the first thing an install creates, so when Fabric refuses it, nothing else exists yet, and
// the stop says what to ask for, and that an existing workspace will do.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig, saveConfig } from '../src/config.js';
import { createCtx, install } from '../src/install.js';
import { ensureWorkspace } from '../src/steps/fabric.js';
import { isResumeLater } from '../src/steps/identity.js';
import { CREATE_WORKSPACES_FIX, NEW_WORKSPACE_NEEDS, createWorkspacesAccess, fabricWorkspaceNeeds, plan } from '../src/steps/plan.js';
import { fakeAzureGraph, fakeCtx, fakeFabric, fakePowerBi, fakeUi, httpError, realSources } from './fakes.js';

/** The command to run again, however the installer was started. */
const RUN_AGAIN = /run "[^"]+" again/;
const SETTING = { settingName: 'CreateAppWorkspaces', title: 'Create workspaces', enabled: true };
/** @param {string[]} [direct] @param {string[]} [all] */
const inGroups = (direct = [], all = []) => async () => ({ direct, all });
const unread = async () => {
  throw new Error('The groups were read.');
};
const forbidden = async () => {
  throw new Error('Forbidden');
};

// What the setting says, for you

test('"Create workspaces": your groups are read only when it names some, and each reason says what it found', async () => {
  assert.deepEqual(await createWorkspacesAccess([SETTING], unread), { status: 'met', reason: '"Create workspaces" is on for the whole organization.' });
  assert.equal((await createWorkspacesAccess([{ ...SETTING, enabledSecurityGroups: [], excludedSecurityGroups: [] }], unread)).status, 'met', 'empty lists name no groups');
  const five = ['A', 'B', 'C', 'D', 'E'].map((n) => ({ graphId: `g-${n}`, name: n }));
  assert.deepEqual(await createWorkspacesAccess([{ ...SETTING, enabledSecurityGroups: five }], inGroups(['g-x'])), {
    status: 'missing',
    reason: '"Create workspaces" is on only for groups you\'re not in: "A", "B", "C" and 2 more.',
  });
  assert.deepEqual(
    await createWorkspacesAccess([{ ...SETTING, excludedSecurityGroups: [{ graphId: 'G-1' }] }], inGroups(['g-1'])),
    { status: 'missing', reason: '"Create workspaces" excludes the group "G-1", which you\'re in.' },
    'a group with no name is shown by its ID, matched in any case',
  );
});

test('"Create workspaces": it\'s found by the name the API gives it, else by its title', async () => {
  assert.deepEqual(await createWorkspacesAccess([{ settingName: 'Renamed', title: 'Create Workspaces', enabled: false }], unread), {
    status: 'missing',
    reason: '"Create Workspaces" is off for the whole organization.',
  });
  const both = [{ settingName: 'Other', title: 'Create workspaces', enabled: false }, { ...SETTING, title: 'Create workspaces (renamed)' }];
  assert.deepEqual(await createWorkspacesAccess(both, unread), { status: 'met', reason: '"Create workspaces (renamed)" is on for the whole organization.' });
  assert.deepEqual(await createWorkspacesAccess([{ settingName: 'Other', title: 'Other', enabled: true }], unread), {
    status: 'unknown',
    reason: 'it isn\'t among the tenant settings Fabric returned.',
  });
});

test('"Create workspaces": what the installer can\'t tell is unknown, never met', async () => {
  for (const key of ['delegateToCapacity', 'delegateToDomain', 'delegateToWorkspace']) {
    assert.deepEqual(await createWorkspacesAccess([{ ...SETTING, enabled: false, [key]: true }], unread), {
      status: 'unknown',
      reason: 'it\'s off for the organization, but delegated to other admins, who may have turned it on.',
    }, key);
  }
  assert.deepEqual(await createWorkspacesAccess([{ settingName: SETTING.settingName, title: SETTING.title }], unread), {
    status: 'unknown',
    reason: 'Fabric didn\'t say whether it\'s on.',
  });
});

test('"Create workspaces": excluding a group you\'re in beats including another, as the most restrictive setting applies', async () => {
  const scoped = { ...SETTING, enabledSecurityGroups: [{ graphId: 'g-in', name: 'Analysts' }], excludedSecurityGroups: [{ graphId: 'g-out', name: 'Contractors' }] };
  assert.deepEqual(await createWorkspacesAccess([scoped], inGroups(['g-in', 'g-out'])), {
    status: 'missing',
    reason: '"Create workspaces" excludes the group "Contractors", which you\'re in.',
  });
  assert.deepEqual(await createWorkspacesAccess([scoped], inGroups(['g-in'], ['g-in', 'g-out'])), {
    status: 'unknown',
    reason: 'it excludes the group "Contractors", which you\'re in only through another group. Learn doesn\'t say whether that counts.',
  });
  assert.deepEqual(await createWorkspacesAccess([scoped], inGroups(['g-in'])), {
    status: 'met',
    reason: '"Create workspaces" is on for the group "Analysts", which you\'re in.',
  });
});

// The workspace question on Fabric

const PRE = /** @type {any} */ ({
  subscriptions: [{ subscriptionId: 'sub-1', displayName: 'Sub' }],
  canConsent: true,
  canCreateApps: true,
  capacities: [{ id: 'cap-1', displayName: 'F64', sku: 'F64', region: 'UK South', state: 'Active' }],
  tenantSettings: [],
});
/** Workspaces you're an Admin or Member of: one not on a capacity yet, one on a capacity, and your own. */
const MINE = [
  { id: 'ws-off', displayName: 'Sandbox', type: 'Workspace' },
  { id: 'ws-on', displayName: 'Team analytics', type: 'Workspace', capacityId: 'cap-x' },
  { id: 'ws-me', displayName: 'My workspace', type: 'Personal' },
];
/** Every workspace you can see, including one you're only a Viewer of. */
const VISIBLE = [...MINE, { id: 'ws-viewer', displayName: 'Analytics Hub', type: 'Workspace' }];
const REFUSED = { status: 'missing', reason: '"Create workspaces" is on only for groups you\'re not in: "Workspace creators".' };
const OFF_CAPACITY = 'It isn\'t on a capacity yet, so it needs Admin on it, to move it onto the capacity you chose.';
const ON_CAPACITY = 'Needs Admin or Member on it. Only an Admin can let the pipeline\'s notebooks share one Spark session, or reach a private Key Vault.';

/**
 * A new Fabric install's plan, with no workspace or Lakehouse yet. Listing workspaces by role gives `mine`; listing
 * them all gives VISIBLE.
 * @param {{ yes?: boolean, mine?: any[] }} [o]
 */
function placement(o = {}) {
  const u = fakeUi({ yes: o.yes });
  /** @type {Record<string, { choices: any[], def: any }>} */
  const selects = {};
  const select = u.ui.select;
  u.ui.select = /** @type {any} */ (async (/** @type {string} */ m, /** @type {any[]} */ ch, /** @type {any} */ d) => ((selects[m] = { choices: ch, def: d }), select(m, ch, d)));
  /** @type {any[]} */
  const roles = [];
  const mine = o.mine ?? MINE;
  const fabric = { ...fakeFabric().api, listWorkspaces: async (/** @type {any} */ r) => (roles.push(r), r ? mine : VISIBLE) };
  const t = fakeCtx({ ui: u.ui, fabric });
  const f = /** @type {any} */ (t.config.fabric);
  for (const key of ['workspaceId', 'workspaceName', 'lakehouseId', 'lakehouseName']) delete f[key];
  return { ...t, u, selects, roles, plan: (/** @type {any} */ createWorkspaces) => plan(t.ctx, { ...PRE, createWorkspaces }) };
}

test('Fabric plan: each workspace choice says what it takes, and only workspaces you\'re an Admin or Member of are offered', async () => {
  assert.equal(fabricWorkspaceNeeds({}), OFF_CAPACITY);
  assert.equal(fabricWorkspaceNeeds({ capacityId: 'cap-x' }), ON_CAPACITY);
  assert.equal(NEW_WORKSPACE_NEEDS, 'Needs the "Create workspaces" tenant setting on for you, or for a group you\'re in.');
  const t = placement();
  await t.plan(undefined);
  assert.deepEqual(t.selects.Workspace.choices, [
    { name: 'Create a new workspace', value: '', description: NEW_WORKSPACE_NEEDS },
    { name: 'Use "Sandbox"', value: 'ws-off', description: OFF_CAPACITY },
    { name: 'Use "Team analytics"', value: 'ws-on', description: ON_CAPACITY },
  ]);
  assert.equal(t.selects.Workspace.def, '', 'a new workspace, when nothing says you can\'t create one');
  assert.deepEqual(t.roles, [['Admin', 'Member'], undefined], 'then every workspace you can see, for the new name');
  assert.equal(t.config.fabric.workspaceName, 'Analytics Hub 2', 'not the name of a workspace you can only view');
  assert.equal(t.config.fabric.workspaceId, undefined);
  assert.doesNotMatch(t.u.text(), /You can't create a workspace/);
});

test('Fabric plan: when "Create workspaces" leaves you out, the default is a workspace you can use, preferably one already on a capacity', async () => {
  const t = placement();
  await t.plan(REFUSED);
  assert.equal(t.selects.Workspace.def, 'ws-on', 'Member is enough for one already on a capacity');
  assert.ok(t.u.text().includes(`You can't create a workspace: ${REFUSED.reason} So the default is a workspace you're an Admin or Member of.`), t.u.text());
  assert.equal(t.config.fabric.workspaceId, 'ws-on');
  assert.equal(t.config.fabric.workspaceName, 'Team analytics');
  assert.equal(t.config.fabric.createdWorkspace, undefined);
  assert.deepEqual(t.roles, [['Admin', 'Member']]);

  const offOnly = placement({ mine: [MINE[0]] });
  await offOnly.plan(REFUSED);
  assert.equal(offOnly.selects.Workspace.def, 'ws-off', 'one that has to move onto the capacity, if that\'s all there is');
});

test('Fabric plan: when "Create workspaces" leaves you out and there\'s no workspace you can use, it says how to get either', async () => {
  const t = placement({ mine: [] });
  await t.plan(REFUSED);
  assert.deepEqual(t.selects.Workspace.choices.map((c) => c.value), ['']);
  assert.equal(t.selects.Workspace.def, '');
  assert.ok(
    t.u.text().includes(`You can't create a workspace: ${REFUSED.reason} ${CREATE_WORKSPACES_FIX} Or ask for Admin or Member on an existing workspace. Then run the installer again.`),
    t.u.text(),
  );
});

test('Fabric plan: an unknown "Create workspaces", or --yes, keeps a new workspace as the default, with no note', async () => {
  for (const [what, o, createWorkspaces] of /** @type {const} */ ([
    ['unknown', {}, { status: 'unknown', reason: 'it isn\'t among the tenant settings Fabric returned.' }],
    ['--yes', { yes: true }, REFUSED],
  ])) {
    const t = placement(o);
    await t.plan(createWorkspaces);
    assert.equal(t.selects.Workspace.def, '', what);
    assert.doesNotMatch(t.u.text(), /You can't create a workspace/, what);
    assert.equal(t.config.fabric.workspaceId, undefined, what);
  }
});

// Creating it

/**
 * A Fabric install about to create its workspace, "Analytics Hub", on the trial capacity.
 * @param {(name: string, capacityId: string) => Promise<any>} create
 */
function creating(create) {
  const fabric = fakeFabric();
  const u = fakeUi();
  const t = fakeCtx({ ui: u.ui, fabric: { ...fabric.api, createWorkspace: create } });
  delete t.config.fabric.workspaceId;
  Object.assign(t.config.fabric, { workspaceName: 'Analytics Hub', capacityId: 'cap-f' });
  return { ...t, fabric, u };
}

test('Fabric: a 401 or 403 creating the workspace stops the install, naming both settings that can refuse it, and an existing workspace', async () => {
  for (const status of [401, 403]) {
    const t = creating(async () => {
      throw httpError(status, 'Forbidden');
    });
    await assert.rejects(ensureWorkspace(t.ctx), (/** @type {Error} */ err) => {
      assert.ok(isResumeLater(err), err.message);
      assert.equal(
        err.message.replace(RUN_AGAIN, 'run X again'),
        'Fabric didn\'t let you create the workspace "Analytics Hub" (Forbidden), so the installer stopped before its other steps. ' +
          'Either the "Create workspaces" tenant setting doesn\'t include you: ask a Fabric administrator to turn it on for you, or for a group you\'re in. ' +
          'Or you can\'t add workspaces to the capacity "Trial": ask its capacity admin to make you a contributor. ' +
          'Or ask for Admin or Member on an existing workspace that\'s already on a capacity. ' +
          'Then run X again, and for the workspace choose that one, or "Create a new workspace".',
      );
      return true;
    });
    assert.equal(t.config.fabric.workspaceId, undefined, `${status}: nothing recorded`);
    assert.equal(t.config.fabric.createdWorkspace, undefined);
    assert.equal(t.saves(), 0);
  }
  const unnamed = creating(async () => {
    throw httpError(403, 'Forbidden');
  });
  unnamed.ctx.api.fabric.listCapacities = forbidden;
  await assert.rejects(ensureWorkspace(unnamed.ctx), (/** @type {Error} */ err) => isResumeLater(err) && err.message.includes('to the capacity "cap-f": ask'));
});

test('Fabric: other errors creating the workspace are not mistaken for a refusal', async () => {
  const t = creating(async () => {
    throw httpError(500, 'Internal error');
  });
  await assert.rejects(ensureWorkspace(t.ctx), (/** @type {Error} */ err) => !isResumeLater(err) && err.message === 'Internal error');
  assert.equal(t.config.fabric.workspaceId, undefined);
});

test('Fabric: the workspace it creates is recorded as the installer\'s, and a re-run reuses it', async () => {
  /** @type {string[]} */
  const created = [];
  const t = creating(async (name, capacityId) => (created.push(`${name} ${capacityId}`), { id: 'ws-new', displayName: name }));
  await ensureWorkspace(t.ctx);
  assert.deepEqual(created, ['Analytics Hub cap-f']);
  assert.equal(t.config.fabric.workspaceId, 'ws-new');
  assert.equal(t.config.fabric.createdWorkspace, true, 'so Uninstall deletes it');
  assert.equal(t.saves(), 1);
  assert.match(t.u.text(), /Created workspace "Analytics Hub"/);

  t.ctx.api.fabric.getWorkspace = async (id) => ({ id, displayName: 'Analytics Hub', capacityId: 'cap-f' });
  await ensureWorkspace(t.ctx);
  assert.deepEqual(created, ['Analytics Hub cap-f'], 'not created again');
  assert.equal(t.config.fabric.workspaceId, 'ws-new');
  assert.equal(t.config.fabric.createdWorkspace, true);
  assert.deepEqual(t.fabric.calls.filter((c) => c.startsWith('assignToCapacity')), []);
});

test('Fabric install: the workspace is the first thing it creates, so a refusal stops it before the Key Vault, the app or the Lakehouse', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-create-workspaces-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'valuelens-install.json');
  const config = loadConfig(file).config;
  config.target = 'fabric';
  config.tenantId = 'tenant-1';
  config.keyVault.mode = 'notebook';
  config.semanticModel.enabled = false;
  config.fabricApp.enabled = false;
  saveConfig(file, config);
  const fabric = fakeFabric();
  const graph = fakeAzureGraph();
  const u = fakeUi();
  const ctx = createCtx({
    ui: u.ui,
    config,
    file,
    api: /** @type {any} */ ({
      // Not a Fabric administrator: the tenant settings can't be read, so nothing says Fabric will refuse.
      fabric: {
        ...fabric.api,
        tenantSettings: forbidden,
        listWorkspaces: async () => [],
        createWorkspace: async () => {
          throw httpError(403, 'Forbidden');
        },
      },
      graph: { ...graph.api, subscribedSkus: forbidden, myDirectoryRoles: async () => [], usersCanRegisterApps: async () => true, ensureRequiredAccess: async () => false },
      powerBi: fakePowerBi().api,
      arm: { listSubscriptions: async () => [] },
      keyVault: {},
      oneLake: {},
      discovery: {},
      powerPlatform: { billingPolicies: async () => [] },
    }),
    user: { id: 'user-1', upn: 'admin@contoso.com', tenantId: 'tenant-1' },
    sources: realSources(),
    sleep: async () => {},
    now: () => new Date('2026-06-01T12:00:00Z'),
  });
  await assert.rejects(install(ctx, { wait: true }), (/** @type {Error} */ err) => {
    assert.ok(isResumeLater(err), err.message);
    assert.match(err.message, /^Fabric didn't let you create the workspace "Analytics Hub" \(Forbidden\)/);
    assert.ok(err.message.includes('the "Create workspaces" tenant setting'));
    assert.ok(err.message.includes('the capacity "Trial"'));
    return true;
  });
  const text = u.text();
  assert.match(text, /App: +Analytics Hub Data Collector \(new\)/, 'the plan was to create the app');
  assert.match(text, /\[1\/\d+\] Workspace\n/);
  assert.doesNotMatch(text, /\[\d+\/\d+\] (Key Vault|App registration|Microsoft Graph permissions|Lakehouse)/, text);
  assert.deepEqual(graph.calls.filter((c) => /^create\w*Application|^addPassword/.test(c)), [], 'no app, and no secret');
  assert.deepEqual(fabric.calls.filter((c) => /^create/.test(c)), [], 'no Lakehouse or anything else in Fabric');
  const saved = loadConfig(file).config;
  assert.equal(saved.fabric.workspaceName, 'Analytics Hub', 'the plan is kept for the next run');
  assert.equal(saved.fabric.workspaceId, undefined);
  assert.equal(saved.fabric.createdWorkspace, undefined);
  assert.equal(saved.app.appId, undefined);
});
