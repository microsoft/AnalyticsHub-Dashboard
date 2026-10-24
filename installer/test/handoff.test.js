// @ts-check
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { graphRolesCommand } from '../src/admin-commands.js';
import { apiPermissionsUrl } from '../src/clients/graph.js';
import { emptyConfig } from '../src/config.js';
import { HttpError } from '../src/http.js';
import { checkPrereqs, dataPolicyPrereq, reportFlowPrereqs, reportPreflight, settingsToConfirm } from '../src/prereqs.js';
import { LEAST_PRIVILEGE_URL } from '../src/steps/azure/least-privilege.js';
import { MANAGE_APPS_URL, TEAMS_APP_PENDING } from '../src/steps/azure/teams-catalog.js';
import { flowsWanted } from '../src/steps/flows.js';
import { ADMINS, adminRequests, ROW_ASKS } from '../src/steps/handoff.js';
import { AZURE_ADMIN_SCRIPT_FILE } from '../src/steps/identity.js';
import { letter } from '../src/steps/next-steps.js';
import { fakeUi } from './fakes.js';

const USER = /** @type {any} */ ({ id: 'user-1', upn: 'analyst@contoso.com', tenantId: 't-1' });
const UPN = USER.upn;

const PRO = 'Assign me a Power BI Pro licence (Premium Per User works too), to publish the Analytics Hub reports.';
const PREMIUM = 'Assign me Power Automate Premium: I\'ll own the Analytics Hub flows, which use premium connectors.';
const CAPACITY =
  'Make me a contributor on a Fabric capacity for Analytics Hub\'s workspace, or an Admin or Member of a workspace that\'s already on one. ' +
  'The capacity needs to be F2 or larger; F64 or larger is best for more than 10,000 people.';
const PURVIEW = 'Check that audit logging is on in Microsoft Purview > Audit, and turn it on if it isn\'t: https://purview.microsoft.com/audit/auditsearch';
const ENV_SALES = 'Give me the System Administrator security role in Sales, for Analytics Hub\'s Power Automate flows.';
const CONNECTION =
  'Once the install has created the flows, sign in to their Power Platform API connection. Whoever signs in needs to be a Power Platform or Global administrator, ' +
  'with the role assigned permanently rather than activated in Privileged Identity Management, because the connection signs in each time the flows run. I\'ll send you the steps.';
const FABRIC_CONSENT_LATER =
  'Once Analytics Hub\'s app registration exists, grant admin consent for its Microsoft Graph application permissions, including AuditLogsQuery.Read.All. I\'ll send you the link.';
const WEB_CONSENT = 'the Analytics Hub web app\'s delegated permissions (Power BI and Microsoft Graph)';
const APPROVE = (/** @type {string} */ clientId) => `Approve ${WEB_CONSENT}: open ${apiPermissionsUrl(clientId)} and select "Grant admin consent".`;
const GRAPH_AFTER_DEPLOY =
  'After the deploy, give the Analytics Hub jobs\' managed identity its Microsoft Graph application permissions, including AuditLogsQuery.Read.All. I\'ll send you the list.';
const DROP_SITE = 'Grant-PnPAzureADAppSitePermission -AppId jobs-1 -DisplayName "vlens jobs" -Site https://contoso.sharepoint.com/sites/drop -Permissions Read';
const OWNER_ACTION =
  'An Application Administrator or Cloud Application Administrator adds analyst@contoso.com as an owner of "Analytics Hub (Azure)" (client ID web-1): ' +
  'Microsoft Entra admin center > Entra ID > App registrations > All applications > "Analytics Hub (Azure)" > Owners > Add owners';
const TEAMS_UPLOAD = `${TEAMS_APP_PENDING}: upload C:\\Users\\someone\\analytics-hub\\teams\\analytics-hub.zip in Teams admin center > Teams apps > Manage apps (${MANAGE_APPS_URL}).`;
const LEAST_PRIVILEGE = 'https://github.com/microsoft/AnalyticsHub-Dashboard/blob/main/docs/AZURE-LEAST-PRIVILEGE.md';
/** What Resource Graph asks for, after "give it". */
const RG_AGENTS = 'the Global Reader role in Microsoft Entra, so Analytics Hub can read Copilot Studio agents from Azure Resource Graph. Global Reader is read-only.';
const RG_FOUNDRY = 'the Reader role in Azure on the tenant root management group, so Analytics Hub can read Foundry resources from Azure Resource Graph.';

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

/** plainConfig with only the Copilot Studio credits flow, made in an environment called Sales. */
const studioConfig = () => {
  const config = plainConfig();
  config.dataSources.studioCredits = 'api';
  config.uploads = { flowEnvironment: { url: 'https://org1.crm.dynamics.com', id: 'env-1', name: 'Sales' } };
  assert.deepEqual(flowsWanted(config), ['studio']);
  return config;
};

/** An Azure install's config, with what it has recorded so far. @param {any} [azure] */
const azureConfig = (azure = {}) => {
  const config = emptyConfig();
  config.target = 'azure';
  config.azure = /** @type {any} */ ({ subscriptionId: 'sub-1', ...azure });
  return config;
};

/** Read-only APIs for someone with no admin roles, licences, capacities or environments, in a tenant where users can't register apps. */
const noRoles = () =>
  /** @type {any} */ ({
    graph: {
      myDirectoryRoles: async () => [],
      myEligibleRoles: async () => [],
      myGroupIds: async () => ['group-1'],
      myDirectGroupIds: async () => ['group-1'],
      myLicenseDetails: async () => [],
      subscribedSkus: async () => [],
      usersCanRegisterApps: async () => false,
    },
    arm: {
      listSubscriptions: async () => [{ subscriptionId: 'sub-1', displayName: 'Production', state: 'Enabled' }],
      permissions: async () => [{ actions: ['*/read'], notActions: [] }],
      myRoleAssignments: async () => [],
      myEligibleRoles: async () => [],
      getVault: async () => ({ name: 'kv' }),
      resourceGraph: async () => ({ data: [] }),
    },
    fabric: {
      listCapacities: async () => [],
      listWorkspaces: async () => [],
      getWorkspace: async () => {
        throw new HttpError('404 Not Found', { method: 'GET', url: 'https://api.fabric.microsoft.com/v1/workspaces/x', status: 404 });
      },
      tenantSettings: async () => {
        throw new HttpError('401 Unauthorized', { method: 'GET', url: 'https://api.fabric.microsoft.com/v1/admin/tenantsettings', status: 401 });
      },
    },
    discovery: { instances: async () => [] },
  });

