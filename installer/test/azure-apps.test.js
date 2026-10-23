// @ts-check
// Azure app registration for someone who isn't a Global Administrator, in a tenant with strict role controls: who
// can create the two Entra apps, the plan's "App registrations" step, adopting apps an admin made, the admin's Cloud
// Shell script, and creating the apps before the deploy, so a refusal stops the install before anything is billed.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { appRoleRights, applicationBody, azureWebApplicationBody, graphApi } from '../src/clients/graph.js';
import { SQL_READER_NAME, WEB_APP_NAME, webAppScopes } from '../src/steps/azure/apps.js';
import { azureAppsGate, azureStatus, installAzure, planAzure, planAzureApps } from '../src/steps/azure/index.js';
import { AZURE_ADMIN_SCRIPT_FILE, azureAdminScript, isResumeLater } from '../src/steps/identity.js';
import { fakeArm, fakeAzureGraph, fakeCtx, fakeFabric, fakePowerBi, fakeUi, httpError } from './fakes.js';

const GA = '62e90394-69f5-4237-9190-012177145e10';
const PRA = 'e8611ab8-c189-46e8-94e1-60213ab1f814';
const APP_ADMIN = '9b895d92-2cd3-44c7-9d02-a6ac2d5ea5c3';
const CLOUD_APP_ADMIN = '158c047a-c907-4556-b7ef-446551a6b5f7';
const APP_DEVELOPER = 'cf1c38e5-3621-4004-a7cb-879624dced7c';

const SUBS = { subscriptions: [{ subscriptionId: 'sub-1', displayName: 'Sub' }], capacities: [], tenantSettings: [] };
/** No app role, in a tenant where users can't register apps. */
const NONE = { ...SUBS, canCreateApps: false, canApproveDelegated: false, canManageApps: false };
/** Can register apps, but can't approve the web app's delegated permissions. */
const CREATOR = { ...SUBS, canCreateApps: true, canApproveDelegated: false, canManageApps: false };
/** An Application Administrator. */
const APP_ADMINISTRATOR = { ...SUBS, canCreateApps: true, canApproveDelegated: true, canManageApps: true };
const WHO = 'Who creates the two Entra app registrations?';
const WEB_ID = '11111111-1111-4111-8111-111111111111';
const SQL_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_WEB_ID = '33333333-3333-4333-8333-333333333333';
/** An install the plan has finished, ready for installAzure. */
const INSTALLED = {
  subscriptionId: 'sub-1', resourceGroup: 'rg', location: 'uksouth', namePrefix: 'vlens', installId: 'install-1', tags: {}, deployments: [], outputs: {},
  graphRoles: { assigned: [], pending: [] }, publicNetworkAccess: true, workspaceName: 'Analytics Hub',
};
/** The command to run again, however the installer was started. */
const RUN_AGAIN = /run "[^"]+" again/;
const OWNERS_PATH = `Microsoft Entra admin center > Entra ID > App registrations > All applications > "${WEB_APP_NAME}" > Owners > Add owners`;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
/** Escaped for a regular expression. @param {string} s */
const re = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** @type {string[]} */
const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** An install record in a folder of its own, so each test's admin script lands somewhere fresh. */
function recordFile() {
  const dir = mkdtempSync(join(tmpdir(), 'ah-azure-apps-'));
  dirs.push(dir);
  return join(dir, 'valuelens-install.json');
}

/**
 * An Azure install's context against fakes. Selects are recorded and answered by question from `pick`; confirms are
 * recorded and take their default unless `confirm` answers them. `answers` script the inputs in order.
 * With `fresh`, there's no Azure config yet, as on a first plan.
 * @param {{ yes?: boolean, answers?: any[], pick?: Record<string, any>, confirm?: Record<string, boolean>, azure?: any, fresh?: boolean, access?: boolean }} [o]
 */
function azureCtx(o = {}) {
  const arm = fakeArm();
  const graph = fakeAzureGraph({ usersCanRegister: false });
  const powerBi = fakePowerBi();
  powerBi.setDatasources([{ datasourceType: 'Sql', gatewayId: 'gw', datasourceId: 'ds', connectionDetails: { server: 'vlens-sql.database.windows.net', database: 'valuelens' } }]);
  const u = fakeUi({ yes: o.yes, answers: o.answers });
  /** @type {Record<string, { choices: any[], def: any }>} */
  const selects = {};
  /** @type {Record<string, boolean>} */
  const confirms = {};
  u.ui.select = async (message, choices, def) => {
    selects[message] = { choices, def };
    u.asked.push(message);
    return o.pick && message in o.pick ? o.pick[message] : def;
  };
  u.ui.confirm = async (message, def) => {
    u.asked.push(message);
    confirms[message] = def;
    return o.confirm?.[message] ?? def;
  };
  const t = fakeCtx({ ui: u.ui, arm: arm.api, graph: graph.api, fabric: fakeFabric().api, powerBi: powerBi.api });
  delete t.config.fabric.workspaceId;
  t.ctx.configFile = recordFile();
  t.ctx.runFirstLoad = false;
  if (!o.fresh) Object.assign(t.config, { target: 'azure', azure: { ...structuredClone(INSTALLED), ...structuredClone(o.azure ?? {}) } });
  if (o.access) {
    t.config.access = /** @type {any} */ ({ ...t.config.access, groupId: 'group-1', groupName: 'Analytics Hub Viewers' });
    Object.assign(graph.api, { getGroup: async (/** @type {string} */ id) => ({ id, displayName: 'Analytics Hub Viewers' }) });
    Object.assign(powerBi.api, { datasetUsers: async () => [], addDatasetUser: async () => null });
  }
  const script = () => join(dirname(String(t.ctx.configFile)), AZURE_ADMIN_SCRIPT_FILE);
  return { ...t, arm, graph, powerBi, u, selects, confirms, script, az: () => /** @type {any} */ (t.config.azure) };
}

/**
 * The two apps an admin made with the script: owned by the installer's user and not yet finished, each with a
 * service principal unless `sps` is false.
 * @param {{ applications: any[], servicePrincipals: any[] }} graph
 * @param {{ sps?: boolean, webOwner?: string }} [o]
 */
