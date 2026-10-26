// @ts-check
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { armApi, ROLES } from '../src/clients/azure.js';
import { FABRIC_ADMIN_ROLE, graphApi, INSIGHTS_ANALYST_ROLE, POWER_BI_APP_ID } from '../src/clients/graph.js';
import { GRAPH_APP_ID } from '../src/catalog.js';
import { emptyConfig, loadConfig, saveConfig } from '../src/config.js';
import { HttpError } from '../src/http.js';
import { createCtx, install } from '../src/install.js';
import { commandLine } from '../src/launch.js';
import { readFile } from 'node:fs/promises';
import { canAssignDirectoryRoles, checkPrereqs, dataPolicyPrereq, preflightVerdict, reportFlowPrereqs, reportPreflight, settingsToConfirm } from '../src/prereqs.js';
import { planAzureConsumption } from '../src/steps/azure/index.js';
import { dataPolicyAsk, FLOW_ENVIRONMENT_HINT, flowsWanted, INVENTORY_SIGNER, planFlows, PP_API_SIGNER, ppApiFlows, PREMIUM_OWNER } from '../src/steps/flows.js';
import { preflight } from '../src/steps/plan.js';
import { fakeArm, fakeAzureGraph, fakeCtx, fakeFabric, fakePowerBi, fakeUi, httpError, realSources } from './fakes.js';

const GA = '62e90394-69f5-4237-9190-012177145e10';
const USER = /** @type {any} */ ({ id: 'user-1', upn: 'admin@contoso.com', tenantId: 't-1' });
const ALL = [{ actions: ['*'], notActions: [] }];
const READ = [{ actions: ['*/read'], notActions: [] }];
const CREATE = [{ actions: ['Microsoft.Resources/*'], notActions: [] }];
const assignment = (/** @type {string} */ role, principalId = USER.id) => ({ properties: { roleDefinitionId: `/subscriptions/x/providers/Microsoft.Authorization/roleDefinitions/${role}`, principalId } });

/**
 * Read-only APIs with everything a user could have, to take away test by test.
 * @param {any} [over]
 */
function fakeApis(over = {}) {
  /** @type {Record<string, any[]>} */
  const perms = { '/subscriptions/sub-1': ALL, ...(over.perms ?? {}) };
  return /** @type {any} */ ({
    graph: {
      myDirectoryRoles: async () => over.roles ?? [{ roleTemplateId: GA, displayName: 'Global Administrator' }, { roleTemplateId: FABRIC_ADMIN_ROLE, displayName: 'Fabric Administrator' }],
      myEligibleRoles: over.eligible ?? (async () => []),
      myGroupIds: async () => over.myGroups ?? ['group-1'],
      myDirectGroupIds: async () => over.directGroups ?? ['group-1'],
      myLicenseDetails: async () => over.licences ?? [{ servicePlans: [{ servicePlanName: 'BI_AZURE_P2', provisioningStatus: 'Success' }] }],
      subscribedSkus: over.skusFn ?? (async () => over.skus ?? []),
      usersCanRegisterApps: async () => over.usersCanRegister ?? true,
    },
    arm: {
      listSubscriptions: async () => over.subs ?? [{ subscriptionId: 'sub-1', displayName: 'Production', state: 'Enabled' }],
      permissions: async (/** @type {string} */ scope) => perms[scope] ?? READ,
      myRoleAssignments: async (/** @type {string} */ scope) => over.assigned?.[scope] ?? [assignment(ROLES.owner)],
      myEligibleRoles: async (/** @type {string} */ scope) => over.armEligible?.[scope] ?? [],
      getVault: async () => ({ name: 'kv' }),
      resourceGraph: over.resourceGraph ?? (async () => ({ data: [{ id: 'x' }] })),
    },
    fabric: {
      listCapacities: async () => over.capacities ?? [{ id: 'cap-1', displayName: 'F64', sku: 'F64', state: 'Active' }],
      listWorkspaces: async (/** @type {string[] | undefined} */ roles) => {
        over.askedRoles = roles;
        return over.workspaces ?? [];
      },
      getWorkspace: async (/** @type {string} */ id) => {
        const ws = (over.workspaces ?? []).find((/** @type {any} */ w) => w.id === id);
        if (!ws) throw new HttpError('404 Not Found', { method: 'GET', url: `https://api.fabric.microsoft.com/v1/workspaces/${id}`, status: 404 });
        return ws;
      },
      tenantSettings: over.tenantSettings ?? (async () => { throw new HttpError('401 Unauthorized', { method: 'GET', url: 'https://api.fabric.microsoft.com/v1/admin/tenantsettings', status: 401 }); }),
    },
    discovery: {
      instances: async () => over.envs ?? [{ Url: 'https://org1.crm.dynamics.com', FriendlyName: 'Default', State: 0, IsUserSysAdmin: true }],
    },
  });
}

const run = async (/** @type {any} */ over, config = emptyConfig()) => {
  const items = await checkPrereqs({ api: fakeApis(over), user: USER, config });
  return Object.fromEntries(items.map((i) => [i.id, i]));
};

test('checkPrereqs: a well-equipped admin meets everything; each item says what it is for and how to get it', async () => {
  const items = await checkPrereqs({ api: fakeApis(), user: USER, config: emptyConfig() });
  assert.deepEqual(items.map((i) => i.id), ['consent-role', 'fabric-admin', 'power-platform-admin', 'register-apps', 'audit-ingestion', 'power-bi-pro', 'copilot-licences', 'power-automate-premium', 'fabric-capacity', 'azure-rbac', 'key-vault', 'environments', 'viva-analyst', 'tenant-settings']);
  for (const i of items) {
    assert.ok(i.neededFor && i.howTo && i.label, i.id);
  }
  const byId = Object.fromEntries(items.map((i) => [i.id, i]));
  assert.equal(byId['consent-role'].status, 'met');
  assert.match(byId['consent-role'].detail, /Active: Global Administrator/);
  assert.equal(byId['fabric-admin'].status, 'met');
  assert.equal(byId['power-platform-admin'].status, 'handoff', 'a System Administrator in an environment only hands off the flows\' connection sign-in');
  assert.equal(byId['register-apps'].status, 'met');
  assert.equal(byId['power-bi-pro'].status, 'met');
  assert.equal(byId['fabric-capacity'].status, 'met');
  assert.equal(byId['azure-rbac'].status, 'met');
  assert.match(byId['azure-rbac'].rows?.[0].detail ?? '', /Can create resources and assign roles \(Owner\)/);
  assert.equal(byId['key-vault'].status, 'met');
  assert.equal(byId.environments.status, 'met');
  assert.equal(byId['viva-analyst'].status, 'handoff', 'Global Administrator isn\'t Insights Analyst');
  assert.equal(byId['tenant-settings'].status, 'unknown', 'a 401 on tenant settings is "couldn\'t check", not missing');
  assert.match(byId['tenant-settings'].detail, /^Couldn't check: only a Fabric administrator can read tenant settings\. Ask one to confirm these are on for you, or for a group you're in: /);
});

