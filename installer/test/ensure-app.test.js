// @ts-check
/**
 * ensureApp: a brought app must be registered, and sign in, in this tenant. When Entra won't let you create one, it
 * writes the admin pack and stops, and Fabric's app question then offers the admin as its default. The question also
 * offers an admin whenever the installer can't confirm you can register apps.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { HttpError } from '../src/http.js';
import { GRAPH_APP_ID } from '../src/catalog.js';
import { graphApi } from '../src/clients/graph.js';
import { ADMIN_PACK_FILE, APP_LOOKUP_ATTEMPTS, APP_LOOKUP_RETRY_MS, ensureApp, isResumeLater } from '../src/steps/identity.js';
import { APP_NAME, plan } from '../src/steps/plan.js';
import { fakeCtx, fakeFabric, fakeUi } from './fakes.js';

const APP = '11111111-2222-4333-8444-555555555555';
const forbidden = () => new HttpError('403 Forbidden', { method: 'POST', url: 'https://graph.microsoft.com/v1.0/servicePrincipals', status: 403 });

/**
 * @param {{ existing?: boolean, application?: any, sp?: any[], spLater?: any, createSp?: 'ok' | 'forbidden' | Error, appLater?: number }} o
 *   sp: what findServicePrincipal returns, call by call (the last one repeats).
 *   appLater: findApplication finds the app only from this call on.
 */
function setup(o) {
  const ui = fakeUi();
  const made = fakeCtx({ ui: ui.ui });
  const app = made.config.app;
  app.appId = APP;
  app.existing = o.existing ?? true;
  delete app.objectId;
  delete app.servicePrincipalId;
  made.config.keyVault.mode = 'notebook';
  /** @type {string[]} */
  const calls = [];
  let finds = 0;
  const sps = [...(o.sp ?? [null])];
  made.ctx.graphRoles = /** @type {any} */ ({ sp: { id: 'graph-sp', appRoles: [] }, roles: [] });
  made.ctx.api.graph = /** @type {any} */ ({
    findApplication: async () => {
      calls.push('findApplication');
      finds++;
      return finds >= (o.appLater ?? 1) ? (o.application === undefined ? { id: 'obj-9', appId: APP, displayName: 'Their app' } : o.application) : null;
    },
    findServicePrincipal: async () => {
      calls.push('findServicePrincipal');
      return sps.length > 1 ? sps.shift() : sps[0];
    },
    createServicePrincipal: async () => {
      calls.push('createServicePrincipal');
      if (o.createSp === 'forbidden') throw forbidden();
      if (o.createSp instanceof Error) throw o.createSp;
      return { id: 'sp-new', appId: APP };
    },
    ensureRequiredAccess: async () => false,
  });
  return { ...made, ui, calls };
}

test('ensureApp: a brought app that isn\'t registered here blocks, after waiting for Entra, and says why', async () => {
  const sp = setup({ application: null, sp: [{ id: 'sp-x', appId: APP }] });
  await assert.rejects(ensureApp(sp.ctx), /No app registration with ID 11111111[^\n]*\(tenant-1\): only its enterprise application is here, so it was registered in another tenant/);
  assert.equal(sp.calls.filter((c) => c === 'findApplication').length, APP_LOOKUP_ATTEMPTS);
  assert.deepEqual(sp.sleeps, Array(APP_LOOKUP_ATTEMPTS - 1).fill(APP_LOOKUP_RETRY_MS));
  assert.equal(sp.config.app.servicePrincipalId, undefined);

  const none = setup({ application: null });
  await assert.rejects(ensureApp(none.ctx), /and no service principal for it\. It was registered in another tenant, or the ID is wrong/);
});

test('ensureApp: a brought app Entra shows a little late is used', async () => {
  const t = setup({ appLater: 2, sp: [{ id: 'sp-x', appId: APP }] });
  await ensureApp(t.ctx);
  assert.equal(t.config.app.objectId, 'obj-9');
  assert.equal(t.config.app.servicePrincipalId, 'sp-x');
  assert.deepEqual(t.sleeps, [APP_LOOKUP_RETRY_MS]);
});

