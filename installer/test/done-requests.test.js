// @ts-check
// What's left for admins at the end of an install or Repair: one request per admin, from the install record and this
// run, in the terminal. The Done page's are in setup-page.test.js, and each module's own asks in its tests.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { graphRolesCommand, graphRolesRevokeCommand, roleAssignmentCommand } from '../src/admin-commands.js';
import { apiPermissionsUrl, GLOBAL_ADMIN_ROLE } from '../src/clients/graph.js';
import { emptyConfig } from '../src/config.js';
import { summary } from '../src/install.js';
import { commandLine } from '../src/launch.js';
import { dataPolicyPrereq, settingsLeft, settingsToConfirm, TENANT_SETTINGS_URL } from '../src/prereqs.js';
import { PURVIEW_AUDIT_URL } from '../src/steps/audit-check.js';
import { azureSummary } from '../src/steps/azure/index.js';
import { MANAGE_APPS_URL, TEAMS_APP_PENDING } from '../src/steps/azure/teams-catalog.js';
import { flowsWanted } from '../src/steps/flows.js';
import { ADMINS, adminRequests, APP_OWNER_ADMIN, doneRequests, isGlobalAdmin, namesState, namesWanted, requestsFor, ROW_ASKS } from '../src/steps/handoff.js';
import { vaultAsk } from '../src/steps/identity.js';
import { CONCEALED_NAMES_AFTER, CONCEALED_NAMES_STEPS } from '../src/steps/next-steps.js';
import { AGENT_ROLE, globalReaderCommand, readerCommand, resourceGraphScope } from '../src/steps/resource-graph.js';
import { lastDataCheck } from '../src/steps/run.js';
import { DATA_CHECK_FILE } from '../src/transform/notebook.js';
import { fakeCtx, fakeFabric, fakeUi } from './fakes.js';

/** @typedef {import('../src/config.js').InstallConfig} InstallConfig */
/** @typedef {import('../src/steps/handoff.js').AdminRequest} AdminRequest */
/** @typedef {import('../src/prereqs.js').Prereq} Prereq */

const UPN = 'admin@contoso.com';
const APP = 'Give the app "Analytics Hub Data Collector" (application ID app-1, enterprise application object ID sp-1)';
const MI = 'mi-1';
const MI_CLIENT = 'mi-client-1';
const MI_RESOURCE = '/subscriptions/sub-1/resourceGroups/rg-ah/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-vlens-jobs';
const SUB = '11111111-1111-4111-8111-111111111111';
const PAYG = '22222222-2222-4222-8222-222222222222';
const REPAIR = 'Run the installer again and choose Repair or change';
const REPAIR_ASKS = 'Run the installer again without --yes and choose Repair or change. When it says you can\'t assign Azure roles there, choose';
/** A data check whose identity match shows names. */
const SHOWN = { identity: { licensed: 10, audit: 5, matched: 10, masked: 0 } };
/** One that shows them concealed. */
const HIDDEN = { identity: { licensed: 10, audit: 5, matched: 1, masked: 9 } };
const GLOBAL_ADMIN = { roleTemplateId: GLOBAL_ADMIN_ROLE, displayName: 'Global Administrator' };

/** A Fabric install's record, with nothing on that leaves an admin anything to do. */
const fabricConfig = () => {
  const config = emptyConfig();
  Object.assign(config.app, { appId: 'app-1', servicePrincipalId: 'sp-1' });
  Object.assign(config.dataSources, { resourceGraph: 'skip', productFeedback: 'csv', studioCredits: 'csv' });
  config.modules.consumption = false;
  config.modules.agentEvaluator = false;
  return config;
};

/** An Azure install's record, once the deployment returned the jobs' managed identity. @param {any} [azure] */
const azureConfig = (azure = {}) => {
  const config = fabricConfig();
  config.target = 'azure';
  config.azure = /** @type {any} */ ({
    ...config.azure,
    resourceGroup: 'rg-ah',
    location: 'uksouth',
    outputs: { identityPrincipalId: MI, identityClientId: MI_CLIENT, identityId: MI_RESOURCE },
    ...azure,
  });
  return config;
};

/** The request to one admin. @param {AdminRequest[]} requests @param {string} admin */
const to = (requests, admin) => requests.find((r) => r.admin === admin);

/** A row preflight or the flows' check showed, missing unless it says otherwise. @param {Partial<Prereq> & { id: string }} p @returns {Prereq} */
const row = (p) => ({ label: p.id, detail: '', neededFor: 'x', howTo: `How to fix ${p.id}.`, status: 'missing', ...p });

/** The tenant settings row as preflight shows it when only a Fabric administrator can read them. @param {InstallConfig} config */
const unreadSettings = (config) =>
  row({
    id: 'tenant-settings',
    label: 'Fabric tenant settings',
    status: 'unknown',
    detail:
      `Couldn't check: only a Fabric administrator can read tenant settings. Ask one to confirm these are on for you, or for a group you're in: ${settingsToConfirm(config).join('; ')}.` +
      (config.access?.rls?.enabled ? ' The capacity\'s XMLA endpoint must also be Read Write, which a capacity admin sets.' : ''),
  });

/** A Fabric install's record with Copilot Studio credits from the API, which needs a flow, in the Sales environment. */
const flowsConfig = () => {
  const config = fabricConfig();
  config.dataSources.studioCredits = 'api';
  config.uploads = { flowEnvironment: { url: 'https://org1.crm.dynamics.com', id: 'env-1', name: 'Sales' } };
  return config;
};

const PURVIEW = `Check that audit logging is on in Microsoft Purview > Audit, and turn it on if it isn't: ${PURVIEW_AUDIT_URL}`;
const CHECK_AUDIT = `If they turned it on, new records take from 60 minutes to 24 hours to appear. Then run "${commandLine('check-audit')}" to test it.`;
const PREMIUM = 'Assign me Power Automate Premium: I\'ll own the Analytics Hub flows, which use premium connectors.';
const TURN_ON = `Run "${commandLine('update')}": it turns on each flow that's off, once its connections are signed in.`;
const SAVE_FLOWS = `Run "${commandLine('update')}": it saves any flow the policy turned down, and turns on each flow that's off once its connections are signed in.`;
const CREATE_AFTER = `${REPAIR}: it creates what the install couldn't.`;
const DEPLOY_APP_AFTER = `Run "${commandLine('deploy-app')}" to deploy the Analytics Hub app.`;
const ACCESS_AFTER = `Apply org-scoped access: run "${commandLine('access')}", choose "Org-scoped access: who sees which orgs", then "Apply now". Until then, people outside the workspace see nothing.`;
const XMLA = 'Set the XMLA endpoint to Read Write on the Fabric capacity Analytics Hub\'s workspace uses.';
/** The tenant settings, by their names in the admin portal. */
const CREATE_WS = '"Create workspaces" (only to create a new workspace, not to use an existing one you\'re an Admin or Member of)';
const ITEMS = '"Users can create Fabric items"';
const SP = '"Service principals can call Fabric public APIs"';
const EXEC = '"Semantic Model Execute Queries REST API"';
const FABRIC_APPS = 'the Fabric apps setting, under "Fabric apps (preview)"';
const VISUALS = '"Allow visuals created using the Power BI SDK"';
const XMLA_SETTING = '"Allow XMLA endpoints and Analyze in Excel with on-premises semantic models"';
/** The ask for some tenant settings. @param {string[]} settings */
const settingsText = (settings) =>
  `Confirm these Fabric tenant settings are on for me, or for a group I'm in, and turn on any that are off: ${settings.join('; ')}. They're in Fabric under Admin portal > Tenant settings: ${TENANT_SETTINGS_URL}`;