/** Each request as [admin, its asks]. @param {import('../src/steps/handoff.js').AdminRequest[]} requests */
const asks = (requests) => requests.map((r) => [r.admin, r.asks]);
/** @param {string} s */
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
/** Who each printed request is for. @param {string} text */
const whoLines = (text) => [...text.slice(text.indexOf('Requests for your admins')).matchAll(/^ {2}\d+\. (.+)$/gm)].map((m) => m[1]);

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

test('letter: hi, the body, thanks, and who it\'s from when that\'s known', () => {
  assert.equal(letter(['First line', '', '- An ask'], UPN), 'Hi,\n\nFirst line\n\n- An ask\n\nThanks\nanalyst@contoso.com');
  assert.equal(letter(['First line'], undefined), 'Hi,\n\nFirst line\n\nThanks');
});

test('adminRequests: one request per admin, not one per row, each asking for everything that admin does, once', () => {
  const config = studioConfig();
  const rows = [
    row({ id: 'power-automate-premium', label: 'Power Automate Premium licence', optional: true }),
    row({ id: 'fabric-capacity', label: 'A Fabric capacity' }),
    row({ id: 'power-bi-pro', label: 'Power BI Pro licence' }),
    row({ id: 'copilot-licences', label: 'Microsoft 365 Copilot licences', optional: true }),
    row({ id: 'consent-role', label: 'Global Administrator or Privileged Role Administrator', status: 'met' }),
  ];
  const requests = adminRequests(rows, config, { from: UPN });
  assert.deepEqual(
    requests.map((r) => [r.admin, r.who, r.rows]),
    [
      ['capacity-admin', 'A Fabric capacity admin', ['A Fabric capacity']],
      ['licence', 'Your licence admin', ['Power Automate Premium licence', 'Power BI Pro licence']],
    ],
  );
  assert.deepEqual(requests[1].asks, [PREMIUM, PRO]);
  assert.equal(
    requests[1].message,
    `Hi,\n\nI'm installing Analytics Hub, and I need your help with these:\n\n- ${PREMIUM}\n- ${PRO}\n\nThanks\n${UPN}`,
    'the next-steps letter, signed by whoever is installing',
  );
  assert.equal(requests[0].message, `Hi,\n\nI'm installing Analytics Hub, and I need your help with this:\n\n- ${CAPACITY}\n\nThanks\n${UPN}`);
  assert.doesNotMatch(adminRequests(rows, config)[0].message, /analyst/, 'unsigned without a sign-in');
  assert.deepEqual(adminRequests([], config), []);
  // Without the flows, preflight leaves the optional Premium row out, so nobody's asked for it.
  assert.deepEqual(asks(adminRequests(rows, plainConfig())), [['capacity-admin', [CAPACITY]], ['licence', [PRO]]]);
});

test('ROW_ASKS: every prerequisite row has an entry, so a new row can\'t go without an admin', () => {
  const source = readFileSync(new URL('../src/prereqs.js', import.meta.url), 'utf8');
  const ids = [...new Set([...source.matchAll(/\bid: '([a-z-]+)'/g)].map((m) => m[1]))].sort();
  assert.ok(ids.length >= 18, ids.join());
  assert.deepEqual(Object.keys(ROW_ASKS).sort(), ids);
});

