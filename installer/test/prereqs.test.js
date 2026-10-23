// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { armApi, ROLES } from '../src/clients/azure.js';
import { FABRIC_ADMIN_ROLE, graphApi, INSIGHTS_ANALYST_ROLE } from '../src/clients/graph.js';
import { emptyConfig } from '../src/config.js';
import { HttpError } from '../src/http.js';
import { readFile } from 'node:fs/promises';
import { canAssignDirectoryRoles, checkPrereqs, preflightVerdict, reportPreflight, settingsToConfirm } from '../src/prereqs.js';
import { flowsWanted, ppApiFlows } from '../src/steps/flows.js';
import { preflight } from '../src/steps/plan.js';
import { fakeUi } from './fakes.js';

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
      myGroupIds: async () => ['group-1'],
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
  assert.match(none['consent-role'].detail, /^You don't need this yourself\. A Privileged Role Administrator or Global Administrator approves the app's Microsoft Graph permissions\. The installer gives you a link to send them and carries on\./);
  assert.match(none['consent-role'].detail, /Couldn't check for roles you could activate yourself/);
  assert.match(none['consent-role'].howTo, /Privileged Role Administrator or Global Administrator approves them, from the link the installer gives you/);
  assert.match(none['consent-role'].howTo, /Application Administrator or Cloud Application Administrator can't approve Microsoft Graph application permissions: https:\/\/learn\.microsoft\.com\/entra\/identity\/enterprise-apps\/grant-admin-consent/);
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
  assert.match(rbac.howTo, /least privilege.*docs\/AZURE-LEAST-PRIVILEGE\.md/);

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
  assert.match(sysAdmin['power-platform-admin'].howTo, /agents inventory flow's connection signs in as a Power Platform administrator, or an admin with Global Reader/);
  assert.match(sysAdmin['power-platform-admin'].howTo, /Power Platform, Billing or Global administrator/);

  const notSysAdmin = await run({ roles: [], envs: [{ Url: 'https://org1.crm.dynamics.com', FriendlyName: 'Default', State: 0, IsUserSysAdmin: false }] });
  assert.equal(notSysAdmin.environments.status, 'missing');
  assert.equal(notSysAdmin['power-platform-admin'].status, 'missing', 'it adds the app to environments you can\'t');
  assert.match(notSysAdmin['power-platform-admin'].detail, /You don't have Power Platform Administrator active/);
  const noEnvs = await run({ roles: [], envs: [] });
  assert.equal(noEnvs['power-platform-admin'].status, 'missing');

  const ppAdmin = await run({ roles: [{ roleTemplateId: '11648597-926c-4cf3-9c36-bcebb0ba8dcc', displayName: 'Power Platform Administrator' }] });
  assert.equal(ppAdmin['power-platform-admin'].status, 'met');
});

test('checkPrereqs: Power Automate Premium is optional, needed only for the flows, and read from your own licences', async () => {
  const none = await run({});
  assert.equal(none['power-automate-premium'].status, 'missing');
  assert.equal(none['power-automate-premium'].optional, true);
  assert.match(none['power-automate-premium'].neededFor, /Copilot Studio credits/);
  assert.match(none['power-automate-premium'].neededFor, /signs in to the flow/);
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
  assert.ok(az.includes('"Create workspaces"'));
  assert.ok(!az.includes('"Users can create Fabric items"'), 'Fabric only');
  assert.ok(!az.some((s) => /Fabric apps/.test(s)), 'the Fabric app is Fabric only');
  assert.ok(az.includes('"Semantic Model Execute Queries REST API"'), 'Azure\'s web app queries the model through it');
  assert.ok(az.includes('"Allow visuals created using the Power BI SDK"'));
  azure.azure = /** @type {any} */ ({ powerBi: { workspaceId: 'ws-2' } });
  assert.ok(!settingsToConfirm(azure).includes('"Create workspaces"'));
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
  ];
  const az = (await run({ subs: [], tenantSettings: settings }, azure))['tenant-settings'];
  assert.equal(az.status, 'missing', 'Azure\'s web app queries the model through it');
  assert.equal(az.detail, 'Off: "Semantic Model Execute Queries REST API".', 'the Fabric app\'s setting is Fabric only');
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

/** A preflight ctx on the fake APIs, with a UI that records what it prints. @param {any} [over] @param {{ yes?: boolean, config?: any }} [o] */
const preflightCtx = (over = {}, o = {}) => {
  const t = fakeUi({ yes: o.yes });
  const ctx = /** @type {any} */ ({ ui: t.ui, api: fakeApis(over), user: USER, config: o.config ?? plainConfig() });
  return { ctx, t };
};

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
  pack.app.adminPack = /** @type {any} */ ({ writtenAt: '2026-06-01' });
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
  assert.match(text, /Hand-off: someone else does this\. The install carries on\./);
  assert.match(text, /Privileged Role Administrator or Global Administrator approves the app's Microsoft Graph permissions/);
  assert.match(text, /That consent includes AuditLogsQuery\.Read\.All: until it's approved, the audit load finds 0 records\./);
  assert.match(text, /Who does it: /);
  assert.doesNotMatch(text, /Audit log access for Copilot interactions/, 'on Fabric the consent is one ask, not two');
  assert.doesNotMatch(text, /Power BI Pro or Premium Per User licence/, 'met rows stay out');
  assert.doesNotMatch(text, /Viva Insights analyst/, 'Cowork credits don\'t come from Viva Insights');
  assert.match(text, /prereqs" for the full list/);
  assert.doesNotMatch(text, /You can't grant admin consent for Microsoft Graph/, 'the list says it once');
  assert.ok(text.indexOf('Register apps in Entra') > text.indexOf('active Fabric capacity'), 'after the tenant checks');
  assert.ok(text.indexOf('Hand-off: someone else does this') > text.indexOf('Register apps in Entra'), 'hand-offs after what needs attention');
});

test('preflight: with --yes, no way to register the app stops it before anything is created', async () => {
  const { ctx, t } = preflightCtx({ roles: [], usersCanRegister: false }, { yes: true });
  await assert.rejects(preflight(ctx), /can't create its app registration\. Run it without --yes to choose an app registration you already have or get the admin pack/);
  assert.match(t.text(), /Stopped before creating anything: Register apps in Entra\./);
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

test('preflight: with no capacity to create a workspace on, an Admin or Member workspace on a capacity is enough, except with --yes and none recorded', async () => {
  const workspaces = [{ id: 'ws-a', displayName: 'Team analytics', type: 'Workspace', capacityId: 'cap-x', capacityRegion: 'North Europe' }];
  const { ctx, t } = preflightCtx({ capacities: [], workspaces });
  const pre = await preflight(ctx);
  assert.deepEqual(pre.capacities, []);
  assert.deepEqual(pre.workspacesOnCapacity?.map((w) => w.id), ['ws-a']);
  assert.match(t.text(), /No capacity you can create a workspace on, but 1 workspace you're an Admin or Member of is already on one/);

  const yes = preflightCtx({ capacities: [], workspaces }, { yes: true });
  await assert.rejects(preflight(yes.ctx), /With --yes the installer can't choose a workspace for you, and it can't create one without a capacity\./);
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
  const consent = row({ id: 'consent-role', label: 'Can grant admin consent', status: 'handoff', optional: true, detail: 'You don\'t need this yourself.', howTo: 'A Privileged Role Administrator approves them.' });
  const audit = row({ id: 'audit-ingestion', label: 'Audit log access', status: 'handoff', detail: 'Not granted yet.', howTo: 'Approve it.' });

  const only = fakeUi();
  const v = reportPreflight(/** @type {any} */ ({ ui: only.ui, config: plainConfig() }), [row({ id: 'register-apps', status: 'met' }), consent, audit]);
  const text = only.text();
  assert.doesNotMatch(text, /nothing missing/, 'there is something to do: hand it off');
  assert.match(text, /Prerequisites: you have what you need yourself/);
  assert.match(text, /Hand-off: someone else does this\. The install carries on\./);
  assert.match(text, /Can grant admin consent/);
  assert.match(text, /That consent includes AuditLogsQuery\.Read\.All: until it's approved, the audit load finds 0 records\./);
  assert.match(text, /Who does it: A Privileged Role Administrator approves them\. A Compliance Administrator checks audit logging is on/);
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

test('update: checks the prerequisites before changing anything, on Fabric and Azure, and never stops on them', async () => {
  const src = await readFile(new URL('../src/install.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('export async function update('), src.indexOf('export async function finishUpdate('));
  assert.match(body, /if \(config\.target === 'azure'\) \{\s*await updatePrereqs\(ctx\);\s*return azureUpdate\(ctx\);/);
  assert.ok(body.indexOf('await updatePrereqs(ctx);', body.indexOf('Nothing is installed yet')) < body.indexOf('ensureKeyVault(ctx)'));
  assert.match(src, /async function updatePrereqs\(ctx\) \{[^}]*reportPreflight\(ctx, await preflightChecks\(ctx\), \{ update: true \}\)/);
});