test('done requests: nothing for an install with nothing left; otherwise one request per admin, signed, in the order of ADMINS', () => {
  const config = fabricConfig();
  assert.deepEqual(doneRequests(config, { dataCheck: SHOWN }), []);
  config.dataSources.resourceGraph = 'api';
  config.modules.consumption = true;
  Object.assign(config.consumption, { azureSubscriptionId: SUB });
  config.dataSources.coworkCredits = 'csv';
  const requests = doneRequests(config, { from: UPN, consented: false });
  assert.deepEqual(requests.map((r) => r.admin), ['role-admin', 'global-admin', 'azure-owner', 'viva']);
  for (const r of requests) {
    assert.equal(r.who, ADMINS[r.admin]);
    assert.match(r.message, /^Hi,\n\nI've installed Analytics Hub, and I need your help with (this|these):\n\n- /);
    assert.match(r.message, /\n\nThanks\nadmin@contoso\.com$/);
    assert.equal(r.asks.length, new Set(r.asks).size, 'each ask once');
    assert.ok(r.after?.length, `${r.admin}: what you do once it's done`);
    for (const after of r.after ?? []) assert.ok(!r.message.includes(after), 'what you do afterwards is for you, not in the message');
  }
  const [role, , owner] = requests;
  assert.deepEqual(role.rows, [AGENT_ROLE, 'Admin consent']);
  assert.match(role.message, /help with these:/);
  assert.deepEqual(owner.rows, ['Azure AI costs and metrics', 'Foundry resources']);
  assert.equal(requests.filter((r) => r.optional).length, 1, 'only the Viva query is optional');
});

test('done requests: concealed names are asked of a Global Administrator unless a data check shows names', () => {
  const config = fabricConfig();
  assert.equal(to(doneRequests(config, { dataCheck: SHOWN }), 'global-admin'), undefined);

  const unsure = to(doneRequests(config, { from: UPN }), 'global-admin');
  assert.ok(unsure, 'no data check: concealing names is Microsoft\'s default');
  assert.equal(unsure.who, 'A Global Administrator');
  assert.deepEqual(unsure.rows, ['Concealed names']);
  assert.ok(unsure.message.includes('Show user names in the Microsoft 365 usage reports. Analytics Hub matches licences to Copilot activity by user principal name'));
  CONCEALED_NAMES_STEPS.forEach((step, i) => assert.ok(unsure.message.includes(`\n  ${i + 1}. ${step}`), step));
  assert.match(unsure.message, /Microsoft 365 admin center: https:\/\/admin\.microsoft\.com/);
  assert.match(unsure.message, /logged event in the Microsoft Purview audit log/);
  assert.match(unsure.message, /org-wide/);
  assert.match(unsure.message, /If the reports already show names, there's nothing to do\./);
  assert.deepEqual(unsure.after, [CONCEALED_NAMES_AFTER]);
  assert.match(CONCEALED_NAMES_AFTER, /^Nothing to run/);

  const masked = to(doneRequests(config, { dataCheck: HIDDEN }), 'global-admin');
  assert.ok(masked, 'the check shows them concealed');
  assert.doesNotMatch(masked.message, /already show names/);
  const cantTell = to(doneRequests(config, { dataCheck: { identity: { licensed: 10, audit: 0, masked: 0 } } }), 'global-admin');
  assert.match(String(cantTell?.message), /If the reports already show names/, 'a check with no audit activity can\'t tell');

  // As printIdentityMatch reads the check: shown while fewer than half the licensed users' names are masked.
  assert.equal(namesState({ licensed: 10, audit: 5, masked: 4 }), 'shown');
  assert.equal(namesState({ licensed: 10, audit: 5, masked: 5 }), 'hidden');
  assert.equal(namesState({ licensed: 0, audit: 5, masked: 0 }), 'unknown');
  assert.equal(namesState(undefined), 'unknown');
  assert.deepEqual(namesWanted(config, null), { unsure: true });
  assert.deepEqual(namesWanted(config, HIDDEN), { unsure: false });
  assert.equal(namesWanted(config, SHOWN), false);

  assert.equal(to(doneRequests(config, { globalAdmin: true }), 'global-admin'), undefined, 'a Global Administrator does it themselves');
});

test('done requests: Azure always asks for concealed names, with nothing to do if the reports show them, except for sample data', () => {
  const config = azureConfig();
  const names = to(doneRequests(config, { dataCheck: SHOWN }), 'global-admin');
  assert.ok(names, 'its first load runs in the background, so no check tells');
  assert.match(names.message, /If the reports already show names, there's nothing to do\./);
  assert.deepEqual(namesWanted(config, SHOWN), { unsure: true });
  /** @type {any} */ (config.azure).sampleData = true;
  assert.equal(namesWanted(config, null), false);
  assert.deepEqual(doneRequests(config), []);
});

test('done requests: whether you are a Global Administrator comes from your active roles, and roles that can\'t be read count as no', async () => {
  assert.equal(await isGlobalAdmin({ graph: { myDirectoryRoles: async () => [GLOBAL_ADMIN] } }), true);
  assert.equal(await isGlobalAdmin({ graph: { myDirectoryRoles: async () => [{ roleTemplateId: 'f2ef992c-3afb-46b9-b7cf-a126ee74c451' }] } }), false);
  assert.equal(await isGlobalAdmin({ graph: { myDirectoryRoles: async () => { throw new Error('403 Forbidden'); } } }), false);
  assert.equal(await isGlobalAdmin({ graph: {} }), false);
  assert.equal(await isGlobalAdmin(undefined), false);
});

test('done requests: admin consent when this run couldn\'t grant it, then the audit history it skipped; never that it was recorded', () => {
  const config = fabricConfig();
  const consent = (/** @type {import('../src/steps/handoff.js').DoneOptions} */ opts) => to(doneRequests(config, { dataCheck: SHOWN, from: UPN, ...opts }), 'role-admin');
  assert.equal(consent({}), undefined, 'not from an earlier run\'s record');
  assert.equal(consent({ consented: true }), undefined);
  config.auditCheck = { at: '2026-01-01T00:00:00Z', result: 'no-role' };
  assert.equal(consent({}), undefined, 'not from the audit check either');

  const r = consent({ consented: false });
  assert.ok(r);
  assert.equal(r.who, 'A Privileged Role Administrator or Global Administrator');
  assert.deepEqual(r.rows, ['Admin consent']);
  assert.ok(r.message.includes(`Grant admin consent for the Microsoft Graph application permissions of Analytics Hub's app registration (client ID app-1), including AuditLogsQuery.Read.All: open ${apiPermissionsUrl('app-1')} and select "Grant admin consent".`));
  const reload = (/** @type {number} */ days) => `, or open the installer again, set Audit history to "Reload the last ${days} days of audit history" and choose Run now`;
  assert.deepEqual(r.after, [`Then load the audit history: run "${commandLine('run --backfill-days 30')}"${reload(30)}.`]);
  assert.deepEqual(consent({ consented: false, backfillDays: 180 })?.after, [`Then load the audit history: run "${commandLine('run --backfill-days 180')}"${reload(180)}.`]);
  assert.deepEqual(consent({ consented: false, backfillDays: 45 })?.after, [`Then load the audit history: run "${commandLine('run --backfill-days 45')}".`], 'Run now offers 30, 90 or 180 days');
  config.history.days = 90;
  assert.deepEqual(consent({ consented: false })?.after, [`Then load the audit history: run "${commandLine('run --backfill-days 90')}"${reload(90)}.`]);
  assert.doesNotMatch(JSON.stringify(r), /recorded/i);

  assert.equal(to(doneRequests(azureConfig(), { consented: false }), 'role-admin'), undefined, 'not on Azure');
});

test('done requests: Global Reader on Azure is asked for the jobs\' managed identity until the record says it has it', () => {
  const config = azureConfig();
  config.dataSources.resourceGraph = 'api';
  config.resourceGraph.foundry = false;
  const reader = () => to(doneRequests(config, { from: UPN }), 'role-admin');
  const r = reader();
  assert.ok(r);
  assert.deepEqual(r.rows, [AGENT_ROLE]);
  assert.deepEqual(r.asks, [
    `Give the Analytics Hub jobs' managed identity (object ID ${MI}) the Global Reader role in Microsoft Entra, so Analytics Hub can read Copilot Studio agents from Azure Resource Graph. Global Reader is read-only.` +
      '\n  1. In the Microsoft Entra admin center, open Roles & admins and choose Global Reader: https://entra.microsoft.com/#view/Microsoft_AAD_IAM/RolesManagementMenuBlade/~/AllRoles' +
      '\n  2. Choose Add assignments, search for "id-vlens-jobs", the Analytics Hub jobs\' managed identity, and select it.' +
      '\n  3. Choose Add. With Privileged Identity Management, make it an active, permanent assignment.' +
      `\n  Or in Azure Cloud Shell (Bash):\n  ${globalReaderCommand(MI)}`,
  ]);
  assert.deepEqual(r.after, [
    'Once the role applies, the next load collects Copilot Studio agents. Until then, it reports them as "Not collected: permission missing".',
    `${REPAIR}: it finds the role and stops asking.`,
  ]);
  assert.equal(r.message.split('\n').find((l) => l.includes('az rest')), `  ${globalReaderCommand(MI)}`, 'the command is one line');

  config.resourceGraph.roleAssigned = AGENT_ROLE;
  assert.ok(reader(), 'the app\'s role isn\'t the managed identity\'s');
  config.resourceGraph.azureRoleAssigned = AGENT_ROLE;
  assert.equal(reader(), undefined);
  delete config.resourceGraph.azureRoleAssigned;
  config.resourceGraph.agents = false;
  assert.equal(reader(), undefined, 'not needed when agents aren\'t read');
  config.resourceGraph.agents = true;
  /** @type {any} */ (config.azure).sampleData = true;
  assert.equal(reader(), undefined, 'not for sample data');
  /** @type {any} */ (config.azure).sampleData = false;

  /** @type {any} */ (config.azure).outputs = {};
  const later = String(reader()?.message);
  assert.match(later, /Once the installer has created the Analytics Hub jobs' managed identity, give it the Global Reader role .* I'll send you its IDs\./);
  assert.match(later, /2\. Choose Add assignments and select the Analytics Hub jobs' managed identity\./);
  assert.doesNotMatch(later, /az rest/, 'no command before it exists');
});

test('done requests: Foundry Reader until the record says the load has it, with the command once the scope is known', () => {
  const foundry = (/** @type {InstallConfig} */ config) => to(doneRequests(config, { dataCheck: SHOWN }), 'azure-owner');
  const fabric = fabricConfig();
  fabric.dataSources.resourceGraph = 'api';
  fabric.resourceGraph.agents = false;
  const f = foundry(fabric);
  assert.ok(f);
  assert.deepEqual(f.rows, ['Foundry resources']);
  assert.deepEqual(f.asks, [`${APP} the Reader role in Azure on the tenant root management group, so Analytics Hub can read Foundry resources from Azure Resource Graph.`], 'no command until the scope is known');
  assert.deepEqual(f.after, [`${REPAIR_ASKS} "It already has access". Until then, the load reports Foundry as not readable.`]);
  fabric.tenantId = 'tenant-1';
  const scope = resourceGraphScope(fabric, 'tenant-1');
  assert.deepEqual(foundry(fabric)?.asks, [
    `${APP} the Reader role in Azure on the tenant root management group (${scope}), so Analytics Hub can read Foundry resources from Azure Resource Graph. In Azure Cloud Shell (Bash):\n  ${readerCommand('sp-1', scope)}`,
  ]);
  fabric.resourceGraph.access = true;
  assert.equal(foundry(fabric), undefined);

  const azure = azureConfig();
  azure.dataSources.resourceGraph = 'api';
  azure.resourceGraph.agents = false;
  azure.resourceGraph.managementGroup = 'mg-ah';
  azure.resourceGraph.access = true;
  const a = foundry(azure);
  assert.ok(a, 'the app\'s access isn\'t the managed identity\'s');
  assert.match(a.message, /Give the Analytics Hub jobs' managed identity \(object ID mi-1\) the Reader role in Azure on/);
  assert.ok(a.message.includes(readerCommand(MI, resourceGraphScope(azure, ''))));
  azure.resourceGraph.azureAccess = true;
  assert.equal(foundry(azure), undefined);
  delete azure.resourceGraph.azureAccess;
  azure.resourceGraph.foundry = false;
  assert.equal(foundry(azure), undefined, 'not when Foundry isn\'t read');
});

test('done requests: the Azure AI roles, then each pay-as-you-go subscription without access, until the record says the load has them', () => {
  const config = fabricConfig();
  config.modules.consumption = true;
  config.dataSources.coworkCredits = 'api';
  Object.assign(config.consumption, {
    azureSubscriptionId: SUB,
    azureSubscriptionName: 'AI',
    paygSubscriptions: [
      { subscriptionId: PAYG, name: 'Copilot PAYG', policies: ['Sales'] },
      { subscriptionId: 'payg-read', policies: ['HR'], access: true },
      { subscriptionId: 'payg-3', policies: ['IT'] },
    ],
  });
  const owner = () => to(doneRequests(config, { dataCheck: SHOWN, from: UPN }), 'azure-owner');
  const r = owner();
  assert.ok(r);
  assert.equal(r.who, 'An Azure Owner or User Access Administrator');
  assert.deepEqual(r.rows, ['Azure AI costs and metrics', 'Pay-as-you-go costs']);
  const sub = `/subscriptions/${SUB}`;
  assert.deepEqual(r.asks, [
    `${APP} the Reader, Cost Management Reader and Monitoring Reader roles on the Azure subscription AI (${SUB}), so Analytics Hub can read Azure AI costs and metrics. In Azure Cloud Shell (Bash):\n  ` +
      ['Reader', 'Cost Management Reader', 'Monitoring Reader'].map((role) => roleAssignmentCommand('sp-1', role, sub)).join('\n  '),
    `${APP} the Cost Management Reader role on the Azure subscription Copilot PAYG (${PAYG}), so Analytics Hub can read its Copilot pay-as-you-go costs. In Azure Cloud Shell (Bash):\n  ` +
      roleAssignmentCommand('sp-1', 'Cost Management Reader', `/subscriptions/${PAYG}`),
    `${APP} the Cost Management Reader role on the Azure subscription payg-3, so Analytics Hub can read its Copilot pay-as-you-go costs. In Azure Cloud Shell (Bash):\n  ` +
      roleAssignmentCommand('sp-1', 'Cost Management Reader', '/subscriptions/payg-3'),
  ]);
  assert.deepEqual(r.after, [
    `${REPAIR_ASKS} "It already has these roles". Until then, Azure AI is left out of the pipeline.`,
    `${REPAIR_ASKS} "It already has this role" for each pay-as-you-go subscription. Until then, the subscription's Copilot pay-as-you-go costs are left out.`,
  ]);

  config.consumption.azureAccess = true;
  assert.deepEqual(owner()?.rows, ['Pay-as-you-go costs']);
  for (const p of config.consumption.paygSubscriptions ?? []) p.access = true;
  assert.equal(owner(), undefined);

  config.consumption.azureAccess = false;
  config.app.servicePrincipalId = undefined;
  assert.ok(owner()?.message.includes(roleAssignmentCommand('$(az ad sp show --id app-1 --query id -o tsv)', 'Reader', sub)), 'looked up from the client ID');
});

test('done requests: on Azure, the Azure AI roles are for the jobs\' managed identity, and only when Azure AI is read through the API', () => {
  const config = azureConfig();
  config.modules.consumption = true;
  config.dataSources.coworkCredits = 'csv';
  Object.assign(config.consumption, { azureSubscriptionId: SUB, paygSubscriptions: [{ subscriptionId: PAYG, policies: ['Sales'] }] });
  config.dataSources.azureAi = 'csv';
  const owner = () => to(doneRequests(config), 'azure-owner');
  assert.equal(owner(), undefined, 'from the CSV, the load reads no subscription');
  config.dataSources.azureAi = 'api';
  const r = owner();
  assert.deepEqual(r?.rows, ['Azure AI costs and metrics', 'Pay-as-you-go costs']);
  assert.match(String(r?.message), /Give the Analytics Hub jobs' managed identity \(object ID mi-1\) the Reader, Cost Management Reader and Monitoring Reader roles/);
  assert.ok(r?.message.includes(roleAssignmentCommand(MI, 'Monitoring Reader', `/subscriptions/${SUB}`)));
  assert.ok(!doneRequests(config).some((x) => x.admin === 'viva'), 'Azure reads Cowork credits from the export only');
  /** @type {any} */ (config.azure).sampleData = true;
  assert.equal(owner(), undefined, 'not for sample data');
});

test('done requests: Azure\'s pending admin actions and Graph roles go to the admin who does each, with what a re-run does then', () => {
  const consent = `Grant delegated consent on ${apiPermissionsUrl('web-1')}`;
  const teams = `${TEAMS_APP_PENDING}: upload /installs/AnalyticsHub-Teams.zip in Teams admin center > Teams apps > Manage apps (${MANAGE_APPS_URL}).`;
  const owner =
    'An Application Administrator or Cloud Application Administrator adds admin@contoso.com as an owner of "Analytics Hub (Azure)" (client ID web-1): ' +
    'Microsoft Entra admin center > Entra ID > App registrations > All applications > "Analytics Hub (Azure)" > Owners > Add owners';
  const dropSite = 'Grant-PnPAzureADAppSitePermission -AppId jobs-1 -DisplayName "vlens jobs" -Site https://contoso.sharepoint.com/sites/drop -Permissions Read';
  const other = 'Something only an admin can do.';
  const config = azureConfig({
    graphRoles: { assigned: ['User.Read.All'], pending: ['AuditLogsQuery.Read.All', 'User.Read.All', 'Reports.Read.All', 'AuditLogsQuery.Read.All'] },
    status: { pendingAdminActions: [consent, teams, owner, dropSite, other] },
  });
  const requests = doneRequests(config, { from: UPN });
  assert.deepEqual(requests.map((r) => r.admin), ['app-admin', 'role-admin', 'global-admin', 'teams', 'sharepoint-admin', 'other']);
  const [apps, roles, , teamsAdmin, sharepoint, anyone] = requests;
  assert.deepEqual(apps.rows, ['Web app consent', 'App ownership']);
  assert.deepEqual(apps.after, [
    `${REPAIR}: it checks the consent, and stops listing it once it's granted.`,
    `${REPAIR}: it finishes setting up the app and stops listing this.`,
  ]);
  assert.deepEqual(roles.rows, ['Microsoft Graph roles']);
  assert.deepEqual(roles.asks, [
    `Give the Analytics Hub jobs' managed identity (object ID ${MI}) these Microsoft Graph application permissions: AuditLogsQuery.Read.All, Reports.Read.All. In Azure Cloud Shell (Bash):\n  ` +
      graphRolesCommand(MI, ['AuditLogsQuery.Read.All', 'Reports.Read.All']),
  ], 'each pending role once, and none already assigned');
  assert.deepEqual(roles.after, [`${REPAIR}: it tries each of these roles again.`]);
  assert.deepEqual(teamsAdmin.rows, ['Teams app']);
  assert.ok(teamsAdmin.message.includes(`Upload the Analytics Hub Teams package I'll send you (AnalyticsHub-Teams.zip) in Teams admin center > Teams apps > Manage apps (${MANAGE_APPS_URL}).`));
  assert.match(String(teamsAdmin.after), /Without one of them it can't read the catalog, so it lists it again\./);
  assert.deepEqual(sharepoint.rows, ['Drop site access']);
  assert.deepEqual(sharepoint.asks, [dropSite], 'word for word');
  assert.deepEqual(sharepoint.after, [`${REPAIR}: it tries this grant again, and lists it again if it can't make it itself, even once the admin has.`]);
  assert.deepEqual(anyone.rows, ['Pending admin action']);
  assert.deepEqual(anyone.asks, [other]);
  assert.deepEqual(anyone.after, ['Once it\'s done, run the installer again and choose Repair or change.']);

  // With no other ask for an Application Administrator, the web app's consent goes with the Graph roles.
  /** @type {any} */ (config.azure).status.pendingAdminActions = [consent];
  const [withRoles] = doneRequests(config);
  assert.equal(withRoles.admin, 'role-admin');
  assert.deepEqual(withRoles.rows, ['Microsoft Graph roles', 'Web app consent']);

  /** @type {any} */ (config.azure).status.pendingAdminActions = [];
  /** @type {any} */ (config.azure).graphRoles = { assigned: ['AuditLogsQuery.Read.All', 'Reports.Read.All'], pending: [] };
  assert.deepEqual(doneRequests(config).map((r) => r.admin), ['global-admin'], 'nothing pending, nothing asked');
});

test('done requests: the Graph roles Azure\'s jobs no longer use and the run couldn\'t take back go to a role admin, with the command that does', () => {
  const config = azureConfig({ graphRoles: { assigned: [], pending: ['Reports.Read.All'], retired: ['ThreatHunting.Read.All', 'Sites.Selected'] } });
  const requests = doneRequests(config, { from: UPN });
  assert.deepEqual(requests.map((r) => r.admin), ['role-admin', 'global-admin']);
  const roles = /** @type {AdminRequest} */ (to(requests, 'role-admin'));
  assert.deepEqual(roles.rows, ['Microsoft Graph roles', 'Microsoft Graph roles to take back']);
  assert.equal(
    roles.asks[1],
    `Take these Microsoft Graph application permissions back from the Analytics Hub jobs' managed identity (object ID ${MI}), as Analytics Hub no longer uses them: ` +
      `ThreatHunting.Read.All, Sites.Selected. In Azure Cloud Shell (Bash):\n  ${graphRolesRevokeCommand(MI, ['ThreatHunting.Read.All', 'Sites.Selected'])}`,
  );
  assert.deepEqual(roles.after, [
    `${REPAIR}: it tries each of these roles again.`,
    `${REPAIR}: it checks the managed identity's roles again, and stops listing these once they're gone.`,
  ]);
  assert.equal(roles.optional, undefined);
  /** @type {any} */ (config.azure).graphRoles = { assigned: [], pending: [] };
  assert.equal(to(doneRequests(config), 'role-admin'), undefined, 'nothing once a run finds them gone');
});

test('done requests: a SharePoint site the drop folder left is an optional ask of a SharePoint Administrator, with the PnP commands that take the jobs\' read back', () => {
  const OLD = 'https://contoso.sharepoint.com/sites/old';
  const old = { siteUrl: OLD, siteId: 'contoso.sharepoint.com:/sites/old', granted: true };
  const config = azureConfig({ retiredDrops: [{ ...old, appId: 'jobs-1' }] });
  const sharepoint = /** @type {AdminRequest} */ (to(doneRequests(config, { from: UPN }), 'sharepoint-admin'));
  assert.deepEqual(sharepoint.rows, ['Drop site access to take back']);
  assert.equal(sharepoint.optional, true);
  assert.deepEqual(sharepoint.asks, [
    `Optional: take the Analytics Hub jobs' read off ${OLD}, the SharePoint site their drop folder was on, as they no longer read it. ` +
      "Removing a site permission isn't supported with delegated permissions, so run these in PnP PowerShell connected app-only, as an app with the " +
      "Sites.FullControl.All application permission. The first shows the permission's Id: put it in the second. If the first shows nothing, there's nothing to remove." +
      ` In PowerShell (PnP):\n  Get-PnPAzureADAppSitePermission -Site ${OLD} -AppIdentity jobs-1\n  Revoke-PnPAzureADAppSitePermission -Site ${OLD} -PermissionId <the Id it shows>`,
  ]);
  assert.deepEqual(sharepoint.after, [
    'Run the installer again without --yes and choose Repair or change. At the end, when it asks whether a SharePoint Administrator has taken the jobs\' read ' +
      'off the old drop site, choose "Yes, it\'s done".',
  ]);
  assert.equal(sharepoint.back, undefined, 'nothing to send back');
  assert.doesNotMatch(sharepoint.message, /\|/, 'one command, then the other: not piped');

  // The identity the record kept, else the managed identity's client ID, else its display name.
  const identity = (/** @type {any} */ azure) => /-AppIdentity (.+)\n/.exec(String(to(doneRequests(azureConfig(azure)), 'sharepoint-admin')?.message))?.[1];
  assert.equal(identity({ retiredDrops: [old] }), MI_CLIENT);
  assert.equal(identity({ retiredDrops: [old], outputs: {} }), '"vlens jobs"');
  assert.equal(identity({ retiredDrops: [old], outputs: {}, namePrefix: 'ah' }), '"ah jobs"');

  // With the new site's grant waiting too: one request, which isn't optional, the grant word for word.
  const dropSite = 'Grant-PnPAzureADAppSitePermission -AppId jobs-1 -DisplayName "vlens jobs" -Site https://contoso.sharepoint.com/sites/drop -Permissions Read';
  /** @type {any} */ (config.azure).status = { pendingAdminActions: [dropSite] };
  const both = doneRequests(config).filter((r) => r.admin === 'sharepoint-admin');
  assert.equal(both.length, 1);
  assert.deepEqual(both[0].rows, ['Drop site access', 'Drop site access to take back']);
  assert.equal(both[0].asks[0], dropSite);
  assert.equal(both[0].optional, undefined);
  assert.equal(both[0].after?.length, 2);

  const fabric = fabricConfig();
  fabric.azure = /** @type {any} */ ({ retiredDrops: [old] });
  assert.equal(to(doneRequests(fabric), 'sharepoint-admin'), undefined, 'a Fabric install ignores what an Azure one left');
  assert.equal(to(doneRequests(azureConfig()), 'sharepoint-admin'), undefined, 'nothing kept, nothing asked');
});

const MADE_APP = 'the app registration "Analytics Hub Data Collector" (client ID app-1)';
const REVOKE_STEPS =
  '\n  1. In the Microsoft Entra admin center, go to Entra ID > Enterprise apps > All applications, search for app-1 and open "Analytics Hub Data Collector".' +
  '\n  2. Choose Permissions, then the Admin consent tab.' +
  '\n  3. For each of these permissions, choose … (More options) next to it, then Revoke permission, and confirm.';
const CONSENT_GONE = `${REPAIR}: it checks the app's admin consent again, and stops listing these once they're gone.`;

test('done requests: what the Fabric app the installer made no longer uses, and the run couldn\'t take back, goes to who can, until a run finds it gone', () => {
  const config = fabricConfig();
  Object.assign(config.app, { existing: false, retiredPermissions: ['ThreatHunting.Read.All', 'CloudApp-Discovery.Read.All'], retiredConsent: ['ThreatHunting.Read.All'] });
  const requests = doneRequests(config, { from: UPN, dataCheck: SHOWN, broughtRetired: ['Ignored.Read.All'] });
  assert.deepEqual(requests.map((r) => [r.admin, r.who, r.optional]), [['app-admin', APP_OWNER_ADMIN, undefined], ['role-admin', ADMINS['role-admin'], undefined]]);
  const [owners, roles] = requests;
  assert.deepEqual(owners.rows, ['API permissions to remove']);
  assert.deepEqual(owners.asks, [
    `Remove these Microsoft Graph application permissions from ${MADE_APP}, as Analytics Hub no longer uses them: ThreatHunting.Read.All, CloudApp-Discovery.Read.All.` +
      `\n  1. Open its API permissions page: ${apiPermissionsUrl('app-1')}` +
      '\n  2. For each of them, choose … (More options) next to it, then Remove permission, and confirm.',
  ]);
  assert.deepEqual(owners.after, [`${REPAIR}: it checks the app's API permissions again, and stops listing these once they're gone.`]);
  assert.deepEqual(roles.rows, ['Admin consent to take back']);
  assert.deepEqual(roles.asks, [
    `Take back admin consent for these Microsoft Graph application permissions of ${MADE_APP}, as Analytics Hub no longer uses them: ThreatHunting.Read.All.${REVOKE_STEPS}`,
  ]);
  assert.deepEqual(roles.after, [CONSENT_GONE]);
  assert.doesNotMatch(JSON.stringify(requests), /Ignored\.Read\.All/, 'the run reads a made app\'s consent itself');

  // With admin consent still to grant, the role admin's request asks for both.
  assert.deepEqual(to(doneRequests(config, { dataCheck: SHOWN, consented: false }), 'role-admin')?.rows, ['Admin consent', 'Admin consent to take back']);

  // Once a run takes them back, the record no longer lists them, and there's nothing to ask.
  delete config.app.retiredPermissions;
  delete config.app.retiredConsent;
  assert.deepEqual(doneRequests(config, { dataCheck: SHOWN }), []);

  // An Azure install has no Fabric app to ask about.
  const azure = azureConfig({ sampleData: true });
  Object.assign(azure.app, { existing: false, retiredPermissions: ['ThreatHunting.Read.All'], retiredConsent: ['ThreatHunting.Read.All'] });
  assert.deepEqual(doneRequests(azure, { broughtRetired: ['ThreatHunting.Read.All'] }), []);
});

test('done requests: for an app you brought, one optional ask to take back the consent this run read it still has; never from the record', () => {
  for (const existing of [undefined, true]) {
    const config = fabricConfig();
    // A record without `existing` is an app you brought too.
    Object.assign(config.app, { ...(existing ? { existing } : {}), retiredPermissions: ['Stale.Read.All'], retiredConsent: ['Stale.Read.All'] });
    assert.deepEqual(doneRequests(config, { dataCheck: SHOWN }), [], `${existing}: nothing from the record`);
    assert.deepEqual(doneRequests(config, { dataCheck: SHOWN, broughtRetired: [] }), []);

    const requests = doneRequests(config, { from: UPN, dataCheck: SHOWN, broughtRetired: ['CopilotPackages.Read.All', 'Application.Read.All'] });
    assert.deepEqual(requests.map((r) => [r.admin, r.who, r.optional]), [['role-admin', ADMINS['role-admin'], true]]);
    const [r] = requests;
    assert.deepEqual(r.rows, ['Admin consent to take back']);
    assert.deepEqual(r.asks, [
      'Optional: take back admin consent for these Microsoft Graph application permissions of ' +
        `${MADE_APP}, as Analytics Hub no longer uses them: CopilotPackages.Read.All, Application.Read.All.${REVOKE_STEPS}`,
    ]);
    assert.deepEqual(r.notes, [
      'The installer leaves an app you brought as it is, in case something else uses these permissions: send this only if nothing does. ' +
        `Taking them off the app's API permissions too needs one of its owners, an Application Administrator or a Cloud Application Administrator: ${apiPermissionsUrl('app-1')}`,
    ]);
    assert.ok(!r.message.includes('send this only if'), 'the note is for you');
    assert.deepEqual(r.after, [CONSENT_GONE]);
    assert.doesNotMatch(JSON.stringify(requests), /Stale\.Read\.All/);

    // In one request with the consent still to grant, the request as a whole isn't optional.
    const merged = doneRequests(config, { dataCheck: SHOWN, consented: false, broughtRetired: ['Application.Read.All'] });
    assert.deepEqual(merged.map((x) => [x.admin, x.optional, x.rows]), [['role-admin', undefined, ['Admin consent', 'Admin consent to take back']]]);

    const fake = fakeUi();
    fake.ui.doneRequests(requests);
    assert.match(fake.text(), /\n {2}1\. A Privileged Role Administrator or Global Administrator \(optional\)\n {5}For: Admin consent to take back\n/);
  }
});

test('done requests: the product feedback export goes to your mailbox, with a note for another one; the Viva query is optional', () => {
  const config = fabricConfig();
  config.dataSources.productFeedback = 'api';
  const feedback = (/** @type {string | undefined} */ from) => to(doneRequests(config, { dataCheck: SHOWN, from }), 'm365-admin');
  const r = feedback(UPN);
  assert.ok(r);
  assert.equal(r.who, 'A Microsoft 365 admin');
  assert.match(r.message, /1\. In the Microsoft 365 admin center, open Health > Product feedback: https:\/\//);
  assert.match(r.message, /2\. Choose Export and schedule it to be emailed to admin@contoso\.com, with the subject "Copilot Product Feedback"\./);
  assert.match(r.message, /The subject must be exactly "Copilot Product Feedback", so the flow picks it up\./);
  assert.deepEqual(r.notes, ['If the Analytics Hub - Product feedback flow\'s Outlook connection signs in as another mailbox, change the address to that one before you send it.']);
  assert.ok(!r.message.includes(String(r.notes?.[0])), 'the note is for you');
  assert.match(String(r.after), /saves the CSV files attached to each export email, and the next load reads them\.$/);
  assert.match(String(feedback(undefined)?.message), /emailed to the mailbox the flow reads,/);
  assert.equal(to(doneRequests(azureConfig({}), { dataCheck: SHOWN }), 'm365-admin'), undefined, 'Fabric only');
});

test('done requests: the client secret a vault admin hasn\'t added yet is a request of its own, after the Azure owner\'s, once', () => {
  const config = fabricConfig();
  config.dataSources.resourceGraph = 'api';
  Object.assign(config.fabric, { workspaceId: 'ws-1', lakehouseId: 'lh-1' });
  Object.assign(config.keyVault, { name: 'kv-ah', secretName: 'ah-client-secret', mode: 'keyvault-admin', rbac: true });
  const vault = vaultAsk({ config, user: { upn: UPN, id: 'user-1', tenantId: 't-1' } });
  const requests = doneRequests(config, { from: UPN, dataCheck: SHOWN, vault: [vault, vault] });
  assert.deepEqual(requests.map((r) => r.admin), ['role-admin', 'azure-owner', 'vault-admin']);
  const r = to(requests, 'vault-admin');
  assert.equal(r?.who, 'A Key Vault admin');
  assert.deepEqual(r?.rows, ['Client secret in Key Vault']);
  assert.equal(r?.asks.length, 1);
  assert.ok(
    r?.message.startsWith(
      'Hi,\n\nI\'ve installed Analytics Hub, and I need your help with this:\n\n- Create a client secret for the app "Analytics Hub Data Collector" (application ID app-1), ' +
        'and add it to the Key Vault kv-ah as a secret named ah-client-secret.\n',
    ),
    r?.message,
  );
  assert.deepEqual(r?.after, ['Run the installer again without --yes and choose Repair or change. When it asks "Has the admin added the secret?", choose "Yes, carry on".']);
  assert.equal(to(doneRequests(config, { from: UPN, dataCheck: SHOWN }), 'vault-admin'), undefined, 'only when the summary passes it');
});

test('requestsFor: one request per admin and addressee, in the order of ADMINS, saying whether the install is under way or finished', () => {
  /** @type {import('../src/steps/handoff.js').Ask[]} */
  const asks = [
    { admin: 'licence', text: 'Assign me a licence.' },
    { admin: 'vault-admin', text: 'Add the secret.', label: 'Client secret in Key Vault', after: ['Carry on.'] },
    { admin: 'licence', text: 'Assign me a licence.' },
  ];
  const during = requestsFor(asks, UPN, false);
  assert.deepEqual(during.map((r) => [r.admin, r.who, r.asks]), [['vault-admin', 'A Key Vault admin', ['Add the secret.']], ['licence', ADMINS.licence, ['Assign me a licence.']]]);
  assert.equal(during[0].message, 'Hi,\n\nI\'m installing Analytics Hub, and I need your help with this:\n\n- Add the secret.\n\nThanks\nadmin@contoso.com');
  assert.deepEqual(during[0].after, ['Carry on.']);
  assert.deepEqual(during[1].rows, ['Pending admin action'], 'an ask without a label');
  assert.match(requestsFor(asks, UPN, true)[0].message, /^Hi,\n\nI've installed Analytics Hub, and I need your help with this:\n/);
});

test('done requests: the terminal lists each request with who, what for, the message, your notes and what you do afterwards', () => {
  const config = fabricConfig();
  config.dataSources.productFeedback = 'api';
  config.modules.consumption = true;
  config.dataSources.coworkCredits = 'csv';
  const fake = fakeUi();
  fake.ui.doneRequests(doneRequests(config, { dataCheck: SHOWN, from: UPN }));
  const text = fake.text();
  assert.match(text, /^\n {2}Still to do by your admins: copy each request and send it\.\n/);
  assert.match(text, /\n {2}1\. A Microsoft 365 admin\n {5}For: Product feedback export\n {5}If the .* flow's Outlook connection signs in as another mailbox.*\n {5}Copy and send:\n {7}Hi,\n/);
  assert.match(text, /\n {2}2\. An Insights Analyst \(optional\)\n {5}For: Cowork credits query\n/);
  assert.match(text, /\n {5}Once it's done:\n {7}Run the installer again and choose Connected \(Dataflow\) for Cowork credits, with the two IDs\.\n/);
  assert.match(text, /\n {7}Thanks\n {7}admin@contoso\.com\n/);

  const none = fakeUi();
  none.ui.doneRequests([]);
  assert.equal(none.text(), '', 'nothing printed with nothing left');
});

test('done requests: no request has a secret, a key, a token, a password, a sign-in code or a path on your computer', () => {
  const planted = (/** @type {InstallConfig} */ config) => {
    const c = /** @type {any} */ (config);
    Object.assign(c.app, {
      secretKeyId: 'PLANTED-key-id',
      pendingSecretKeyIds: ['PLANTED-pending-key'],
      clientSecret: 'PLANTED-client-secret',
      adminPack: 'C:\\Users\\someone\\analytics-hub\\analytics-hub-admin-pack.md',
    });
    Object.assign(c.keyVault, { secretName: 'PLANTED-secret-name', secretKeyId: 'PLANTED-vault-key' });
    c.semanticModel.secretKeyId = 'PLANTED-model-key';
    c.setup = { completed: [], uploads: [{ name: 'x', token: 'PLANTED-upload-token' }] };
    c.tenantId = 'tenant-1';
    c.dataSources.resourceGraph = 'api';
    c.dataSources.productFeedback = 'api';
    c.dataSources.coworkCredits = 'csv';
    c.dataSources.azureAi = 'api';
    c.modules.consumption = true;
    Object.assign(c.consumption, { azureSubscriptionId: SUB, paygSubscriptions: [{ subscriptionId: PAYG, policies: ['Sales'] }] });
    return config;
  };
  const fabric = planted(fabricConfig());
  Object.assign(fabric.app, { existing: false, retiredPermissions: ['ThreatHunting.Read.All'], retiredConsent: ['CloudApp-Discovery.Read.All'] });
  const brought = planted(fabricConfig());
  const azure = planted(
    azureConfig({
      webApp: { clientId: 'web-1', clientSecret: 'PLANTED-web-secret', secretKeyId: 'PLANTED-web-key' },
      sqlReader: { clientId: 'sql-1', secretKeyId: 'PLANTED-sql-key' },
      graphRoles: { assigned: [], pending: ['AuditLogsQuery.Read.All'], retired: ['ThreatHunting.Read.All'] },
      retiredDrops: [{ siteUrl: 'https://contoso.sharepoint.com/sites/old', siteId: 'contoso.sharepoint.com:/sites/old', granted: true, appId: MI_CLIENT }],
      adminScript: 'C:\\Users\\someone\\analytics-hub\\admin.sh',
      status: {
        pendingAdminActions: [
          `Grant delegated consent on ${apiPermissionsUrl('web-1')}`,
          `${TEAMS_APP_PENDING}: upload C:\\Users\\someone\\analytics-hub\\AnalyticsHub-Teams.zip in Teams admin center > Teams apps > Manage apps (${MANAGE_APPS_URL}).`,
        ],
      },
    }),
  );
  /** Each config, and the take-back rows its requests carry. @type {[InstallConfig, string[]][]} */
  const cases = [
    [fabric, ['API permissions to remove', 'Admin consent to take back']],
    [brought, ['Admin consent to take back']],
    [azure, ['Microsoft Graph roles to take back', 'Drop site access to take back']],
  ];
  for (const [config, takeBack] of cases) {
    // With the asks the end carries from preflight and the flows' check.
    const carried = [
      row({ id: 'consent-role', howTo: `Ask a Global Administrator to grant admin consent, and to check audit logging is on: ${PURVIEW_AUDIT_URL}` }),
      row({ id: 'audit-ingestion', status: 'handoff' }),
      row({ id: 'power-automate-premium' }),
      dataPolicyPrereq(config),
      unreadSettings(config),
    ];
    const requests = doneRequests(config, { from: UPN, consented: false, carried, broughtRetired: ['Application.Read.All'] });
    assert.ok(requests.length >= 4, config.target);
    for (const admin of ['compliance', 'licence', 'power-platform', 'fabric-admin']) assert.ok(to(requests, admin), `${config.target}: ${admin}`);
    for (const label of takeBack) assert.ok(requests.some((r) => r.rows.includes(label)), `${config.target}: ${label}`);
    const text = JSON.stringify(requests);
    assert.doesNotMatch(text, /PLANTED/);
    assert.doesNotMatch(text, /\b(client secrets?|password|passcode|sign-in code|device code|bearer|access token|refresh token)\b/i);
    assert.doesNotMatch(text, /Users\\\\someone|C:\\\\/, 'files go by their names, not their paths');
  }
});

/**
 * Whether the end asks again for each row's ask from preflight or the flows' check: a finished install settles it, the
 * end asks for it from the install record anyway, it's carried while the record doesn't settle it, or the row never
 * asks. The Power Platform Administrator's environment ask is settled, and its connection ask is the record's.
 * @type {Record<string, 'settled' | 'record' | 'settled, record' | 'carried' | 'none'>}
 */
const CARRY = {
  'register-apps': 'settled',
  'fabric-capacity': 'settled',
  'azure-rbac': 'settled',
  environments: 'settled',
  'key-vault': 'settled',
  'power-bi-pro': 'settled',
  'power-platform-admin': 'settled, record',
  'teams-admin': 'record',
  'viva-analyst': 'record',
  'resource-graph': 'record',
  'consent-role': 'carried',
  'audit-ingestion': 'carried',
  'power-automate-premium': 'carried',
  'data-policy': 'carried',
  'tenant-settings': 'carried',
  'fabric-admin': 'none',
  'copilot-licences': 'none',
  'defender-licence': 'none',
};

test('done requests: of the rows preflight and the flows\' check asked for, the end asks again for none that a finished install settles, or that the record asks for itself', () => {
  assert.deepEqual(Object.keys(CARRY).sort(), Object.keys(ROW_ASKS).sort(), 'every row that can ask is classified');
  for (const [id, why] of Object.entries(CARRY)) assert.equal(ROW_ASKS[id] === null, why === 'none', id);
  for (const config of [fabricConfig(), azureConfig()]) {
    Object.assign(config.keyVault, { id: '/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.KeyVault/vaults/kv-ah', name: 'kv-ah' });
    const base = doneRequests(config, { from: UPN });
    /** What each row asked for before the install. @type {import('../src/steps/handoff.js').AskContext} */
    const before = { config, status: () => undefined, ppApi: true, pendingConsent: false, pendingTeams: false };
    for (const [id, why] of Object.entries(CARRY)) {
      if (why === 'carried' || why === 'none') continue;
      for (const status of /** @type {const} */ (['missing', 'handoff'])) {
        const it = row({ id, status });
        assert.ok(ROW_ASKS[id]?.(it, before).length, `${config.target}: ${id} asked for something`);
        assert.deepEqual(doneRequests(config, { from: UPN, carried: [it] }), base, `${config.target}: ${id}, ${status}`);
      }
    }
  }
});

test('done requests: the end asks again for audit logging in Microsoft Purview, once, until something finds audit records', () => {
  const consent = row({ id: 'consent-role', label: 'Admin consent', howTo: `Ask a Global Administrator to grant admin consent, and to check audit logging is on: ${PURVIEW_AUDIT_URL}` });
  const ingestion = row({ id: 'audit-ingestion', label: 'Audit log ingestion', status: 'handoff' });
  const carried = [consent, ingestion];
  const config = fabricConfig();
  assert.deepEqual(doneRequests(config, { from: UPN, dataCheck: SHOWN }), []);
  const requests = doneRequests(config, { from: UPN, dataCheck: SHOWN, carried });
  assert.deepEqual(
    requests.map(({ message, ...r }) => r),
    [{ admin: 'compliance', who: ADMINS.compliance, rows: ['Audit logging in Microsoft Purview'], asks: [PURVIEW], after: [CHECK_AUDIT] }],
    'once from both rows, and not their consent asks: the record asks for consent',
  );
  assert.match(requests[0].message, /^Hi,\n\nI've installed Analytics Hub, and I need your help with this:\n\n- Check that audit logging is on in Microsoft Purview > Audit/);
  assert.deepEqual(doneRequests(config, { from: UPN, dataCheck: SHOWN, carried: [...carried, ...carried] }), requests, 'the same rows twice ask once');
  assert.deepEqual(doneRequests(config, { from: UPN, dataCheck: SHOWN, carried: [row({ id: 'consent-role' })] }), [], 'preflight didn\'t ask about audit logging');

  // This run's data check, or else the Lakehouse's last one, loaded or left out audit records.
  assert.deepEqual(doneRequests(config, { from: UPN, dataCheck: { ...SHOWN, tables: { audit: { rows: 12 } } }, carried }), []);
  assert.deepEqual(doneRequests(config, { from: UPN, dataCheck: { ...SHOWN, auditExcluded: { parsed: 3 } }, carried }), []);
  // The last audit check found records. "ok" says only that the app can search the audit log.
  for (const result of /** @type {const} */ (['records', 'no-copilot', 'ok', 'empty-log', 'timeout'])) {
    config.auditCheck = { at: '2026-06-01T00:00:00Z', result };
    const found = result === 'records' || result === 'no-copilot';
    assert.deepEqual(doneRequests(config, { from: UPN, dataCheck: SHOWN, carried }).map((r) => r.admin), found ? [] : ['compliance'], result);
  }

  // Azure runs no live audit search to test it with, and the record asks for the jobs' Graph roles.
  const azure = azureConfig();
  const onAzure = doneRequests(azure, { from: UPN, carried: [row({ id: 'audit-ingestion', label: 'Audit log ingestion' })] });
  assert.deepEqual(onAzure.filter((r) => r.admin !== 'compliance'), doneRequests(azure, { from: UPN }));
  assert.deepEqual(to(onAzure, 'compliance')?.asks, [PURVIEW]);
  assert.equal(to(onAzure, 'compliance')?.after, undefined);
});

test('done requests: the end asks again for Power Automate Premium while there are flows, and for the data policy until every flow is on', () => {
  const premium = row({ id: 'power-automate-premium', label: 'Power Automate Premium' });
  const none = fabricConfig();
  assert.deepEqual(flowsWanted(none), []);
  assert.deepEqual(doneRequests(none, { from: UPN, carried: [premium, dataPolicyPrereq(none)] }), doneRequests(none, { from: UPN }), 'no flows, so neither');

  const on = flowsConfig();
  assert.deepEqual(flowsWanted(on), ['studio']);
  Object.assign(on.uploads, { flowIds: { studio: 'flow-1' }, flowsConnected: { studio: 'flow-1' } });
  const requests = doneRequests(on, { from: UPN, carried: [premium, dataPolicyPrereq(on)] });
  assert.deepEqual(requests.filter((r) => r.admin !== 'licence'), doneRequests(on, { from: UPN }), 'every flow is on, so not the data policy');
  assert.deepEqual(to(requests, 'licence')?.asks, [PREMIUM]);
  assert.deepEqual(to(requests, 'licence')?.rows, ['Power Automate Premium']);
  assert.equal(to(requests, 'licence')?.after, undefined, 'nothing for you to do once it\'s assigned');

  /** @type {any[]} */
  const offs = [
    {},
    { flowIds: { studio: 'flow-1' } },
    { flowIds: { studio: 'flow-1' }, flowsConnected: { studio: 'flow-0' } },
    { flowIds: { studio: 'flow-1' }, flowsConnected: { studio: 'flow-1' }, flowFiles: { studio: 'flow.zip' } },
  ];
  for (const off of offs) {
    const config = flowsConfig();
    Object.assign(config.uploads, off);
    const policy = dataPolicyPrereq(config);
    const these = doneRequests(config, { from: UPN, carried: [premium, policy, premium, policy] });
    const why = JSON.stringify(off);
    assert.deepEqual(these.filter((r) => r.admin !== 'licence' && r.admin !== 'power-platform'), doneRequests(config, { from: UPN }), why);
    assert.deepEqual(to(these, 'licence')?.asks, [PREMIUM], why);
    assert.deepEqual(to(these, 'licence')?.after, [TURN_ON], why);
    const pp = to(these, 'power-platform');
    assert.deepEqual(pp?.asks, adminRequests([policy], config)[0].asks, why);
    assert.match(pp?.asks[0] ?? '', /^Confirm that .* in Sales\./, why);
    assert.deepEqual(pp?.rows, ['Data policy'], why);
    assert.deepEqual(pp?.after, [SAVE_FLOWS], why);
  }
});

test('done requests: the end asks again for the Fabric tenant settings preflight couldn\'t read, less those the install record proves are on', () => {
  const config = fabricConfig();
  config.semanticModel.enabled = true;
  // As preflight showed it before the install made anything.
  const unread = unreadSettings(config);
  const base = doneRequests(config, { from: UPN, dataCheck: SHOWN });
  /** @param {Prereq} [it] */
  const at = (it = unread) => {
    const requests = doneRequests(config, { from: UPN, dataCheck: SHOWN, carried: [it] });
    assert.deepEqual(requests.filter((r) => r.admin !== 'fabric-admin' && r.admin !== 'capacity-admin'), base);
    return { fabric: to(requests, 'fabric-admin'), capacity: to(requests, 'capacity-admin') };
  };

  // No workspace: creating it and its items, and the model's connection. The app and the reports weren't chosen.
  assert.deepEqual(settingsLeft(config), { settings: [CREATE_WS, ITEMS, SP], xmla: false, app: false, create: true });
  let left = at();
  assert.deepEqual(left.fabric?.asks, [settingsText([CREATE_WS, ITEMS, SP])]);
  assert.deepEqual(left.fabric?.rows, ['Fabric tenant settings']);
  assert.deepEqual(left.fabric?.after, [CREATE_AFTER]);
  assert.equal(left.capacity, undefined);

  // The workspace proves "Create workspaces"; without its pipeline, the items may not all be made.
  Object.assign(config.fabric, { workspaceId: 'ws-1', lakehouseId: 'lh-1' });
  assert.deepEqual(settingsLeft(config), { settings: [ITEMS, SP], xmla: false, app: false, create: true });
  assert.deepEqual(at().fabric?.after, [CREATE_AFTER]);
  // The Lakehouse and the pipeline prove "Users can create Fabric items". Nothing in the record proves the model's.
  config.fabric.pipelineId = 'pl-1';
  assert.deepEqual(settingsLeft(config), { settings: [SP], xmla: false, app: false, create: false });
  left = at();
  assert.deepEqual(left.fabric?.asks, [settingsText([SP])]);
  assert.equal(left.fabric?.after, undefined);

  // The app and the reports, chosen: the app's item proves the Fabric apps setting.
  config.semanticModel.reports = true;
  config.fabricApp.enabled = true;
  assert.deepEqual(settingsLeft(config), { settings: [SP, EXEC, FABRIC_APPS, VISUALS], xmla: false, app: true, create: false });
  left = at();
  assert.deepEqual(left.fabric?.asks, [settingsText([SP, EXEC, FABRIC_APPS, VISUALS])]);
  assert.deepEqual(left.fabric?.after, [DEPLOY_APP_AFTER]);
  config.fabricApp.itemId = 'app-item-1';
  assert.deepEqual(settingsLeft(config), { settings: [SP, EXEC, VISUALS], xmla: false, app: false, create: false });
  assert.equal(at().fabric?.after, undefined);

  // Org-scoped access, until it's applied through the XMLA endpoint, which proves the setting and the capacity's Read Write.
  Object.assign(config.semanticModel, { reports: false });
  Object.assign(config.fabricApp, { enabled: false, itemId: undefined });
  config.access = { rls: { enabled: true } };
  assert.deepEqual(settingsLeft(config), { settings: [SP, XMLA_SETTING], xmla: true, app: false, create: false });
  left = at();
  assert.deepEqual(left.fabric?.asks, [settingsText([SP, XMLA_SETTING])]);
  assert.deepEqual(left.fabric?.after, [ACCESS_AFTER]);
  assert.deepEqual(left.capacity?.asks, [XMLA]);
  assert.deepEqual(left.capacity?.rows, ['Fabric tenant settings']);
  assert.deepEqual(left.capacity?.after, [ACCESS_AFTER]);
  config.access.rls = { enabled: true, applied: ['model-1'] };
  left = at();
  assert.deepEqual(left.fabric?.asks, [settingsText([SP])]);
  assert.equal(left.capacity, undefined);

  // Settings you could read, you turn on yourself; and none are left with the model off.
  assert.equal(at(row({ id: 'tenant-settings', label: 'Fabric tenant settings', detail: `Off: ${SP}.` })).fabric, undefined);
  assert.equal(at({ ...unread, status: 'met' }).fabric, undefined);
  config.semanticModel.enabled = false;
  assert.deepEqual(settingsLeft(config), { settings: [], xmla: false, app: false, create: false });
  assert.equal(at().fabric, undefined);
});

test('done requests: on Azure, the end asks again for the web app\'s and the reports\' tenant settings preflight couldn\'t read', () => {
  const config = azureConfig();
  const unread = unreadSettings(config);
  const base = doneRequests(config, { from: UPN });
  /** @param {InstallConfig} c */
  const at = (c) => {
    const requests = doneRequests(c, { from: UPN, carried: [unread] });
    assert.deepEqual(requests.filter((r) => r.admin !== 'fabric-admin' && r.admin !== 'capacity-admin'), doneRequests(c, { from: UPN }));
    return { fabric: to(requests, 'fabric-admin'), capacity: to(requests, 'capacity-admin') };
  };
  assert.equal(to(base, 'fabric-admin'), undefined);
  assert.deepEqual(settingsLeft(config), { settings: [CREATE_WS, SP, EXEC, VISUALS], xmla: false, app: false, create: true });
  let left = at(config);
  assert.deepEqual(left.fabric?.asks, [settingsText([CREATE_WS, SP, EXEC, VISUALS])]);
  assert.deepEqual(left.fabric?.after, [CREATE_AFTER]);

  const built = azureConfig({ powerBi: { workspaceId: 'pbi-ws-1' } });
  left = at(built);
  assert.deepEqual(left.fabric?.asks, [settingsText([SP, EXEC, VISUALS])]);
  assert.equal(left.fabric?.after, undefined);
  built.access = { rls: { enabled: true } };
  left = at(built);
  assert.deepEqual(left.fabric?.asks, [settingsText([SP, EXEC, VISUALS, XMLA_SETTING])]);
  assert.deepEqual(left.fabric?.after, [ACCESS_AFTER]);
  assert.deepEqual(left.capacity?.asks, [XMLA]);
  assert.deepEqual(left.capacity?.after, [ACCESS_AFTER]);
});

/**
 * A Fabric install's summary, with the last data check the Lakehouse holds and your directory roles.
 * @param {{ check?: any, roles?: any[] | Error, opts?: Parameters<typeof summary>[1], config?: InstallConfig }} [o]
 */
async function fabricSummary(o = {}) {
  const fake = fakeUi();
  /** @type {string[]} */
  const reads = [];
  const oneLake = {
    readJson: async (/** @type {string} */ ws, /** @type {string} */ lh, /** @type {string} */ path) => {
      reads.push(`${ws} ${lh} ${path}`);
      if (o.check instanceof Error) throw o.check;
      return o.check ?? null;
    },
  };
  const graph = {
    myDirectoryRoles: async () => {
      if (o.roles instanceof Error) throw o.roles;
      return o.roles ?? [];
    },
  };
  const t = fakeCtx({ ui: fake.ui, fabric: fakeFabric().api, oneLake, graph, config: o.config ?? fabricConfig() });
  t.config.fabric.workspaceName = 'Analytics Hub';
  await summary(t.ctx, o.opts);
  return { ...t, ...fake, reads };
}

test('summary: concealed names go by this run\'s data check, or else the last one the Lakehouse holds', async () => {
  // A Repair without a first load: the Lakehouse's last check shows names.
  const repair = await fabricSummary({ check: SHOWN });
  assert.deepEqual(repair.reads, [`ws-1 lh-1 ${DATA_CHECK_FILE}`]);
  assert.doesNotMatch(repair.text(), /Concealed names|Still to do by your admins/);

  const run = await fabricSummary({ check: SHOWN, opts: { dataCheck: HIDDEN } });
  assert.deepEqual(run.reads, [], 'this run\'s check comes first');
  assert.match(run.text(), /\n {2}1\. A Global Administrator\n {5}For: Concealed names\n/);
  assert.doesNotMatch(run.text(), /already show names/);

  for (const check of [null, new Error('404 Not Found')]) {
    const none = await fabricSummary({ check });
    assert.match(none.text(), /For: Concealed names/, 'no check to tell by');
    assert.match(none.text(), /If the reports already show names, there's nothing to do\./);
  }
});

test('summary: lastDataCheck reads the Lakehouse\'s last data check, and is null without one', async () => {
  const check = { identity: { licensed: 3, audit: 2, masked: 0 } };
  const { ctx } = fakeCtx({ oneLake: { readJson: async () => check } });
  assert.deepEqual(await lastDataCheck(ctx), check);
  ctx.config.fabric.lakehouseId = undefined;
  assert.equal(await lastDataCheck(ctx), null, 'no Lakehouse');
  const failing = fakeCtx({ oneLake: { readJson: async () => { throw new Error('404 Not Found'); } } });
  assert.equal(await lastDataCheck(failing.ctx), null);
  const empty = fakeCtx({ oneLake: { readJson: async () => undefined } });
  assert.equal(await lastDataCheck(empty.ctx), null);
});

test('summary: a Global Administrator gets concealed names as their own card; roles that can\'t be read get the request', async () => {
  const admin = await fabricSummary({ roles: [GLOBAL_ADMIN] });
  assert.match(admin.text(), /1 step left/);
  assert.match(admin.text(), /\d\. Show user names in the Microsoft 365 usage reports +You/);
  assert.doesNotMatch(admin.text(), /For: Concealed names|Still to do by your admins/);

  const unread = await fabricSummary({ roles: new Error('403 Forbidden') });
  assert.match(unread.text(), /For: Concealed names/);
  assert.doesNotMatch(unread.text(), /\d\. Show user names in the Microsoft 365 usage reports +You/);
});

test('summary: this run\'s consent result and audit history reach the request, with nothing saying that nothing\'s left', async () => {
  const t = await fabricSummary({ check: SHOWN, opts: { consented: false, backfillDays: 90 } });
  const text = t.text();
  assert.match(text, /\n {2}1\. A Privileged Role Administrator or Global Administrator\n {5}For: Admin consent\n/);
  assert.ok(text.includes(`Then load the audit history: run "${commandLine('run --backfill-days 90')}"`));
  assert.doesNotMatch(text, /steps? left|nothing left|all set/i, 'no cards, and the requests are still to do');
  assert.ok(text.indexOf('Still to do by your admins') < text.indexOf('Workspace:'));
});

/**
 * An Azure install's summary, with your directory roles.
 * @param {InstallConfig} config @param {any[]} [roles] @param {{ update?: boolean }} [opts]
 */
async function azureSummaryText(config, roles = [], opts = {}) {
  const fake = fakeUi();
  const t = fakeCtx({ ui: fake.ui, graph: { myDirectoryRoles: async () => roles }, config });
  await azureSummary(t.ctx, opts);
  return fake.text();
}

test('azure summary: the requests print once, before the record line, and the Teams line points to its request', async () => {
  const teams = `${TEAMS_APP_PENDING}: upload /installs/AnalyticsHub-Teams.zip in Teams admin center > Teams apps > Manage apps (${MANAGE_APPS_URL}).`;
  const dropSite = 'Grant-PnPAzureADAppSitePermission -AppId jobs-1 -DisplayName "vlens jobs" -Site https://contoso.sharepoint.com/sites/drop -Permissions Read';
  const config = azureConfig({
    teamsPackage: '/installs/AnalyticsHub-Teams.zip',
    graphRoles: { assigned: [], pending: ['AuditLogsQuery.Read.All'] },
    status: { pendingAdminActions: [teams, dropSite] },
  });
  config.dataSources.resourceGraph = 'api';
  const text = await azureSummaryText(config);
  const title = text.indexOf('Still to do by your admins: copy each request and send it.');
  assert.ok(title > 0, text);
  assert.ok(title < text.indexOf('Record:     Keep valuelens-install.json'), 'before the record line');
  assert.equal(text.split('Still to do by your admins: copy each request').length, 2, 'once');
  assert.match(text, /Teams: +Not published yet\. Send a Teams Administrator the request for it, under "Still to do by your admins"\./);
  assert.equal(text.split('Upload the Analytics Hub Teams package').length, 2, 'the Teams ask once');
  assert.equal(text.split(dropSite).length, 2, 'the drop site\'s grant once');
  assert.equal(text.split('these Microsoft Graph application permissions').length, 2, 'the Graph roles once');
  for (const who of ['A Privileged Role Administrator or Global Administrator', 'A Global Administrator', 'A Teams Administrator', 'A SharePoint Administrator', 'An Azure Owner or User Access Administrator']) {
    assert.match(text, new RegExp(`\\n  \\d\\. ${who}\\n`), who);
  }
  assert.match(text, /For: Global Reader; Microsoft Graph roles\n/, 'Global Reader for the managed identity, with its Graph roles');
});

test('azure summary: an update lists no requests, so its Teams line says what to do, as before', async () => {
  const teams = `${TEAMS_APP_PENDING}: upload /installs/AnalyticsHub-Teams.zip in Teams admin center > Teams apps > Manage apps (${MANAGE_APPS_URL}).`;
  const config = azureConfig({ teamsPackage: '/installs/AnalyticsHub-Teams.zip', graphRoles: { assigned: [], pending: ['AuditLogsQuery.Read.All'] }, status: { pendingAdminActions: [teams] } });
  config.dataSources.resourceGraph = 'api';
  const text = await azureSummaryText(config, [], { update: true });
  assert.ok(text.includes(`Teams:      Not published yet. A Teams Administrator needs to upload /installs/AnalyticsHub-Teams.zip in Teams admin center`), text);
  assert.doesNotMatch(text, /Still to do by your admins/);
  assert.match(text, /Record: +Keep valuelens-install\.json/);

  const admin = await azureSummaryText(azureConfig(), [GLOBAL_ADMIN], { update: true });
  assert.doesNotMatch(admin, /Show user names in the Microsoft 365 usage reports|steps? left/, 'nor the card for a Global Administrator');
});

test('azure summary: a drop site to take back is listed, then asked about at the end of each install or Repair after, until you say it\'s done', async () => {
  const OLD = 'https://contoso.sharepoint.com/sites/old';
  const config = azureConfig({ retiredDrops: [{ siteUrl: OLD, siteId: 'contoso.sharepoint.com:/sites/old', granted: true }] });
  const az = /** @type {any} */ (config.azure);
  const question = `Has a SharePoint Administrator taken the Analytics Hub jobs' read off ${OLD}?`;
  const end = async (/** @type {Parameters<typeof fakeUi>[0]} */ ui, /** @type {{ update?: boolean }} */ opts = {}) => {
    const fake = fakeUi(ui);
    const t = fakeCtx({ ui: fake.ui, graph: { myDirectoryRoles: async () => [] }, config });
    await azureSummary(t.ctx, opts);
    return { ...fake, saves: t.saves() };
  };

  const update = await end({ answers: ['yes'] }, { update: true });
  assert.deepEqual(update.asked, []);
  assert.equal(az.retiredDrops[0].shownAt, undefined, 'an update lists no requests');

  const first = await end({ answers: ['yes'] });
  assert.deepEqual(first.asked, [], 'no admin has had it yet');
  assert.match(first.text(), /\n {2}\d\. A SharePoint Administrator \(optional\)\n/);
  assert.ok(first.text().includes(`Get-PnPAzureADAppSitePermission -Site ${OLD} -AppIdentity ${MI_CLIENT}`));
  assert.equal(az.retiredDrops[0].shownAt, '2026-06-01T12:00:00.000Z');
  assert.equal(first.saves, 1);

  const notYet = await end({ answers: ['no'] });
  assert.deepEqual(notYet.asked, [question]);
  assert.ok(notYet.text().includes('Get-PnPAzureADAppSitePermission'), 'still listed');
  assert.equal(notYet.saves, 0, 'nothing changed');
  const yes = await end({ yes: true });
  assert.deepEqual(yes.asked, [], '--yes answers "Not yet" without asking');
  assert.ok(yes.text().includes('Get-PnPAzureADAppSitePermission'));

  const done = await end({ answers: ['yes'] });
  assert.deepEqual(done.asked, [question]);
  assert.match(done.text(), /The jobs no longer have read on https:\/\/contoso\.sharepoint\.com\/sites\/old/);
  assert.doesNotMatch(done.text(), /Get-PnPAzureADAppSitePermission|A SharePoint Administrator/);
  assert.equal(az.retiredDrops, undefined);
  assert.equal(done.saves, 1);
});

test('azure summary: a Global Administrator gets concealed names as their own card, and nothing for sample data', async () => {
  const config = azureConfig();
  const admin = await azureSummaryText(config, [GLOBAL_ADMIN]);
  assert.match(admin, /\d\. Show user names in the Microsoft 365 usage reports +You/);
  assert.match(admin, /If the reports already show names, there's nothing to do\./);
  assert.doesNotMatch(admin, /Still to do by your admins: copy/);
  assert.ok(admin.indexOf('Show user names') < admin.indexOf('Record:'));

  const other = await azureSummaryText(azureConfig());
  assert.match(other, /\n {2}1\. A Global Administrator\n {5}For: Concealed names\n/);

  const sample = azureConfig({ sampleData: true });
  const demo = await azureSummaryText(sample, [GLOBAL_ADMIN]);
  assert.doesNotMatch(demo, /Show user names|Still to do by your admins: copy/);
});