test('checkPrereqs: only active roles count; one you can activate in PIM says so, with a link', async () => {
  const eligible = await run({ roles: [], eligible: async () => [{ roleDefinitionId: GA, principalId: USER.id }] });
  assert.equal(eligible['consent-role'].status, 'eligible');
  assert.match(eligible['consent-role'].detail, /Not active yet: Global Administrator\. You can activate this role in Entra \(Privileged Identity Management\): https:\/\/entra\.microsoft\.com\//);
  assert.doesNotMatch(eligible['consent-role'].detail, /PIM-eligible|Eligible/);

  const none = await run({ roles: [], eligible: async () => { throw new HttpError('403', { method: 'GET', url: 'x', status: 403 }); } });
  assert.equal(none['consent-role'].status, 'handoff', 'someone else approves the consent; the install carries on');
  assert.match(none['consent-role'].detail, /^You don't need this yourself: the installer gives you an admin consent link to send, and carries on\./);
  assert.doesNotMatch(none['consent-role'].detail, /Administrator/, 'the label and "Who does it" name who approves it');
  assert.match(none['consent-role'].detail, /Couldn't check for roles you could activate yourself/);
  assert.equal(none['consent-role'].howTo, 'A Privileged Role Administrator or Global Administrator approves the app\'s Microsoft Graph permissions from the installer\'s consent link. An Application Administrator or Cloud Application Administrator can\'t: https://learn.microsoft.com/entra/identity/enterprise-apps/grant-admin-consent');
  assert.equal(none['register-apps'].status, 'met', 'users can register apps');

  const locked = await run({ roles: [], usersCanRegister: false });
  assert.equal(locked['register-apps'].status, 'missing');
});

test('checkPrereqs: Power BI Pro only counts once provisioned', async () => {
  const none = await run({ licences: [{ servicePlans: [{ servicePlanName: 'BI_AZURE_P2', provisioningStatus: 'PendingActivation' }, { servicePlanName: 'EXCHANGE_S_ENTERPRISE', provisioningStatus: 'Success' }] }] });
  assert.equal(none['power-bi-pro'].status, 'missing');
  const ppu = await run({ licences: [{ servicePlans: [{ servicePlanName: 'BI_AZURE_P3', provisioningStatus: 'Success' }] }] });
  assert.equal(ppu['power-bi-pro'].status, 'met');
  assert.match(ppu['power-bi-pro'].detail, /Premium Per User/);
});

test('checkPrereqs: Azure access per subscription: Contributor alone is missing, Contributor and UAA is met, eligible Owner says activate first', async () => {
  const subs = [
    { subscriptionId: 'sub-a', displayName: 'A', state: 'Enabled' },
    { subscriptionId: 'sub-b', displayName: 'B', state: 'Enabled' },
    { subscriptionId: 'sub-c', displayName: 'C', state: 'Enabled' },
    { subscriptionId: 'sub-off', displayName: 'Off', state: 'Disabled' },
  ];
  const r = await run({
    subs,
    perms: { '/subscriptions/sub-a': CREATE, '/subscriptions/sub-b': ALL, '/subscriptions/sub-c': READ },
    assigned: {
      '/subscriptions/sub-a': [assignment(ROLES.contributor)],
      '/subscriptions/sub-b': [assignment(ROLES.contributor), assignment(ROLES.userAccessAdministrator, 'group-1')],
      '/subscriptions/sub-c': [],
    },
    armEligible: { '/subscriptions/sub-c': [assignment(ROLES.owner)] },
  });
  const rows = Object.fromEntries((r['azure-rbac'].rows ?? []).map((row) => [row.name, row]));
  assert.deepEqual(Object.keys(rows).sort(), ['A', 'B', 'C'], 'disabled subscriptions are skipped');
  assert.equal(rows.A.status, 'missing');
  assert.match(rows.A.detail ?? '', /not assign roles \(no User Access Administrator\) \(Contributor\)/);
  assert.equal(rows.B.status, 'met');
  assert.match(rows.B.detail ?? '', /Contributor, User Access Administrator/, 'a role held through a group counts');
  assert.equal(rows.C.status, 'eligible');
  assert.match(rows.C.detail ?? '', /Not active yet: Owner\. You can activate it/);
  assert.equal(r['azure-rbac'].status, 'met');
  assert.match(r['azure-rbac'].detail, /1 of 3 subscriptions/);
});

test('checkPrereqs: the install\'s subscription is checked first; no Azure at all is optional for Fabric and required for Azure', async () => {
  const config = emptyConfig();
  config.keyVault.subscriptionId = 'sub-b';
  const r = await run({ subs: [{ subscriptionId: 'sub-a', displayName: 'A', state: 'Enabled' }, { subscriptionId: 'sub-b', displayName: 'B', state: 'Enabled' }] }, config);
  assert.equal(r['azure-rbac'].rows?.[0].name, 'B');

  const none = await run({ subs: [] });
  assert.equal(none['azure-rbac'].status, 'missing');
  assert.equal(none['azure-rbac'].optional, true);
  assert.match(none['azure-rbac'].howTo, /--no-key-vault/);
  assert.equal(none['key-vault'].status, 'missing');
  assert.equal(none['key-vault'].optional, true, 'no Key Vault is a choice on Fabric');

  const azure = emptyConfig();
  azure.target = 'azure';
  const az = await run({ subs: [] }, azure);
  assert.equal(az['azure-rbac'].optional, false);
  assert.equal(az['fabric-capacity'], undefined, 'the Azure target needs no Fabric capacity');
  assert.equal(az['key-vault'], undefined);
  assert.equal(az['teams-admin'].status, 'met', 'Global Administrator publishes the Teams app');
  assert.equal(az['teams-admin'].optional, true);
  assert.equal(none['teams-admin'], undefined, 'only the Azure target has a Teams app');
  const noTeams = await run({ roles: [] }, azure);
  assert.equal(noTeams['teams-admin'].status, 'handoff');
  assert.match(noTeams['teams-admin'].detail, /the installer prints the steps for a Teams Administrator/);
  assert.match(noTeams['teams-admin'].howTo, /Teams admin center, under Teams apps > Manage apps: https:\/\/admin\.teams\.microsoft\.com\//);
  const teamsAdmin = await run({ roles: [{ roleTemplateId: '69091246-20e8-4a56-aa4d-066075b2a7a8', displayName: 'Teams Administrator' }] }, azure);
  assert.match(teamsAdmin['teams-admin'].detail, /Active: Teams Administrator/);
});

const CONTRIBUTOR = [{ actions: ['*'], notActions: ['Microsoft.Authorization/*/Delete', 'Microsoft.Authorization/*/Write', 'Microsoft.Authorization/elevateAccess/Action'] }];
const RBAC_ADMIN = [{ actions: ['Microsoft.Authorization/roleAssignments/write', 'Microsoft.Authorization/roleAssignments/delete', '*/read', 'Microsoft.Support/*'], notActions: [] }];
const RG = '/subscriptions/sub-1/resourceGroups/rg-x';

/** An Azure install into resource group rg-x in sub-1. @param {'existing' | 'new'} [mode] */
function azureInto(mode = 'existing') {
  const config = emptyConfig();
  config.target = 'azure';
  config.azure = /** @type {any} */ ({ subscriptionId: 'sub-1', resourceGroup: 'rg-x', resourceGroupMode: mode });
  return config;
}

test('checkPrereqs: an existing resource group is checked there, so least privilege on just that group is enough', async () => {
  const lp = await run({
    perms: { '/subscriptions/sub-1': READ, [RG]: [...CONTRIBUTOR, ...RBAC_ADMIN] },
    assigned: { '/subscriptions/sub-1': [], [RG]: [assignment(ROLES.contributor), assignment(ROLES.rbacAdministrator)] },
  }, azureInto());
  const rbac = lp['azure-rbac'];
  assert.equal(rbac.status, 'met', 'the resource group decides, not the subscription');
  assert.match(rbac.detail, /^Resource group rg-x: enough to install there\. Subscription-wide, 0 of 1 subscription give you this\./);
  assert.deepEqual(rbac.rows?.map((r) => [r.name, r.status]), [['Resource group rg-x', 'met'], ['Production', 'missing']]);
  assert.equal(rbac.rows?.[0].detail, 'Can deploy and assign roles in this resource group (Contributor, Role Based Access Control Administrator)');
  assert.match(rbac.howTo, /least privilege.*\(https:\/\/github\.com\/microsoft\/AnalyticsHub-Dashboard\/blob\/main\/docs\/AZURE-LEAST-PRIVILEGE\.md\)\.$/, 'a link that works outside the repo');

  const subs = [{ subscriptionId: 'sub-1', displayName: 'Production', state: 'Enabled' }, { subscriptionId: 'sub-2', displayName: 'Other', state: 'Enabled' }];
  const noAssign = await run({ subs, perms: { '/subscriptions/sub-1': READ, '/subscriptions/sub-2': ALL, [RG]: CONTRIBUTOR }, assigned: { [RG]: [assignment(ROLES.contributor)] } }, azureInto());
  assert.equal(noAssign['azure-rbac'].status, 'missing', 'Owner on another subscription doesn\'t help an install into rg-x');
  assert.match(noAssign['azure-rbac'].detail, /^Resource group rg-x: not enough to install there\. Subscription-wide, 1 of 2 subscriptions give you this\./);
  assert.equal(noAssign['azure-rbac'].rows?.[0].detail, 'Can deploy here but not assign roles (no Role Based Access Control Administrator or User Access Administrator) (Contributor)');

  const assignOnly = await run({ perms: { '/subscriptions/sub-1': READ, [RG]: RBAC_ADMIN }, assigned: { [RG]: [assignment(ROLES.rbacAdministrator)] } }, azureInto());
  assert.equal(assignOnly['azure-rbac'].rows?.[0].detail, 'Can assign roles here but not deploy (no Contributor) (Role Based Access Control Administrator)');

  const readOnly = await run({ perms: { '/subscriptions/sub-1': READ, [RG]: READ }, assigned: { [RG]: [] } }, azureInto());
  assert.equal(readOnly['azure-rbac'].status, 'missing');
  assert.equal(readOnly['azure-rbac'].rows?.[0].detail, 'Can\'t deploy or assign roles in this resource group');

  const eligible = await run({
    perms: { '/subscriptions/sub-1': READ, [RG]: CONTRIBUTOR },
    assigned: { [RG]: [assignment(ROLES.contributor)] },
    armEligible: { [RG]: [assignment(ROLES.rbacAdministrator)] },
  }, azureInto());
  assert.equal(eligible['azure-rbac'].status, 'eligible');
  assert.match(eligible['azure-rbac'].detail, /^Resource group rg-x: activate your role first\./);
  assert.equal(eligible['azure-rbac'].rows?.[0].detail, 'Not active yet: Role Based Access Control Administrator. You can activate it in Privileged Identity Management.');
});

test('checkPrereqs: a resource group that can\'t be checked leaves it to the subscriptions; no resource group row for a new group or on Fabric', async () => {
  const forbidden = () => new HttpError('403 Forbidden', { method: 'GET', url: 'x', status: 403 });
  const byId = (/** @type {import('../src/prereqs.js').Prereq[]} */ items) => Object.fromEntries(items.map((i) => [i.id, i]));

  const unreadable = fakeApis();
  unreadable.arm.permissions = async (/** @type {string} */ scope) => {
    if (scope === RG) throw forbidden();
    return ALL;
  };
  const r = byId(await checkPrereqs({ api: unreadable, user: USER, config: azureInto() }));
  assert.equal(r['azure-rbac'].status, 'met', 'Owner on the subscription still decides');
  assert.match(r['azure-rbac'].detail, /^Resource group rg-x: couldn't check\. Subscription-wide, 1 of 1 subscription give you this\./);
  assert.equal(r['azure-rbac'].rows?.[0].status, 'unknown');
  assert.match(r['azure-rbac'].rows?.[0].detail ?? '', /^Couldn't check: 403/);

  const hidden = await run({ subs: [], perms: { [RG]: [...CONTRIBUTOR, ...RBAC_ADMIN] } }, azureInto());
  assert.equal(hidden['azure-rbac'].status, 'met', 'rights on just the group, with no subscription you can list');
  assert.equal(hidden['azure-rbac'].detail, 'Resource group rg-x: enough to install there.');
  assert.deepEqual(hidden['azure-rbac'].rows?.map((row) => row.name), ['Resource group rg-x']);

  const unlisted = fakeApis({ perms: { [RG]: [...CONTRIBUTOR, ...RBAC_ADMIN] } });
  unlisted.arm.listSubscriptions = async () => { throw forbidden(); };
  const u = byId(await checkPrereqs({ api: unlisted, user: USER, config: azureInto() }));
  assert.equal(u['azure-rbac'].status, 'met', 'a subscription list that fails doesn\'t hide the resource group');

  const fresh = await run({}, azureInto('new'));
  assert.ok(!fresh['azure-rbac'].rows?.some((row) => row.name.startsWith('Resource group')), 'a new group needs the subscription');
  assert.doesNotMatch(fresh['azure-rbac'].detail, /Resource group/);

  const fabric = azureInto();
  fabric.target = 'fabric';
  const fab = await run({}, fabric);
  assert.ok(!fab['azure-rbac'].rows?.some((row) => row.name.startsWith('Resource group')), 'Fabric doesn\'t deploy into a resource group');
  assert.doesNotMatch(fab['azure-rbac'].howTo, /LEAST-PRIVILEGE/);
});

test('checkPrereqs: System Administrator per environment; a failing check is "couldn\'t check"', async () => {
  const r = await run({
    envs: [
      { Url: 'https://a.crm.dynamics.com', FriendlyName: 'Dev', State: 0, IsUserSysAdmin: false },
      { Url: 'https://b.crm.dynamics.com', FriendlyName: 'Prod', State: 0, IsUserSysAdmin: false },
    ],
    capacities: [{ id: 'p1', displayName: 'Premium', sku: 'P1', state: 'Active' }, { id: 'f2', displayName: 'Paused', sku: 'F2', state: 'Paused' }],
  });
  assert.equal(r.environments.status, 'missing');
  assert.deepEqual(r.environments.rows?.map((x) => x.status), ['missing', 'missing']);
  assert.equal(r['fabric-capacity'].status, 'met', 'a P SKU runs Fabric');

  const noCap = await run({ capacities: [{ id: 'a1', displayName: 'Embedded', sku: 'A1', state: 'Active' }] });
  assert.equal(noCap['fabric-capacity'].status, 'missing');

  const api = fakeApis();
  api.discovery.instances = async () => { throw new HttpError('503 Service Unavailable', { method: 'GET', url: 'x', status: 503 }); };
  const items = await checkPrereqs({ api, user: USER, config: emptyConfig() });
  const env = items.find((i) => i.id === 'environments');
  assert.equal(env?.status, 'unknown');
  assert.match(env?.detail ?? '', /^Couldn't check: 503/);
});

test('checkPrereqs: with Resource Graph on, it says what you can see of agents and Foundry; a refusal is missing, none is unknown', async () => {
  const config = emptyConfig();
  config.dataSources.resourceGraph = 'api';
  config.resourceGraph = { managementGroup: 'mg-1', agents: true, foundry: true };
  /** @type {any[]} */
  const asked = [];
  const seen = await run({ resourceGraph: async (/** @type {string} */ q, /** @type {string} */ mg) => (asked.push([q, mg]), { data: [{ id: 'x' }] }) }, config);
  assert.equal(seen['resource-graph'].status, 'met');
  assert.equal(seen['resource-graph'].optional, true);
  assert.deepEqual(asked.map((a) => a[1]), ['mg-1', 'mg-1']);
  assert.match(asked[0][0], /PowerPlatformResources \| where type =~ 'microsoft\.copilotstudio\/agents'/);
  assert.match(asked[1][0], /microsoft\.cognitiveservices\/accounts\/projects/);

  const refused = await run({ resourceGraph: async (/** @type {string} */ q) => {
    if (q.startsWith('PowerPlatformResources')) throw new HttpError('403 Forbidden', { method: 'POST', url: 'x', status: 403 });
    return { data: [] };
  } }, config);
  assert.equal(refused['resource-graph'].status, 'missing');
  assert.deepEqual(refused['resource-graph'].rows?.map((r) => r.status), ['missing', 'unknown']);
  assert.match(refused['resource-graph'].detail, /Copilot Studio agents: Refused/);

  assert.equal((await run({}))['resource-graph'], undefined, 'not checked when the source is off');
});

test('graph and ARM lookups keep only rows for the signed-in user\'s principals, whatever the filter returned', async () => {
  /** @type {any[]} */
  const queries = [];
  const http = /** @type {any} */ ({
    list: async (/** @type {string} */ path, /** @type {any} */ o) => {
      queries.push([path, o.query]);
      if (path.includes('roleEligibilityScheduleInstances') && path.startsWith('/roleManagement')) {
        return [{ roleDefinitionId: GA, principalId: USER.id }, { roleDefinitionId: GA, principalId: 'someone-else' }];
      }
      return [assignment(ROLES.owner), assignment(ROLES.owner, 'someone-else'), assignment(ROLES.contributor, 'group-1')];
    },
  });
  const graph = graphApi(http);
  assert.deepEqual((await graph.myEligibleRoles(USER.id)).map((r) => r.principalId), [USER.id]);
  assert.match(queries[0][1].$filter, /principalId eq 'user-1'/);

  const arm = armApi(http);
  const ids = [USER.id, 'group-1'];
  assert.deepEqual((await arm.myRoleAssignments('/subscriptions/s', ids)).map((r) => r.properties.principalId), [USER.id, 'group-1']);
  assert.equal(queries[1][1].$filter, "assignedTo('user-1')");
  assert.deepEqual((await arm.myEligibleRoles('/subscriptions/s', ids)).map((r) => r.properties.principalId), [USER.id, 'group-1']);
  assert.equal(queries[2][1].$filter, 'asTarget()');
});

test('checkPrereqs: the Defender licence check only shows when Defender is picked, and is optional', async () => {
  assert.equal((await run({}))['defender-licence'], undefined);
  const config = emptyConfig();
  config.modules.defender = true;
  const none = await run({}, config);
  assert.equal(none['defender-licence'].status, 'missing');
  assert.equal(none['defender-licence'].optional, true);
  assert.match(none['defender-licence'].howTo, /skipped/);
  const p2 = await run({ skus: [{ capabilityStatus: 'Enabled', servicePlans: [{ servicePlanName: 'WINDEFATP' }, { servicePlanName: 'ADALLOM_S_STANDALONE' }] }] }, config);
  assert.equal(p2['defender-licence'].status, 'met');
  assert.match(p2['defender-licence'].detail, /Defender for Endpoint P2, Defender for Cloud Apps/);
  const lapsed = await run({ skus: [{ capabilityStatus: 'Suspended', servicePlans: [{ servicePlanName: 'WINDEFATP' }] }] }, config);
  assert.equal(lapsed['defender-licence'].status, 'missing');
  const unreadable = await run({ skusFn: async () => { throw new HttpError('403', { method: 'GET', url: 'x', status: 403 }); } }, config);
  assert.equal(unreadable['defender-licence'].status, 'unknown');
});

test('checkPrereqs: Fabric Administrator is a hand-off: you don\'t need it yourself, a Fabric administrator turns on or confirms the tenant settings', async () => {
  const r = await run({ roles: [], eligible: async () => [{ roleDefinitionId: FABRIC_ADMIN_ROLE, principalId: USER.id }] });
  assert.equal(r['fabric-admin'].label, 'Fabric Administrator');
  assert.equal(r['fabric-admin'].status, 'eligible', 'one you can activate yourself is unchanged');
  assert.match(r['fabric-admin'].detail, /You can activate this role in Entra \(Privileged Identity Management\)/);
  for (const i of Object.values(r)) assert.doesNotMatch(`${i.label} ${i.detail} ${i.howTo}`, /PIM-eligible|only needed if the tenant settings below are off/, i.id);

  const lacking = await run({ roles: [] });
  assert.equal(lacking['fabric-admin'].status, 'handoff');
  assert.match(lacking['fabric-admin'].detail, /^You don't need this role yourself: a Fabric administrator turns on, or confirms, the tenant settings for you\./);
  assert.match(lacking['fabric-admin'].howTo, /A Fabric administrator .* in Fabric under Admin portal > Tenant settings: https:\/\/learn\.microsoft\.com\/fabric\/admin\/tenant-settings-index/);
  assert.equal((await run({}))['fabric-admin'].status, 'met', 'an active role is unchanged');
});

test('checkPrereqs: Power Platform Administrator is a hand-off only for a System Administrator in an environment; otherwise it stays missing', async () => {
  const sysAdmin = await run({ roles: [] });
  assert.equal(sysAdmin.environments.status, 'met');
  assert.equal(sysAdmin['power-platform-admin'].status, 'handoff');
  assert.match(sysAdmin['power-platform-admin'].detail, /Only the flows' Power Platform API connection needs an admin to sign in to it/);
  assert.equal(
    sysAdmin['power-platform-admin'].howTo,
    `With the Copilot Studio credits flow, that connection signs in as ${PP_API_SIGNER}. With only the agent inventory flow, it signs in as ${INVENTORY_SIGNER}.`,
  );
  assert.equal(PP_API_SIGNER, 'a Power Platform or Global administrator', 'the licensing routes name these two roles, not Billing');
  assert.doesNotMatch(sysAdmin['power-platform-admin'].howTo, /Billing/);

  const notSysAdmin = await run({ roles: [], envs: [{ Url: 'https://org1.crm.dynamics.com', FriendlyName: 'Default', State: 0, IsUserSysAdmin: false }] });
  assert.equal(notSysAdmin.environments.status, 'missing');
  assert.equal(notSysAdmin['power-platform-admin'].status, 'missing', 'it adds the app to environments you can\'t');
  assert.match(notSysAdmin['power-platform-admin'].detail, /You don't have Power Platform Administrator active/);
  const noEnvs = await run({ roles: [], envs: [] });
  assert.equal(noEnvs['power-platform-admin'].status, 'missing');

  const ppAdmin = await run({ roles: [{ roleTemplateId: '11648597-926c-4cf3-9c36-bcebb0ba8dcc', displayName: 'Power Platform Administrator' }] });
  assert.equal(ppAdmin['power-platform-admin'].status, 'met');
});

test('checkPrereqs: Power Automate Premium is optional, needed only for the flows, and read from your own licences: the flows run on their owner\'s licence', async () => {
  const none = await run({});
  assert.equal(none['power-automate-premium'].status, 'missing');
  assert.equal(none['power-automate-premium'].optional, true);
  assert.match(none['power-automate-premium'].neededFor, /Copilot Studio credits/);
  assert.ok(none['power-automate-premium'].neededFor.includes(PREMIUM_OWNER));
  assert.equal(PREMIUM_OWNER, 'The flows run on your Power Automate Premium licence, because you\'ll own them. Whoever signs in to their connections doesn\'t need Premium.');
  assert.equal(none['power-automate-premium'].detail, 'No Power Automate Premium licence is assigned to you, and you\'ll own the flows. Ask your licence admin for one, or upload the CSV exports instead.');
  for (const text of [none['power-automate-premium'].detail, none['power-automate-premium'].howTo, none['power-automate-premium'].neededFor]) {
    assert.doesNotMatch(text, /Someone else|signs in to the flow/, 'only the owner needs Premium, and someone else signing in doesn\'t change the owner');
  }
  const premium = await run({ licences: [{ servicePlans: [{ servicePlanName: 'BI_AZURE_P2', provisioningStatus: 'Success' }, { servicePlanName: 'POWER_AUTOMATE_ATTENDED_RPA', provisioningStatus: 'Success' }] }] });
  assert.equal(premium['power-automate-premium'].status, 'met');
  assert.equal(premium['power-bi-pro'].status, 'met', 'one licence read serves both rows');
  assert.match(premium['power-automate-premium'].detail, /Power Automate Premium/);
  const perUser = await run({ licences: [{ servicePlans: [{ servicePlanName: 'FLOW_PER_USER', provisioningStatus: 'Success' }] }] });
  assert.equal(perUser['power-automate-premium'].status, 'met');
  const seeded = await run({ licences: [{ servicePlans: [{ servicePlanName: 'FLOW_O365_P3', provisioningStatus: 'Success' }, { servicePlanName: 'FLOW_PER_USER', provisioningStatus: 'PendingActivation' }] }] });
  assert.equal(seeded['power-automate-premium'].status, 'missing', 'the Microsoft 365 flow plan has no premium connectors');
});

test('checkPrereqs: audit ingestion needs consent for AuditLogsQuery.Read.All, says who grants it and shows the last audit check', async () => {
  const admin = await run({});
  assert.equal(admin['audit-ingestion'].status, 'met');
  assert.match(admin['audit-ingestion'].detail, /your Global Administrator role lets the installer grant it/);
  assert.match(admin['audit-ingestion'].howTo, /Global Administrator or Privileged Role Administrator grants admin consent for AuditLogsQuery\.Read\.All/);
  assert.match(admin['audit-ingestion'].howTo, /Compliance Administrator checks audit logging is on/);
  assert.match(admin['audit-ingestion'].howTo, /check-audit/);

  const user = await run({ roles: [] });
  assert.equal(user['audit-ingestion'].status, 'handoff', 'someone else approves it; the install carries on');
  assert.match(user['audit-ingestion'].detail, /^Not granted yet, so the audit load finds 0 records until a Privileged Role Administrator or Global Administrator approves it\./);

  const graphSp = { id: 'graph-sp', appRoles: [{ id: 'role-audit', value: 'AuditLogsQuery.Read.All' }] };
  /** @param {any[]} assigned */
  const withApp = (assigned) => {
    const api = fakeApis({ roles: [] });
    api.graph.graphServicePrincipal = async () => graphSp;
    api.graph.appRoleAssignments = async () => assigned;
    return api;
  };
  const config = emptyConfig();
  Object.assign(config.app, { appId: 'app-1', servicePrincipalId: 'sp-1' });
  /** @param {any[]} assigned */
  const audit = async (assigned) => (await checkPrereqs({ api: withApp(assigned), user: USER, config })).find((i) => i.id === 'audit-ingestion');

  const granted = await audit([{ resourceId: 'graph-sp', appRoleId: 'role-audit' }]);
  assert.equal(granted?.status, 'met');
  assert.match(granted?.detail ?? '', /Admin consent is in place for the app app-1/);
  assert.equal((await audit([{ resourceId: 'other', appRoleId: 'role-audit' }]))?.status, 'handoff', 'another API\'s role doesn\'t count: still to approve');

  config.auditCheck = { at: '2026-06-01T12:00:00Z', result: 'empty-log' };
  const empty = await audit([{ resourceId: 'graph-sp', appRoleId: 'role-audit' }]);
  assert.equal(empty?.status, 'missing', 'consent alone isn\'t enough when the last check found the log empty');
  assert.match(empty?.detail ?? '', /Last audit check \(2026-06-01\): the audit log is empty; audit logging may be off/);

  const az = emptyConfig();
  az.target = 'azure';
  az.azure = /** @type {any} */ ({ graphRoles: { assigned: [], pending: ['AuditLogsQuery.Read.All'] } });
  const pending = (await run({}, az))['audit-ingestion'];
  assert.equal(pending.status, 'handoff');
  assert.match(pending.detail, /The jobs' managed identity doesn't have it yet, so the audit load finds 0 records until a Privileged Role Administrator or Global Administrator grants it/);
  az.azure = /** @type {any} */ ({ graphRoles: { assigned: ['AuditLogsQuery.Read.All'], pending: [] } });
  assert.match((await run({}, az))['audit-ingestion'].detail, /The jobs' managed identity has it/);
});

const PRA = 'e8611ab8-c189-46e8-94e1-60213ab1f814';
const APP_ADMIN = '9b895d92-2cd3-44c7-9d02-a6ac2d5ea5c3';
const CLOUD_APP_ADMIN = '158c047a-c907-4556-b7ef-446551a6b5f7';
const APP_DEVELOPER = 'cf1c38e5-3621-4004-a7cb-879624dced7c';
/** An active directory role. @param {string} roleTemplateId @param {string} displayName */
const role = (roleTemplateId, displayName) => ({ roleTemplateId, displayName });

/** An Azure install's config, with what it has recorded so far. @param {any} [azure] */
const azureConfig = (azure = {}) => {
  const config = emptyConfig();
  config.target = 'azure';
  config.azure = /** @type {any} */ ({ subscriptionId: 'sub-1', ...azure });
  return config;
};

/**
 * checkPrereqs with the Graph calls the Azure rows make on top of fakeApis.
 * @param {any} over @param {import('../src/config.js').InstallConfig} config @param {Record<string, any>} [graph]
 */
const runWith = async (over, config, graph = {}) => {
  const api = fakeApis(over);
  Object.assign(api.graph, graph);
  const items = await checkPrereqs({ api, user: USER, config });
  return Object.fromEntries(items.map((i) => [i.id, i]));
};

test('checkPrereqs: a Privileged Role Administrator alone can\'t register apps, and an Application Developer can, on Fabric and Azure', async () => {
  for (const config of [emptyConfig(), azureConfig()]) {
    const pra = await run({ roles: [role(PRA, 'Privileged Role Administrator')], usersCanRegister: false }, config);
    assert.equal(pra['register-apps'].status, 'missing', config.target);
    const dev = await run({ roles: [role(APP_DEVELOPER, 'Application Developer')], usersCanRegister: false }, config);
    assert.equal(dev['register-apps'].status, 'met', config.target);
    assert.equal(dev['register-apps'].detail, 'Your Application Developer role allows it.');
  }
  const fabric = await run({ roles: [], usersCanRegister: false });
  assert.equal(fabric['register-apps'].howTo, 'Ask for the Application Administrator, Cloud Application Administrator or Application Developer role, use an app registration you already have, or choose "An admin will register the app for me" in the plan: it puts the Cloud Shell script and portal steps in the app admin\'s file in the admin pack.');
});

test('checkPrereqs: on Azure, registering apps is met by recorded apps, a role, the tenant setting, or one unfinished app of each name an admin made; otherwise the plan has an admin create them', async () => {
  const locked = { roles: [], usersCanRegister: false };
  const recorded = await run(locked, azureConfig({ webApp: { clientId: 'web-1' }, sqlReader: { clientId: 'sql-1' } }));
  assert.equal(recorded['register-apps'].status, 'met');
  assert.equal(recorded['register-apps'].detail, 'Uses the app registrations web-1 and sql-1.');
  assert.equal((await run({ roles: [] }, azureConfig()))['register-apps'].detail, 'Users in this tenant can register apps.');

  const web = { id: 'web-obj', appId: 'web-1', displayName: 'Analytics Hub (Azure)' };
  const sql = { id: 'sql-obj', appId: 'sql-1', displayName: 'Analytics Hub SQL Reader' };
  /** The apps the signed-in user owns, as ownedApplications finds them by exact name. @param {any[]} apps */
  const owning = (apps) => ({ ownedApplications: async (/** @type {string} */ name) => apps.filter((a) => a.displayName === name) });
  const made = await runWith(locked, azureConfig(), owning([web, sql]));
  assert.equal(made['register-apps'].status, 'met');
  assert.equal(made['register-apps'].detail, 'An admin created the apps for you: "Analytics Hub (Azure)" (web-1) and "Analytics Hub SQL Reader" (sql-1). The plan uses them.');
  const one = await runWith(locked, azureConfig({ webApp: { clientId: 'web-1' } }), owning([sql]));
  assert.equal(one['register-apps'].detail, 'An admin created the app for you: "Analytics Hub SQL Reader" (sql-1). The plan uses it.');
  // Two of a name, an app another install finished, or only one of the two: the plan asks.
  const finishedWeb = { ...web, spa: { redirectUris: ['https://other.example.com/'] } };
  const finishedSql = { ...sql, passwordCredentials: [{ keyId: 'k' }] };
  for (const apps of [[web, { ...web, appId: 'web-2' }, sql], [finishedWeb, sql], [web, finishedSql], [web]]) {
    assert.equal((await runWith(locked, azureConfig(), owning(apps)))['register-apps'].status, 'missing', JSON.stringify(apps));
  }
  // When an admin made only one of the two, the row names it and the one still needed.
  const detail = async (/** @type {any} */ config, /** @type {any[]} */ apps) => (await runWith(locked, config, owning(apps)))['register-apps'].detail;
  const sqlNeeded = 'An admin created "Analytics Hub (Azure)" (web-1) for you, and the plan uses it. "Analytics Hub SQL Reader" still needs creating: the plan offers to have an admin create it.';
  assert.equal(await detail(azureConfig(), [web]), sqlNeeded);
  assert.equal(await detail(azureConfig(), [web, finishedSql]), sqlNeeded);
  assert.equal(await detail(azureConfig(), [finishedWeb, sql]), 'An admin created "Analytics Hub SQL Reader" (sql-1) for you, and the plan uses it. "Analytics Hub (Azure)" still needs creating: the plan offers to have an admin create it.');
  assert.equal(await detail(azureConfig({ webApp: { clientId: 'web-1' } }), []), 'Users in this tenant can\'t register apps, and you have no app admin role. The plan offers to have an admin create "Analytics Hub SQL Reader" for you.');
  assert.doesNotMatch(await detail(azureConfig(), [web, { ...web, appId: 'web-2' }, sql]), /still needs creating/, 'both have apps to use: the plan asks which web app');

  const cant = (await run(locked, azureConfig()))['register-apps'];
  assert.equal(cant.status, 'missing');
  assert.equal(cant.detail, 'Users in this tenant can\'t register apps, and you have no app admin role. The plan offers to have an admin create the two apps for you.');
  assert.equal(cant.howTo, 'Ask for the Application Administrator, Cloud Application Administrator or Application Developer role. Or, in the plan, choose \'Use the apps an admin created for me\' if an admin has made them, or \'An admin will create the apps for me\': the plan writes a script for an Application Administrator or Cloud Application Administrator, and stops before anything is deployed. The installer can\'t see custom roles: if one lets you register apps, choose \'Create the two apps\'.');
  assert.match(cant.neededFor, /"Analytics Hub \(Azure\)", for signing in to the web app, and "Analytics Hub SQL Reader", for Power BI/);
});

test('checkPrereqs: while the admin pack or the admin script waits, an admin registers the apps, whatever your role or the tenant setting seems to allow', async () => {
  const howTo = 'An Application Administrator or Cloud Application Administrator, from app-admin.md in the admin pack.';
  const appAdmin = { roles: [role(APP_ADMIN, 'Application Administrator')], usersCanRegister: true };
  const fabric = emptyConfig();
  // The pack's path: the index since the pack was split, a single file before.
  fabric.app.adminPack = '/records/analytics-hub-admin-pack.md';
  for (const over of [{}, appAdmin, { roles: [], usersCanRegister: false }]) {
    const row = (await run(over, fabric))['register-apps'];
    assert.equal(row.status, 'handoff', JSON.stringify(over));
    assert.equal(row.detail, 'An admin registers the app for you, with the script and portal steps in the installer\'s admin pack. Once they send you its client ID, the plan asks for it.');
    assert.equal(row.howTo, howTo);
  }
  fabric.app.appId = 'app-1';
  const registered = (await run(appAdmin, fabric))['register-apps'];
  assert.equal(registered.status, 'met', 'the admin sent the client ID');
  assert.equal(registered.detail, 'Uses the app registration app-1.');

  const script = { adminScript: '/records/analytics-hub-azure-admin-script.md' };
  for (const over of [{}, appAdmin]) {
    const row = (await run(over, azureConfig(script)))['register-apps'];
    assert.equal(row.status, 'handoff');
    assert.equal(row.detail, 'An admin creates the app registrations for you, with the installer\'s script. Once they\'ve run it, the plan finds them itself.');
    assert.equal(row.howTo, howTo);
  }
  const web = { id: 'web-obj', appId: 'web-1', displayName: 'Analytics Hub (Azure)' };
  const sql = { id: 'sql-obj', appId: 'sql-1', displayName: 'Analytics Hub SQL Reader' };
  const owning = (/** @type {any[]} */ apps) => ({ ownedApplications: async (/** @type {string} */ name) => apps.filter((a) => a.displayName === name) });
  const made = (await runWith(appAdmin, azureConfig(script), owning([web, sql])))['register-apps'];
  assert.equal(made.status, 'met', 'the admin ran the script');
  assert.equal(made.detail, 'An admin created the apps for you: "Analytics Hub (Azure)" (web-1) and "Analytics Hub SQL Reader" (sql-1). The plan uses them.');
  assert.equal((await runWith(appAdmin, azureConfig(script), owning([web])))['register-apps'].status, 'handoff', 'one of the two is still to make');
  const recorded = (await run(appAdmin, azureConfig({ ...script, webApp: { clientId: 'web-1' }, sqlReader: { clientId: 'sql-1' } })))['register-apps'];
  assert.equal(recorded.status, 'met');
});

test('checkPrereqs: on Azure, the consent row is the web app\'s delegated permissions: met by four roles or by grants already made, otherwise a hand-off', async () => {
  const none = (await run({ roles: [] }, azureConfig()))['consent-role'];
  assert.equal(none.label, 'Application Administrator, Cloud Application Administrator, Privileged Role Administrator or Global Administrator');
  assert.equal(none.neededFor, 'Approving the web app\'s delegated permissions (Power BI and Microsoft Graph), so people can use the web app.');
  assert.equal(none.status, 'handoff');
  assert.equal(none.optional, true);
  assert.equal(none.detail, 'You don\'t need this yourself: after the deploy, the installer gives you a consent link to send, and carries on. People can use the web app once it\'s approved.');
  assert.equal(none.howTo, 'An Application Administrator, Cloud Application Administrator, Privileged Role Administrator or Global Administrator approves the web app\'s delegated permissions (Power BI and Microsoft Graph) from the consent link. The admin script grants them too.');
  /** @type {[string, string, boolean][]} */
  const approvers = [[GA, 'Global Administrator', true], [PRA, 'Privileged Role Administrator', true], [APP_ADMIN, 'Application Administrator', false], [CLOUD_APP_ADMIN, 'Cloud Application Administrator', false]];
  for (const [id, name, assigns] of approvers) {
    const it = (await run({ roles: [role(id, name)] }, azureConfig()))['consent-role'];
    assert.equal(it.status, 'met', name);
    assert.equal(it.detail, `Active: ${name}`);
    assert.equal(it.assignsDirectoryRoles, assigns, 'only a Global Administrator or Privileged Role Administrator assigns directory roles');
  }
  assert.equal((await run({ roles: [role(APP_DEVELOPER, 'Application Developer')] }, azureConfig()))['consent-role'].status, 'handoff', 'an Application Developer can\'t grant consent');

  // Grants an admin already made for everyone, or the admin script made, meet it too.
  const graphSp = { id: 'graph-sp', oauth2PermissionScopes: [{ id: 'g-1', value: 'User.Read' }] };
  const pbiSp = { id: 'pbi-sp', oauth2PermissionScopes: [{ id: 'p-1', value: 'Dataset.Read.All' }] };
  /** @param {any[] | Error} grants */
  const granted = (grants) => ({
    servicePrincipalByAppId: async (/** @type {string} */ appId) => (appId === GRAPH_APP_ID ? graphSp : appId === POWER_BI_APP_ID ? pbiSp : null),
    oauth2Grants: async () => {
      if (grants instanceof Error) throw grants;
      return grants;
    },
  });
  const all = [
    { consentType: 'AllPrincipals', resourceId: 'pbi-sp', scope: 'Dataset.Read.All' },
    { consentType: 'AllPrincipals', resourceId: 'graph-sp', scope: 'openid User.Read' },
  ];
  const config = azureConfig({ webApp: { clientId: 'web-1', servicePrincipalId: 'sp-web' } });
  const done = (await runWith({ roles: [] }, config, granted(all)))['consent-role'];
  assert.equal(done.status, 'met');
  assert.equal(done.detail, 'Already approved: the web app has its delegated permissions for everyone.');
  assert.equal(done.assignsDirectoryRoles, false);
  assert.equal((await runWith({ roles: [] }, config, granted(all.slice(0, 1))))['consent-role'].status, 'handoff', 'one grant missing');
  assert.equal((await runWith({ roles: [] }, config, granted(all.map((g) => ({ ...g, consentType: 'Principal' })))))['consent-role'].status, 'handoff', 'only for one person');
  assert.equal((await runWith({ roles: [] }, config, granted(new HttpError('403', { method: 'GET', url: 'x', status: 403 }))))['consent-role'].status, 'handoff', 'grants that can\'t be read aren\'t assumed');
  assert.equal((await runWith({ roles: [] }, azureConfig(), granted(all)))['consent-role'].status, 'handoff', 'no web app yet');
});

test('checkPrereqs: on Azure, the audit role is the jobs\' managed identity\'s, which a Privileged Role Administrator or Global Administrator grants after the deploy', async () => {
  const az = (await run({ roles: [] }, azureConfig()))['audit-ingestion'];
  assert.equal(az.status, 'handoff');
  assert.equal(az.detail, 'Not granted yet, so the audit load finds 0 records until a Privileged Role Administrator or Global Administrator grants it to the jobs\' managed identity.');
  assert.match(az.howTo, /^After the deploy, a Privileged Role Administrator or Global Administrator gives the jobs' managed identity its Microsoft Graph roles, including AuditLogsQuery\.Read\.All, with a command the installer prints\. A Compliance Administrator checks audit logging is on in Microsoft Purview > Audit: \S+ After install, run .*check-audit/);
  assert.doesNotMatch(az.howTo, /consent/, 'no consent link: the managed identity\'s roles aren\'t a consent');
  const fabric = (await run({ roles: [] }))['audit-ingestion'];
  assert.match(fabric.howTo, /^A Global Administrator or Privileged Role Administrator grants admin consent for AuditLogsQuery\.Read\.All \(the installer gives you a link\)\./);
});

test('checkPrereqs: Viva Insights analyst is the Insights Analyst Entra role: met, can be activated, a hand-off, or couldn\'t check', async () => {
  const analyst = await run({ roles: [{ roleTemplateId: INSIGHTS_ANALYST_ROLE, displayName: 'Insights Analyst' }] });
  assert.equal(INSIGHTS_ANALYST_ROLE, '25df335f-86eb-4119-b717-0ff02de207e9');
  assert.equal(analyst['viva-analyst'].status, 'met');
  assert.match(analyst['viva-analyst'].detail, /Active: Insights Analyst/);

  const eligible = await run({ roles: [], eligible: async () => [{ roleDefinitionId: INSIGHTS_ANALYST_ROLE, principalId: USER.id }] });
  assert.equal(eligible['viva-analyst'].status, 'eligible');
  assert.match(eligible['viva-analyst'].detail, /Not active yet: Insights Analyst\. You can activate this role/);

  const r = await run({ roles: [] });
  assert.equal(r['viva-analyst'].status, 'handoff');
  assert.equal(r['viva-analyst'].optional, true);
  assert.match(r['viva-analyst'].detail, /^You don't need it yourself: an Insights Analyst can create the Cowork credits query and share it with you\./);
  assert.match(r['viva-analyst'].detail, /the CSV export works meanwhile/);
  assert.match(r['viva-analyst'].howTo, /sends you its partition and query IDs/);
  assert.match(r['viva-analyst'].howTo, /a Global Administrator assigns you Insights Analyst in the Microsoft 365 admin center \(Settings > Viva > Viva Insights, or Role assignments\)/);
  assert.match(r['viva-analyst'].howTo, /Privileged Role Administrator/);
  assert.match(r['viva-analyst'].howTo, /https:\/\/learn\.microsoft\.com\/viva\/insights\/advanced\/setup-maint\/assign-user-roles/);
  assert.doesNotMatch(r['viva-analyst'].howTo, /Viva Insights administrator/);
  assert.match(r['viva-analyst'].neededFor, /Insights Analyst role creates the query/);
  assert.match(r['viva-analyst'].neededFor, /add it later/);

  const api = fakeApis();
  api.graph.myDirectoryRoles = async () => { throw new HttpError('403', { method: 'GET', url: 'x', status: 403 }); };
  const unread = Object.fromEntries((await checkPrereqs({ api, user: USER, config: emptyConfig() })).map((i) => [i.id, i]));
  assert.equal(unread['viva-analyst'].status, 'unknown');
  assert.match(unread['viva-analyst'].detail, /^Couldn't check/);
});

test('checkPrereqs: tenant settings that can\'t be read name each one to confirm, and who confirms them', async () => {
  const fabric = emptyConfig();
  const r = await run({}, fabric);
  const detail = r['tenant-settings'].detail;
  for (const name of ['"Create workspaces"', '"Users can create Fabric items"', '"Service principals can call Fabric public APIs"', '"Semantic Model Execute Queries REST API"', '"Allow visuals created using the Power BI SDK"']) {
    assert.ok(detail.includes(name), name);
  }
  assert.match(detail, /the Fabric apps setting, under "Fabric apps \(preview\)"/);
  assert.doesNotMatch(detail, /Fabric App items/, 'the portal names its section, not the toggle');
  assert.doesNotMatch(detail, /XMLA/, 'only with org-scoped access');
  assert.match(r['tenant-settings'].howTo, /A Fabric administrator turns them on, for everyone or for a group you're in, in Fabric under Admin portal > Tenant settings: https:\/\/learn\.microsoft\.com\/fabric\/admin\/tenant-settings-index/);

  const recorded = emptyConfig();
  recorded.fabric.workspaceId = 'ws-1';
  recorded.access = /** @type {any} */ ({ ...recorded.access, rls: { enabled: true } });
  const rls = (await run({}, recorded))['tenant-settings'].detail;
  assert.doesNotMatch(rls, /Create workspaces/, 'a recorded workspace needs no new one');
  assert.match(rls, /"Allow XMLA endpoints and Analyze in Excel with on-premises semantic models"/);
  assert.match(rls, /The capacity's XMLA endpoint must also be Read Write, which a capacity admin sets\./);

  const azure = emptyConfig();
  azure.target = 'azure';
  const az = settingsToConfirm(azure);
  const createWorkspaces = (/** @type {string[]} */ list) => list.find((s) => s.startsWith('"Create workspaces"'));
  assert.equal(createWorkspaces(az), '"Create workspaces" (only to create a new workspace, not to use an existing one you\'re an Admin or Member of)');
  assert.ok(!az.includes('"Users can create Fabric items"'), 'Fabric only');
  assert.ok(!az.some((s) => /Fabric apps/.test(s)), 'the Fabric app is Fabric only');
  assert.ok(az.includes('"Semantic Model Execute Queries REST API"'), 'Azure\'s web app queries the model through it');
  assert.ok(az.includes('"Allow visuals created using the Power BI SDK"'));
  azure.azure = /** @type {any} */ ({ powerBi: { workspaceId: 'ws-2' } });
  assert.equal(createWorkspaces(settingsToConfirm(azure)), undefined);
});

test('checkPrereqs: tenant settings that can be read name the ones that are off by their titles in the API', async () => {
  const off = await run({
    tenantSettings: async () => [
      { settingName: 'ServicePrincipalAccessPermissionAPIs', title: 'Service principals can call Fabric public APIs (renamed)', enabled: false },
      { settingName: 'AppBackendTenant', title: 'The Fabric apps toggle', enabled: false },
    ],
  });
  assert.equal(off['tenant-settings'].status, 'missing');
  assert.match(off['tenant-settings'].detail, /"Service principals can call Fabric public APIs \(renamed\)"/);
  assert.match(off['tenant-settings'].detail, /"The Fabric apps toggle"/);

  const azure = emptyConfig();
  azure.target = 'azure';
  const settings = async () => [
    { settingName: 'DatasetExecuteQueries', title: 'Semantic Model Execute Queries REST API', enabled: false },
    { settingName: 'AppBackendTenant', title: 'The Fabric apps toggle', enabled: false },
    { settingName: 'CreateAppWorkspaces', title: 'Create workspaces', enabled: true },
  ];
  const az = (await run({ subs: [], tenantSettings: settings }, azure))['tenant-settings'];
  assert.equal(az.status, 'missing', 'Azure\'s web app queries the model through it');
  assert.equal(az.detail, 'Off: "Semantic Model Execute Queries REST API".', 'the Fabric app\'s setting is Fabric only');
});

test('checkPrereqs: "Create workspaces", when it can be read, counts you in or out by the security groups it names, and points to an existing workspace', async () => {
  const FIX = 'As a Fabric administrator, you can turn it on for you, or for a group you\'re in, in Fabric under Admin portal > Tenant settings.';
  const EXISTING = 'Or use an existing workspace you\'re an Admin or Member of.';
  /** @param {string} graphId @param {string} name */
  const group = (graphId, name) => ({ graphId, name });
  /** The tenant settings row, with "Create workspaces" as given. @param {any} create @param {any} [over] @param {any[]} [others] */
  const tenant = async (create, over = {}, others = []) =>
    (await run({ ...over, tenantSettings: async () => [...others, { settingName: 'CreateAppWorkspaces', title: 'Create workspaces', ...create }] }))['tenant-settings'];

  const everyone = await tenant({ enabled: true });
  assert.equal(everyone.status, 'met');
  assert.equal(everyone.detail, 'The settings Analytics Hub needs are on.');
  assert.equal((await tenant({ enabled: true, enabledSecurityGroups: [group('GROUP-1', 'Analysts')] })).status, 'met', 'a group you\'re in, whatever the case of its ID');
  assert.equal((await tenant({ enabled: true, excludedSecurityGroups: [group('group-2', 'Finance')] })).status, 'met', 'excluding only groups you\'re not in');

  const excluded = await tenant({ enabled: true, excludedSecurityGroups: [group('group-1', 'Contractors')] });
  assert.equal(excluded.status, 'missing');
  assert.equal(excluded.detail, `"Create workspaces" excludes the group "Contractors", which you're in. ${FIX} ${EXISTING}`);

  const others = await tenant({ enabled: true, enabledSecurityGroups: [group('group-2', 'Finance'), group('group-3', 'HR')] });
  assert.equal(others.status, 'missing');
  assert.equal(others.detail, `"Create workspaces" is on only for groups you're not in: "Finance", "HR". ${FIX} ${EXISTING}`);

  const executeQueries = { settingName: 'DatasetExecuteQueries', title: 'Semantic Model Execute Queries REST API', enabled: false };
  const off = await tenant({ enabled: false }, {}, [executeQueries]);
  assert.equal(off.status, 'missing');
  assert.equal(off.detail, `Off: "Semantic Model Execute Queries REST API". "Create workspaces" is off for the whole organization. ${FIX} ${EXISTING}`);

  // In group-2 only through group-1.
  const nested = await tenant({ enabled: true, enabledSecurityGroups: [group('group-2', 'Finance')] }, { myGroups: ['group-1', 'group-2'] });
  assert.equal(nested.status, 'unknown');
  assert.equal(
    nested.detail,
    'The other settings Analytics Hub needs are on. Couldn\'t confirm "Create workspaces": it\'s on for the group "Finance", which you\'re in only through another group. ' +
      'Learn doesn\'t say whether that counts. If it leaves you out, use an existing workspace you\'re an Admin or Member of.',
  );
  const nestedOff = await tenant({ enabled: true, excludedSecurityGroups: [group('group-2', 'Finance')] }, { myGroups: ['group-1', 'group-2'] }, [executeQueries]);
  assert.equal(nestedOff.status, 'missing', 'another setting is off');
  assert.match(nestedOff.detail, /^Off: "Semantic Model Execute Queries REST API"\. Couldn't confirm "Create workspaces": it excludes the group "Finance", which you're in only through another group\./);

  const absent = (await run({ tenantSettings: async () => [{ ...executeQueries, enabled: true }] }))['tenant-settings'];
  assert.equal(absent.status, 'unknown', 'not in a list that has others isn\'t on');
  assert.match(absent.detail, /Couldn't confirm "Create workspaces": it isn't among the tenant settings Fabric returned\./);

  const empty = (await run({ tenantSettings: async () => [] }))['tenant-settings'];
  assert.equal(empty.status, 'unknown', 'an empty list isn\'t "on"');
  assert.match(empty.detail, /^Couldn't check: Fabric returned no tenant settings\. Ask a Fabric administrator to confirm these are on for you, or for a group you're in: "Create workspaces" \(only to create a new workspace/);

  const recorded = emptyConfig();
  recorded.fabric.workspaceId = 'ws-1';
  const refused = async () => [{ settingName: 'CreateAppWorkspaces', title: 'Create workspaces', enabled: false }];
  assert.equal((await run({ tenantSettings: refused }, recorded))['tenant-settings'].status, 'met', 'a recorded workspace needs no new one');
  assert.equal((await run({ subs: [], tenantSettings: refused }, azureConfig({ powerBi: { workspaceId: 'pbi-ws-1' } })))['tenant-settings'].status, 'met', 'nor on Azure');
  assert.equal((await run({ subs: [], tenantSettings: refused }, azureConfig()))['tenant-settings'].status, 'missing', 'Azure creates a Power BI workspace too');

  const unread = { myDirectGroupIds: async () => { throw new HttpError('403', { method: 'GET', url: 'x', status: 403 }); } };
  const whole = await runWith({ tenantSettings: async () => [{ settingName: 'CreateAppWorkspaces', title: 'Create workspaces', enabled: true }] }, emptyConfig(), unread);
  assert.equal(whole['tenant-settings'].status, 'met', 'your groups are read only when the setting names some');
  const scoped = await runWith({ tenantSettings: async () => [{ settingName: 'CreateAppWorkspaces', title: 'Create workspaces', enabled: true, enabledSecurityGroups: [group('group-1', 'Analysts')] }] }, emptyConfig(), unread);
  assert.equal(scoped['tenant-settings'].status, 'unknown');
  assert.match(scoped['tenant-settings'].detail, /Couldn't confirm "Create workspaces": it's on only for some security groups, and the installer couldn't read the groups you're in\./);
});

test('checkPrereqs: with no capacity to create a workspace on, an Admin or Member workspace on a capacity is enough', async () => {
  /** @param {string} id @param {string} [capacityId] */
  const ws = (id, capacityId) => ({ id, displayName: `WS ${id}`, type: 'Workspace', capacityId });
  const over = { capacities: [], workspaces: [ws('a', 'cap-x'), ws('b'), { ...ws('c', 'cap-y'), type: 'Personal' }] };
  const r = await run(over);
  assert.deepEqual(/** @type {any} */ (over).askedRoles, ['Admin', 'Member']);
  assert.equal(r['fabric-capacity'].status, 'met');
  assert.match(r['fabric-capacity'].detail, /^No capacity you can create a workspace on, but you can use a workspace that's already on one: "WS a"\. The installer can't create a new workspace, and can't check that capacity's size or state\./);

  const none = await run({ capacities: [], workspaces: [ws('b')] });
  assert.equal(none['fabric-capacity'].status, 'missing');
  assert.match(none['fabric-capacity'].howTo, /you need to be that capacity's admin or contributor\. Ask its capacity admin, or start a Fabric trial: https:\/\/learn\.microsoft\.com\/fabric\/fundamentals\/fabric-trial Or ask to be an Admin or Member of a workspace that's already on a capacity\./);

  const paused = await run({ capacities: [{ id: 'CAP-X', sku: 'F2', state: 'Suspended' }], workspaces: [ws('a', 'cap-x')] });
  assert.equal(paused['fabric-capacity'].status, 'missing', 'a workspace on a paused capacity doesn\'t count');

  const config = emptyConfig();
  config.fabric.workspaceId = 'b';
  assert.equal((await run({ capacities: [], workspaces: [ws('a', 'cap-x'), ws('b')] }, config))['fabric-capacity'].status, 'missing', 'only the recorded workspace counts');
  config.fabric.workspaceId = 'a';
  assert.equal((await run({ capacities: [], workspaces: [ws('a', 'cap-x')] }, config))['fabric-capacity'].status, 'met');
});

test('checkPrereqs: Microsoft 365 Copilot licences in the tenant are met once any are assigned', async () => {
  const copilot = (/** @type {number} */ consumedUnits, sku = 'Microsoft_365_Copilot') => ({ skuPartNumber: sku, capabilityStatus: 'Enabled', consumedUnits, prepaidUnits: { enabled: 100 }, servicePlans: [{ servicePlanName: 'M365_COPILOT_APPS' }] });
  const none = await run({ skus: [{ skuPartNumber: 'SPE_E5', consumedUnits: 50, servicePlans: [{ servicePlanName: 'EXCHANGE_S_ENTERPRISE' }] }] });
  assert.equal(none['copilot-licences'].status, 'missing');
  assert.match(none['copilot-licences'].detail, /No Microsoft 365 Copilot licences/);
  const bought = await run({ skus: [copilot(0)] });
  assert.equal(bought['copilot-licences'].status, 'missing');
  assert.match(bought['copilot-licences'].detail, /Microsoft_365_Copilot, but none are assigned/);
  const used = await run({ skus: [copilot(30), copilot(5, 'Microsoft_365_Copilot_EDU')] });
  assert.equal(used['copilot-licences'].status, 'met');
  assert.match(used['copilot-licences'].detail, /35 assigned \(Microsoft_365_Copilot, Microsoft_365_Copilot_EDU\)/);
  const unreadable = await run({ skusFn: async () => { throw new HttpError('403', { method: 'GET', url: 'x', status: 403 }); } });
  assert.equal(unreadable['copilot-licences'].status, 'unknown');
});

test('canAssignDirectoryRoles: true only with Global Administrator or Privileged Role Administrator active', async () => {
  assert.equal(await canAssignDirectoryRoles(fakeApis()), true);
  assert.equal(await canAssignDirectoryRoles(fakeApis({ roles: [{ roleTemplateId: 'e8611ab8-c189-46e8-94e1-60213ab1f814', displayName: 'Privileged Role Administrator' }] })), true);
  assert.equal(await canAssignDirectoryRoles(fakeApis({ roles: [{ roleTemplateId: FABRIC_ADMIN_ROLE, displayName: 'Fabric Administrator' }] })), false);
  assert.equal(await canAssignDirectoryRoles(fakeApis({ roles: [] })), false);
});

/** @param {Partial<import('../src/prereqs.js').Prereq> & { id: string }} p @returns {import('../src/prereqs.js').Prereq} */
const row = (p) => ({ label: p.id, detail: '', neededFor: 'x', howTo: `how to fix ${p.id}`, status: 'missing', ...p });

/** A Fabric config with no flows, Agent Evaluator, credit consumption or semantic model. */
const plainConfig = () => {
  const config = emptyConfig();
  Object.assign(config.dataSources, { productFeedback: 'csv', studioCredits: 'csv', resourceGraph: 'off' });
  config.modules.agentEvaluator = false;
  config.modules.consumption = false;
  config.semanticModel.enabled = false;
  assert.deepEqual(flowsWanted(config), []);
  return config;
};

/** A preflight ctx on the fake APIs, with a UI that records what it prints. @param {any} [over] @param {{ yes?: boolean, config?: any, answers?: any[] }} [o] */
const preflightCtx = (over = {}, o = {}) => {
  const t = fakeUi({ yes: o.yes, answers: o.answers });
  const ctx = /** @type {any} */ ({ ui: t.ui, api: fakeApis(over), user: USER, config: o.config ?? plainConfig() });
  return { ctx, t };
};

/** plainConfig with only the Copilot Studio credits flow, made in an environment called Sales. */
const studioConfig = () => {
  const config = plainConfig();
  config.dataSources.studioCredits = 'api';
  config.uploads = { flowEnvironment: { url: 'https://org1.crm.dynamics.com', id: 'env-1', name: 'Sales' } };
  assert.deepEqual(flowsWanted(config), ['studio']);
  return config;
};

const PP_ADMIN = '11648597-926c-4cf3-9c36-bcebb0ba8dcc';
const DATA_POLICY_DETAIL = 'Couldn\'t check: the installer can\'t read data policies (DLP). If one blocks the flows\' connectors, or puts them in different data groups, Power Automate won\'t save the flows or turn them on.';

test('checkPrereqs: the data policy row shows only with the flows, is "couldn\'t check" for everyone, and names the connectors, addresses and environment to confirm', async () => {
  assert.equal((await run({}, plainConfig()))['data-policy'], undefined, 'no flows, no row');
  const config = studioConfig();
  const people = {
    'a Global Administrator': {},
    'a Power Platform Administrator': { roles: [role(PP_ADMIN, 'Power Platform Administrator')] },
    'someone with no admin roles': { roles: [] },
    'someone in no environment': { roles: [], envs: [] },
    'someone whose checks fail': { roles: [], licences: [], envs: [], eligible: async () => { throw new HttpError('403', { method: 'GET', url: 'x', status: 403 }); } },
  };
  for (const [who, over] of Object.entries(people)) {
    const it = (await run(over, config))['data-policy'];
    assert.equal(it.status, 'unknown', who);
    assert.equal(it.label, 'Data policy');
    assert.equal(it.optional, undefined, 'not tagged optional, beside a detail saying Power Automate won\'t save the flows');
    assert.equal(it.who, 'A Power Platform administrator');
    assert.equal(it.detail, DATA_POLICY_DETAIL);
    assert.equal(it.neededFor, 'Only the Power Automate flows: Analytics Hub - Copilot Studio credits.');
    assert.equal(it.howTo, dataPolicyAsk(config));
    assert.equal(
      it.howTo,
      'Ask a Power Platform administrator to confirm that HTTP with Microsoft Entra ID (preauthorized) is allowed in Sales. If the policy filters endpoints for HTTP with Microsoft Entra ID (preauthorized), it must allow https://api.powerplatform.com and https://onelake.dfs.fabric.microsoft.com.',
    );
  }

  // The ask follows the flows chosen, the target and the flow identity.
  const app = studioConfig();
  app.dataSources.productFeedback = 'api';
  app.uploads.flowIdentity = 'app';
  const appRow = (await run({}, app))['data-policy'];
  assert.equal(appRow.neededFor, 'Only the Power Automate flows: Analytics Hub - Product feedback, Analytics Hub - Copilot Studio credits.');
  assert.match(appRow.howTo, /^Ask a Power Platform administrator to confirm that HTTP with Microsoft Entra ID \(preauthorized\), HTTP, Office 365 Outlook and Azure Key Vault are allowed and in the same data group \(Business or Non-business\) in Sales\. If the policy filters endpoints for HTTP or HTTP with Microsoft Entra ID \(preauthorized\), it must allow https:\/\/api\.powerplatform\.com and https:\/\/onelake\.blob\.fabric\.microsoft\.com\.$/);
  const azure = studioConfig();
  azure.target = 'azure';
  azure.modules.consumption = true;
  azure.azure = /** @type {any} */ ({ outputs: { storageAccountName: 'acct' } });
  assert.deepEqual(flowsWanted(azure), ['studio']);
  assert.match((await run({}, azure))['data-policy'].howTo, /it must allow https:\/\/api\.powerplatform\.com and https:\/\/acct\.dfs\.core\.windows\.net\.$/);
});

test('checkPrereqs: a Power Platform Administrator role you can only activate warns that the flows\' connection needs it active whenever they run, without claiming how long an activation lasts', async () => {
  const eligible = async () => [{ roleDefinitionId: PP_ADMIN, principalId: USER.id }];
  const notSysAdmin = [{ Url: 'https://org1.crm.dynamics.com', FriendlyName: 'Default', State: 0, IsUserSysAdmin: false }];
  const warning = ' The flows\' Power Platform API connection needs the role active whenever the flows run, and an activation lasts at most 24 hours, as your organisation sets it. Have someone with the role assigned permanently sign in to that connection.';
  for (const envs of [notSysAdmin, undefined]) {
    const it = (await run({ roles: [], eligible, envs }, studioConfig()))['power-platform-admin'];
    assert.equal(it.status, 'eligible', 'a System Administrator in an environment still has the role to activate');
    assert.match(it.detail, /^Not active yet: Power Platform Administrator\. You can activate this role in Entra \(Privileged Identity Management\): https:\/\/entra\.microsoft\.com\//);
    assert.ok(it.detail.endsWith(warning), it.detail);
    assert.doesNotMatch(it.detail, /default|\b8 hours/i, 'the organisation sets how long an activation lasts');
  }

  // Without a flow that signs in to the Power Platform API, there's nothing to warn about.
  const feedback = plainConfig();
  feedback.dataSources.productFeedback = 'api';
  for (const config of [plainConfig(), feedback]) {
    const it = (await run({ roles: [], eligible, envs: notSysAdmin }, config))['power-platform-admin'];
    assert.equal(it.status, 'eligible');
    assert.doesNotMatch(it.detail, /at most 24 hours/);
  }
  // An active role needs no warning.
  const active = (await run({ roles: [role(PP_ADMIN, 'Power Platform Administrator')] }, studioConfig()))['power-platform-admin'];
  assert.equal(active.status, 'met');
  assert.doesNotMatch(active.detail, /at most 24 hours/);
});

test('preflightVerdict: a Power Platform Administrator role you can only activate shows while a flow signs in to the Power Platform API, even as a System Administrator', () => {
  const items = [row({ id: 'power-platform-admin', status: 'eligible', optional: true }), row({ id: 'environments', status: 'met', optional: true })];
  assert.deepEqual(preflightVerdict(items, { config: studioConfig() }).warn.map((it) => it.id), ['power-platform-admin']);
  const feedback = plainConfig();
  feedback.dataSources.productFeedback = 'api';
  assert.deepEqual(preflightVerdict(items, { config: feedback }).warn, [], 'the feedback flow has no Power Platform API connection');
  assert.deepEqual(preflightVerdict(items, { config: plainConfig() }).warn, []);
});

test('preflightVerdict: the data policy row is one to confirm whenever flows are chosen; it never blocks, never needs attention and isn\'t a hand-off, even with --yes', () => {
  const policy = row({ id: 'data-policy', label: 'Data policy', status: 'unknown' });
  const unread = [row({ id: 'copilot-licences', status: 'unknown', optional: true }), row({ id: 'power-automate-premium', status: 'unknown', optional: true })];
  for (const opts of [{}, { yes: true }, { update: true }, { yes: true, update: true }]) {
    const v = preflightVerdict([policy, ...unread], { config: studioConfig(), ...opts });
    assert.deepEqual([v.block, v.warn, v.handoff], [[], [], []], JSON.stringify(opts));
    assert.deepEqual(v.confirm.map((it) => it.id), ['data-policy'], 'other optional rows that couldn\'t be checked stay out');
  }
  assert.deepEqual(preflightVerdict([policy], { config: plainConfig() }).confirm, [], 'no flows, nothing to confirm');

  // With --yes, can't-register-apps still blocks on its own.
  const v = preflightVerdict([row({ id: 'register-apps' }), policy], { config: studioConfig(), yes: true });
  assert.deepEqual(v.block.map((it) => it.id), ['register-apps']);
  assert.deepEqual(v.confirm.map((it) => it.id), ['data-policy']);
});

test('reportPreflight: the data policy row prints last, as one to confirm, and the install carries on, even with --yes', () => {
  const policy = row({ id: 'data-policy', label: 'Data policy', status: 'unknown', detail: DATA_POLICY_DETAIL, howTo: 'Ask a Power Platform administrator to confirm.' });
  for (const yes of [false, true]) {
    const t = fakeUi({ yes });
    const v = reportPreflight(/** @type {any} */ ({ ui: t.ui, config: studioConfig() }), [row({ id: 'register-apps', status: 'met' }), policy]);
    assert.deepEqual([v.block, v.warn, v.handoff, v.confirm.map((it) => it.id)], [[], [], [], ['data-policy']]);
    const text = t.text();
    assert.match(text, /Prerequisites: nothing missing for what you chose\n/);
    assert.match(text, /To confirm: the installer can't check this\.\n/);
    assert.match(text, /\? Data policy\n/);
    assert.doesNotMatch(text, /optional/, 'not tagged optional');
    assert.match(text, /Couldn't check: the installer can't read data policies \(DLP\)\./);
    assert.match(text, /How to get it: Ask a Power Platform administrator to confirm\.\n/);
    assert.doesNotMatch(text, /needs? attention|Hand-off|Stopped before creating anything/);
  }

  // After what needs attention and the hand-offs, and before the pointer to the full list.
  const t = fakeUi();
  const consent = row({ id: 'consent-role', label: 'Can grant admin consent', status: 'handoff', optional: true });
  reportPreflight(/** @type {any} */ ({ ui: t.ui, config: studioConfig() }), [row({ id: 'power-bi-pro', label: 'Power BI Pro' }), consent, policy]);
  const text = t.text();
  assert.match(text, /1 prerequisite needs attention\. The install carries on\./);
  assert.equal(text.split('carries on.').length - 1, 1, 'said once');
  const order = ['Power BI Pro', 'Hand-off: someone else does this.', 'To confirm: the installer can\'t check this.', 'for the full list'].map((s) => text.indexOf(s));
  assert.ok(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1])), text);
});

test('preflight: with the flows chosen, the data policy ask shows before anything is created, and --yes doesn\'t stop on it', async () => {
  for (const yes of [false, true]) {
    const { ctx, t } = preflightCtx({}, { yes, config: studioConfig() });
    await preflight(ctx);
    const text = t.text();
    assert.match(text, /To confirm: the installer can't check this\./);
    assert.match(text, /\? Data policy\n/);
    assert.doesNotMatch(text, /Data policy \(optional\)/);
    assert.ok(text.includes(dataPolicyAsk(ctx.config)));
    assert.doesNotMatch(text, /Stopped before creating anything/);
  }
  const { ctx, t } = preflightCtx({});
  await preflight(ctx);
  assert.doesNotMatch(t.text(), /Data policy/, 'no flows, no row');
});

test('preflightVerdict: shows only what needs attention for what was chosen; met, hidden and optional "couldn\'t check" rows stay out', () => {
  const config = plainConfig();
  const items = [
    row({ id: 'consent-role', optional: true }),
    row({ id: 'fabric-admin', optional: true }),
    row({ id: 'power-platform-admin', optional: true }),
    row({ id: 'register-apps', status: 'met' }),
    row({ id: 'audit-ingestion' }),
    row({ id: 'power-bi-pro', status: 'unknown' }),
    row({ id: 'copilot-licences', optional: true }),
    row({ id: 'power-automate-premium', optional: true }),
    row({ id: 'fabric-capacity' }),
    row({ id: 'azure-rbac', optional: true }),
    row({ id: 'key-vault', status: 'eligible', optional: true }),
    row({ id: 'environments', optional: true }),
    row({ id: 'viva-analyst', status: 'unknown', optional: true }),
    row({ id: 'tenant-settings', status: 'unknown' }),
  ];
  const v = preflightVerdict(items, { config });
  assert.deepEqual(v.block, []);
  assert.deepEqual(v.handoff, []);
  assert.deepEqual(v.warn.map((it) => it.id), ['consent-role', 'audit-ingestion', 'power-bi-pro', 'copilot-licences', 'key-vault'],
    'the capacity (preflight stops on it itself), the Fabric admin role and the Viva analyst role are left out, and so are flows, environments, Azure access and unreadable tenant settings, none of which this install uses');

  // Consent already granted: the role to grant it doesn't matter.
  const consented = preflightVerdict(items.map((it) => (it.id === 'audit-ingestion' ? { ...it, status: /** @type {const} */ ('met') } : it)), { config });
  assert.ok(!consented.warn.some((it) => it.id === 'consent-role'));

  // With the flows, Agent Evaluator, credit consumption and the model on, their rows show.
  const full = plainConfig();
  Object.assign(full.dataSources, { productFeedback: 'api' });
  full.keyVault.mode = 'keyvault';
  full.modules.agentEvaluator = true;
  full.modules.consumption = true;
  full.semanticModel.enabled = true;
  assert.ok(flowsWanted(full).length);
  assert.deepEqual(preflightVerdict(items, { config: full }).warn.map((it) => it.id),
    ['consent-role', 'power-platform-admin', 'audit-ingestion', 'power-bi-pro', 'copilot-licences', 'power-automate-premium', 'azure-rbac', 'key-vault', 'environments', 'tenant-settings']);
  // System Administrator in an environment already: the Power Platform Administrator role isn't needed.
  const sysAdmin = preflightVerdict(items.map((it) => (it.id === 'environments' ? { ...it, status: /** @type {const} */ ('met') } : it)), { config: full });
  assert.ok(!sysAdmin.warn.some((it) => it.id === 'power-platform-admin'));
});

test('preflightVerdict: only can\'t-register-apps with --yes blocks an install; "couldn\'t check" and update never block', () => {
  const config = plainConfig();
  const cant = [row({ id: 'register-apps' })];
  assert.deepEqual(preflightVerdict(cant, { config }).block, [], 'asked, the plan offers an app you already have or the admin pack');
  assert.deepEqual(preflightVerdict(cant, { config, yes: true }).block.map((it) => it.id), ['register-apps']);
  assert.deepEqual(preflightVerdict(cant, { config, yes: true, update: true }).block, [], 'an update never blocks');
  assert.deepEqual(preflightVerdict([row({ id: 'register-apps', status: 'unknown' })], { config, yes: true }).block, [], '"couldn\'t check" never blocks');
  const brought = plainConfig();
  brought.app.appId = 'app-1';
  assert.deepEqual(preflightVerdict(cant, { config: brought, yes: true }).block, []);
  const pack = plainConfig();
  pack.app.adminPack = '/records/analytics-hub-admin-pack.md';
  assert.deepEqual(preflightVerdict(cant, { config: pack, yes: true }).block, []);
  // Everything else only warns, even with --yes.
  const missing = ['audit-ingestion', 'power-bi-pro', 'tenant-settings', 'key-vault', 'consent-role'].map((id) => row({ id }));
  assert.deepEqual(preflightVerdict(missing, { config, yes: true }).block, []);
  // A hand-off never blocks, even with --yes, and isn't something that needs attention.
  const handedOff = preflightVerdict([...cant, row({ id: 'consent-role', status: 'handoff', optional: true })], { config, yes: true });
  assert.deepEqual(handedOff.block.map((it) => it.id), ['register-apps']);
  assert.deepEqual(handedOff.warn, []);
  assert.deepEqual(handedOff.handoff.map((it) => it.id), ['consent-role']);
});

test('preflightVerdict: on Azure, can\'t-register-apps never blocks, even with --yes: the plan has an admin create the apps and stops before deploying', () => {
  const cant = [row({ id: 'register-apps' })];
  for (const opts of [{}, { yes: true }]) {
    const v = preflightVerdict(cant, { config: azureConfig(), ...opts });
    assert.deepEqual(v.block, [], JSON.stringify(opts));
    assert.deepEqual(v.warn.map((it) => it.id), ['register-apps']);
  }
  assert.deepEqual(preflightVerdict(cant, { config: plainConfig(), yes: true }).block.map((it) => it.id), ['register-apps'], 'Fabric is as before');
});

test('preflightVerdict: on Azure the consent row is the web app\'s, so it shows whether or not the audit role is met', () => {
  const items = [row({ id: 'consent-role', status: 'handoff', optional: true }), row({ id: 'audit-ingestion', status: 'met' })];
  assert.deepEqual(preflightVerdict(items, { config: azureConfig() }).handoff.map((it) => it.id), ['consent-role']);
  assert.deepEqual(preflightVerdict(items, { config: plainConfig() }).handoff, [], 'on Fabric the app\'s consent includes the audit role');
});

test('preflightVerdict: a hand-off never blocks and never needs attention; it shows only for what was chosen', () => {
  const items = [
    row({ id: 'consent-role', status: 'handoff', optional: true }),
    row({ id: 'fabric-admin', status: 'handoff', optional: true }),
    row({ id: 'power-platform-admin', status: 'handoff', optional: true }),
    row({ id: 'register-apps', status: 'met' }),
    row({ id: 'audit-ingestion', status: 'handoff' }),
    row({ id: 'environments', status: 'met', optional: true }),
    row({ id: 'viva-analyst', status: 'handoff', optional: true }),
  ];
  const config = plainConfig();
  for (const opts of [{}, { yes: true }, { update: true }, { yes: true, update: true }]) {
    const v = preflightVerdict(items, { config, ...opts });
    assert.deepEqual(v.block, [], JSON.stringify(opts));
    assert.deepEqual(v.warn, [], JSON.stringify(opts));
    assert.deepEqual(v.handoff.map((it) => it.id), ['consent-role', 'audit-ingestion'],
      'the Fabric admin role stays hidden; no flow signs in to the Power Platform API; Cowork credits don\'t come from Viva Insights');
  }
  // Consent already granted: nothing to hand off for it.
  const consented = preflightVerdict(items.map((it) => (it.id === 'audit-ingestion' ? { ...it, status: /** @type {const} */ ('met') } : it)), { config });
  assert.deepEqual(consented.handoff, []);

  // The Power Platform administrator only signs in to the Power Platform API connection, which Copilot Studio credits' flow uses and feedback's doesn't.
  const studio = plainConfig();
  studio.dataSources.studioCredits = 'api';
  assert.deepEqual(ppApiFlows(studio), ['studio']);
  assert.ok(preflightVerdict(items, { config: studio }).handoff.some((it) => it.id === 'power-platform-admin'));
  const feedback = plainConfig();
  feedback.dataSources.productFeedback = 'api';
  assert.ok(flowsWanted(feedback).length && !ppApiFlows(feedback).length);
  assert.ok(!preflightVerdict(items, { config: feedback }).handoff.some((it) => it.id === 'power-platform-admin'));

  // The Viva Insights analyst only for Cowork credits read from Viva Insights, on Fabric.
  const viva = plainConfig();
  viva.modules.consumption = true;
  viva.dataSources.coworkCredits = 'api';
  assert.ok(preflightVerdict(items, { config: viva }).handoff.some((it) => it.id === 'viva-analyst'));
  viva.dataSources.coworkCredits = 'csv';
  assert.ok(!preflightVerdict(items, { config: viva }).handoff.some((it) => it.id === 'viva-analyst'));
  const azure = plainConfig();
  azure.target = 'azure';
  azure.modules.consumption = true;
  azure.dataSources.coworkCredits = 'api';
  assert.ok(!preflightVerdict(items, { config: azure }).handoff.some((it) => it.id === 'viva-analyst'));
});

test('checkPrereqs: a check that takes too long is "couldn\'t check" rather than holding preflight up', async () => {
  const never = () => new Promise(() => {});
  const started = Date.now();
  const items = await checkPrereqs({ api: fakeApis({ roles: [], licences: undefined, envs: undefined }), user: USER, config: plainConfig() }, { timeoutMs: 20 });
  assert.ok(items.every((it) => it.status !== 'unknown' || !/longer than/.test(it.detail)), 'nothing slow, nothing timed out');
  const slow = fakeApis();
  slow.graph.myLicenseDetails = never;
  slow.graph.usersCanRegisterApps = never;
  slow.graph.myDirectoryRoles = async () => [];
  const timed = Object.fromEntries((await checkPrereqs({ api: slow, user: USER, config: plainConfig() }, { timeoutMs: 20 })).map((i) => [i.id, i]));
  assert.equal(timed['power-bi-pro'].status, 'unknown');
  assert.equal(timed['power-bi-pro'].detail, 'Couldn\'t check: it took longer than 20 ms');
  assert.equal(timed['register-apps'].status, 'unknown');
  assert.equal(timed['fabric-capacity'].status, 'met', 'the others still answer');
  assert.ok(Date.now() - started < 5000);
  assert.deepEqual(preflightVerdict(Object.values(timed), { config: plainConfig(), yes: true }).block, [], 'a timeout never blocks');
});

test('preflight: prints only the prerequisites that need attention, then the hand-offs, before the plan, and carries on', async () => {
  const { ctx, t } = preflightCtx({ roles: [], usersCanRegister: false });
  const pre = await preflight(ctx);
  assert.equal(pre.canCreateApps, false);
  const text = t.text();
  assert.match(text, /2 prerequisites need attention\. The install carries on\./);
  assert.match(text, /Register apps in Entra/);
  assert.match(text, /Hand-off: someone else does this\.\n/);
  assert.equal(text.split('The install carries on.').length - 1, 1, 'said once, on the attention line');
  assert.match(text, /You don't need this yourself: the installer gives you an admin consent link to send, and carries on\. That consent includes AuditLogsQuery\.Read\.All: until it's approved, the audit load finds 0 records\.\n/);
  assert.match(text, /Who does it: A Privileged Role Administrator or Global Administrator approves the app's Microsoft Graph permissions from the installer's consent link\. An Application Administrator or Cloud Application Administrator can't: https:\/\/learn\.microsoft\.com\/entra\/identity\/enterprise-apps\/grant-admin-consent A Compliance Administrator checks audit logging is on/);
  assert.doesNotMatch(text, /Audit log access for Copilot interactions/, 'on Fabric the consent is one ask, not two');
  assert.doesNotMatch(text, /Power BI Pro or Premium Per User licence/, 'met rows stay out');
  assert.doesNotMatch(text, /Viva Insights analyst/, 'Cowork credits don\'t come from Viva Insights');
  assert.match(text, /prereqs" for the full list/);
  assert.doesNotMatch(text, /You can't grant admin consent for Microsoft Graph/, 'the list says it once');
  assert.ok(text.indexOf('Register apps in Entra') > text.indexOf('active Fabric capacity'), 'after the tenant checks');
  assert.ok(text.indexOf('Hand-off: someone else does this') > text.indexOf('Register apps in Entra'), 'hand-offs after what needs attention');
});

test('preflight: with --yes, no way to register the app stops it before anything is created, and says a custom role can still create it without --yes', async () => {
  const { ctx, t } = preflightCtx({ roles: [], usersCanRegister: false }, { yes: true });
  await assert.rejects(preflight(ctx), (err) => {
    assert.equal(
      /** @type {Error} */ (err).message,
      'Users in this tenant can\'t register apps and you have no app admin role, so with --yes the installer can\'t create its app registration. ' +
        'Run it without --yes to use an app registration you already have, or to choose "An admin will register the app for me", which puts the script for an admin in the admin pack. Or ask for the Application Administrator or Cloud Application Administrator role. ' +
        `The installer can't see custom roles: if one lets you register apps, run "${commandLine('install')}" again without --yes, and choose to create it yourself.`,
    );
    return true;
  });
  assert.match(t.text(), /Stopped before creating anything: Register apps in Entra\./);
});

test('preflight: on Azure with --yes, no way to register apps doesn\'t stop preflight: the plan has an admin create them', async () => {
  const { ctx, t } = preflightCtx({ roles: [], usersCanRegister: false }, { yes: true, config: azureConfig() });
  const pre = await preflight(ctx);
  assert.equal(pre.canCreateApps, false);
  assert.match(t.text(), /Register apps in Entra/);
  assert.doesNotMatch(t.text(), /Stopped before creating anything/);
});

test('preflight: an Application Developer can create the apps and a Privileged Role Administrator alone can\'t, on Fabric and Azure', async () => {
  for (const config of [plainConfig(), azureConfig()]) {
    const dev = preflightCtx({ roles: [role(APP_DEVELOPER, 'Application Developer')], usersCanRegister: false }, { config });
    const canDo = await preflight(dev.ctx);
    assert.equal(canDo.canCreateApps, true, config.target);
    assert.equal(canDo.canApproveDelegated, false, 'an Application Developer can\'t grant consent');
    const pra = preflightCtx({ roles: [role(PRA, 'Privileged Role Administrator')], usersCanRegister: false }, { config });
    const pre = await preflight(pra.ctx);
    assert.equal(pre.canCreateApps, false, config.target);
    assert.equal(pre.canConsent, true, 'a Privileged Role Administrator still grants Microsoft Graph consent');
    assert.equal(pre.canApproveDelegated, true);
    assert.equal(pre.canManageApps, false);
  }
});

test('preflight: the list prints before preflight\'s own stops, such as no Fabric capacity', async () => {
  const { ctx, t } = preflightCtx({ roles: [], usersCanRegister: false, capacities: [] });
  await assert.rejects(preflight(ctx), (err) => {
    const message = /** @type {Error} */ (err).message;
    assert.match(message, /you need to be that capacity's admin or contributor: ask its capacity admin, or start a Fabric trial\./);
    assert.match(message, /Or ask to be an Admin or Member of a workspace that's already on a capacity\./);
    return true;
  });
  const text = t.text();
  assert.ok(text.indexOf('Register apps in Entra') >= 0 && text.indexOf('Register apps in Entra') < text.indexOf('No active Fabric capacity you can use.'));
  assert.doesNotMatch(text, /Active Fabric capacity\n/, 'preflight says it itself, once');
});

test('preflight: with no capacity to create a workspace on, an Admin or Member workspace on a capacity is enough, except with --yes and none recorded, where the stop names both ways forward', async () => {
  const workspaces = [{ id: 'ws-a', displayName: 'Team analytics', type: 'Workspace', capacityId: 'cap-x', capacityRegion: 'North Europe' }];
  const { ctx, t } = preflightCtx({ capacities: [], workspaces });
  const pre = await preflight(ctx);
  assert.deepEqual(pre.capacities, []);
  assert.deepEqual(pre.workspacesOnCapacity?.map((w) => w.id), ['ws-a']);
  assert.match(t.text(), /No capacity you can create a workspace on, but 1 workspace you're an Admin or Member of is already on one/);

  const yes = preflightCtx({ capacities: [], workspaces }, { yes: true });
  await assert.rejects(preflight(yes.ctx), (err) => {
    assert.equal(
      /** @type {Error} */ (err).message,
      'With --yes the installer can\'t choose a workspace for you, and it can only create one on a capacity you\'re an admin or contributor of. ' +
        'Run it without --yes to choose a workspace you\'re an Admin or Member of that\'s already on a capacity. ' +
        'Or ask a capacity admin to make you that capacity\'s admin or contributor, or start a Fabric trial, then run it again.',
    );
    return true;
  });
  assert.match(yes.t.text(), /No Fabric capacity you can create a workspace on\./);

  const config = plainConfig();
  config.fabric.workspaceId = 'ws-a';
  const recorded = preflightCtx({ capacities: [], workspaces }, { yes: true, config });
  const again = await preflight(recorded.ctx);
  assert.deepEqual(again.workspacesOnCapacity?.map((w) => w.id), ['ws-a'], 'a recorded workspace on a capacity passes, even with --yes');
  assert.match(recorded.t.text(), /the workspace "Team analytics" is already on one/);

  const offCapacity = preflightCtx({ capacities: [], workspaces: [{ id: 'ws-b', displayName: 'Shared', type: 'Workspace' }] });
  await assert.rejects(preflight(offCapacity.ctx), /Or ask to be an Admin or Member of a workspace that's already on a capacity/);
});

test('preflight: when "Create workspaces" leaves you out, --yes stops before anything is created and names both ways forward; without --yes the plan gets the reason', async () => {
  const settings = async () => [{ settingName: 'CreateAppWorkspaces', title: 'Create workspaces', enabled: true, excludedSecurityGroups: [{ graphId: 'group-1', name: 'Contractors' }] }];
  for (const target of ['fabric', 'azure']) {
    const config = () => (target === 'azure' ? azureConfig() : plainConfig());
    const yes = preflightCtx({ tenantSettings: settings }, { yes: true, config: config() });
    await assert.rejects(preflight(yes.ctx), (err) => {
      assert.equal(
        /** @type {Error} */ (err).message,
        'With --yes the installer creates a workspace. As a Fabric administrator, you can turn it on for you, or for a group you\'re in, in Fabric under Admin portal > Tenant settings. Then run it again. ' +
          'Or run it without --yes and choose an existing workspace you\'re an Admin or Member of.',
        target,
      );
      return true;
    });
    const text = yes.t.text();
    assert.match(text, /You can't create a workspace: "Create workspaces" excludes the group "Contractors", which you're in\./, target);
    assert.ok(text.indexOf('Fabric tenant settings') < text.indexOf('You can\'t create a workspace:'), 'after the prerequisites');

    const asked = preflightCtx({ tenantSettings: settings }, { config: config() });
    const pre = await preflight(asked.ctx);
    assert.deepEqual(pre.createWorkspaces, { status: 'missing', reason: '"Create workspaces" excludes the group "Contractors", which you\'re in.' }, target);
    assert.doesNotMatch(asked.t.text(), /You can't create a workspace:/, 'the workspace question says it');

    const recorded = config();
    if (target === 'azure') /** @type {any} */ (recorded.azure).powerBi = { workspaceId: 'pbi-ws-1' };
    else recorded.fabric.workspaceId = 'ws-1';
    const kept = preflightCtx({ tenantSettings: settings }, { yes: true, config: recorded });
    assert.equal((await preflight(kept.ctx)).createWorkspaces, undefined, `${target}: a recorded workspace needs no new one`);

    for (const tenantSettings of [undefined, async () => []]) {
      const unread = preflightCtx({ tenantSettings }, { yes: true, config: config() });
      assert.equal((await preflight(unread.ctx)).createWorkspaces, undefined, `${target}: settings it can't read don't stop it`);
    }
  }
});

test('reportPreflight: nothing missing says so; an update warns and carries on; no checks says where to find them', () => {
  const met = fakeUi();
  reportPreflight(/** @type {any} */ ({ ui: met.ui, config: plainConfig() }), [row({ id: 'register-apps', status: 'met' })]);
  assert.match(met.text(), /Prerequisites: nothing missing for what you chose/);

  const upd = fakeUi({ yes: true });
  const v = reportPreflight(/** @type {any} */ ({ ui: upd.ui, config: plainConfig() }), [row({ id: 'register-apps' })], { update: true });
  assert.deepEqual(v.block, []);
  assert.match(upd.text(), /1 prerequisite needs attention\. The update carries on\./);

  const none = fakeUi();
  reportPreflight(/** @type {any} */ ({ ui: none.ui, config: plainConfig() }), null);
  assert.match(none.text(), /Couldn't check the prerequisites\. Run ".*prereqs" for the full list\./);
});

test('reportPreflight: hand-offs print on their own after what needs attention; the Fabric consent is one ask, Azure\'s are two', () => {
  const consent = row({ id: 'consent-role', label: 'Can grant admin consent', status: 'handoff', optional: true, detail: 'You don\'t need this yourself.', howTo: 'A Privileged Role Administrator approves the app\'s Microsoft Graph permissions.' });
  const audit = row({ id: 'audit-ingestion', label: 'Audit log access', status: 'handoff', detail: 'Not granted yet.', howTo: 'Approve it.' });

  const only = fakeUi();
  const v = reportPreflight(/** @type {any} */ ({ ui: only.ui, config: plainConfig() }), [row({ id: 'register-apps', status: 'met' }), consent, audit]);
  const text = only.text();
  assert.doesNotMatch(text, /nothing missing/, 'there is something to do: hand it off');
  assert.match(text, /Prerequisites: you have what you need yourself/);
  assert.match(text, /Hand-off: someone else does this\. The install carries on\./);
  assert.match(text, /Can grant admin consent/);
  assert.match(text, /That consent includes AuditLogsQuery\.Read\.All: until it's approved, the audit load finds 0 records\./);
  assert.match(text, /Who does it: A Privileged Role Administrator approves the app's Microsoft Graph permissions\. A Compliance Administrator checks audit logging is on/);
  assert.match(text, /check-audit/);
  assert.doesNotMatch(text, /Audit log access/);
  assert.deepEqual(v.handoff.map((it) => it.id), ['consent-role']);
  assert.deepEqual([v.block, v.warn], [[], []]);

  const azure = plainConfig();
  azure.target = 'azure';
  const az = fakeUi();
  const both = reportPreflight(/** @type {any} */ ({ ui: az.ui, config: azure }), [consent, audit]);
  assert.deepEqual(both.handoff.map((it) => it.id), ['consent-role', 'audit-ingestion'], 'the web app\'s consent, and the jobs\' managed identity\'s Graph role');
  assert.match(az.text(), /Hand-offs: someone else does these\. The install carries on\./);
  assert.match(az.text(), /Audit log access/);
  assert.doesNotMatch(az.text(), /That consent includes/);

  const blocked = fakeUi({ yes: true });
  assert.throws(() => reportPreflight(/** @type {any} */ ({ ui: blocked.ui, config: plainConfig() }), [row({ id: 'register-apps', label: 'Register apps in Entra' }), consent]), /can't create its app registration/);
  assert.match(blocked.text(), /1 prerequisite needs attention\.\n/);
  assert.match(blocked.text(), /Hand-off: someone else does this\.\n/, 'nothing carries on when something blocks');
  assert.ok(blocked.text().indexOf('Hand-off') < blocked.text().indexOf('Stopped before creating anything'));
});

test('reportPreflight: with rows that need attention and hand-offs, "carries on" is said once; on Fabric the audit note follows the consent sentence', () => {
  const unread = ' Couldn\'t check for roles you could activate yourself.';
  const consent = row({ id: 'consent-role', label: 'Global Administrator or Privileged Role Administrator', status: 'handoff', optional: true, detail: `You don't need this yourself: the installer gives you an admin consent link to send, and carries on.${unread}` });
  const audit = row({ id: 'audit-ingestion', label: 'Audit log access', status: 'handoff', detail: 'Not granted yet.' });
  const items = [row({ id: 'register-apps', label: 'Register apps in Entra' }), consent, audit];
  for (const update of [false, true]) {
    const word = update ? 'update' : 'install';
    const t = fakeUi({ yes: update });
    const v = reportPreflight(/** @type {any} */ ({ ui: t.ui, config: plainConfig() }), items, { update });
    const text = t.text();
    assert.deepEqual([v.block, v.warn.map((it) => it.id), v.handoff.map((it) => it.id)], [[], ['register-apps'], ['consent-role']]);
    assert.match(text, new RegExp(`1 prerequisite needs attention\\. The ${word} carries on\\.\\n`));
    assert.match(text, /Hand-off: someone else does this\.\n/);
    assert.equal(text.split(`The ${word} carries on.`).length - 1, 1, `said once, for the ${word}`);
    assert.match(text, /You don't need this yourself: the installer gives you an admin consent link to send, and carries on\. That consent includes AuditLogsQuery\.Read\.All: until it's approved, the audit load finds 0 records\. Couldn't check for roles you could activate yourself\.\n/);
  }
});

test('update: checks the prerequisites before changing anything, on Fabric and Azure, and never stops on them', async () => {
  const src = await readFile(new URL('../src/install.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('export async function update('), src.indexOf('export async function finishUpdate('));
  assert.match(body, /if \(config\.target === 'azure'\) \{\s*await updatePrereqs\(ctx\);\s*return azureUpdate\(ctx\);/);
  assert.ok(body.indexOf('await updatePrereqs(ctx);', body.indexOf('Nothing is installed yet')) < body.indexOf('ensureKeyVault(ctx)'));
  assert.match(src, /async function updatePrereqs\(ctx\) \{[^}]*reportPreflight\(ctx, await preflightChecks\(ctx\), \{ update: true \}\)/);
});

// A new terminal install checks the prerequisites before its plan asks about the flows. Once they're chosen, the rows
// for them that preflight would have shown, had they been chosen then, show before anything is created, and never stop it.

const PIM_WARNING = ' The flows\' Power Platform API connection needs the role active whenever the flows run, and an activation lasts at most 24 hours, as your organisation sets it. Have someone with the role assigned permanently sign in to that connection.';
const PREMIUM_ROW = '  ✗ Power Automate Premium licence (optional)\n';
const PREMIUM_MISSING = '    No Power Automate Premium licence is assigned to you, and you\'ll own the flows. Ask your licence admin for one, or upload the CSV exports instead.\n';
const PP_ADMIN_HANDOFF = '    Hand-off: someone else does this.\n  → Power Platform Administrator (optional)\n';
const PP_ADMIN_ELIGIBLE = '  ◐ Power Platform Administrator (optional)\n';
const ENVIRONMENTS_ROW = '  ✗ Power Platform environments, System Administrator in each (optional)\n';
const DATA_POLICY_ROW = '    To confirm: the installer can\'t check this.\n  ? Data policy\n';
/** Written where the install asks "Go ahead?". */
const GO_AHEAD = '<<Go ahead?>>\n';
/** Power Platform Administrator to activate in PIM, and System Administrator in no environment. */
const ELIGIBLE = {
  roles: [],
  eligible: async () => [{ roleDefinitionId: PP_ADMIN, principalId: USER.id }],
  envs: [{ Url: 'https://org1.crm.dynamics.com', FriendlyName: 'Default', State: 0, IsUserSysAdmin: false }],
};
/** A Power Automate Premium licence and the Power Platform Administrator role, active. */
const EQUIPPED = {
  roles: [role(GA, 'Global Administrator'), role(PP_ADMIN, 'Power Platform Administrator')],
  licences: [{ servicePlans: [{ servicePlanName: 'BI_AZURE_P2', provisioningStatus: 'Success' }, { servicePlanName: 'POWER_AUTOMATE_ATTENDED_RPA', provisioningStatus: 'Success' }] }],
};

/** How many times `part` is in `text`. @param {string} text @param {string} part */
const count = (text, part) => text.split(part).length - 1;

/** Whether each part is in `text`, in this order. @param {string} text @param {string[]} parts */
const inOrder = (text, parts) => {
  let at = 0;
  for (const part of parts) {
    const i = text.indexOf(part, at);
    if (i < 0) return false;
    at = i + part.length;
  }
  return true;
};

/** Each prerequisite row printed, with its detail line. @param {string} text */
const rowLines = (text) => {
  const lines = text.split('\n');
  return lines.flatMap((line, i) => (/^  [✗◐?→] /.test(line) ? [`${line}\n${lines[i + 1]}`] : []));
};

/** The rows' first lines. @param {string} text */
const rowNames = (text) => rowLines(text).map((r) => r.split('\n')[0]);

/**
 * A new terminal install on Fabric: preflight with no flows chosen, then the plan picks the Copilot Studio credits flow
 * and its environment.
 * @param {any} [over] @param {{ yes?: boolean }} [o]
 */
async function flowsAfterPreflight(over = {}, o = {}) {
  const { ctx, t } = preflightCtx(over, o);
  await preflight(ctx);
  const before = t.text();
  ctx.config.dataSources.studioCredits = 'api';
  await planFlows(ctx);
  return { ctx, before, after: t.text().slice(before.length), text: t.text() };
}

test('planFlows: a flow picked after a new install\'s preflight shows the Premium licence and Power Platform Administrator rows preflight would have, then the data policy ask, and --yes carries on', async () => {
  for (const yes of [false, true]) {
    const { ctx, before, after, text } = await flowsAfterPreflight({}, { yes });
    for (const part of [PREMIUM_ROW, 'Power Platform Administrator', 'Data policy']) assert.ok(!before.includes(part), `no flow chosen yet: ${part}`);
    assert.ok(
      inOrder(after, [FLOW_ENVIRONMENT_HINT, '  ! 1 prerequisite needs attention. The install carries on.\n', PREMIUM_ROW, PREMIUM_MISSING, PP_ADMIN_HANDOFF, DATA_POLICY_ROW, dataPolicyAsk(ctx.config)]),
      after,
    );
    assert.match(dataPolicyAsk(ctx.config), / is allowed in Default\. /, 'the environment just picked');
    assert.equal(count(text, dataPolicyAsk(ctx.config)), 1, 'the ask is said once');
    assert.equal(count(after, 'The install carries on.'), 1);
    assert.doesNotMatch(after, /Stopped before|for the full list/);
  }
});

test('planFlows: after a new install\'s preflight, a Power Platform Administrator role you can only activate shows with its PIM warning once a flow is picked, without claiming how long an activation lasts', async () => {
  for (const yes of [false, true]) {
    const { before, after, text } = await flowsAfterPreflight(ELIGIBLE, { yes });
    assert.ok(!before.includes('Power Platform Administrator (optional)'), 'no flow chosen yet');
    assert.ok(inOrder(after, ['  ! 3 prerequisites need attention. The install carries on.\n', PP_ADMIN_ELIGIBLE, PREMIUM_ROW, ENVIRONMENTS_ROW, DATA_POLICY_ROW]), after);
    const detail = after.slice(after.indexOf(PP_ADMIN_ELIGIBLE) + PP_ADMIN_ELIGIBLE.length).split('\n')[0];
    assert.ok(detail.endsWith(PIM_WARNING), detail);
    assert.doesNotMatch(detail, /default|\b8 hours/i, 'the organisation sets how long an activation lasts');
    assert.equal(count(text, PIM_WARNING), 1);
    assert.doesNotMatch(after, /Stopped before|for the full list/);
  }
});

test('planFlows: after a new install\'s preflight, someone with Premium and the role active sees only the data policy ask; for everyone, the rows are the ones preflight shows with the flow chosen up front', async () => {
  for (const yes of [false, true]) {
    const { after } = await flowsAfterPreflight(EQUIPPED, { yes });
    assert.deepEqual(rowNames(after), ['  ? Data policy'], after);
    assert.ok(after.includes(DATA_POLICY_ROW));
    assert.doesNotMatch(after, /needs? attention|Hand-off/);
  }
  for (const over of [{}, ELIGIBLE, EQUIPPED]) {
    const upFront = plainConfig();
    upFront.dataSources.studioCredits = 'api';
    upFront.uploads = { flowEnvironment: { url: 'https://org1.crm.dynamics.com', name: 'Default' } };
    const { ctx, t } = preflightCtx(over, { config: upFront });
    await preflight(ctx);
    const { before, after } = await flowsAfterPreflight(over);
    assert.deepEqual([...rowLines(before), ...rowLines(after)].sort(), rowLines(t.text()).sort());
  }
});

test('planFlows: with --studio-flow, preflight shows the flow\'s rows and the data policy ask, and the plan doesn\'t repeat them', async () => {
  for (const yes of [false, true]) {
    // --studio-flow sets the source before preflight.
    const config = plainConfig();
    config.dataSources.studioCredits = 'api';
    const { ctx, t } = preflightCtx({}, { yes, config });
    await preflight(ctx);
    const before = t.text();
    await planFlows(ctx);
    const after = t.text().slice(before.length);
    for (const part of [PREMIUM_ROW, PP_ADMIN_HANDOFF, DATA_POLICY_ROW]) assert.ok(before.includes(part), part);
    assert.ok(after.includes(FLOW_ENVIRONMENT_HINT), 'the plan still asks where the flows go');
    assert.equal(ctx.config.uploads.flowEnvironment?.name, 'Default');
    assert.deepEqual(rowLines(after), [], after);
    assert.equal(count(t.text(), '  ? Data policy\n'), 1);
  }
});

test('planFlows: a terminal repair with the flows says the data policy ask once, in preflight; another environment says it again, for that one', async () => {
  const envs = [
    { Url: 'https://org1.crm.dynamics.com', EnvironmentId: 'env-1', FriendlyName: 'Sales', State: 0, IsUserSysAdmin: true },
    { Url: 'https://org2.crm.dynamics.com', EnvironmentId: 'env-2', FriendlyName: 'Marketing', State: 0, IsUserSysAdmin: true },
  ];
  for (const yes of [false, true]) {
    const { ctx, t } = preflightCtx({ envs }, { yes, config: studioConfig() });
    await preflight(ctx);
    const before = t.text();
    await planFlows(ctx);
    const after = t.text().slice(before.length);
    assert.equal(ctx.config.uploads.flowEnvironment?.name, 'Sales', 'the saved environment');
    assert.ok(before.includes(dataPolicyAsk(ctx.config)), before);
    assert.equal(count(t.text(), dataPolicyAsk(ctx.config)), 1, 'said once');
    assert.deepEqual(rowLines(after), [], 'nor any other row again');
  }
  const { ctx, t } = preflightCtx({ envs }, { config: studioConfig(), answers: ['https://org2.crm.dynamics.com'] });
  await preflight(ctx);
  const before = t.text();
  await planFlows(ctx);
  const after = t.text().slice(before.length);
  assert.equal(ctx.config.uploads.flowEnvironment?.name, 'Marketing');
  assert.match(dataPolicyAsk(ctx.config), / is allowed in Marketing\. /);
  assert.ok(inOrder(after, [DATA_POLICY_ROW, dataPolicyAsk(ctx.config)]), after);
  assert.deepEqual(rowNames(after), ['  ? Data policy'], 'only the ask, for the other environment');
});

test('reportFlowPrereqs: nothing without install preflight or flows; when preflight couldn\'t check, the data policy ask still shows, once', () => {
  const t = fakeUi();
  reportFlowPrereqs(/** @type {any} */ ({ ui: t.ui, config: studioConfig() }));
  assert.equal(t.text(), '', 'no install preflight');
  /** @type {import('../src/prereqs.js').PreflightSeen} */
  const seen = { items: null, shown: new Map() };
  reportFlowPrereqs(/** @type {any} */ ({ ui: t.ui, config: plainConfig(), preflightSeen: seen }));
  assert.equal(t.text(), '', 'no flows');
  const ctx = /** @type {any} */ ({ ui: t.ui, config: studioConfig(), preflightSeen: seen });
  reportFlowPrereqs(ctx);
  const once = t.text();
  assert.ok(once.startsWith(DATA_POLICY_ROW), once);
  assert.ok(once.includes(dataPolicyAsk(ctx.config)));
  assert.deepEqual(rowNames(once), ['  ? Data policy']);
  reportFlowPrereqs(ctx);
  assert.equal(t.text(), once, 'said once');
});

test('ui.prereqs: the terminal tags optional rows, but not the data policy row', () => {
  const t = fakeUi();
  t.ui.prereqs([row({ id: 'power-automate-premium', label: 'Power Automate Premium licence', optional: true }), dataPolicyPrereq(studioConfig())]);
  const text = t.text();
  assert.ok(text.includes(PREMIUM_ROW), text);
  assert.ok(text.includes('  ? Data policy\n'), text);
  assert.doesNotMatch(text, /Data policy \(optional\)/);
});

/** A new Azure install with credit consumption: nothing recorded yet, and no flows until its plan picks the Copilot Studio source. */
const newAzureConfig = () => {
  const config = emptyConfig();
  config.target = 'azure';
  config.modules.consumption = true;
  config.modules.agentEvaluator = false;
  config.azure = /** @type {any} */ ({
    subscriptionId: 'sub-1', resourceGroup: 'rg', location: 'uksouth', namePrefix: 'vlens', installId: 'install-1', tags: {}, deployments: [], outputs: {},
    graphRoles: { assigned: [], pending: [] }, publicNetworkAccess: true, workspaceName: 'Analytics Hub',
  });
  assert.deepEqual(flowsWanted(config), []);
  return config;
};

test('planAzureConsumption: a new Azure install defaults Copilot Studio credits to the flow, so its Premium licence row, any PIM warning and the data policy ask show after preflight; --yes carries on', async () => {
  const pending = 'the new storage account\'s address (https://<name>.dfs.core.windows.net), which the installer shows once it\'s made';
  for (const [who, over] of /** @type {[string, any][]} */ ([['', {}], ['eligible', ELIGIBLE]])) {
    for (const yes of [false, true]) {
      const { ctx, t } = preflightCtx(over, { yes, config: newAzureConfig() });
      ctx.advanced = false;
      await preflight(ctx);
      const before = t.text();
      await planAzureConsumption(ctx, []);
      const after = t.text().slice(before.length);
      const ask = dataPolicyAsk(ctx.config);
      assert.equal(ctx.config.dataSources.studioCredits, 'api');
      assert.ok(!before.includes(PREMIUM_ROW), `no flow chosen yet ${who}`);
      assert.ok(inOrder(after, [FLOW_ENVIRONMENT_HINT, PREMIUM_ROW, PREMIUM_MISSING, DATA_POLICY_ROW, ask]), after);
      assert.ok(ask.endsWith(`it must allow https://api.powerplatform.com and ${pending}.`), ask);
      assert.equal(count(t.text(), PREMIUM_ROW), 1, who);
      assert.equal(count(t.text(), ask), 1, who);
      assert.equal(count(t.text(), PIM_WARNING), who ? 1 : 0, who);
      if (who) assert.ok(inOrder(after, [PP_ADMIN_ELIGIBLE, PREMIUM_ROW, ENVIRONMENTS_ROW]), after);
      assert.doesNotMatch(after, /Stopped before|for the full list/);
    }
  }
});

test('Azure install: the Copilot Studio credits flow a new install\'s plan picks shows its Premium licence row before the plan is confirmed, and declining creates nothing', async () => {
  const PIM = async () => [{ roleDefinitionId: PP_ADMIN, principalId: 'user-1' }];
  for (const eligible of [async () => [], PIM]) {
    for (const yes of [false, true]) {
      const u = fakeUi({ yes });
      const arm = fakeArm();
      // Each change in Azure is marked where it happens in the output.
      const armApi = /** @type {any} */ ({ ...arm.api });
      for (const [name, fn] of Object.entries(arm.api)) {
        if (!/^(ensure|deploy|assign|start|delete)/.test(name)) continue;
        armApi[name] = (/** @type {any[]} */ ...args) => {
          u.out.push(`<<ARM ${name}>>\n`);
          return /** @type {any} */ (fn)(...args);
        };
      }
      const graph = fakeAzureGraph();
      const config = emptyConfig();
      config.target = 'azure';
      config.tenantId = 'tenant-1';
      config.modules.consumption = true;
      const { ctx } = fakeCtx({
        config,
        ui: u.ui,
        arm: armApi,
        fabric: fakeFabric().api,
        powerBi: fakePowerBi().api,
        graph: {
          ...graph.api,
          myDirectoryRoles: async () => [role(GA, 'Global Administrator')],
          myEligibleRoles: eligible,
          myGroupIds: async () => [],
          myDirectGroupIds: async () => [],
          myLicenseDetails: async () => [],
          subscribedSkus: async () => [],
          usersCanRegisterApps: async () => true,
        },
        discovery: { instances: async () => [{ Url: 'https://org1.crm.dynamics.com', FriendlyName: 'Default', State: 0, IsUserSysAdmin: true }] },
      });
      delete config.fabric.workspaceId;
      const ui = /** @type {any} */ (u.ui);
      const { confirm } = ui;
      ui.confirm = async (/** @type {string} */ message, /** @type {boolean} */ def) => {
        if (message !== 'Go ahead?') return confirm(message, def);
        u.out.push(GO_AHEAD);
        return false;
      };
      assert.equal(await install(ctx, { wait: false }), true);
      const text = u.text();
      assert.ok(inOrder(text, ['Checking your tenant', FLOW_ENVIRONMENT_HINT, PREMIUM_ROW, PREMIUM_MISSING, DATA_POLICY_ROW, 'Ready to set up', GO_AHEAD, 'Stopped before changing anything.']), text);
      assert.equal(count(text, PREMIUM_ROW), 1);
      assert.equal(count(text, '  ? Data policy\n'), 1);
      assert.equal(count(text, PIM_WARNING), eligible === PIM ? 1 : 0);
      // Checking Azure registers resource providers before "Go ahead?", as it did before; the row shows first.
      const firstChange = text.indexOf('<<ARM ');
      assert.ok(text.indexOf(PREMIUM_MISSING) < (firstChange < 0 ? text.length : firstChange), text);
      assert.deepEqual(arm.calls.filter((c) => /^(ensureResourceGroup|deployTemplate|assignRole|startContainerAppJob|delete)/.test(c)), [], 'nothing created');
    }
  }
});

test('Fabric install: the Copilot Studio credits flow picked on a new install\'s Data sources screen shows its Premium licence row before the plan is confirmed and before the first step', async (t) => {
  const forbidden = async () => {
    throw new Error('Forbidden');
  };
  for (const yes of [false, true]) {
    const dir = mkdtempSync(join(tmpdir(), 'ah-flow-prereqs-'));
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
    const u = fakeUi({ yes });
    const ui = /** @type {any} */ (u.ui);
    const { sources, confirm } = ui;
    // Copilot Studio credits from the flow, on the Data sources screen.
    ui.sources = async (/** @type {string} */ message, /** @type {any[]} */ cards, /** @type {{ lockModes?: boolean } | undefined} */ o) => {
      const picked = await sources(message, cards, o);
      if (!o?.lockModes) picked.modes.studioCredits = 'api';
      return picked;
    };
    ui.confirm = async (/** @type {string} */ message, /** @type {boolean} */ def) => {
      if (message === 'Go ahead?') u.out.push(GO_AHEAD);
      return confirm(message, def);
    };
    const ctx = createCtx({
      ui: u.ui,
      config,
      file,
      api: /** @type {any} */ ({
        // Fabric refuses the workspace, the first thing the install creates.
        fabric: {
          ...fabric.api,
          tenantSettings: forbidden,
          listWorkspaces: async () => [],
          createWorkspace: async () => {
            u.out.push('<<createWorkspace>>\n');
            throw httpError(403, 'Forbidden');
          },
        },
        graph: {
          ...graph.api,
          subscribedSkus: forbidden,
          myDirectoryRoles: async () => [],
          myEligibleRoles: async () => [],
          myGroupIds: async () => [],
          myDirectGroupIds: async () => [],
          myLicenseDetails: async () => [],
          usersCanRegisterApps: async () => true,
          ensureRequiredAccess: async () => false,
        },
        powerBi: fakePowerBi().api,
        arm: { listSubscriptions: async () => [] },
        keyVault: {},
        oneLake: {},
        discovery: { instances: async () => [{ Url: 'https://org1.crm.dynamics.com', FriendlyName: 'Default', State: 0, IsUserSysAdmin: true }] },
        powerPlatform: { billingPolicies: async () => [] },
      }),
      user: { id: 'user-1', upn: 'admin@contoso.com', tenantId: 'tenant-1' },
      sources: realSources(),
      sleep: async () => {},
      now: () => new Date('2026-06-01T12:00:00Z'),
    });
    await assert.rejects(install(ctx, { wait: true }), /Fabric didn't let you create the workspace/);
    const text = u.text();
    assert.ok(inOrder(text, ['Checking your tenant', FLOW_ENVIRONMENT_HINT, PREMIUM_ROW, PREMIUM_MISSING, PP_ADMIN_HANDOFF, DATA_POLICY_ROW, 'Ready to set up', GO_AHEAD, '[1/', '<<createWorkspace>>']), text);
    assert.equal(count(text, '<<createWorkspace>>'), 1, 'the first thing created');
    assert.equal(count(text, PREMIUM_ROW), 1);
    assert.equal(count(text, '  ? Data policy\n'), 1);
    assert.deepEqual(fabric.calls.filter((c) => /^create/.test(c)), [], 'nothing created in Fabric');
  }
});