function adminMade(graph, o = {}) {
  graph.applications.push(
    { id: 'web-obj', appId: WEB_ID, displayName: WEB_APP_NAME, owners: [o.webOwner ?? 'user-1'] },
    { id: 'sql-obj', appId: SQL_ID, displayName: SQL_READER_NAME, owners: ['user-1'] },
  );
  if (o.sps !== false) graph.servicePrincipals.push({ id: 'sp-web', appId: WEB_ID }, { id: 'sp-sql', appId: SQL_ID });
}

/** Adopted apps, as the plan records them. */
const ADOPTED = {
  webApp: { clientId: WEB_ID, objectId: 'web-obj', created: false, servicePrincipalId: 'sp-web' },
  sqlReader: { clientId: SQL_ID, objectId: 'sql-obj', created: false, servicePrincipalId: 'sp-sql' },
};

/**
 * Delegated grants as Graph keeps them, behind the installer's own grantOauth2Permission. With `unreadable`, listing
 * them fails, and with `refuse`, writing them fails with 403, as for someone who can't approve them.
 * @param {{ unreadable?: boolean, refuse?: boolean, grants?: { clientId: string, resourceId: string, scope: string }[] }} [o]
 */
function grantStore(o = {}) {
  const grants = (o.grants ?? []).map((g, i) => ({ id: `grant-${i + 1}`, consentType: 'AllPrincipals', ...g }));
  /** @type {string[]} */
  const calls = [];
  const { grantOauth2Permission } = graphApi(/** @type {any} */ ({
    list: async (/** @type {string} */ _p, /** @type {any} */ q) => {
      if (o.unreadable) throw httpError(403, 'Authorization_RequestDenied');
      const [, clientId, resourceId] = /clientId eq '([^']*)' and resourceId eq '([^']*)'/.exec(q.query.$filter) ?? [];
      return grants.filter((g) => g.clientId === clientId && g.resourceId === resourceId);
    },
    post: async (/** @type {string} */ _p, /** @type {any} */ body) => {
      calls.push(`post ${body.resourceId} ${body.scope}`);
      if (o.refuse) throw httpError(403, 'Authorization_RequestDenied');
      const grant = { id: `grant-${grants.length + 1}`, ...body };
      grants.push(grant);
      return grant;
    },
    patch: async (/** @type {string} */ p, /** @type {any} */ body) => {
      calls.push(`patch ${p} ${body.scope}`);
      if (o.refuse) throw httpError(403, 'Authorization_RequestDenied');
      const grant = grants.find((g) => p === `/oauth2PermissionGrants/${g.id}`);
      if (grant) grant.scope = body.scope;
      return {};
    },
  }));
  return { grants, calls, grantOauth2Permission };
}

/** The pending admin actions an install records. @param {any} az @returns {string[]} */
const pending = (az) => az.status?.pendingAdminActions ?? [];
/** The pending actions to make someone an owner of an app. @param {any} az @returns {string[]} */
const ownerActions = (az) => pending(az).filter((a) => a.includes(' as an owner of "'));

/** The value of a select's choices. @param {{ choices: any[] } | undefined} s */
const values = (s) => s?.choices.map((c) => c.value);

// Who can do what

test('App rights: Application Developer can create apps, a Privileged Role Administrator alone cannot', () => {
  const rights = (/** @type {string} */ id) => {
    const r = appRoleRights([{ roleTemplateId: id }]);
    return { consent: !!r.consent, create: !!r.create, delegated: !!r.delegated, manage: !!r.manage };
  };
  assert.deepEqual(rights(APP_DEVELOPER), { consent: false, create: true, delegated: false, manage: false }, 'creates and owns apps, approves nothing');
  assert.deepEqual(rights(PRA), { consent: true, create: false, delegated: true, manage: false }, 'consents, but registers nothing');
  assert.deepEqual(rights(APP_ADMIN), { consent: false, create: true, delegated: true, manage: true });
  assert.deepEqual(rights(CLOUD_APP_ADMIN), { consent: false, create: true, delegated: true, manage: true });
  assert.deepEqual(rights(GA), { consent: true, create: true, delegated: true, manage: true });
  assert.deepEqual(rights('a9ea8996-122f-4c74-9520-8edcd192826c'), { consent: false, create: false, delegated: false, manage: false }, 'Fabric Administrator');
  assert.equal(appRoleRights([{ roleTemplateId: APP_DEVELOPER, displayName: 'Application Developer' }]).create, 'Application Developer', 'named for the rows');
});

// Planning: the "App registrations" step

