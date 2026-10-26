// @ts-check
// What's left for admins at the end of an install or Repair: one request per admin, from the install record and this
// run, in the terminal. The Done page's are in setup-page.test.js, and each module's own asks in its tests.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { graphRolesCommand, roleAssignmentCommand } from '../src/admin-commands.js';
import { apiPermissionsUrl, GLOBAL_ADMIN_ROLE } from '../src/clients/graph.js';
import { emptyConfig } from '../src/config.js';
import { summary } from '../src/install.js';
import { commandLine } from '../src/launch.js';
import { azureSummary } from '../src/steps/azure/index.js';
import { MANAGE_APPS_URL, TEAMS_APP_PENDING } from '../src/steps/azure/teams-catalog.js';
import { ADMINS, doneRequests, isGlobalAdmin, namesState, namesWanted } from '../src/steps/handoff.js';
import { CONCEALED_NAMES_AFTER, CONCEALED_NAMES_STEPS } from '../src/steps/next-steps.js';
import { AGENT_ROLE, globalReaderCommand, readerCommand, resourceGraphScope } from '../src/steps/resource-graph.js';
import { lastDataCheck } from '../src/steps/run.js';
import { DATA_CHECK_FILE } from '../src/transform/notebook.js';
import { fakeCtx, fakeFabric, fakeUi } from './fakes.js';

/** @typedef {import('../src/config.js').InstallConfig} InstallConfig */
/** @typedef {import('../src/steps/handoff.js').AdminRequest} AdminRequest */

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
  const azure = planted(
    azureConfig({
      webApp: { clientId: 'web-1', clientSecret: 'PLANTED-web-secret', secretKeyId: 'PLANTED-web-key' },
      sqlReader: { clientId: 'sql-1', secretKeyId: 'PLANTED-sql-key' },
      graphRoles: { assigned: [], pending: ['AuditLogsQuery.Read.All'] },
      adminScript: 'C:\\Users\\someone\\analytics-hub\\admin.sh',
      status: {
        pendingAdminActions: [
          `Grant delegated consent on ${apiPermissionsUrl('web-1')}`,
          `${TEAMS_APP_PENDING}: upload C:\\Users\\someone\\analytics-hub\\AnalyticsHub-Teams.zip in Teams admin center > Teams apps > Manage apps (${MANAGE_APPS_URL}).`,
        ],
      },
    }),
  );
  for (const config of [fabric, azure]) {
    const requests = doneRequests(config, { from: UPN, consented: false });
    assert.ok(requests.length >= 4, config.target);
    const text = JSON.stringify(requests);
    assert.doesNotMatch(text, /PLANTED/);
    assert.doesNotMatch(text, /\b(client secrets?|password|passcode|sign-in code|device code|bearer|access token|refresh token)\b/i);
    assert.doesNotMatch(text, /Users\\\\someone|C:\\\\/, 'files go by their names, not their paths');
  }
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