test('adminRequests: for someone with no admin roles on Fabric, the prerequisites list gives one request to each admin it needs', async () => {
  const config = studioConfig();
  const items = await checkPrereqs({ api: noRoles(), user: USER, config });
  const requests = adminRequests(items, config, { from: UPN });
  assert.deepEqual(requests.map((r) => r.admin), ['app-admin', 'role-admin', 'fabric-admin', 'capacity-admin', 'compliance', 'power-platform', 'licence']);
  const by = Object.fromEntries(requests.map((r) => [r.admin, r]));
  assert.deepEqual(by['app-admin'].asks, [
    'Register the app Analytics Hub uses to collect data, in Microsoft Entra. I\'ll send you the installer\'s admin pack, which says how, and what to send back.',
  ]);
  // The consent and the audit rows both need the app's admin consent: one ask, for both rows.
  assert.deepEqual(by['role-admin'].asks, [FABRIC_CONSENT_LATER]);
  assert.deepEqual(by['role-admin'].rows, ['Global Administrator or Privileged Role Administrator', 'Audit log access for Copilot interactions (AuditLogsQuery.Read.All)']);
  assert.deepEqual(by.compliance.asks, [PURVIEW]);
  assert.equal(by['fabric-admin'].asks.length, 1);
  assert.match(by['fabric-admin'].asks[0], /^Confirm these Fabric tenant settings are on for me, or for a group I'm in, and turn on any that are off: "Create workspaces" \(only to create a new workspace/);
  assert.ok(by['fabric-admin'].asks[0].includes(settingsToConfirm(config).join('; ')));
  assert.deepEqual(by['capacity-admin'].asks, [CAPACITY]);
  assert.deepEqual(by['power-platform'].asks.slice(0, 2), [ENV_SALES, CONNECTION]);
  assert.match(by['power-platform'].asks[2], /^Confirm that HTTP with Microsoft Entra ID \(preauthorized\) is allowed in Sales\b/);
  assert.deepEqual(by.licence.asks, [PRO, PREMIUM]);
  for (const r of requests) {
    assert.equal(r.who, ADMINS[r.admin]);
    assert.match(r.message, /\nThanks\nanalyst@contoso\.com$/);
  }
});

test('adminRequests: no request has a secret, a key, a token, a password, a sign-in code or a path on your computer', () => {
  const planted = (/** @type {import('../src/config.js').InstallConfig} */ config) => {
    const c = /** @type {any} */ (config);
    Object.assign(c.app, {
      appId: 'app-1',
      secretKeyId: 'PLANTED-key-id',
      pendingSecretKeyIds: ['PLANTED-pending-key'],
      clientSecret: 'PLANTED-client-secret',
      adminPack: 'C:\\Users\\someone\\analytics-hub\\analytics-hub-admin-pack.md',
    });
    Object.assign(c.keyVault, { secretName: 'PLANTED-secret-name', secretKeyId: 'PLANTED-vault-key', id: '/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.KeyVault/vaults/kv-ah' });
    c.semanticModel.secretKeyId = 'PLANTED-model-key';
    c.setup = { completed: [], uploads: [{ name: 'x', token: 'PLANTED-upload-token' }] };
    c.auditCheck = { at: '2026-01-01T00:00:00Z', result: 'no-role' };
    // So the Foundry ask has its Reader command.
    c.tenantId = 't-1';
    return config;
  };
  const fabric = planted(studioConfig());
  Object.assign(fabric.modules, { consumption: true });
  Object.assign(fabric.dataSources, { coworkCredits: 'api' });
  const azure = planted(
    azureConfig({
      resourceGroup: 'rg-ah',
      resourceGroupMode: 'existing',
      outputs: { identityPrincipalId: 'mi-1' },
      webApp: { clientId: 'web-1', clientSecret: 'PLANTED-web-secret', secretKeyId: 'PLANTED-web-key' },
      sqlReader: { clientId: 'sql-1', secretKeyId: 'PLANTED-sql-key' },
      jobsApp: { clientId: 'jobs-1' },
      graphRoles: { assigned: [], pending: ['AuditLog.Read.All', 'AuditLogsQuery.Read.All'] },
      adminScript: `C:\\Users\\someone\\analytics-hub\\${AZURE_ADMIN_SCRIPT_FILE}`,
      status: { pendingAdminActions: [`Grant delegated consent on ${apiPermissionsUrl('web-1')}`, TEAMS_UPLOAD, OWNER_ACTION, DROP_SITE] },
    }),
  );
  for (const config of [fabric, azure]) {
    const settings = `Couldn't check: only a Fabric administrator can read tenant settings. Ask one to confirm these are on for you, or for a group you're in: ${settingsToConfirm(config).join('; ')}. The capacity's XMLA endpoint must also be Read Write, which a capacity admin sets.`;
    const rows = [
      ...Object.keys(ROW_ASKS).map((id) => row({ id })),
      ...Object.keys(ROW_ASKS).map((id) => row({ id, status: 'handoff' })),
      row({ id: 'tenant-settings', status: 'unknown', detail: settings }),
      dataPolicyPrereq(config),
    ];
    const requests = adminRequests(rows, config, { from: UPN });
    assert.deepEqual(requests.map((r) => r.admin), Object.keys(ADMINS).filter((k) => k !== 'other' && (config.target === 'azure' || k !== 'sharepoint-admin')), config.target);
    const text = JSON.stringify(requests);
    assert.match(text, /az role assignment create --assignee-object-id (\w[\w-]*|\$\(az ad sp show --id \S+ --query id -o tsv\)) --assignee-principal-type ServicePrincipal --role \\"Reader\\"/, 'with the commands');
    if (config.target === 'azure') assert.match(text, /servicePrincipals\/\$MI\/appRoleAssignments/);
    assert.doesNotMatch(text, /PLANTED/);
    assert.doesNotMatch(text, /\b(client secrets?|password|passcode|sign-in code|device code|bearer|access token|refresh token)\b/i);
    assert.doesNotMatch(text, /someone|C:\\\\/, 'files go by their names, not their paths');
  }
});

test('adminRequests: a Graph role the Azure install lists twice as pending is asked for once, and one it has since assigned not at all', () => {
  const config = azureConfig({
    outputs: { identityPrincipalId: 'mi-1', identityClientId: 'mi-client-1' },
    graphRoles: { pending: ['AuditLog.Read.All', 'Reports.Read.All', 'AuditLog.Read.All', 'User.Read.All'], assigned: ['User.Read.All'] },
  });
  const roles =
    'Give the Analytics Hub jobs\' managed identity (object ID mi-1) these Microsoft Graph application permissions: AuditLog.Read.All, Reports.Read.All. In Azure Cloud Shell (Bash):\n' +
    `  ${graphRolesCommand('mi-1', ['AuditLog.Read.All', 'Reports.Read.All'])}`;
  const met = adminRequests([row({ id: 'audit-ingestion', status: 'met' })], config, { from: UPN });
  assert.deepEqual(
    met.map((r) => [r.admin, r.rows, r.asks]),
    [['role-admin', ['Pending admin action'], [roles]]],
  );
  // While the audit row is a hand-off, it asks for the same roles: still once, for that row.
  const handoff = adminRequests([row({ id: 'audit-ingestion', status: 'handoff', label: 'Audit log access' })], config, { from: UPN });
  assert.deepEqual(
    handoff.map((r) => [r.admin, r.rows, r.asks]),
    [
      ['role-admin', ['Audit log access'], [roles]],
      ['compliance', ['Audit logging in Microsoft Purview'], [PURVIEW]],
    ],
  );
  // Once in the list and once in the command, which gives the identity, by its object ID, each role once.
  const [list, command] = handoff[0].asks[0].split('\n');
  assert.equal(list.split('AuditLog.Read.All').length - 1, 1);
  assert.match(command, /^ {2}MI=mi-1; GRAPH=\$\(az ad sp show --id 00000003-0000-0000-c000-000000000000 --query id -o tsv\); for P in AuditLog\.Read\.All Reports\.Read\.All; do /);
  assert.equal(handoff[0].message.split('AuditLog.Read.All').length - 1, 2);
  assert.doesNotMatch(handoff[0].message, /mi-client-1/, 'not the client ID');
  assert.deepEqual(asks(adminRequests([row({ id: 'audit-ingestion', status: 'met' })], azureConfig({ graphRoles: { pending: ['X'], assigned: ['X'] } }))), []);
});

test('adminRequests: the Azure install\'s pending admin actions go to the admin who does each, the drop site\'s grant word for word; one it doesn\'t know goes to "An admin" as it is', () => {
  const actions = [`Grant delegated consent on ${apiPermissionsUrl('web-1')}`, TEAMS_UPLOAD, OWNER_ACTION, DROP_SITE, 'Something new: do it.'];
  const config = azureConfig({ webApp: { clientId: 'web-1' }, status: { pendingAdminActions: actions } });
  const rows = [row({ id: 'consent-role', status: 'handoff', label: 'Consent', optional: true }), row({ id: 'teams-admin', status: 'handoff', label: 'Teams', optional: true })];
  const requests = adminRequests(rows, config, { from: UPN });
  assert.deepEqual(
    requests.map((r) => [r.admin, r.who, r.rows, r.asks]),
    [
      [
        'app-admin',
        ADMINS['app-admin'],
        ['Consent', 'Pending admin action'],
        [
          APPROVE('web-1'),
          'Add analyst@contoso.com as an owner of "Analytics Hub (Azure)" (client ID web-1): Microsoft Entra admin center > Entra ID > App registrations > All applications > "Analytics Hub (Azure)" > Owners > Add owners.',
        ],
      ],
      ['teams', 'A Teams Administrator', ['Teams'], [`Upload the Analytics Hub Teams package I'll send you (analytics-hub.zip) in Teams admin center > Teams apps > Manage apps (${MANAGE_APPS_URL}).`]],
      ['sharepoint-admin', 'A SharePoint Administrator', ['Pending admin action'], [DROP_SITE]],
      ['other', 'An admin', ['Pending admin action'], ['Something new: do it.']],
    ],
  );
  assert.doesNotMatch(JSON.stringify(requests), /recorded/i, 'the consent link is asked for, not said to be done');

  const approve = azureConfig({ status: { pendingAdminActions: [`${TEAMS_APP_PENDING}: approve Analytics Hub in Teams admin center > Teams apps > Manage apps (${MANAGE_APPS_URL}), then run the installer again.`] } });
  assert.deepEqual(asks(adminRequests([], approve)), [['teams', [`Approve Analytics Hub in Teams admin center > Teams apps > Manage apps (${MANAGE_APPS_URL}).`]]]);

  // Once the consent and the Teams app are done, their actions ask for nothing.
  const done = [row({ id: 'consent-role', status: 'met' }), row({ id: 'teams-admin', status: 'met' })];
  assert.deepEqual(adminRequests(done, config).map((r) => r.admin), ['app-admin', 'sharepoint-admin', 'other']);
  assert.deepEqual(adminRequests(done, config, { pending: false }), []);
  // A Fabric install ignores what an Azure one left.
  const fabric = plainConfig();
  fabric.azure = /** @type {any} */ ({ status: { pendingAdminActions: actions }, graphRoles: { pending: ['AuditLog.Read.All'] } });
  assert.deepEqual(adminRequests([], fabric), []);
});

test('adminRequests: the Azure web app\'s consent goes with whichever request already approves it, or else to an admin who can', () => {
  const consent = row({ id: 'consent-role', status: 'handoff', label: 'Consent', optional: true });
  const audit = row({ id: 'audit-ingestion', status: 'handoff', label: 'Audit' });
  const register = row({ id: 'register-apps', label: 'Register apps' });
  const shape = (/** @type {import('../src/steps/handoff.js').AdminRequest[]} */ requests) => requests.map((r) => [r.admin, r.rows, r.asks]);

  assert.deepEqual(shape(adminRequests([consent], azureConfig({ webApp: { clientId: 'web-1' } }))), [['app-admin', ['Consent'], [APPROVE('web-1')]]]);
  // A Privileged Role Administrator can approve it too, so one request does both.
  assert.deepEqual(shape(adminRequests([consent, audit], azureConfig({ webApp: { clientId: 'web-1' } }))), [
    ['role-admin', ['Consent', 'Audit'], [APPROVE('web-1'), GRAPH_AFTER_DEPLOY]],
    ['compliance', ['Audit logging in Microsoft Purview'], [PURVIEW]],
  ]);
  // Creating the web app approves it too.
  assert.deepEqual(shape(adminRequests([consent, register], azureConfig({ sqlReader: { clientId: 'sql-1' } }))), [
    [
      'app-admin',
      ['Consent', 'Register apps'],
      [`Create Analytics Hub's app registration "Analytics Hub (Azure)", and approve ${WEB_CONSENT}. I'll send you a script from the installer that does it.`],
    ],
  ]);
  assert.deepEqual(shape(adminRequests([consent, register], azureConfig({ webApp: { clientId: 'web-1' } }))), [
    ['app-admin', ['Consent', 'Register apps'], [APPROVE('web-1'), 'Create Analytics Hub\'s app registration "Analytics Hub SQL Reader". I\'ll send you a script from the installer that does it.']],
  ]);
  // The app the row says still needs creating, after an admin made the other.
  const named = row({ id: 'register-apps', detail: 'An admin created "Analytics Hub (Azure)" (web-9) for you, and the plan uses it. "Analytics Hub SQL Reader" still needs creating: the plan offers to have an admin create it.' });
  assert.deepEqual(asks(adminRequests([named], azureConfig())), [
    ['app-admin', ['Create Analytics Hub\'s app registration "Analytics Hub SQL Reader". I\'ll send you a script from the installer that does it.']],
  ]);
  assert.deepEqual(asks(adminRequests([register], azureConfig())), [
    ['app-admin', [`Create Analytics Hub's two app registrations, "Analytics Hub (Azure)" and "Analytics Hub SQL Reader", and approve ${WEB_CONSENT}. I'll send you a script from the installer that does it.`]],
  ]);
  // The admin script does both, and goes by its file name.
  const scripted = adminRequests([consent, register], azureConfig({ adminScript: `C:\\Users\\someone\\analytics-hub\\${AZURE_ADMIN_SCRIPT_FILE}` }), { from: UPN });
  assert.deepEqual(shape(scripted), [
    [
      'app-admin',
      ['Consent', 'Register apps'],
      [
        `Run the script in ${AZURE_ADMIN_SCRIPT_FILE}, which I'll send you, in Azure Cloud Shell (Bash). It creates Analytics Hub's app registrations and approves ${WEB_CONSENT}. It makes no secrets.`,
      ],
    ],
  ]);
  assert.doesNotMatch(scripted[0].message, /someone|C:\\/);
  // Before the deploy there's no link yet.
  assert.deepEqual(asks(adminRequests([consent], azureConfig())), [['app-admin', [`After the deploy, approve ${WEB_CONSENT}. I'll send you the link.`]]]);
});

test('adminRequests: on Fabric, the app\'s admin consent and Purview audit logging, as the audit row needs them', () => {
  const config = plainConfig();
  const consent = row({ id: 'consent-role', status: 'handoff', optional: true });
  const audit = row({ id: 'audit-ingestion', status: 'handoff' });
  assert.deepEqual(asks(adminRequests([consent, audit], config)), [['role-admin', [FABRIC_CONSENT_LATER]], ['compliance', [PURVIEW]]]);
  // You can activate the consent role yourself, so only Purview is left to ask for.
  assert.deepEqual(asks(adminRequests([{ ...consent, status: 'eligible' }, audit], config)), [['compliance', [PURVIEW]]]);

  config.app.appId = 'app-1';
  const granted = `Grant admin consent for the Microsoft Graph application permissions of Analytics Hub's app registration (client ID app-1), including AuditLogsQuery.Read.All: open ${apiPermissionsUrl('app-1')} and select "Grant admin consent".`;
  assert.deepEqual(asks(adminRequests([consent], config)), [['role-admin', [granted]]]);
  // Consent is in place but the last audit check failed: as that check advises.
  const failed = row({ id: 'audit-ingestion' });
  const after = (/** @type {any} */ result) => {
    config.auditCheck = { at: '2026-01-01T00:00:00Z', result };
    return asks(adminRequests([failed], config));
  };
  assert.deepEqual(after('empty-log'), [['compliance', [PURVIEW]]]);
  assert.deepEqual(after('no-role'), [['role-admin', [granted]]]);
  assert.deepEqual(after('refused'), [['role-admin', [granted]]]);
  delete config.auditCheck;
  assert.deepEqual(asks(adminRequests([failed], config)), []);
});

test('adminRequests: the flows ask the Power Platform administrator for the environment role and the connection sign-in, as each row needs', () => {
  const config = studioConfig();
  const pp = (/** @type {any} */ status, /** @type {any} */ envs) =>
    asks(adminRequests([row({ id: 'power-platform-admin', status, optional: true }), row({ id: 'environments', status: envs, optional: true })], config));
  assert.deepEqual(pp('missing', 'missing'), [['power-platform', [ENV_SALES, CONNECTION]]]);
  // A role activated in Privileged Identity Management keeps the connection signed in for a day at most.
  assert.deepEqual(pp('eligible', 'met'), [['power-platform', [CONNECTION]]]);
  assert.deepEqual(pp('handoff', 'met'), [['power-platform', [CONNECTION]]]);
  // A Power Platform Administrator gives themselves the environment role.
  assert.deepEqual(pp('met', 'missing'), []);

  const evaluator = plainConfig();
  evaluator.modules.agentEvaluator = true;
  assert.deepEqual(asks(adminRequests([row({ id: 'power-platform-admin', optional: true }), row({ id: 'environments', optional: true })], evaluator)), [
    ['power-platform', ['Give me the System Administrator security role in the Power Platform environment I\'ll use, for Analytics Hub\'s Agent Evaluator.']],
  ]);
});

test('adminRequests: the data policy asks a Power Platform administrator to confirm what the row names', () => {
  const config = studioConfig();
  const [request] = adminRequests([dataPolicyPrereq(config)], config);
  assert.equal(request.admin, 'power-platform');
  assert.deepEqual(request.rows, ['Data policy']);
  assert.match(request.asks[0], /^Confirm that HTTP with Microsoft Entra ID \(preauthorized\) is allowed in Sales\b/);
  const general = row({ id: 'data-policy', status: 'unknown', howTo: 'Ask a Power Platform administrator to confirm that the flows\' connectors are allowed, and in the same data group, in the environment the flows go in.' });
  assert.deepEqual(asks(adminRequests([general], config)), [
    ['power-platform', ['Confirm that the flows\' connectors are allowed, and in the same data group, in the environment the flows go in.']],
  ]);
});

test('adminRequests: tenant settings only you couldn\'t read go to a Fabric administrator, and the XMLA endpoint to a capacity admin', () => {
  const config = studioConfig();
  const unread = `Couldn't check: only a Fabric administrator can read tenant settings. Ask one to confirm these are on for you, or for a group you're in: ${settingsToConfirm(config).join('; ')}.`;
  const settings = (/** @type {any} */ status, /** @type {string} */ detail) => adminRequests([row({ id: 'tenant-settings', status, detail })], config);
  const ask = `Confirm these Fabric tenant settings are on for me, or for a group I'm in, and turn on any that are off: ${settingsToConfirm(config).join('; ')}. They're in Fabric under Admin portal > Tenant settings: https://learn.microsoft.com/fabric/admin/tenant-settings-index`;
  assert.deepEqual(asks(settings('unknown', unread)), [['fabric-admin', [ask]]]);
  assert.ok(ask.includes('"Create workspaces"'));
  assert.deepEqual(asks(settings('unknown', `${unread} The capacity's XMLA endpoint must also be Read Write, which a capacity admin sets.`)), [
    ['fabric-admin', [ask]],
    ['capacity-admin', ['Set the XMLA endpoint to Read Write on the Fabric capacity Analytics Hub\'s workspace uses.']],
  ]);
  const none = `Couldn't check: Fabric returned no tenant settings. Ask a Fabric administrator to confirm these are on for you, or for a group you're in: ${settingsToConfirm(config).join('; ')}.`;
  assert.deepEqual(asks(settings('unknown', none)), [['fabric-admin', [ask]]]);
  // Readable settings mean you're a Fabric administrator, who turns them on.
  assert.deepEqual(settings('missing', 'Off: "Service principals can use Fabric APIs".'), []);
  assert.deepEqual(settings('unknown', 'The other settings Analytics Hub needs are on. Couldn\'t confirm "Create workspaces": it\'s on for some groups.'), []);
  // With a workspace chosen, "Create workspaces" isn't needed.
  config.fabric.workspaceId = 'ws-1';
  assert.doesNotMatch(settings('unknown', unread)[0].asks[0], /Create workspaces/);
});

test('adminRequests: Azure access and the Key Vault ask for the least that works, with the least-privilege steps', () => {
  assert.equal(LEAST_PRIVILEGE_URL, LEAST_PRIVILEGE);
  assert.ok(existsSync(new URL('../../docs/AZURE-LEAST-PRIVILEGE.md', import.meta.url)), 'the link is to a page in this repo');
  const steps = `The steps and the condition are in ${LEAST_PRIVILEGE}`;
  const rbac = row({ id: 'azure-rbac', optional: true });
  assert.deepEqual(asks(adminRequests([rbac], azureConfig({ resourceGroup: 'rg-ah', resourceGroupMode: 'existing' }))), [
    ['azure-owner', [`Give me Contributor and a condition-limited Role Based Access Control Administrator (or Owner) on the resource group "rg-ah" in the subscription sub-1. ${steps}`]],
  ]);
  assert.deepEqual(asks(adminRequests([rbac], azureConfig())), [
    [
      'azure-owner',
      [
        'Give me Owner, or Contributor and User Access Administrator, on the subscription sub-1. Or, for least privilege, create the resource group and give me Contributor and a ' +
          `condition-limited Role Based Access Control Administrator on just that group. ${steps}`,
      ],
    ],
  ]);
  const consumption = plainConfig();
  consumption.modules.consumption = true;
  assert.deepEqual(asks(adminRequests([rbac], consumption)), [['azure-owner', ['Give me Owner, or Contributor and User Access Administrator, on a subscription I can use.']]]);
  consumption.keyVault.subscriptionId = 'sub-2';
  assert.deepEqual(asks(adminRequests([rbac], consumption)), [['azure-owner', ['Give me Owner, or Contributor and User Access Administrator, on the subscription sub-2.']]]);

  const vault = row({ id: 'key-vault' });
  const kv = (/** @type {any} */ keyVault) => {
    const config = plainConfig();
    Object.assign(config.keyVault, keyVault);
    return asks(adminRequests([vault], config));
  };
  assert.deepEqual(kv({}), [], 'no vault chosen yet');
  assert.deepEqual(kv({ mode: 'local', id: '/subscriptions/s/resourceGroups/r/providers/Microsoft.KeyVault/vaults/kv-ah' }), [], 'not using a vault');
  assert.deepEqual(kv({ id: '/subscriptions/s/resourceGroups/r/providers/Microsoft.KeyVault/vaults/kv-ah' }), [
    ['azure-owner', ['Give me Key Vault Secrets Officer on the Key Vault "kv-ah", which Analytics Hub uses.']],
  ]);
  assert.deepEqual(kv({ name: 'kv-named', id: '/subscriptions/s/resourceGroups/r/providers/Microsoft.KeyVault/vaults/kv-ah' }), [
    ['azure-owner', ['Give me Key Vault Secrets Officer on the Key Vault "kv-named", which Analytics Hub uses.']],
  ]);
  assert.deepEqual(kv({ subscriptionId: 'sub-2' }), [
    ['azure-owner', ['Give me Contributor on an Azure subscription, so I can create a Key Vault for Analytics Hub, or Key Vault Secrets Officer on an existing vault.']],
  ]);
});

test('adminRequests: the capacity ask says F2 is the minimum, and steers a large tenant to F64', () => {
  const capacity = (/** @type {import('../src/transform/pipeline.js').TenantScale | undefined} */ scale) => {
    const config = plainConfig();
    if (scale) config.scale = scale;
    return asks(adminRequests([row({ id: 'fabric-capacity' })], config));
  };
  const ask = 'Make me a contributor on a Fabric capacity for Analytics Hub\'s workspace, or an Admin or Member of a workspace that\'s already on one.';
  assert.deepEqual(capacity(undefined), [['capacity-admin', [CAPACITY]]], 'the size isn\'t known yet, so both');
  assert.ok(CAPACITY.startsWith(ask));
  assert.deepEqual(capacity('standard'), [['capacity-admin', [`${ask} The capacity needs to be F2 or larger.`]]]);
  assert.deepEqual(capacity('large'), [['capacity-admin', [`${ask} With more than 10,000 people in the tenant, F64 or larger is best; F2 is the minimum.`]]]);
});

test('adminRequests: on Fabric, Resource Graph asks for roles for the app the load runs as, not for you', () => {
  const later = (/** @type {string} */ what) => `Once the installer has created Analytics Hub's app "Analytics Hub Data Collector", give it ${what} I'll send you its IDs.`;
  const graph = (/** @type {any} */ rows, config = plainConfig()) => asks(adminRequests([row({ id: 'resource-graph', rows })], config));
  // Only for what your own check was refused.
  assert.deepEqual(graph([{ name: 'Copilot Studio agents', status: 'missing' }, { name: 'Foundry resources', status: 'met' }]), [['role-admin', [later(RG_AGENTS)]]]);
  assert.deepEqual(graph([{ name: 'Copilot Studio agents', status: 'unknown' }, { name: 'Foundry resources', status: 'missing' }]), [['azure-owner', [later(RG_FOUNDRY)]]]);
  assert.deepEqual(graph(undefined), [['role-admin', [later(RG_AGENTS)]], ['azure-owner', [later(RG_FOUNDRY)]]]);
  const off = plainConfig();
  off.resourceGraph.foundry = false;
  assert.deepEqual(graph(undefined, off), [['role-admin', [later(RG_AGENTS)]]], 'only what the load reads');

  // Once the app exists, by its name and whichever IDs are known.
  const config = plainConfig();
  Object.assign(config.app, { displayName: 'AH Collector', appId: 'app-1', servicePrincipalId: 'sp-1' });
  const app = 'Give the app "AH Collector" (application ID app-1, enterprise application object ID sp-1)';
  assert.deepEqual(graph(undefined, config), [['role-admin', [`${app} ${RG_AGENTS}`]], ['azure-owner', [`${app} ${RG_FOUNDRY}`]]]);
  delete config.app.displayName;
  delete config.app.servicePrincipalId;
  assert.deepEqual(graph(undefined, config)[0], ['role-admin', [`Give the app "Analytics Hub Data Collector" (application ID app-1) ${RG_AGENTS}`]]);
  delete config.app.appId;
  config.app.servicePrincipalId = 'sp-1';
  assert.deepEqual(graph(undefined, config)[0], ['role-admin', [`Give the app "Analytics Hub Data Collector" (enterprise application object ID sp-1) ${RG_AGENTS}`]]);

  // Reader goes on the management group the load reads, or the tenant root group, with its ID when that's known.
  const scoped = plainConfig();
  scoped.tenantId = 't-1';
  const reader = (/** @type {string} */ where) => later(`the Reader role in Azure on ${where}, so Analytics Hub can read Foundry resources from Azure Resource Graph.`);
  assert.deepEqual(graph(undefined, scoped)[1], ['azure-owner', [reader('the tenant root management group (/providers/Microsoft.Management/managementGroups/t-1)')]]);
  scoped.resourceGraph.managementGroup = 'mg-ah';
  assert.deepEqual(graph(undefined, scoped)[1], ['azure-owner', [reader('management group mg-ah (/providers/Microsoft.Management/managementGroups/mg-ah)')]]);

  // When you can't register apps, an admin registers it from the admin pack.
  const rg = row({ id: 'resource-graph' });
  const unregistered = adminRequests([rg], plainConfig(), { all: [rg, row({ id: 'register-apps' })] });
  assert.deepEqual(unregistered[0].asks, [`Once Analytics Hub's app "Analytics Hub Data Collector" is registered, give it ${RG_AGENTS} I'll send you its IDs.`]);
});

test('adminRequests: Resource Graph asks for nothing the install record says the app has, or that you can give it', () => {
  const rg = row({ id: 'resource-graph' });
  const admins = (/** @type {any} */ record, /** @type {import('../src/prereqs.js').Prereq[]} */ others = []) => {
    const config = plainConfig();
    Object.assign(config.resourceGraph, record);
    return adminRequests([rg], config, { all: [rg, ...others] }).map((r) => r.admin);
  };
  assert.deepEqual(admins({}), ['role-admin', 'azure-owner']);
  // The record names the role the installer found or gave.
  assert.deepEqual(admins({ roleAssigned: 'Global Reader' }), ['azure-owner']);
  assert.deepEqual(admins({ roleAssigned: 'AI Administrator' }), ['azure-owner']);
  assert.deepEqual(admins({ access: true }), ['role-admin'], 'it has Reader');
  assert.deepEqual(admins({ roleAssigned: 'Global Reader', access: true }), []);
  assert.deepEqual(admins({ azureRoleAssigned: 'Global Reader', azureAccess: true }), ['role-admin', 'azure-owner'], 'the managed identity\'s roles aren\'t the app\'s');
  // A Global Administrator or Privileged Role Administrator, even one who has to activate the role, gives the app Global Reader.
  assert.deepEqual(admins({}, [row({ id: 'consent-role', status: 'met' })]), ['azure-owner']);
  assert.deepEqual(admins({}, [row({ id: 'consent-role', status: 'eligible' })]), ['azure-owner']);
  assert.deepEqual(admins({}, [row({ id: 'consent-role' })]), ['role-admin', 'azure-owner']);
});

test('adminRequests: on Azure, Resource Graph asks for roles for the jobs\' managed identity, by its object ID once it\'s deployed', () => {
  const rg = row({ id: 'resource-graph' });
  const graph = (/** @type {any} */ azure, /** @type {any} */ record = {}, /** @type {import('../src/prereqs.js').Prereq[]} */ others = []) => {
    const config = azureConfig(azure);
    Object.assign(config.resourceGraph, record);
    return asks(adminRequests([rg], config, { all: [rg, ...others] }));
  };
  const later = (/** @type {string} */ what) => `Once the installer has created the Analytics Hub jobs' managed identity, give it ${what} I'll send you its IDs.`;
  assert.deepEqual(graph({}), [['role-admin', [later(RG_AGENTS)]], ['azure-owner', [later(RG_FOUNDRY)]]]);
  const deployed = { outputs: { identityPrincipalId: 'mi-1' } };
  const mi = 'Give the Analytics Hub jobs\' managed identity (object ID mi-1)';
  assert.deepEqual(graph(deployed), [['role-admin', [`${mi} ${RG_AGENTS}`]], ['azure-owner', [`${mi} ${RG_FOUNDRY}`]]]);
  const admins = (/** @type {any} */ record, /** @type {import('../src/prereqs.js').Prereq[]} */ others = []) => graph(deployed, record, others).map(([admin]) => admin);
  assert.deepEqual(admins({ azureRoleAssigned: 'Global Reader' }), ['azure-owner']);
  assert.deepEqual(admins({ azureAccess: true }), ['role-admin']);
  assert.deepEqual(admins({ azureRoleAssigned: 'Global Reader', azureAccess: true }), []);
  assert.deepEqual(admins({ roleAssigned: 'Global Reader', access: true }), ['role-admin', 'azure-owner'], 'the app\'s roles aren\'t the managed identity\'s');
  // On Azure an Application Administrator meets the consent row too, and can't give Entra roles.
  assert.deepEqual(admins({}, [row({ id: 'consent-role', status: 'met' })]), ['role-admin', 'azure-owner']);
});

test('adminRequests: the Foundry ask has the Reader command, by the object ID of whoever the load runs as, never its client ID', () => {
  const rg = row({ id: 'resource-graph', rows: [{ name: 'Copilot Studio agents', status: 'met' }, { name: 'Foundry resources', status: 'missing' }] });
  const foundry = (/** @type {import('../src/config.js').InstallConfig} */ config, tenantId = 't-1') => {
    if (tenantId) config.tenantId = tenantId;
    const requests = adminRequests([rg], config);
    assert.deepEqual(requests.map((r) => r.admin), ['azure-owner']);
    assert.equal(requests[0].asks.length, 1);
    return requests[0].asks[0];
  };
  const root = '/providers/Microsoft.Management/managementGroups/t-1';
  const command = (/** @type {string} */ id, scope = root) =>
    ` In Azure Cloud Shell (Bash):\n  az role assignment create --assignee-object-id ${id} --assignee-principal-type ServicePrincipal --role "Reader" --scope "${scope}"`;
  const reader = (/** @type {string} */ where) => `the Reader role in Azure on ${where}, so Analytics Hub can read Foundry resources from Azure Resource Graph.`;

  // On Fabric, the app's enterprise application object ID.
  const fabric = plainConfig();
  Object.assign(fabric.app, { appId: 'app-1', servicePrincipalId: 'sp-1' });
  const app = 'Give the app "Analytics Hub Data Collector" (application ID app-1, enterprise application object ID sp-1)';
  assert.equal(foundry(fabric), `${app} ${reader(`the tenant root management group (${root})`)}${command('sp-1')}`);
  fabric.resourceGraph.managementGroup = 'mg-ah';
  const mg = '/providers/Microsoft.Management/managementGroups/mg-ah';
  assert.equal(foundry(fabric), `${app} ${reader(`management group mg-ah (${mg})`)}${command('sp-1', mg)}`);
  // With only its client ID, the command looks the object ID up.
  const lookup = plainConfig();
  lookup.app.appId = 'app-1';
  assert.ok(foundry(lookup).endsWith(command('$(az ad sp show --id app-1 --query id -o tsv)')));
  assert.doesNotMatch(foundry(lookup), /--assignee(-object-id)? app-1/);

  // On Azure, the managed identity's principal ID, not its client ID.
  const azure = azureConfig({ outputs: { identityPrincipalId: 'mi-1', identityClientId: 'mi-client-1' } });
  const ask = foundry(azure);
  assert.ok(ask.startsWith('Give the Analytics Hub jobs\' managed identity (object ID mi-1) '), ask);
  assert.ok(ask.endsWith(command('mi-1')), ask);
  assert.doesNotMatch(ask, /mi-client-1/);

  // No command until there's someone to give it to, or a scope to give it on.
  assert.doesNotMatch(foundry(plainConfig()), /az role assignment/);
  assert.doesNotMatch(foundry(azureConfig({})), /az role assignment/);
  const noTenant = plainConfig();
  Object.assign(noTenant.app, { appId: 'app-1', servicePrincipalId: 'sp-1' });
  assert.doesNotMatch(foundry(noTenant, ''), /az role assignment/);
});

test('adminRequests: rows nobody else needs to do ask for nothing', () => {
  const config = plainConfig();
  for (const it of [
    row({ id: 'power-bi-pro', status: 'met' }),
    row({ id: 'power-bi-pro', status: 'unknown' }),
    row({ id: 'consent-role', status: 'eligible', optional: true }),
    row({ id: 'fabric-admin', optional: true }),
    row({ id: 'copilot-licences', optional: true }),
    row({ id: 'defender-licence', optional: true }),
    // Optional rows for features this install doesn't have.
    row({ id: 'power-automate-premium', optional: true }),
    row({ id: 'viva-analyst', optional: true }),
    row({ id: 'environments', optional: true }),
    row({ id: 'azure-rbac', optional: true }),
  ]) {
    assert.deepEqual(adminRequests([it], config), [], `${it.id} ${it.status}`);
  }
});

test('ui.adminRequests: prints each request with who it\'s for, its rows and the message to copy; nothing when there are none', () => {
  const t = fakeUi();
  t.ui.adminRequests(adminRequests([row({ id: 'power-bi-pro', label: 'Power BI Pro licence' })], plainConfig(), { from: UPN }));
  assert.equal(
    plain(t.text()),
    [
      '',
      '  Requests for your admins: copy each one and send it.',
      '  1. Your licence admin',
      '     For: Power BI Pro licence',
      '     Copy and send:',
      '       Hi,',
      '       ',
      '       I\'m installing Analytics Hub, and I need your help with this:',
      '       ',
      `       - ${PRO}`,
      '       ',
      '       Thanks',
      '       analyst@contoso.com',
      '',
    ].join('\n'),
  );
  const none = fakeUi();
  none.ui.adminRequests([]);
  assert.equal(none.text(), '');
});

test('reportPreflight: after what it shows, the requests for the rows it shows, one per admin, before it stops', async () => {
  const config = studioConfig();
  const items = await checkPrereqs({ api: noRoles(), user: USER, config });
  const t = fakeUi({ yes: true });
  assert.throws(() => reportPreflight({ ui: t.ui, config, user: USER }, items), /can't register apps/);
  const text = plain(t.text());
  assert.ok(inOrder(text, ['for the full list.', 'Requests for your admins: copy each one and send it.', 'Stopped before creating anything: Register apps in Entra.']), text);
  // The capacity, which preflight checks itself, and the tenant settings, which matter only with a model, aren't shown, so nor are their requests.
  assert.deepEqual(whoLines(text), [ADMINS['app-admin'], ADMINS['role-admin'], ADMINS.compliance, ADMINS['power-platform'], ADMINS.licence]);
  assert.match(text, /^ {7}Thanks\n {7}analyst@contoso\.com$/m);

  // A row nobody else does: no requests.
  const alone = fakeUi();
  reportPreflight({ ui: alone.ui, config: plainConfig(), user: USER }, [row({ id: 'copilot-licences', label: 'Microsoft 365 Copilot licences', optional: true })]);
  assert.match(plain(alone.text()), /1 prerequisite needs attention\./);
  assert.doesNotMatch(alone.text(), /Requests for your admins/);
});

test('reportFlowPrereqs: once the flows are chosen, the requests for their rows, once', () => {
  const config = studioConfig();
  const items = [
    row({ id: 'power-platform-admin', label: 'Power Platform Administrator', optional: true }),
    row({ id: 'power-automate-premium', label: 'Power Automate Premium licence', optional: true }),
    row({ id: 'environments', label: 'System Administrator in a Power Platform environment', optional: true }),
  ];
  const t = fakeUi();
  const ctx = /** @type {any} */ ({ ui: t.ui, config, user: USER, preflightSeen: { items, shown: new Map() } });
  reportFlowPrereqs(ctx);
  const text = plain(t.text());
  assert.deepEqual(whoLines(text), [ADMINS['power-platform'], ADMINS.licence]);
  assert.ok(inOrder(text, [`- ${ENV_SALES}`, `- ${CONNECTION}`, '- Confirm that HTTP with Microsoft Entra ID (preauthorized) is allowed in Sales', `- ${PREMIUM}`]), text);
  const before = t.text().length;
  reportFlowPrereqs(ctx);
  assert.equal(t.text().length, before, 'shown once');
});
