// @ts-check
/**
 * ensureApp: a brought app must be registered, and sign in, in this tenant. When Entra won't let you create one, it
 * sends you back to Fabric's app question, which offers an admin whenever the installer can't confirm you can.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HttpError } from '../src/http.js';
import { APP_LOOKUP_ATTEMPTS, APP_LOOKUP_RETRY_MS, ensureApp } from '../src/steps/identity.js';
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
  made.ctx.graphRoles = /** @type {any} */ ({ sp: { id: 'graph-sp' }, roles: [] });
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

// Fabric's app question, which a refusal sends you back to

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
  `If Entra refuses, the installer stops: run it again and choose "${ADMIN}". It reuses what it has made, such as the workspace.`;

/**
 * What Fabric's plan offers for a new app, and its default. The plan stops there.
 * @param {{ canCreateApps?: boolean, yes?: boolean, adminPack?: string }} o
 */
async function appQuestion(o) {
  const u = fakeUi({ yes: o.yes });
  const t = fakeCtx({ ui: u.ui, fabric: fakeFabric().api });
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

test('ensureApp: when Entra won\'t let you create the app, it says to run the installer again and choose an admin', async () => {
  for (const yes of [false, true]) {
    const t = fakeCtx({ ui: fakeUi({ yes }).ui });
    for (const key of ['appId', 'objectId', 'servicePrincipalId']) delete /** @type {any} */ (t.config.app)[key];
    t.ctx.graphRoles = /** @type {any} */ ({ sp: { id: 'graph-sp' }, roles: [] });
    t.ctx.api.graph = /** @type {any} */ ({
      createApplication: async () => {
        throw new HttpError('403 Forbidden\nInsufficient privileges to complete the operation.', { method: 'POST', url: 'https://graph.microsoft.com/v1.0/applications', status: 403 });
      },
    });
    await assert.rejects(ensureApp(t.ctx), (err) => {
      const msg = /** @type {Error} */ (err).message;
      assert.match(msg, /^Entra didn't let you create the app registration \(403 Forbidden\)\. /, 'with the first line of what Entra said');
      assert.ok(
        msg.includes(`again${yes ? ' without --yes' : ''} and choose "${ADMIN}": you get an admin pack to send to an Application Administrator or Cloud Application Administrator. `),
        msg,
      );
      assert.ok(msg.endsWith(`Or, if an admin has already made one, choose "${EXISTING}". The installer reuses what it has made, such as the workspace.`), msg);
      assert.doesNotMatch(msg, /docs\//, 'the installer doesn\'t ship the repo\'s docs');
      return true;
    });
    assert.equal(t.config.app.appId, undefined);
  }
});