test('ensureApp: a brought app with no service principal that you can\'t create blocks with who can', async () => {
  const t = setup({ createSp: 'forbidden' });
  await assert.rejects(ensureApp(t.ctx), (err) => {
    const msg = /** @type {Error} */ (err).message;
    assert.match(msg, /Their app has no service principal \(enterprise application\) in this tenant, and you can't create one/);
    assert.match(msg, /Application Administrator creates it \(az ad sp create --id 11111111-2222-4333-8444-555555555555\)/);
    assert.match(msg, /Global Administrator opens the admin consent link[^\n]*login\.microsoftonline\.com\/tenant-1\/adminconsent\?client_id=11111111/);
    return true;
  });
  assert.equal(t.calls.filter((c) => c === 'findServicePrincipal').length, 1 + APP_LOOKUP_ATTEMPTS, 'looked for again before blocking');
  assert.equal(t.config.app.servicePrincipalId, undefined);

  const other = setup({ createSp: new Error('boom') });
  await assert.rejects(ensureApp(other.ctx), /^Error: boom$/, 'anything but a refusal is passed on');
});

test('ensureApp: a service principal someone else just made is found on a second look', async () => {
  const t = setup({ createSp: 'forbidden', sp: [null, null, { id: 'sp-late', appId: APP }] });
  await ensureApp(t.ctx);
  assert.equal(t.config.app.servicePrincipalId, 'sp-late');

  const made = setup({});
  await ensureApp(made.ctx);
  assert.equal(made.config.app.servicePrincipalId, 'sp-new');
  assert.match(made.ui.text(), /Created its service principal/);
  assert.deepEqual(made.sleeps, []);
});

test('ensureApp: an app the installer made keeps the old messages, with no extra block', async () => {
  const gone = setup({ existing: false, application: null });
  await assert.rejects(ensureApp(gone.ctx), /in the install record no longer exists/);

  const refused = setup({ existing: false, createSp: 'forbidden' });
  await assert.rejects(ensureApp(refused.ctx), /403 Forbidden/);
  assert.equal(refused.calls.filter((c) => c === 'findServicePrincipal').length, 1, 'no waiting');
});

// Taking back what Analytics Hub no longer uses. The default modules use neither Agent 365's API nor Defender.

/** Graph's app roles in a tenant, including one Analytics Hub never asks for. */
const GRAPH_SP = {
  id: 'graph-sp',
  appRoles: [
    { id: 'r-audit', value: 'AuditLogsQuery.Read.All' },
    { id: 'r-reports', value: 'Reports.Read.All' },
    { id: 'r-users', value: 'User.Read.All' },
    { id: 'r-packages', value: 'CopilotPackages.Read.All' },
    { id: 'r-hunting', value: 'ThreatHunting.Read.All' },
    { id: 'r-mail', value: 'Mail.Read' },
  ],
};
const NEEDED = GRAPH_SP.appRoles.slice(0, 3);

/** An app registration listing these Graph roles, and a delegated scope. @param {string[]} roles */
const listing = (roles) => ({
  id: 'obj-9',
  appId: APP,
  displayName: 'Analytics Hub Data Collector',
  requiredResourceAccess: [
    { resourceAppId: GRAPH_APP_ID, resourceAccess: [...roles.map((id) => ({ id, type: 'Role' })), { id: 's-hunting', type: 'Scope' }] },
    { resourceAppId: 'other-api', resourceAccess: [{ id: 'x', type: 'Role' }] },
  ],
});

/**
 * ensureApp for a recorded app that lists `roles`, with removeRequiredAccess failing with `refusal` if given.
 * @param {{ existing?: boolean, roles: string[], refusal?: Error }} o
 */
function takeBack(o) {
  const t = setup({ existing: o.existing, application: listing(o.roles), sp: [{ id: 'sp-x', appId: APP }] });
  t.ctx.graphRoles = /** @type {any} */ ({ sp: GRAPH_SP, roles: NEEDED });
  /** @type {string[]} */
  const removed = [];
  const graph = /** @type {any} */ (t.ctx.api.graph);
  graph.removeRequiredAccess = async (/** @type {any} */ _application, /** @type {{ value: string }[]} */ roles) => {
    removed.push(...roles.map((r) => r.value));
    if (o.refusal) throw o.refusal;
    return true;
  };
  return { ...t, removed };
}

test('ensureApp: an app the installer made loses the API permissions Analytics Hub no longer uses, and nothing else', async () => {
  const t = takeBack({ existing: false, roles: ['r-audit', 'r-reports', 'r-users', 'r-hunting', 'r-mail'] });
  t.config.app.retiredPermissions = ['ThreatHunting.Read.All'];
  await ensureApp(t.ctx);
  assert.deepEqual(t.removed, ['ThreatHunting.Read.All'], 'not the roles it still needs, nor Mail.Read, which it never asks for');
  assert.match(t.ui.text(), /Took ThreatHunting\.Read\.All off its API permissions, as Analytics Hub no longer uses it/);
  assert.equal(t.config.app.retiredPermissions, undefined, 'nothing left for an admin');

  const none = takeBack({ existing: false, roles: ['r-audit', 'r-reports', 'r-users', 'r-mail'] });
  await ensureApp(none.ctx);
  assert.deepEqual(none.removed, [], 'nothing it no longer uses is listed');
  assert.doesNotMatch(none.ui.text(), /off its API permissions/);
});

test('ensureApp: when Entra won\'t let you edit the app it made, the record keeps what to remove and an app admin or owner is asked', async () => {
  const t = takeBack({ existing: false, roles: ['r-packages', 'r-hunting'], refusal: forbidden() });
  await ensureApp(t.ctx);
  assert.deepEqual(t.config.app.retiredPermissions, ['CopilotPackages.Read.All', 'ThreatHunting.Read.All']);
  const text = t.ui.text();
  assert.ok(
    text.includes(
      'You can\'t edit its API permissions, so Analytics Hub Data Collector still lists CopilotPackages.Read.All, ThreatHunting.Read.All, which Analytics Hub no longer uses. ' +
        'An Application Administrator, a Cloud Application Administrator or one of the app\'s owners can remove them on its API permissions page:',
    ),
    text,
  );
  assert.ok(text.includes(`CallAnAPI/appId/${APP}`), 'with the link');
  assert.match(text, /Using app registration "Analytics Hub Data Collector"/, 'and the install carries on');

  const other = takeBack({ existing: false, roles: ['r-hunting'], refusal: new HttpError('400 Bad Request\nmore', { method: 'PATCH', url: 'https://x', status: 400 }) });
  await ensureApp(other.ctx);
  assert.deepEqual(other.config.app.retiredPermissions, ['ThreatHunting.Read.All']);
  assert.match(other.ui.text(), /Entra didn't change its API permissions \(400 Bad Request\), so Analytics Hub Data Collector still lists ThreatHunting\.Read\.All/);

  const boom = takeBack({ existing: false, roles: ['r-hunting'], refusal: new Error('network down') });
  await assert.rejects(ensureApp(boom.ctx), /network down/, 'anything but Entra\'s answer is passed on');
});

test('ensureApp: an app you brought, or a record that doesn\'t say who made the app, keeps its API permissions', async () => {
  for (const existing of [true, undefined]) {
    const t = takeBack({ existing: true, roles: ['r-audit', 'r-reports', 'r-users', 'r-packages', 'r-hunting'] });
    if (existing === undefined) delete t.config.app.existing;
    t.config.app.retiredPermissions = ['ThreatHunting.Read.All'];
    await ensureApp(t.ctx);
    assert.deepEqual(t.removed, [], `existing: ${existing}`);
    assert.equal(t.config.app.retiredPermissions, undefined, 'and asks no one to remove them');
  }
});

test('the Graph client takes app roles off an app registration, keeping the rest, and revokes one\'s consent', async () => {
  /** @type {[string, any][]} */
  const patches = [];
  /** @type {string[]} */
  const deletes = [];
  const g = graphApi(
    /** @type {any} */ ({
      patch: async (/** @type {string} */ p, /** @type {any} */ body) => (patches.push([p, body]), {}),
      del: async (/** @type {string} */ p) => (deletes.push(p), undefined),
    }),
  );
  const application = listing(['r-audit', 'r-hunting']);
  assert.equal(await g.removeRequiredAccess(application, [{ id: 'r-mail' }, { id: 's-hunting' }]), false, 'none of them is listed as a role');
  assert.deepEqual(patches, []);

  assert.equal(await g.removeRequiredAccess(application, [{ id: 'r-hunting' }, { id: 'r-mail' }]), true);
  const kept = [
    { resourceAppId: GRAPH_APP_ID, resourceAccess: [{ id: 'r-audit', type: 'Role' }, { id: 's-hunting', type: 'Scope' }] },
    { resourceAppId: 'other-api', resourceAccess: [{ id: 'x', type: 'Role' }] },
  ];
  assert.deepEqual(patches, [['/applications/obj-9', { requiredResourceAccess: kept }]]);
  assert.deepEqual(application.requiredResourceAccess, kept, 'the application matches what was saved');

  const only = { id: 'obj-8', requiredResourceAccess: [{ resourceAppId: GRAPH_APP_ID, resourceAccess: [{ id: 'r-hunting', type: 'Role' }] }] };
  await g.removeRequiredAccess(only, [{ id: 'r-hunting' }]);
  assert.deepEqual(patches[1], ['/applications/obj-8', { requiredResourceAccess: [] }], 'no empty Graph entry is left');

  await g.revokeAppRole('graph-sp', 'assignment-1');
  assert.deepEqual(deletes, ['/servicePrincipals/graph-sp/appRoleAssignedTo/assignment-1']);
});

// Fabric's app question. After a refusal, it offers the admin first.

const APP_QUESTION = 'The notebooks sign in to Microsoft Graph as an app.';
const ADMIN = 'An admin will register the app for me';
const EXISTING = 'Use an app registration I already have';
const PRE = /** @type {any} */ ({
  subscriptions: [{ subscriptionId: 'sub-1', displayName: 'Sub' }],
  canConsent: true,
  capacities: [{ id: 'cap-1', displayName: 'F64', sku: 'F64', region: 'UK South', state: 'Active' }],
  tenantSettings: [],
});
const CUSTOM_ROLE =
  'The installer found no role or setting that lets you register apps, but it can\'t see custom roles. Choose this only if a custom role lets you create it. ' +
  'If Entra refuses, the installer stops and writes the admin pack, with a file for an admin who can register it. When you run it again, it reuses what it has made, such as the workspace.';

/**
 * What Fabric's plan offers for a new app, and its default. The plan stops there.
 * @param {{ canCreateApps?: boolean, yes?: boolean, adminPack?: string, config?: import('../src/config.js').InstallConfig }} o
 *   config: the install record to plan from, such as one a stopped run saved.
 */
async function appQuestion(o) {
  const u = fakeUi({ yes: o.yes });
  const t = fakeCtx({ ui: u.ui, fabric: fakeFabric().api, config: o.config });
  for (const key of ['appId', 'objectId', 'servicePrincipalId']) delete /** @type {any} */ (t.config.app)[key];
  if (o.adminPack) t.config.app.adminPack = o.adminPack;
  /** @type {{ names: string[], create: any, def: string } | undefined} */
  let asked;
  const stop = new Error('Stopped at the app question.');
  const select = u.ui.select;
  u.ui.select = /** @type {any} */ (
    async (/** @type {string} */ m, /** @type {any[]} */ ch, /** @type {any} */ d) => {
      if (m !== APP_QUESTION) return select(m, ch, d);
      asked = { names: ch.map((x) => x.name), create: ch[0], def: d };
      throw stop;
    }
  );
  await assert.rejects(plan(t.ctx, { ...PRE, canCreateApps: o.canCreateApps }), (err) => err === stop);
  return /** @type {{ names: string[], create: any, def: string }} */ (asked);
}

test('Fabric plan: "(recommended)" is on the default only, and Create says when it may not work', async () => {
  const can = await appQuestion({ canCreateApps: true });
  assert.deepEqual(can.names, [`Create "${APP_NAME}" (recommended)`, EXISTING]);
  assert.equal(can.def, 'new');
  assert.equal(can.create.description, undefined);

  const cannot = await appQuestion({ canCreateApps: false });
  assert.deepEqual(cannot.names, [`Create "${APP_NAME}"`, EXISTING, ADMIN], 'the admin is the default, so Create isn\'t recommended');
  assert.equal(cannot.def, 'admin');
  assert.equal(cannot.create.description, CUSTOM_ROLE);

  const unread = await appQuestion({});
  assert.deepEqual(unread.names, [`Create "${APP_NAME}" (recommended)`, EXISTING, ADMIN], 'an admin is offered when the installer can\'t read whether you can register apps');
  assert.equal(unread.def, 'new');
  assert.equal(unread.create.description, undefined);

  const pack = await appQuestion({ canCreateApps: true, adminPack: 'admin-pack.md' });
  assert.deepEqual(pack.names, [`Create "${APP_NAME}"`, EXISTING, ADMIN], 'a pack already written is the default');
  assert.equal(pack.def, 'admin');

  const yes = await appQuestion({ canCreateApps: false, yes: true });
  assert.equal(yes.def, 'new', '--yes keeps Create as its default');
  assert.equal(yes.names[0], `Create "${APP_NAME}" (recommended)`);
  assert.equal(yes.create.description, CUSTOM_ROLE);
});

test('ensureApp: when Entra won\'t let you create the app, it writes the admin pack, names it and stops, and the next run offers the admin first', async () => {
  const first = await appQuestion({ canCreateApps: true });
  assert.ok(!first.names.includes(ADMIN), 'you can register apps and grant consent, so the plan offered no admin');
  for (const yes of [false, true]) {
    const dir = mkdtempSync(join(tmpdir(), 'ah-refused-'));
    try {
      const t = fakeCtx({ ui: fakeUi({ yes }).ui });
      for (const key of ['appId', 'objectId', 'servicePrincipalId']) delete /** @type {any} */ (t.config.app)[key];
      t.ctx.configFile = join(dir, 'valuelens-install.json');
      /** @type {import('../src/config.js').InstallConfig[]} */
      const saved = [];
      t.ctx.save = () => saved.push(structuredClone(t.config));
      t.ctx.graphRoles = /** @type {any} */ ({ sp: { id: 'graph-sp' }, roles: [] });
      t.ctx.api.graph = /** @type {any} */ ({
        createApplication: async () => {
          throw new HttpError('403 Forbidden\nInsufficient privileges to complete the operation.', { method: 'POST', url: 'https://graph.microsoft.com/v1.0/applications', status: 403 });
        },
      });
      const pack = join(dir, ADMIN_PACK_FILE);
      const appFile = join(dir, 'analytics-hub-admin-pack', 'app-admin.md');
      await assert.rejects(ensureApp(t.ctx), (err) => {
        assert.ok(isResumeLater(err), 'it stops, as the plan\'s admin option does');
        const msg = /** @type {Error} */ (err).message;
        assert.match(msg, /^Entra didn't let you create the app registration \(403 Forbidden\), so the installer stopped\. /, 'with the first line of what Entra said');
        assert.ok(msg.includes(`Send ${appFile} to an Application Administrator or Cloud Application Administrator: it has a Cloud Shell script and portal steps to register the app. `), msg);
        assert.ok(msg.includes(`${pack} lists it, with any other admin's file. `), msg);
        assert.ok(msg.includes('Once they send you its client ID, run "'), msg);
        assert.ok(msg.includes(`again${yes ? ' without --yes' : ''} and choose "${ADMIN}" to enter it. `), msg);
        assert.ok(msg.endsWith(`Or, if an admin has already made one, choose "${EXISTING}". The installer reuses what it has made, such as the workspace.`), msg);
        assert.doesNotMatch(msg, /docs\//, 'the installer doesn\'t ship the repo\'s docs');
        return true;
      });
      const index = readFileSync(pack, 'utf8');
      assert.match(index, /^# Analytics Hub: your admin pack\n/);
      assert.match(index, /Microsoft Entra refused to let you create Analytics Hub's app registration/, 'it says what happened');
      assert.doesNotMatch(index, /can't register apps|can't grant admin consent/, 'and no more: your role or the tenant setting may have looked as if it allowed you');
      assert.match(index, /analytics-hub-admin-pack\/app-admin\.md/);
      assert.match(readFileSync(appFile, 'utf8'), /az ad app create --display-name "Analytics Hub Data Collector"/, 'the app admin\'s file has the script');
      const record = saved.at(-1);
      assert.ok(record, 'the record is saved before it stops');
      assert.equal(record.app.adminPack, pack);
      assert.equal(record.app.appId, undefined);

      const next = await appQuestion({ canCreateApps: true, yes, config: record });
      assert.deepEqual(next.names, [`Create "${APP_NAME}"`, EXISTING, ADMIN], 'the next run offers the admin');
      assert.equal(next.def, 'admin', 'as its default');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