test('Azure apps plan: with no way to create apps, it offers the apps an admin made or an admin, not creating them', async () => {
  const t = azureCtx();
  await planAzureApps(t.ctx, NONE);
  assert.deepEqual(values(t.selects[WHO]), ['adopt', 'admin']);
  assert.equal(t.selects[WHO].def, 'admin', 'nothing to adopt yet');
  assert.match(t.u.text(), /You can't create app registrations in this tenant\. An Application Administrator or Cloud Application Administrator can create them for you\./);
  assert.equal(t.az().adminScript, t.script(), 'the file is recorded');
  assert.ok(existsSync(t.script()), 'the file is written');
  assert.match(t.u.text(), /Send this file to an Application Administrator or Cloud Application Administrator/);
  assert.deepEqual(t.graph.calls, [], 'nothing changes in Entra');
  // The stop comes after the preflight, so one run lists everything.
  await assert.rejects(azureAppsGate(t.ctx, NONE), (/** @type {Error} */ err) => {
    assert.ok(isResumeLater(err));
    assert.match(err.message, new RegExp(`An admin needs to create the app registrations, so the installer stopped before deploying anything\\. Send ${re(t.script())} to an Application Administrator or Cloud Application Administrator\\.`));
    assert.match(err.message, RUN_AGAIN);
    assert.match(err.message, /the installer finds the apps itself/);
    return true;
  });
});

test("Azure apps plan: someone who can create apps but can't approve the consent is told about the consent link, and offered an admin", async () => {
  const t = azureCtx();
  await planAzureApps(t.ctx, CREATOR);
  assert.deepEqual(values(t.selects[WHO]), ['create', 'adopt', 'admin']);
  assert.equal(t.selects[WHO].def, 'create');
  const create = t.selects[WHO].choices.find((c) => c.value === 'create');
  assert.equal(create.name, 'Create the two apps (recommended)');
  assert.match(create.description, /after the deploy, the installer gives you a consent link to send, and carries on/);
  assert.equal(t.az().adminScript, undefined);
  await azureAppsGate(t.ctx, CREATOR);
  assert.ok(!existsSync(t.script()));
});

test('Azure apps plan: an Application Administrator with nothing to adopt is asked nothing', async () => {
  const t = azureCtx();
  await planAzureApps(t.ctx, APP_ADMINISTRATOR);
  assert.ok(!t.u.asked.includes(WHO));
  assert.doesNotMatch(t.u.text(), /App registrations/);
  await azureAppsGate(t.ctx, APP_ADMINISTRATOR);
  assert.equal(t.az().webApp, undefined, 'created at install time');
});

test('Azure apps plan: apps an admin made for you are the default, and adopting them records them as not created by the installer', async () => {
  const t = azureCtx();
  adminMade(t.graph);
  await planAzureApps(t.ctx, APP_ADMINISTRATOR);
  assert.deepEqual(values(t.selects[WHO]), ['create', 'adopt'], 'no admin needed');
  assert.equal(t.selects[WHO].def, 'adopt');
  assert.match(t.selects[WHO].choices[1].description, /that you own are ready to use/);
  assert.deepEqual(t.az().webApp, ADOPTED.webApp);
  assert.deepEqual(t.az().sqlReader, ADOPTED.sqlReader);
  assert.match(t.u.text(), new RegExp(`Using "${re(WEB_APP_NAME)}" \\(client ID ${WEB_ID}\\), which an admin created`));
  assert.deepEqual(t.graph.calls, []);
});

test('Azure apps plan: with two adoptable apps of a name, you choose which', async () => {
  const which = `Which "${WEB_APP_NAME}"?`;
  const t = azureCtx({ pick: { [which]: OTHER_WEB_ID } });
  adminMade(t.graph);
  t.graph.applications.push({ id: 'web-obj-2', appId: OTHER_WEB_ID, displayName: WEB_APP_NAME, owners: ['user-1'] });
  t.graph.servicePrincipals.push({ id: 'sp-web-2', appId: OTHER_WEB_ID });
  await planAzureApps(t.ctx, NONE);
  assert.equal(t.selects[WHO].def, 'adopt');
  assert.deepEqual(values(t.selects[which]), [WEB_ID, OTHER_WEB_ID, '']);
  assert.equal(t.selects[which].def, WEB_ID);
  assert.equal(t.az().webApp.clientId, OTHER_WEB_ID);
  assert.equal(t.az().sqlReader.clientId, SQL_ID);
});

test('Azure apps plan: recorded apps ask nothing', async () => {
  const t = azureCtx({ azure: ADOPTED });
  adminMade(t.graph);
  await planAzureApps(t.ctx, NONE);
  assert.ok(!t.u.asked.includes(WHO));
  const section = azureCtx({ azure: ADOPTED });
  await planAzureApps(section.ctx, NONE, 'identity');
  assert.ok(!section.u.asked.includes(WHO));
  assert.match(section.u.text(), new RegExp(`Using ${re(WEB_APP_NAME)} \\(${WEB_ID}\\), which an admin created`));
});

// --yes

test('Azure apps --yes: with no way to create apps, the plan writes the admin file and stops after the preflight, before anything changes', async () => {
  const t = azureCtx({ yes: true, fresh: true });
  await assert.rejects(planAzure(t.ctx, NONE), (/** @type {Error} */ err) => {
    assert.ok(isResumeLater(err), err.message);
    assert.match(err.message, /so the installer stopped before deploying anything/);
    assert.ok(err.message.includes(t.script()), 'names the file');
    assert.match(err.message, RUN_AGAIN);
    return true;
  });
  assert.match(t.u.text(), /Checking Azure/, 'the preflight ran first, so one run lists everything');
  assert.ok(existsSync(t.script()));
  assert.equal(t.az().adminScript, t.script());
  for (const call of ['ensureResourceGroup', 'deployTemplate', 'validateDeployment', 'whatIfDeployment']) {
    assert.ok(!t.arm.calls.some((c) => c.startsWith(call)), `no ${call}`);
  }
  assert.deepEqual(t.graph.calls, [], 'no Graph writes');
  assert.ok(t.saves() > 0, 'the record is saved before the stop');
});

test('Azure apps --yes: exactly one unfinished app of each name that you own is adopted; finished ones and ones you do not own are left', async () => {
  const t = azureCtx({ yes: true, fresh: true });
  adminMade(t.graph);
  t.graph.applications.push(
    { id: 'done', appId: OTHER_WEB_ID, displayName: WEB_APP_NAME, owners: ['user-1'], spa: { redirectUris: ['https://other.example.com/'] } },
    { id: 'theirs', appId: '44444444-4444-4444-8444-444444444444', displayName: WEB_APP_NAME, owners: ['user-2'] },
    { id: 'near', appId: '55555555-5555-4555-8555-555555555555', displayName: `${WEB_APP_NAME} (old)`, owners: ['user-1'] },
  );
  await planAzure(t.ctx, NONE);
  assert.deepEqual(t.az().webApp, ADOPTED.webApp);
  assert.deepEqual(t.az().sqlReader, ADOPTED.sqlReader);
  assert.equal(t.az().adminScript, undefined);
  assert.ok(!existsSync(t.script()), 'no admin needed');
  assert.deepEqual(t.graph.calls, []);
});

test('Azure apps --yes: two unfinished apps of a name stop the plan and list both client IDs', async () => {
  const t = azureCtx({ yes: true, fresh: true });
  adminMade(t.graph);
  t.graph.applications.push({ id: 'web-obj-2', appId: OTHER_WEB_ID, displayName: WEB_APP_NAME, owners: ['user-1'] });
  await assert.rejects(planAzure(t.ctx, CREATOR), (/** @type {Error} */ err) => {
    assert.ok(!isResumeLater(err), 'a choice is needed, not an admin');
    assert.match(err.message, new RegExp(`You own more than one unfinished app registration called "${re(WEB_APP_NAME)}" \\(${WEB_ID}, ${OTHER_WEB_ID}\\), so the installer can't tell which to use\\.`));
    assert.match(err.message, /Run the installer without --yes to choose one, or to enter the client IDs\./);
    return true;
  });
  assert.equal(t.az().webApp, undefined);
  assert.equal(t.az().sqlReader?.clientId, SQL_ID, 'the other app is still adopted');
  assert.ok(!t.arm.calls.some((c) => c.startsWith('ensureResourceGroup') || c.startsWith('deployTemplate')));
  assert.deepEqual(t.graph.calls, []);
});

test('Azure apps --yes: someone who can create apps creates them at install time, without an admin file', async () => {
  const t = azureCtx({ yes: true, fresh: true });
  await planAzure(t.ctx, CREATOR);
  assert.equal(t.az().adminScript, undefined);
  assert.ok(!existsSync(t.script()));
  assert.equal(t.az().webApp, undefined);
});

// Waiting for the admin's script

test('Azure apps: a re-run while the admin script is still waiting stops again, with the file written again', async () => {
  const old = azureCtx({ azure: { adminScript: 'C:\\old\\analytics-hub-azure-admin-script.md' } });
  await planAzureApps(old.ctx, NONE);
  const admin = old.selects[WHO].choices.find((c) => c.value === 'admin');
  assert.equal(old.selects[WHO].def, 'admin');
  assert.match(admin.description, /Still waiting for an admin to run the script in C:\\old\\analytics-hub-azure-admin-script\.md\. The installer writes it again, and stops before it deploys anything\./);
  await assert.rejects(azureAppsGate(old.ctx, NONE), (/** @type {Error} */ err) => {
    assert.ok(isResumeLater(err));
    assert.match(err.message, /Still waiting for an admin to create the app registrations with the script in .*, so the installer stopped again before deploying anything\./);
    return true;
  });
  assert.equal(old.az().adminScript, old.script(), 'the file is written next to this record');
  assert.ok(existsSync(old.script()));

  const yes = azureCtx({ yes: true, azure: { adminScript: 'C:\\old\\analytics-hub-azure-admin-script.md' } });
  await planAzureApps(yes.ctx, NONE);
  await assert.rejects(azureAppsGate(yes.ctx, NONE), /Still waiting for an admin/);
  assert.ok(existsSync(yes.script()));

  // Even someone who could create the apps waits for the admin they chose, under --yes.
  const creator = azureCtx({ yes: true, azure: { adminScript: 'C:\\old\\analytics-hub-azure-admin-script.md' } });
  await assert.rejects(azureAppsGate(creator.ctx, CREATOR), /Still waiting for an admin/);
});

test("Azure apps: once the admin has run the script, a re-run finds the apps itself and doesn't ask", async () => {
  for (const yes of [false, true]) {
    const t = azureCtx({ yes, azure: { adminScript: 'C:\\old\\analytics-hub-azure-admin-script.md' } });
    adminMade(t.graph);
    await planAzureApps(t.ctx, NONE);
    await azureAppsGate(t.ctx, NONE);
    assert.ok(!t.u.asked.includes(WHO), `yes=${yes}: nothing to ask`);
    assert.deepEqual(t.az().webApp, ADOPTED.webApp);
    assert.deepEqual(t.az().sqlReader, ADOPTED.sqlReader);
    assert.equal(t.az().adminScript, undefined, `yes=${yes}: no longer waiting`);
  }
});

test('Azure apps: choosing to create the apps after all stops waiting for the admin', async () => {
  const t = azureCtx({ azure: { adminScript: 'C:\\old\\analytics-hub-azure-admin-script.md' }, pick: { [WHO]: 'create' } });
  await planAzureApps(t.ctx, CREATOR);
  assert.deepEqual(values(t.selects[WHO]), ['create', 'adopt', 'admin']);
  assert.equal(t.selects[WHO].def, 'admin', 'still the admin, as chosen before');
  assert.equal(t.az().adminScript, undefined);
  await azureAppsGate(t.ctx, CREATOR);
});

test('Azure status: says the install is waiting for the admin script, and where it is', async () => {
  const t = azureCtx({ fresh: true });
  t.config.azure = /** @type {any} */ ({ adminScript: 'C:\\records\\analytics-hub-azure-admin-script.md' });
  await azureStatus(t.ctx);
  assert.match(t.u.text(), /Nothing is installed yet\. Waiting for an admin to create the app registrations with the script in C:\\records\\analytics-hub-azure-admin-script\.md\. Once they've run it, run "[^"]+" again\./);
  const done = azureCtx({ fresh: true });
  done.config.azure = /** @type {any} */ ({ adminScript: 'C:\\records\\x.md', ...ADOPTED });
  await azureStatus(done.ctx);
  assert.doesNotMatch(done.u.text(), /Waiting for an admin/);
});

// Adopting by client ID

test("Azure apps by ID: an app you don't own stops the plan, naming who adds you as an owner, and where", async () => {
  const t = azureCtx({ answers: [WEB_ID] });
  adminMade(t.graph, { webOwner: 'user-2' });
  await assert.rejects(planAzureApps(t.ctx, NONE), (/** @type {Error} */ err) => {
    assert.ok(isResumeLater(err));
    assert.equal(
      err.message.replace(RUN_AGAIN, 'run X again'),
      `You don't own "${WEB_APP_NAME}" (client ID ${WEB_ID}), so the installer can't finish it for you. An Application Administrator or Cloud Application Administrator adds you as an owner: ${OWNERS_PATH}. Then run X again.`,
    );
    return true;
  });
  assert.equal(t.selects[WHO].def, 'adopt', 'the SQL reader is adoptable');
  assert.ok(t.u.asked.includes(`Client ID of "${WEB_APP_NAME}"`));
  assert.equal(t.az().webApp, undefined);
  assert.ok(t.saves() > 0);
});

test("Azure apps by ID: an Application Administrator can use an app they don't own", async () => {
  const t = azureCtx({ answers: [WEB_ID], pick: { [WHO]: 'adopt' } });
  adminMade(t.graph, { webOwner: 'user-2' });
  await planAzureApps(t.ctx, APP_ADMINISTRATOR, 'identity');
  assert.deepEqual(t.az().webApp, ADOPTED.webApp);
  assert.deepEqual(t.az().sqlReader, ADOPTED.sqlReader);
});

test('Azure apps by ID: a finished app warns that another install may use it, and the confirm defaults to No', async () => {
  const t = azureCtx({ answers: [WEB_ID, 'not-a-guid'] });
  adminMade(t.graph);
  t.graph.applications[0].spa = { redirectUris: ['https://other.example.com/'] };
  await assert.rejects(planAzureApps(t.ctx, NONE), new RegExp(`Client ID of "${re(WEB_APP_NAME)}": Enter its Application \\(client\\) ID, a GUID\\.`), 'asked again');
  assert.equal(t.confirms['Use it anyway?'], false);
  assert.match(t.u.text(), new RegExp(`"${re(WEB_APP_NAME)}" \\(client ID ${WEB_ID}\\) already has redirect URIs, so another install may use it\\. Finishing it for this install replaces its redirect URIs and identifier URI, and sign-in to the other install stops working\\.`));
  assert.equal(t.az().webApp, undefined);

  const sure = azureCtx({ answers: [WEB_ID], confirm: { 'Use it anyway?': true } });
  adminMade(sure.graph);
  sure.graph.applications[0].spa = { redirectUris: ['https://other.example.com/'] };
  await planAzureApps(sure.ctx, NONE);
  assert.deepEqual(sure.az().webApp, ADOPTED.webApp);

  const secret = azureCtx({ answers: [SQL_ID, 'not-a-guid'], pick: { [WHO]: 'adopt' } });
  adminMade(secret.graph);
  secret.graph.applications.splice(1, 1, { id: 'sql-obj', appId: SQL_ID, displayName: SQL_READER_NAME, owners: ['user-1'], passwordCredentials: [{ keyId: 'k' }] });
  await assert.rejects(planAzureApps(secret.ctx, NONE), /a GUID/);
  assert.match(secret.u.text(), /already has a client secret, so another install may use it\. Finishing it for this install adds a client secret\./);
});

test("Azure apps by ID: the other app's client ID, or one that isn't there, is asked for again", async () => {
  const t = azureCtx({ answers: [SQL_ID, OTHER_WEB_ID, 'not-a-guid'] });
  t.graph.applications.push({ id: 'sql-obj', appId: SQL_ID, displayName: SQL_READER_NAME, owners: ['user-1'] });
  t.graph.servicePrincipals.push({ id: 'sp-sql', appId: SQL_ID });
  await assert.rejects(planAzureApps(t.ctx, NONE), /a GUID/);
  assert.match(t.u.text(), new RegExp(`That's the client ID of "${re(SQL_READER_NAME)}"\\. Enter the client ID of "${re(WEB_APP_NAME)}"\\.`));
  assert.match(t.u.text(), new RegExp(`No app registration with client ID ${OTHER_WEB_ID} in this tenant, or you can't read it\\.`));
});

// Service principals

test("Azure apps: an adopted app with no service principal stops the plan when you can't create one", async () => {
  const t = azureCtx();
  adminMade(t.graph, { sps: false });
  await assert.rejects(planAzureApps(t.ctx, NONE), (/** @type {Error} */ err) => {
    assert.ok(isResumeLater(err));
    assert.equal(
      err.message.replace(RUN_AGAIN, 'run X again'),
      `"${WEB_APP_NAME}" (client ID ${WEB_ID}) has no service principal, and you can't create one. An Application Administrator or Cloud Application Administrator runs "az ad sp create --id ${WEB_ID}" in Azure Cloud Shell. Then run X again.`,
    );
    return true;
  });
  assert.deepEqual(t.graph.calls, []);
});

test('Azure apps: an adopted app with no service principal gets one in the first install step when you can create it', async () => {
  const t = azureCtx();
  adminMade(t.graph, { sps: false });
  await planAzureApps(t.ctx, CREATOR);
  assert.equal(t.az().webApp.created, false);
  assert.equal(await installAzure(t.ctx, { wait: true }), true);
  assert.ok(t.graph.calls.includes(`createServicePrincipal ${WEB_ID}`));
  assert.ok(t.graph.calls.includes(`createServicePrincipal ${SQL_ID}`));
  assert.ok(t.graph.calls.indexOf(`createServicePrincipal ${WEB_ID}`) < t.graph.calls.findIndex((c) => c.startsWith('updateAzureWebApplication')));
  assert.ok(!t.graph.calls.some((c) => c.startsWith('createAzureWebApplication') || c.startsWith('createApplication')), 'no new apps');
  assert.equal(t.az().webApp.servicePrincipalId, `sp-${WEB_ID}`);
  assert.equal(t.az().webApp.created, false);
});

// Installing: create before the deploy, finish after

test('Azure install: Entra applications come first, and their settings follow the Azure resources', async () => {
  const t = azureCtx();
  assert.equal(await installAzure(t.ctx, { wait: true }), true);
  const text = t.u.text();
  assert.match(text, /\[1\/\d+\] Entra applications/);
  assert.match(text, /\[2\/\d+\] Resource group/);
  const resources = text.search(/\[\d+\/\d+\] Azure resources/);
  const settings = text.search(/\[\d+\/\d+\] Entra application settings/);
  assert.ok(resources > 0 && settings > resources, 'settings after the deploy');
  const calls = t.graph.calls;
  assert.ok(calls.indexOf(`createAzureWebApplication ${WEB_APP_NAME}`) < calls.indexOf(`createApplication ${SQL_READER_NAME}`));
  assert.ok(t.arm.calls.findIndex((c) => c.startsWith('ensureResourceGroup')) >= 0);
  assert.equal(t.graph.webAppBodies[0].spa, undefined, 'no redirect URIs before the web app exists');
  assert.equal(t.graph.webAppBodies[0].identifierUris, undefined);
  assert.ok(calls.includes('updateAzureWebApplication vlens.example.com'));
  assert.equal(t.az().webApp.created, true);
  assert.equal(t.az().sqlReader.created, true);
});

test('Azure install: a 403 creating the apps writes the admin file and stops before the resource group or the deploy', async () => {
  const t = azureCtx();
  t.graph.failures.createApplication = [httpError(403, 'Insufficient privileges to complete the operation.')];
  await assert.rejects(installAzure(t.ctx, { wait: true }), (/** @type {Error} */ err) => {
    assert.ok(isResumeLater(err), err.message);
    assert.match(err.message, /^Entra didn't let you create the app registrations \(.*Insufficient privileges.*\), so the installer stopped before deploying anything\./);
    assert.ok(err.message.includes(`Send ${t.script()} to an Application Administrator or Cloud Application Administrator.`));
    assert.match(err.message, RUN_AGAIN);
    return true;
  });
  assert.ok(existsSync(t.script()));
  assert.equal(t.az().adminScript, t.script());
  assert.ok(!t.arm.calls.some((c) => c.startsWith('ensureResourceGroup') || c.startsWith('deployTemplate')), t.arm.calls.join('\n'));
  const web = t.graph.applications.find((a) => a.displayName === WEB_APP_NAME);
  assert.equal(t.az().webApp.created, true, 'the app made before the 403 is still the installer\'s to delete');
  assert.equal(t.az().webApp.clientId, web.appId);
  assert.equal(t.az().sqlReader?.clientId, undefined);
  // The admin's script finishes what was started: it reuses the recorded web app.
  assert.ok(readFileSync(t.script(), 'utf8').includes(`WEB_APP=$(find_app '${web.appId}' '${WEB_APP_NAME}'`));

  const first = azureCtx();
  first.graph.failures.createAzureWebApplication = [httpError(401, 'Unauthorized')];
  await assert.rejects(installAzure(first.ctx, { wait: true }), (/** @type {Error} */ err) => isResumeLater(err));
  assert.equal(first.az().webApp?.clientId, undefined);
  assert.deepEqual(first.arm.calls.filter((c) => /^(ensureResourceGroup|deployTemplate)/.test(c)), []);
});

test('Azure install: other errors creating the apps are not mistaken for a refusal', async () => {
  const t = azureCtx();
  t.graph.failures.createApplication = [httpError(500, 'Internal error')];
  await assert.rejects(installAzure(t.ctx, { wait: true }), (/** @type {Error} */ err) => !isResumeLater(err) && /Internal error/.test(err.message));
  assert.ok(!existsSync(t.script()));
});

test('Azure install: adopted apps are finished after the deploy: redirect URIs, the federated credential, the grants and the Admin role', async () => {
  const t = azureCtx({ azure: ADOPTED });
  adminMade(t.graph);
  assert.equal(await installAzure(t.ctx, { wait: true }), true);
  const calls = t.graph.calls;
  assert.ok(!calls.some((c) => /^(createAzureWebApplication|createApplication|createServicePrincipal)/.test(c)), calls.join('\n'));
  assert.ok(calls.includes('updateAzureWebApplication vlens.example.com'));
  assert.ok(calls.some((c) => c.startsWith('fic web-obj ')));
  assert.ok(calls.includes('oauth Dataset.Read.All'));
  assert.ok(calls.includes('oauth User.Read'));
  assert.ok(calls.includes('assign user-1 role-admin'));
  assert.ok(calls.some((c) => c.startsWith('addPassword')), 'the SQL reader gets its secret after the deploy');
  const deploy = t.arm.calls.findIndex((c) => c.startsWith('deployTemplate'));
  assert.ok(deploy >= 0);
  assert.equal(t.az().webApp.created, false);
  assert.equal(t.az().sqlReader.created, false);
  assert.match(t.u.text(), new RegExp(`Using "${re(WEB_APP_NAME)}" \\(client ID ${WEB_ID}\\), which an admin created`));
});

test('Azure install: an adopted app that has gone is dropped from the record, and the plan asks again', async () => {
  const t = azureCtx({ azure: ADOPTED });
  await assert.rejects(installAzure(t.ctx, { wait: true }), (/** @type {Error} */ err) => {
    assert.match(err.message, new RegExp(`Couldn't find "${re(WEB_APP_NAME)}" \\(client ID ${WEB_ID}\\), which an admin created for this install\\.`));
    return true;
  });
  assert.equal(t.az().webApp, undefined);
  assert.ok(!t.arm.calls.some((c) => c.startsWith('deployTemplate')));
});

for (const step of /** @type {const} */ (['updateAzureWebApplication', 'addFederatedIdentityCredential'])) {
  test(`Azure install: a 403 on ${step} after the deploy stops with the owner step, recorded as a pending admin action`, async () => {
    const t = azureCtx({ azure: ADOPTED });
    adminMade(t.graph);
    t.graph.failures[step] = [httpError(403, 'Insufficient privileges to complete the operation.')];
    await assert.rejects(installAzure(t.ctx, { wait: true }), (/** @type {Error} */ err) => {
      assert.ok(isResumeLater(err), err.message);
      assert.match(err.message, new RegExp(`^Entra didn't let you finish "${re(WEB_APP_NAME)}" \\(.*\\), so people can't sign in to the web app yet\\.`));
      assert.ok(err.message.includes(`An Application Administrator or Cloud Application Administrator adds admin@contoso.com as an owner of "${WEB_APP_NAME}" (client ID ${WEB_ID}): ${OWNERS_PATH}.`));
      assert.match(err.message, RUN_AGAIN);
      return true;
    });
    assert.ok(t.arm.calls.some((c) => c.startsWith('deployTemplate')), 'after the deploy');
    assert.deepEqual(ownerActions(t.az()), [`An Application Administrator or Cloud Application Administrator adds admin@contoso.com as an owner of "${WEB_APP_NAME}" (client ID ${WEB_ID}): ${OWNERS_PATH}`]);
    // Once they've added the owner, a re-run finishes the app and clears the action.
    assert.equal(await installAzure(t.ctx, { wait: true }), true);
    assert.deepEqual(ownerActions(t.az()), []);
  });
}

// Grants

test('Azure install: grants an admin already made are neither written again nor reported as pending', async () => {
  const t = azureCtx({ azure: ADOPTED });
  adminMade(t.graph);
  const store = grantStore({ refuse: true, grants: [
    { clientId: 'sp-web', resourceId: 'pbi-sp', scope: 'Dataset.Read.All' },
    { clientId: 'sp-web', resourceId: 'graph-sp', scope: 'User.Read' },
  ] });
  Object.assign(t.graph.api, { grantOauth2Permission: store.grantOauth2Permission });
  assert.equal(await installAzure(t.ctx, { wait: true }), true);
  assert.deepEqual(store.calls, [], 'nothing written');
  assert.ok(!pending(t.az()).some((a) => a.startsWith('Grant delegated consent')));
  assert.doesNotMatch(t.u.text(), /Couldn't grant delegated admin consent|Couldn't check whether an admin/);
});

test("Azure install: when the grants can't be read and can't be written, it says it couldn't check, and records nothing as pending", async () => {
  const t = azureCtx({ azure: ADOPTED });
  adminMade(t.graph);
  const store = grantStore({ unreadable: true, refuse: true });
  Object.assign(t.graph.api, { grantOauth2Permission: store.grantOauth2Permission });
  assert.equal(await installAzure(t.ctx, { wait: true }), true);
  assert.match(t.u.text(), /Couldn't check whether an admin has already approved the web app's delegated permissions, and couldn't approve them yourself/);
  assert.match(t.u.text(), new RegExp(`Check Microsoft Entra admin center > Entra ID > Enterprise apps > "${re(WEB_APP_NAME)}" > Permissions\\.`));
  assert.doesNotMatch(t.u.text(), /Couldn't grant delegated admin consent/);
  assert.ok(!pending(t.az()).some((a) => a.startsWith('Grant delegated consent')), pending(t.az()).join('\n'));
});

test("Azure install: when the grants can be read but can't be written, the consent link is given and the action recorded, as before", async () => {
  const t = azureCtx({ azure: ADOPTED });
  adminMade(t.graph);
  const store = grantStore({ refuse: true });
  Object.assign(t.graph.api, { grantOauth2Permission: store.grantOauth2Permission });
  assert.equal(await installAzure(t.ctx, { wait: true }), true);
  assert.match(t.u.text(), /Couldn't grant delegated admin consent \(.*\)\. Send this to an admin: https:\/\//);
  assert.ok(pending(t.az()).some((a) => a.startsWith('Grant delegated consent on ')));
  assert.ok(t.graph.calls.includes('assign user-1 role-admin'), 'carries on');
});

test("Azure install: the Admin role's note covers organisations that block the Entra admin center", async () => {
  const t = azureCtx({ azure: ADOPTED });
  adminMade(t.graph);
  assert.equal(await installAzure(t.ctx, { wait: true }), true);
  assert.match(t.u.text(), /Gave admin@contoso\.com the Analytics Hub Admin role\. Assign other users or groups at https:\/\/\S+/);
  assert.match(t.u.text(), /If your organisation blocks the Entra admin center for non-admins and the link doesn't open, ask an Application Administrator to assign them\./);
});

// The web app's registration body, shared by the installer and the admin script

test("Azure web app body: redirect URIs only with the web app's address, and never an identifier URI", async () => {
  const graph = fakeAzureGraph();
  const t = azureCtx();
  const scopes = await webAppScopes(t.ctx.api, t.config);
  const without = azureWebApplicationBody({ displayName: WEB_APP_NAME, ...scopes.registration });
  assert.equal(without.spa, undefined);
  assert.equal(/** @type {any} */ (without).identifierUris, undefined);
  const withFqdn = azureWebApplicationBody({ displayName: WEB_APP_NAME, ...scopes.registration, fqdn: 'vlens.example.com' });
  assert.deepEqual(withFqdn.spa?.redirectUris, ['https://vlens.example.com/', 'https://vlens.example.com/?host=teams&auth=popup']);
  assert.equal(/** @type {any} */ (withFqdn).identifierUris, undefined);
});

// The admin script

/** The JSON a script variable holds. @param {string[]} lines @param {string} name */
function scriptJson(lines, name) {
  const line = lines.find((l) => l.startsWith(`  ${name}='`));
  assert.ok(line, `${name} is set`);
  return JSON.parse(line.slice(`  ${name}=`.length).replace(/^'|'$/g, '').replace(/'\\''/g, "'"));
}

/** A value with its random IDs made comparable. @param {any} v */
const comparable = (v) => JSON.parse(JSON.stringify(v).replace(UUID, 'uuid'));

/** The script's commands, without its comments. @param {string[]} lines */
const commands = (lines) => lines.filter((l) => !/^\s*#/.test(l)).map((l) => l.replace(/\s+#.*$/, '')).join('\n');

/** @param {{ access?: boolean, azure?: any }} [o] */
async function adminScript(o = {}) {
  const t = azureCtx({ access: o.access, azure: o.azure });
  const scopes = await webAppScopes(t.ctx.api, t.config);
  return { t, scopes, lines: azureAdminScript(t.ctx, scopes) };
}

test('Azure admin script: creates both apps and both service principals, and makes the runner an owner of the apps and the web service principal', async () => {
  const { lines } = await adminScript();
  const code = commands(lines);
  assert.match(code, new RegExp(`WEB_APP=\\$\\(find_app '' '${re(WEB_APP_NAME)}' '\\[\\?!spa\\.redirectUris\\]\\.appId'\\)`));
  assert.match(code, new RegExp(`SQL_APP=\\$\\(find_app '' '${re(SQL_READER_NAME)}' '\\[\\?!passwordCredentials\\]\\.appId'\\)`));
  assert.ok(lines.includes('    WEB_APP=$(az rest -m POST -u "$G/applications" -b "$WEB_BODY" --query appId -o tsv)'));
  assert.ok(lines.includes('    SQL_APP=$(az rest -m POST -u "$G/applications" -b "$SQL_BODY" --query appId -o tsv)'));
  assert.ok(lines.includes('  own_app "$WEB_APP"'));
  assert.ok(lines.includes('  own_app "$SQL_APP"'));
  assert.ok(lines.includes('  WEB_SP=$(sp_of "$WEB_APP")'));
  assert.ok(lines.includes('  sp_of "$SQL_APP" >/dev/null'));
  assert.match(code, /-m POST -u "\$G\/servicePrincipals\/\$WEB_SP\/owners\/\\\$ref" -b "\{\\"@odata\.id\\":\\"\$G\/directoryObjects\/\$RUNNER\\"\}"/);
  assert.ok(lines.includes('  RUNNER=user-1  # admin@contoso.com'), "the runner's object ID, with their UPN in a comment");
  assert.ok(lines.includes('  set -euo pipefail'));
  assert.equal(lines.at(-1), 'analytics_hub_apps');
  assert.ok(lines.includes(`  echo "${WEB_APP_NAME} client ID: $WEB_APP"`));
  assert.ok(lines.includes(`  echo "${SQL_READER_NAME} client ID: $SQL_APP"`));
});

test("Azure admin script: approves the web app's delegated permissions, with the viewer group's scopes only when access is on", async () => {
  const off = await adminScript();
  assert.ok(off.lines.includes("  grant 'pbi-sp' 'Dataset.Read.All'  # Power BI"));
  assert.ok(off.lines.includes("  grant 'graph-sp' 'User.Read'  # Microsoft Graph"));
  const on = await adminScript({ access: true });
  assert.ok(on.lines.includes("  grant 'pbi-sp' 'Dataset.Read.All'  # Power BI"));
  assert.ok(on.lines.includes("  grant 'graph-sp' 'User.Read GroupMember.ReadWrite.All User.ReadBasic.All'  # Microsoft Graph"));
  assert.equal(on.lines.filter((l) => l.startsWith('  grant ')).length, 2, 'one grant per resource');
});

test('Azure admin script: makes no secrets, and adds nothing that needs the deployed web app or a Privileged Role Administrator', async () => {
  const { lines } = await adminScript({ access: true });
  const code = commands(lines);
  assert.doesNotMatch(code, /addPassword|secretText|credential reset|az ad app credential|keyCredentials/i, 'no secrets or certificates');
  assert.doesNotMatch(code, /identifierUris|identifier-uris/, 'no identifier URI');
  assert.deepEqual(code.split('\n').filter((l) => /redirectUris|redirect-uris/.test(l)), [`  WEB_APP=$(find_app '' '${WEB_APP_NAME}' '[?!spa.redirectUris].appId')`], 'redirect URIs are only read, to skip finished apps');
  assert.doesNotMatch(code, /federatedIdentityCredentials|federated-credential/i, 'no federated credential');
  assert.doesNotMatch(code, /appRoleAssign|AuditLogsQuery|Reports\.Read\.All|az role assignment/, "no app roles, and nothing for the managed identity");
  assert.doesNotMatch(code, /az ad app update|-m PATCH -u "\$G\/applications/, 'apps are only created, never changed');
  assert.doesNotMatch(code, /mktemp|\/tmp\b|@[\w./-]+\.json/, 'no temporary files');
  const web = scriptJson(lines, 'WEB_BODY');
  const sql = scriptJson(lines, 'SQL_BODY');
  for (const body of [web, sql]) {
    for (const key of ['passwordCredentials', 'keyCredentials', 'identifierUris', 'spa', 'web']) assert.equal(body[key], undefined, key);
  }
});

test('Azure admin script: can be run again: it looks before it creates or adds anything', async () => {
  const { lines } = await adminScript();
  const at = (/** @type {string} */ s) => {
    const i = lines.findIndex((l) => l.includes(s));
    assert.ok(i >= 0, s);
    return i;
  };
  assert.ok(at('WEB_APP=$(find_app') < at('if [ -z "$WEB_APP" ]; then') && at('if [ -z "$WEB_APP" ]; then') < at('-b "$WEB_BODY"'), 'an app it made before is reused');
  assert.ok(at('SQL_APP=$(find_app') < at('if [ -z "$SQL_APP" ]; then') && at('if [ -z "$SQL_APP" ]; then') < at('-b "$SQL_BODY"'));
  assert.ok(at('owner list --id "$1"') < at('az ad app owner add'), 'owners are checked first');
  assert.ok(at('az ad sp list --filter') < at('az ad sp create'), 'service principals are checked first');
  assert.ok(at('owners?\\$select=id') < at('owners/\\$ref'), "the web app's service principal's owners are checked first");
  assert.ok(at('-m GET -u "$G/oauth2PermissionGrants') < at('-m POST -u "$G/oauth2PermissionGrants"'), 'grants are read first, as a second POST fails');
  assert.ok(at('if [ -n "$add" ]; then') < at('-m PATCH -u "$G/oauth2PermissionGrants/$gid"'), 'only missing scopes are added');
  assert.match(commands(lines), /owned=\$\(az ad app owner list --id "\$id" --query "\[\?id=='\$RUNNER'\]\.id" -o tsv\)/, "only apps the runner owns are reused by name");
});

test("Azure admin script: prefers the apps the install recorded, so it finishes what the installer started", async () => {
  const { lines } = await adminScript({ azure: { webApp: { clientId: WEB_ID, objectId: 'web-obj', created: true } } });
  assert.ok(lines.includes(`  WEB_APP=$(find_app '${WEB_ID}' '${WEB_APP_NAME}' '[?!spa.redirectUris].appId')`));
  assert.ok(lines.includes(`  SQL_APP=$(find_app '' '${SQL_READER_NAME}' '[?!passwordCredentials].appId')`));
});

test("Azure admin script: the apps' bodies are the installer's own, from the shared builders", async () => {
  for (const access of [false, true]) {
    const { lines, scopes } = await adminScript({ access });
    assert.deepEqual(comparable(scriptJson(lines, 'WEB_BODY')), comparable(azureWebApplicationBody({ displayName: WEB_APP_NAME, ...scopes.registration })), `access=${access}`);
    assert.deepEqual(scriptJson(lines, 'SQL_BODY'), applicationBody(SQL_READER_NAME, []));
  }
});

test('Azure admin file: says who runs it, what it changes and what it does not, with the script and no portal steps', async () => {
  const t = azureCtx({ access: true });
  await planAzureApps(t.ctx, NONE);
  const md = readFileSync(t.script(), 'utf8');
  for (const heading of ['# Analytics Hub: create the two Azure app registrations', '## Who runs it', '## What it changes', "## What it doesn't change", '## Run it', '## What happens next']) {
    assert.ok(md.includes(`\n${heading}\n`) || md.startsWith(`${heading}\n`), heading);
  }
  assert.match(md, /An Application Administrator or Cloud Application Administrator\. A Global Administrator can too\. A Privileged\nRole Administrator alone can't/);
  assert.match(md, /Microsoft Graph User\.Read, GroupMember\.ReadWrite\.All, User\.ReadBasic\.All/);
  assert.match(md, /It makes no client secrets or certificates\./);
  assert.match(md, /a Privileged Role Administrator or\n {2}Global Administrator gives the jobs' managed identity its Microsoft Graph roles/);
  assert.match(md, /https:\/\/shell\.azure\.com/);
  assert.match(md, /```bash\n# Creates the two Azure app registrations for Analytics Hub, for admin@contoso\.com/);
  assert.match(md, /the installer finds the apps itself|it finds the two apps itself/);
  assert.doesNotMatch(md, /admin center >|portal\.azure\.com|entra\.microsoft\.com/, 'no portal steps');
  assert.doesNotMatch(md, /secret-\d|secretText/);
});

test('Azure admin script: Bash accepts it', async (t) => {
  const probe = spawnSync('bash', ['-c', 'echo ok'], { encoding: 'utf8' });
  if (probe.error || probe.stdout !== 'ok\n') {
    t.skip('bash is not on the PATH');
    return;
  }
  for (const access of [false, true]) {
    const { lines } = await adminScript({ access, azure: { webApp: { clientId: WEB_ID, objectId: 'web-obj', created: true } } });
    const r = spawnSync('bash', ['-n'], { input: `${lines.join('\n')}\n`, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  }
});
