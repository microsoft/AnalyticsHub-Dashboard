// @ts-check
/** ensureApp: a brought app must be registered, and sign in, in this tenant. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HttpError } from '../src/http.js';
import { APP_LOOKUP_ATTEMPTS, APP_LOOKUP_RETRY_MS, ensureApp } from '../src/steps/identity.js';
import { fakeCtx, fakeUi } from './fakes.js';

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
