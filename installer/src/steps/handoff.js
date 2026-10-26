// @ts-check
/**
 * "Copy a request for your admin": for the prerequisites someone else has to do, a message to copy and send,
 * one per admin, asking for everything that admin does. It builds text only: it writes no files, and puts no
 * client secrets, keys, tokens, passwords or sign-in codes in a request.
 */
import { graphRolesCommand, graphRolesRevokeCommand, objectIdOrLookup, pendingGraphRoles, roleAssignmentCommand } from '../admin-commands.js';
import { apiPermissionsUrl, GLOBAL_ADMIN_ROLE } from '../clients/graph.js';
import { secretMode } from '../config.js';
import { commandLine } from '../launch.js';
import { ppApiWanted, preflightVerdict, settingsLeft, settingsToConfirm, TENANT_SETTINGS_URL } from '../prereqs.js';
import { isVivaId } from '../transform/dataflow.js';
import { FEEDBACK_SUBJECT } from '../transform/flows.js';
import { adminFileName } from './admin-pack.js';
import { AUDIT_ROLE, PURVIEW_AUDIT_URL } from './audit-check.js';
import { AZURE_APPS } from './azure/apps.js';
import { LEAST_PRIVILEGE_URL } from './azure/least-privilege.js';
import { MANAGE_APPS_URL, TEAMS_APP_PENDING } from './azure/teams-catalog.js';
import { AZURE_AI_ROLES, DATAFLOW_GUIDE } from './consumption.js';
import { FEEDBACK_EXPORT_URL, FLOW_NAMES, flowConnected, flowsWanted, ppApiSigner } from './flows.js';
import { CONCEALED_NAMES_AFTER, CONCEALED_NAMES_STEPS, CONCEALED_NAMES_WHY, letter, M365_ADMIN_URL } from './next-steps.js';
import { APP_NAME } from './plan.js';
import { AGENT_ROLE, ENTRA_ROLES_URL, globalReaderCommand, readerCommand, resourceGraphOn, resourceGraphScope, scopeName } from './resource-graph.js';

/** @typedef {import('../prereqs.js').Prereq} Prereq */
/** @typedef {import('../prereqs.js').PrereqStatus} PrereqStatus */
/** @typedef {import('../config.js').InstallConfig} InstallConfig */

/** Who each request goes to, in the order they're shown: the least role that does what it asks. */
export const ADMINS = {
  'app-admin': 'An Application Administrator or Cloud Application Administrator',
  'role-admin': 'A Privileged Role Administrator or Global Administrator',
  'global-admin': 'A Global Administrator',
  'fabric-admin': 'A Fabric administrator',
  'capacity-admin': 'A Fabric capacity admin',
  compliance: 'A Compliance Administrator',
  'm365-admin': 'A Microsoft 365 admin',
  'power-platform': 'A Power Platform administrator',
  teams: 'A Teams Administrator',
  'sharepoint-admin': 'A SharePoint Administrator',
  'azure-owner': 'An Azure Owner or User Access Administrator',
  'vault-admin': 'A Key Vault admin',
  viva: 'An Insights Analyst',
  licence: 'Your licence admin',
  other: 'An admin',
};

/** Who takes a permission off an app registration's API permissions: the app admins, or one of the app's owners. */
export const APP_OWNER_ADMIN = "An Application Administrator, a Cloud Application Administrator or one of the app's owners";

/** @typedef {keyof typeof ADMINS} AdminKey */
/**
 * One admin's request: who it goes to, the prerequisites it's for (by their labels in the list), what it asks
 * for, and the message to copy and send.
 * @typedef {object} AdminRequest
 * @property {AdminKey} admin
 * @property {string} who
 * @property {string[]} rows
 * @property {string[]} asks
 * @property {string} message
 * @property {boolean} [optional]  Everything it asks for is optional.
 * @property {string[]} [notes]  For you, before you send it.
 * @property {string[]} [after]  For you, once the admin has done it.
 * @property {string[]} [back]  What the admin sends you back, one item each.
 */
/**
 * @typedef {object} Ask
 * @property {AdminKey} admin
 * @property {string} text
 * @property {string} [label]  The prerequisite it's for. The row's own label when absent.
 * @property {boolean} [consent]  Approves the Azure web app's delegated permissions, which an admin can do with another ask.
 * @property {boolean} [coversConsent]  Approves those permissions too, so no separate ask is needed.
 * @property {string} [who]  Who it goes to, when it isn't ADMINS' name for its admin, such as one environment's System Administrator.
 * @property {boolean} [optional]
 * @property {string} [note]  For you, before you send it.
 * @property {string[]} [after]  For you, once it's done.
 * @property {string} [back]  What the admin sends you back.
 * @property {string} [kind]  Which pending admin action it's for: graph, graph-revoke (Microsoft Graph roles to take back
 *   from the jobs' managed identity), consent, teams, owner, drop-site, drop-site-revoke (the jobs' read on a SharePoint
 *   site their drop folder left, to take back) or other.
 */
/**
 * @typedef {object} AskContext
 * @property {InstallConfig} config
 * @property {(id: string) => PrereqStatus | undefined} status  Of any row checked.
 * @property {boolean} ppApi  A flow signs in to the Power Platform API connection.
 * @property {boolean} pendingConsent  The Azure install left the web app's consent for an admin, with its link.
 * @property {boolean} pendingTeams  The Azure install left the Teams app for an admin to publish.
 */

const PURVIEW_LABEL = 'Audit logging in Microsoft Purview';
const PENDING_LABEL = 'Pending admin action';
/** How the Azure install's pending admin actions start: the web app's consent, and making you an owner of its apps. */
const CONSENT_PENDING = 'Grant delegated consent on ';
const OWNER_PENDING = 'An Application Administrator or Cloud Application Administrator adds ';
/** The SharePoint drop site's read grant, which a SharePoint Administrator runs as it is. */
const DROP_SITE_PENDING = 'Grant-PnPAzureADAppSitePermission ';
/** Before a command in an ask, which goes on the next line, indented. */
const CLOUD_SHELL = ' In Azure Cloud Shell (Bash):\n  ';
/** Before PnP PowerShell commands in an ask, as CLOUD_SHELL: for SharePoint, which has no Bash command for them. */
const PNP_SHELL = ' In PowerShell (PnP):\n  ';
/** In the tenant settings row when only a Fabric administrator could read them. */
const SETTINGS_UNREAD = ' to confirm these are on for you';
const XMLA_UNREAD = 'XMLA endpoint must also be Read Write';
const WEB_CONSENT = 'the Analytics Hub web app\'s delegated permissions (Power BI and Microsoft Graph)';
const RG_AGENTS = 'Copilot Studio agents';
const RG_FOUNDRY = 'Foundry resources';
const VIVA_BACK = 'The Cowork credits query\'s partition ID and query ID.';

/** @param {string} p */
const fileName = (p) => p.split(/[\\/]/).pop() || p;
/** @param {string} s */
const capitalise = (s) => s.charAt(0).toUpperCase() + s.slice(1);
/** Ends a sentence with a full stop, unless it already has one or ends with a link. @param {string} s */
const stop = (s) => (/[.!?]$|https?:\/\/\S+$/.test(s) ? s : `${s}.`);
/** @param {PrereqStatus | undefined} s */
const settled = (s) => s === 'met' || s === 'eligible';

/** @returns {Ask} */
const purviewAsk = () => ({
  admin: 'compliance',
  label: PURVIEW_LABEL,
  text: `Check that audit logging is on in Microsoft Purview > Audit, and turn it on if it isn't: ${PURVIEW_AUDIT_URL}`,
});

/**
 * The Microsoft Graph roles for the jobs' managed identity and, once it's deployed, the command that gives them.
 * @param {InstallConfig} config
 * @param {string[]} roles
 */
const graphRolesText = (config, roles) => {
  const id = config.azure?.outputs?.identityPrincipalId;
  const ask = `Give the Analytics Hub jobs' managed identity${id ? ` (object ID ${id})` : ''} these Microsoft Graph application permissions: ${roles.join(', ')}.`;
  return id ? `${ask}${CLOUD_SHELL}${graphRolesCommand(id, roles)}` : ask;
};

/**
 * The Microsoft Graph roles the jobs' managed identity no longer uses and still has, and the command that takes them back.
 * @param {InstallConfig} config
 * @param {string[]} roles
 */
const graphRevokeText = (config, roles) => {
  const id = config.azure?.outputs?.identityPrincipalId;
  const ask =
    `Take these Microsoft Graph application permissions back from the Analytics Hub jobs' managed identity${id ? ` (object ID ${id})` : ''}, ` +
    `as Analytics Hub no longer uses them: ${roles.join(', ')}.`;
  return id ? `${ask}${CLOUD_SHELL}${graphRolesRevokeCommand(id, roles)}` : ask;
};

/**
 * The object ID of whoever the loads run as, for a command, or a lookup of it from the app's client
 * ID. Undefined until it exists, as in forLoad.
 * @param {InstallConfig} config
 */
const loadObjectId = (config) => {
  if (config.target === 'azure') return config.azure?.outputs?.identityPrincipalId;
  const { servicePrincipalId, appId } = config.app ?? {};
  return servicePrincipalId || appId ? objectIdOrLookup(servicePrincipalId, appId) : undefined;
};

/**
 * An ask for whoever the Resource Graph load runs as: the app on Fabric, the jobs' managed identity on Azure,
 * named by its IDs once it exists. Until then, it's for once it does, with its IDs to follow.
 * @param {AskContext} c
 * @param {string} what  The role and why, after "give it".
 */
function forLoad(c, what) {
  const { config } = c;
  const later = (/** @type {string} */ once) => `Once ${once}, give it ${what} I'll send you its IDs.`;
  if (config.target === 'azure') {
    const id = config.azure?.outputs?.identityPrincipalId;
    const mi = 'the Analytics Hub jobs\' managed identity';
    return id ? `Give ${mi} (object ID ${id}) ${what}` : later(`the installer has created ${mi}`);
  }
  const app = config.app?.displayName ?? APP_NAME;
  const ids = [
    ...(config.app?.appId ? [`application ID ${config.app.appId}`] : []),
    ...(config.app?.servicePrincipalId ? [`enterprise application object ID ${config.app.servicePrincipalId}`] : []),
  ];
  if (ids.length) return `Give the app "${app}" (${ids.join(', ')}) ${what}`;
  // When you can't register apps, an admin registers it from the admin pack.
  const registers = ['missing', 'handoff'].includes(c.status('register-apps') ?? '');
  return later(registers ? `Analytics Hub's app "${app}" is registered` : `the installer has created Analytics Hub's app "${app}"`);
}

/**
 * Admin consent for the Fabric app registration's Microsoft Graph permissions, with the page that grants it once
 * there's an app.
 * @param {InstallConfig} config
 * @returns {Ask}
 */
const fabricConsentAsk = (config) => {
  const appId = config.app?.appId;
  return {
    admin: 'role-admin',
    text: appId
      ? `Grant admin consent for the Microsoft Graph application permissions of Analytics Hub's app registration (client ID ${appId}), including ${AUDIT_ROLE}: open ${apiPermissionsUrl(appId)} and select "Grant admin consent".`
      : `Once Analytics Hub's app registration exists, grant admin consent for its Microsoft Graph application permissions, including ${AUDIT_ROLE}. I'll send you the link.`,
  };
};

/** The Global Reader ask, after "give it". */
const globalReaderWhat = () =>
  `the ${AGENT_ROLE} role in Microsoft Entra, so Analytics Hub can read Copilot Studio agents from Azure Resource Graph. ${AGENT_ROLE} is read-only.`;

/**
 * Reader in Azure on the scope Resource Graph reads, for Foundry resources, with the command that gives it once
 * the scope and whoever the load runs as are known.
 * @param {AskContext} c
 */
function foundryText(c) {
  const { config } = c;
  const scope = config.resourceGraph?.managementGroup || config.tenantId ? resourceGraphScope(config, config.tenantId ?? '') : '';
  const scopeId = scope ? ` (${scope})` : '';
  const reader = scope && loadObjectId(config);
  return (
    forLoad(c, `the Reader role in Azure on ${scopeName(config)}${scopeId}, so Analytics Hub can read Foundry resources from Azure Resource Graph.`) +
    (reader ? `${CLOUD_SHELL}${readerCommand(reader, scope)}` : '')
  );
}

/**
 * The System Administrator role in the environment the flows or Agent Evaluator use.
 * @param {InstallConfig} config
 * @returns {Ask}
 */
const environmentAsk = (config) => {
  const env = config.uploads?.flowEnvironment;
  const flows = flowsWanted(config).length > 0;
  const evaluator = !!config.modules?.agentEvaluator;
  const what = flows && evaluator ? 'Power Automate flows and Agent Evaluator' : flows ? 'Power Automate flows' : 'Agent Evaluator';
  return { admin: 'power-platform', text: `Give me the System Administrator security role in ${env?.name ?? env?.url ?? 'the Power Platform environment I\'ll use'}, for Analytics Hub's ${what}.` };
};

/**
 * Signing in to the flows' Power Platform API connection, as someone with the role assigned permanently.
 * @param {InstallConfig} config
 * @returns {Ask}
 */
const connectionAsk = (config) => ({
  admin: 'power-platform',
  text:
    `Once the install has created the flows, sign in to their Power Platform API connection. Whoever signs in needs to be ${ppApiSigner(config)}, ` +
    'with the role assigned permanently rather than activated in Privileged Identity Management, because the connection signs in each time the flows run. I\'ll send you the steps.',
});

/**
 * Turning on the Fabric tenant settings someone who can't read them needs.
 * @param {string[]} settings  By their names in the admin portal.
 * @returns {Ask}
 */
const settingsAsk = (settings) => ({
  admin: 'fabric-admin',
  text: `Confirm these Fabric tenant settings are on for me, or for a group I'm in, and turn on any that are off: ${settings.join('; ')}. They're in Fabric under Admin portal > Tenant settings: ${TENANT_SETTINGS_URL}`,
});

/** @returns {Ask} */
const xmlaAsk = () => ({ admin: 'capacity-admin', text: 'Set the XMLA endpoint to Read Write on the Fabric capacity Analytics Hub\'s workspace uses.' });

/**
 * What each prerequisite asks of an admin when it needs someone else, by row ID: null when it never does, such as
 * a row the install carries on without, or one another row asks for.
 * @type {Record<string, null | ((it: Prereq, c: AskContext) => Ask[])>}
 */
export const ROW_ASKS = {
  'consent-role': (it, c) => {
    if (c.config.target !== 'azure') return [fabricConsentAsk(c.config), ...(it.howTo.includes(PURVIEW_AUDIT_URL) ? [purviewAsk()] : [])];
    // The pending action has the link, so it asks instead.
    if (c.pendingConsent) return [];
    const clientId = c.config.azure?.webApp?.clientId;
    return [
      {
        admin: 'app-admin',
        consent: true,
        text: clientId ? `Approve ${WEB_CONSENT}: open ${apiPermissionsUrl(clientId)} and select "Grant admin consent".` : `After the deploy, approve ${WEB_CONSENT}. I'll send you the link.`,
      },
    ];
  },
  // The tenant settings row asks for what a Fabric administrator does.
  'fabric-admin': null,
  'power-platform-admin': (it, c) => [...(it.status === 'missing' ? [environmentAsk(c.config)] : []), ...(c.ppApi ? [connectionAsk(c.config)] : [])],
  environments: (it, c) => (settled(c.status('power-platform-admin')) ? [] : [environmentAsk(c.config)]),
  'teams-admin': (it, c) =>
    c.pendingTeams ? [] : [{ admin: 'teams', text: `After the install, upload the Analytics Hub Teams package I'll send you in the Teams admin center, under Teams apps > Manage apps: ${MANAGE_APPS_URL}` }],
  'register-apps': (it, c) => {
    const { config } = c;
    if (config.target !== 'azure') {
      // Once you've chosen to have an admin register it, their own file in the admin pack has the script and steps.
      const steps =
        config.app?.adminPack && !config.app.appId
          ? `The installer's Cloud Shell script and portal steps for it are in ${adminFileName('app-admin')}, from its admin pack, with what to send back.`
          : 'I\'ll send you the installer\'s Cloud Shell script and portal steps for it, which say what to send back.';
      return [{ admin: 'app-admin', text: `Register the app Analytics Hub uses to collect data, in Microsoft Entra. ${steps}` }];
    }
    if (config.azure?.adminScript) {
      // The app admin's own file in the admin pack has the script, as the file it records does.
      return [
        {
          admin: 'app-admin',
          coversConsent: true,
          text: `Run the script in ${adminFileName('app-admin')}, from the installer's admin pack, in Azure Cloud Shell (Bash). It creates Analytics Hub's app registrations and approves ${WEB_CONSENT}. It makes no secrets.`,
        },
      ];
    }
    const named = AZURE_APPS.filter((a) => it.detail.includes(`"${a.name}" still needs creating`) || it.detail.includes(`create "${a.name}" for you`));
    const unmade = AZURE_APPS.filter((a) => !config.azure?.[a.key]?.clientId);
    const apps = named.length ? named : unmade.length ? unmade : AZURE_APPS;
    const web = apps.some((a) => a.key === 'webApp');
    const what = apps.length === 1 ? `Analytics Hub's app registration "${apps[0].name}"` : `Analytics Hub's two app registrations, ${apps.map((a) => `"${a.name}"`).join(' and ')}`;
    return [{ admin: 'app-admin', coversConsent: web, text: `Create ${what}${web ? `, and approve ${WEB_CONSENT}` : ''}. I'll send you a script from the installer that does it.` }];
  },
  'audit-ingestion': (it, c) => {
    const { config } = c;
    if (config.target === 'azure') {
      const pending = pendingGraphRoles(config.azure?.graphRoles);
      const roles = pending.length
        ? graphRolesText(config, pending)
        : `After the deploy, give the Analytics Hub jobs' managed identity its Microsoft Graph application permissions, including ${AUDIT_ROLE}. I'll send you the list.`;
      return [{ admin: 'role-admin', text: roles }, purviewAsk()];
    }
    if (it.status === 'handoff') return [...(c.status('consent-role') === 'eligible' ? [] : [fabricConsentAsk(config)]), purviewAsk()];
    // Consent is in place, but the last audit check failed: as that check advises.
    const last = config.auditCheck?.result;
    if (last === 'empty-log') return [purviewAsk()];
    if (last === 'no-role' || last === 'refused') return [fabricConsentAsk(config)];
    return [];
  },
  'power-bi-pro': () => [{ admin: 'licence', text: 'Assign me a Power BI Pro licence (Premium Per User works too), to publish the Analytics Hub reports.' }],
  'copilot-licences': null,
  'power-automate-premium': () => [{ admin: 'licence', text: 'Assign me Power Automate Premium: I\'ll own the Analytics Hub flows, which use premium connectors.' }],
  'data-policy': (it) => [{ admin: 'power-platform', text: capitalise(it.howTo.replace(/^Ask an? Power Platform administrator to /, '')) }],
  'fabric-capacity': (it, c) => {
    const { scale } = c.config;
    const size =
      scale === 'large'
        ? 'With more than 10,000 people in the tenant, F64 or larger is best; F2 is the minimum.'
        : scale === 'standard'
          ? 'The capacity needs to be F2 or larger.'
          : 'The capacity needs to be F2 or larger; F64 or larger is best for more than 10,000 people.';
    return [{ admin: 'capacity-admin', text: `Make me a contributor on a Fabric capacity for Analytics Hub's workspace, or an Admin or Member of a workspace that's already on one. ${size}` }];
  },
  'azure-rbac': (it, c) => {
    const { config } = c;
    const azure = config.target === 'azure';
    const subId = config.azure?.subscriptionId ?? config.keyVault?.subscriptionId;
    const sub = subId ? `the subscription ${subId}` : 'a subscription I can use';
    const steps = `The steps and the condition are in ${LEAST_PRIVILEGE_URL}`;
    if (azure && config.azure?.resourceGroupMode === 'existing' && config.azure.resourceGroup) {
      return [{ admin: 'azure-owner', text: `Give me Contributor and a condition-limited Role Based Access Control Administrator (or Owner) on the resource group "${config.azure.resourceGroup}" in ${sub}. ${steps}` }];
    }
    const least = azure ? ` Or, for least privilege, create the resource group and give me Contributor and a condition-limited Role Based Access Control Administrator on just that group. ${steps}` : '';
    return [{ admin: 'azure-owner', text: `Give me Owner, or Contributor and User Access Administrator, on ${sub}.${least}` }];
  },
  'key-vault': (it, c) => {
    const kv = c.config.keyVault;
    // No Key Vault is the default on Fabric until one is chosen, and a vault admin who adds the secret has their own steps.
    if (secretMode(c.config) !== 'keyvault' || !(kv.id || kv.name || kv.uri || kv.subscriptionId)) return [];
    if (kv.id) return [{ admin: 'azure-owner', text: `Give me Key Vault Secrets Officer on the Key Vault "${kv.name ?? kv.id.split('/').pop()}", which Analytics Hub uses.` }];
    return [{ admin: 'azure-owner', text: 'Give me Contributor on an Azure subscription, so I can create a Key Vault for Analytics Hub, or Key Vault Secrets Officer on an existing vault.' }];
  },
  'viva-analyst': () => [
    {
      admin: 'viva',
      text: 'Create the Copilot Cowork credits query in Viva Insights (Consumption query, the preselected credit metrics, Auto-refresh on), and send me its partition ID and query ID.',
      back: VIVA_BACK,
    },
  ],
  'defender-licence': null,
  'tenant-settings': (it, c) => {
    // Readable settings mean you're a Fabric administrator, and can turn them on yourself.
    if (!it.detail.includes(SETTINGS_UNREAD)) return [];
    return [settingsAsk(settingsToConfirm(c.config)), ...(it.detail.includes(XMLA_UNREAD) ? [xmlaAsk()] : [])];
  },
  'resource-graph': (it, c) => {
    const { config } = c;
    const rg = config.resourceGraph;
    const azure = config.target === 'azure';
    const kinds = it.rows?.length
      ? it.rows.filter((r) => r.status === 'missing').map((r) => r.name)
      : [...(rg?.agents !== false ? [RG_AGENTS] : []), ...(rg?.foundry !== false ? [RG_FOUNDRY] : [])];
    // The record names the Entra role it was given. On Fabric, a Global Administrator or Privileged Role
    // Administrator running the installer gives the app Global Reader themselves.
    const hasRole = azure ? !!rg?.azureRoleAssigned : (!!rg?.roleAssigned || settled(c.status('consent-role')));
    const agents = kinds.includes(RG_AGENTS) && !hasRole;
    const foundry = kinds.includes(RG_FOUNDRY) && !(azure ? rg?.azureAccess : rg?.access);
    return [
      ...(agents ? [/** @type {Ask} */ ({ admin: 'role-admin', text: forLoad(c, globalReaderWhat()) })] : []),
      ...(foundry ? [/** @type {Ask} */ ({ admin: 'azure-owner', text: foundryText(c) })] : []),
    ];
  },
};

/**
 * Whether a row needs someone else to do something. A role you can activate yourself doesn't, except the Power
 * Platform Administrator role for the flows' connection, which an activation keeps signed in for a day at most.
 * Of the rows that couldn't be checked, only the data policy and the tenant settings ask someone to confirm.
 * @param {Prereq} it
 * @param {AskContext} c
 */
function needsSomeoneElse(it, c) {
  switch (it.status) {
    case 'missing':
    case 'handoff':
      return true;
    case 'eligible':
      return it.id === 'power-platform-admin' && c.ppApi;
    case 'unknown':
      return it.id === 'data-policy' || (it.id === 'tenant-settings' && it.detail.includes(SETTINGS_UNREAD));
    default:
      return false;
  }
}

/**
 * Teams admin center steps from the Teams app's pending admin action, for the package's file name rather than
 * its path on your computer.
 * @param {string} action
 */
function teamsAsk(action) {
  const rest = action.slice(TEAMS_APP_PENDING.length + 2);
  const upload = /^upload (.+) in (Teams admin center > .+)\.$/.exec(rest);
  if (upload) return `Upload the Analytics Hub Teams package I'll send you (${fileName(upload[1])}) in ${upload[2]}.`;
  const approve = /^approve (.+?) in (Teams admin center > .+?), then run the installer again\.$/.exec(rest);
  if (approve) return `Approve ${approve[1]} in ${approve[2]}.`;
  return stop(capitalise(rest));
}

/**
 * The admin actions an Azure install left for someone else, as asks: the Microsoft Graph roles its jobs' managed
 * identity is still waiting for, those it no longer uses and still has, and the actions it lists. Known actions are
 * matched by how they start; any other goes to "An admin" as it is.
 * @param {string[]} actions
 * @param {string[]} roles  Graph roles, from pendingGraphRoles.
 * @param {string[]} retired  Graph roles to take back, from the record's graphRoles.retired.
 * @param {Prereq[]} rows
 * @param {AskContext} c
 * @returns {Ask[]}
 */
function pendingAsks(actions, roles, retired, rows, c) {
  const labelFor = (/** @type {string} */ id) => rows.find((r) => r.id === id)?.label ?? PENDING_LABEL;
  // The audit row asks for the same roles while it's a hand-off; otherwise they're only pending.
  const audit = rows.find((r) => r.id === 'audit-ingestion' && r.status === 'handoff');
  /** @type {Ask[]} */
  const graph = roles.length ? [{ admin: 'role-admin', kind: 'graph', label: audit?.label ?? PENDING_LABEL, text: graphRolesText(c.config, roles) }] : [];
  /** @type {Ask[]} */
  const revoke = retired.length ? [{ admin: 'role-admin', kind: 'graph-revoke', label: PENDING_LABEL, text: graphRevokeText(c.config, retired) }] : [];
  return [
    ...graph,
    ...revoke,
    ...actions.flatMap((action) => {
      if (action.startsWith(CONSENT_PENDING)) {
        if (settled(c.status('consent-role'))) return [];
        return [{ admin: /** @type {AdminKey} */ ('app-admin'), kind: 'consent', consent: true, label: labelFor('consent-role'), text: `Approve ${WEB_CONSENT}: open ${action.slice(CONSENT_PENDING.length).trim()} and select "Grant admin consent".` }];
      }
      if (action.startsWith(`${TEAMS_APP_PENDING}: `)) {
        if (settled(c.status('teams-admin'))) return [];
        return [{ admin: /** @type {AdminKey} */ ('teams'), kind: 'teams', label: labelFor('teams-admin'), text: teamsAsk(action) }];
      }
      if (action.includes(' as an owner of "')) {
        return [{ admin: /** @type {AdminKey} */ ('app-admin'), kind: 'owner', label: PENDING_LABEL, text: stop(action.startsWith(OWNER_PENDING) ? `Add ${action.slice(OWNER_PENDING.length)}` : action) }];
      }
      if (action.startsWith(DROP_SITE_PENDING)) return [{ admin: /** @type {AdminKey} */ ('sharepoint-admin'), kind: 'drop-site', label: PENDING_LABEL, text: action }];
      return [{ admin: /** @type {AdminKey} */ ('other'), kind: 'other', label: PENDING_LABEL, text: action }];
    }),
  ];
}

/**
 * The web app's consent asks: when another ask approves it too, that ask, so its request still lists the consent's
 * row; else to whoever approves anything else. Any Application Administrator, Cloud Application Administrator,
 * Privileged Role Administrator or Global Administrator can, so with no other ask for an app admin but one for a
 * role admin, that one does it too.
 * @param {Ask[]} asks
 * @returns {Ask[]}
 */
function placeConsent(asks) {
  if (!asks.some((a) => a.consent)) return asks;
  const cover = asks.find((a) => a.coversConsent);
  const others = asks.filter((a) => !a.consent);
  const admin = !others.some((a) => a.admin === 'app-admin') && others.some((a) => a.admin === 'role-admin') ? 'role-admin' : 'app-admin';
  return asks.map((a) => (!a.consent ? a : cover ? { ...a, admin: cover.admin, text: cover.text } : { ...a, admin: /** @type {AdminKey} */ (admin) }));
}

/**
 * One request per admin for the rows that need someone else, in the order of ADMINS. Each asks for everything
 * that admin does, once, as a message signed by `from`. Optional rows count only when the install needs them,
 * as preflight decides. On Azure, the Graph roles and admin actions a run left pending are asked for too, unless
 * `pending` is false.
 * @param {Prereq[]} rows  The rows to ask for.
 * @param {InstallConfig} config
 * @param {{ from?: string, pending?: boolean, all?: Prereq[] }} [opts]  all: every row checked, when `rows` is only
 *   some of them, to see what's relevant and what's already met.
 * @returns {AdminRequest[]}
 */
export function adminRequests(rows, config, opts = {}) {
  const all = opts.all ?? rows;
  const status = (/** @type {string} */ id) => all.find((it) => it.id === id)?.status;
  const verdict = preflightVerdict(all, { config });
  const counted = new Set([...verdict.block, ...verdict.warn, ...verdict.handoff, ...verdict.confirm].map((it) => it.id));
  const pendingOn = opts.pending !== false && config.target === 'azure';
  const actions = pendingOn ? config.azure?.status?.pendingAdminActions ?? [] : [];
  const roles = pendingOn ? pendingGraphRoles(config.azure?.graphRoles) : [];
  const retired = pendingOn ? config.azure?.graphRoles?.retired ?? [] : [];
  const pendingConsent = actions.some((a) => a.startsWith(CONSENT_PENDING)) && !settled(status('consent-role'));
  const pendingTeams = actions.some((a) => a.startsWith(`${TEAMS_APP_PENDING}: `)) && !settled(status('teams-admin'));
  /** @type {AskContext} */
  const c = { config, status, ppApi: ppApiWanted(config), pendingConsent, pendingTeams };
  const fromRows = rows
    .filter((it) => (!it.optional || counted.has(it.id)) && needsSomeoneElse(it, c))
    .flatMap((it) => (ROW_ASKS[it.id]?.(it, c) ?? []).map((a) => ({ label: it.label, ...a })));
  const asks = placeConsent([...fromRows, ...pendingAsks(actions, roles, retired, rows, c)]);
  return /** @type {AdminKey[]} */ (Object.keys(ADMINS)).flatMap((admin) => {
    const mine = asks.filter((a) => a.admin === admin);
    if (!mine.length) return [];
    const texts = [...new Set(mine.map((a) => a.text))];
    const back = [...new Set(mine.flatMap((a) => (a.back ? [a.back] : [])))];
    const intro = `I'm installing Analytics Hub, and I need your help with ${texts.length === 1 ? 'this' : 'these'}:`;
    return [
      {
        admin,
        who: ADMINS[admin],
        rows: [...new Set(mine.map((a) => a.label ?? PENDING_LABEL))],
        asks: texts,
        message: letter([intro, '', ...texts.map((t) => `- ${t}`)], opts.from),
        ...(back.length ? { back } : {}),
      },
    ];
  });
}

/** The re-run that picks up what an admin did. */
const REPAIR = 'Run the installer again and choose Repair or change';
/** The re-run that asks whether an admin gave a role it couldn't. With --yes it can't ask. */
const REPAIR_ASKS = 'Run the installer again without --yes and choose Repair or change. When it says you can\'t assign Azure roles there, choose';
/** Numbered steps under an ask, one per line. @param {string[]} steps */
const numberedLines = (steps) => steps.map((s, i) => `\n  ${i + 1}. ${s}`).join('');
/** "A, B and C". @param {string[]} items */
const andList = (items) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);
/** Run now's Audit history choices on the Done page's installer, in days. */
const RUN_NOW_DAYS = [30, 90, 180];

/**
 * What a re-run does with each kind of pending admin action, from the Azure install's code, and the label it's
 * listed under. A re-run tries the Graph roles and the drop site's grant again, and lists them again if it still
 * can't make them, whoever has done them since.
 * @type {Record<string, { label: string, after: string }>}
 */
const PENDING_DONE = {
  graph: { label: 'Microsoft Graph roles', after: `${REPAIR}: it tries each of these roles again.` },
  'graph-revoke': {
    label: 'Microsoft Graph roles to take back',
    after: `${REPAIR}: it checks the managed identity's roles again, and stops listing these once they're gone.`,
  },
  consent: { label: 'Web app consent', after: `${REPAIR}: it checks the consent, and stops listing it once it's granted.` },
  teams: {
    label: 'Teams app',
    after:
      `${REPAIR}: with the Teams Administrator or Global Administrator role, it finds Analytics Hub in your org's app catalog and stops listing this. ` +
      "Without one of them it can't read the catalog, so it lists it again.",
  },
  owner: { label: 'App ownership', after: `${REPAIR}: it finishes setting up the app and stops listing this.` },
  'drop-site': { label: 'Drop site access', after: `${REPAIR}: it tries this grant again, and lists it again if it can't make it itself, even once the admin has.` },
  other: { label: PENDING_LABEL, after: `Once it's done, ${REPAIR.charAt(0).toLowerCase()}${REPAIR.slice(1)}.` },
};

/**
 * Whether a data check's identity match shows user names, as printIdentityMatch (run.js) reads it: hidden when at
 * least half the licensed users' names are masked, and unknown with no licensed users or no audit activity to tell by.
 * @param {{ licensed?: number, audit?: number, masked?: number } | null | undefined} identity
 * @returns {'shown' | 'hidden' | 'unknown'}
 */
export function namesState(identity) {
  const licensed = Number(identity?.licensed ?? 0);
  const audit = Number(identity?.audit ?? 0);
  const masked = Number(identity?.masked ?? 0);
  if (!(licensed > 0 && audit > 0)) return 'unknown';
  return masked * 2 < licensed ? 'shown' : 'hidden';
}

/**
 * Whether to ask for user names in the Microsoft 365 usage reports, and whether it's unsure they're concealed. On
 * Fabric it's asked unless the data check shows names: with no check, or one that can't tell, it's asked, since
 * concealing them is Microsoft's default. Azure's first load runs in the background, so there's no check to tell by:
 * it's always asked, except for sample data.
 * @param {InstallConfig} config
 * @param {{ identity?: { licensed?: number, audit?: number, masked?: number } } | null | undefined} dataCheck  This run's data
 *   check, or else the last one the Lakehouse holds.
 * @returns {false | { unsure: boolean }}
 */
export function namesWanted(config, dataCheck) {
  if (config.target === 'azure') return config.azure?.sampleData === true ? false : { unsure: true };
  const state = namesState(dataCheck?.identity);
  return state === 'shown' ? false : { unsure: state === 'unknown' };
}

/**
 * Whether you're a Global Administrator, from your active directory roles. Not when they can't be read.
 * @param {any} api
 * @returns {Promise<boolean>}
 */
export async function isGlobalAdmin(api) {
  try {
    const roles = await api?.graph?.myDirectoryRoles?.();
    return Array.isArray(roles) && roles.some((r) => r?.roleTemplateId === GLOBAL_ADMIN_ROLE);
  } catch {
    return false;
  }
}

/**
 * @typedef {object} DoneOptions
 * @property {string} [from]  Your sign-in: it signs each message, and it's the mailbox the product feedback export goes to.
 * @property {boolean} [consented]  This run's admin consent (Fabric). False when it's still needed.
 * @property {{ identity?: { licensed?: number, audit?: number, masked?: number }, tables?: { audit?: { rows?: number } }, auditExcluded?: { parsed?: number } } | null} [dataCheck]
 *   This run's data check, or else the last one the Lakehouse holds.
 * @property {boolean} [globalAdmin]  You're a Global Administrator, so concealed names are your own card rather than a request.
 * @property {number} [backfillDays]  The audit history the skipped load would have loaded.
 * @property {Ask[]} [transcripts]  The Agent Evaluator's asks, one per environment, from its module.
 * @property {Prereq[]} [carried]  The rows preflight and the flows' check showed as needing someone else in this run, which
 *   the admin pack keeps. Their asks that a finished install doesn't settle are asked for again (carriedDone).
 * @property {Ask[]} [vault]  The vault admin's ask while the app's client secret waits for them (Fabric), from identity.js's vaultAsk.
 * @property {string[]} [broughtRetired]  Fabric: the Graph application permissions Analytics Hub no longer uses that this run
 *   read as consented on the app you brought, which the installer leaves alone.
 */

/**
 * Global Reader for whoever the load runs as, so Resource Graph returns Copilot Studio agents, until the record says
 * it has a role that covers them.
 * @param {AskContext} c
 * @returns {Ask[]}
 */
function globalReaderDone(c) {
  const { config } = c;
  const rg = config.resourceGraph;
  const azure = config.target === 'azure';
  if (!resourceGraphOn(config) || rg?.agents === false) return [];
  if (azure ? config.azure?.sampleData === true || rg?.azureRoleAssigned : rg?.roleAssigned) return [];
  const out = config.azure?.outputs;
  const mi = out?.identityId ? String(out.identityId).split('/').pop() : '';
  const select = !azure
    ? `Choose Add assignments, search for "${config.app?.displayName ?? APP_NAME}" and select it.`
    : mi
      ? `Choose Add assignments, search for "${mi}", the Analytics Hub jobs' managed identity, and select it.`
      : "Choose Add assignments and select the Analytics Hub jobs' managed identity.";
  const steps = [
    `In the Microsoft Entra admin center, open Roles & admins and choose ${AGENT_ROLE}: ${ENTRA_ROLES_URL}`,
    select,
    'Choose Add. With Privileged Identity Management, make it an active, permanent assignment.',
  ];
  const { servicePrincipalId, appId } = config.app ?? {};
  const command = azure
    ? out?.identityPrincipalId && globalReaderCommand(out.identityPrincipalId)
    : (servicePrincipalId || appId) && globalReaderCommand(servicePrincipalId, appId);
  return [
    {
      admin: 'role-admin',
      label: AGENT_ROLE,
      text: `${forLoad(c, globalReaderWhat())}${numberedLines(steps)}${command ? `\n  Or in Azure Cloud Shell (Bash):\n  ${command}` : ''}`,
      after: [
        'Once the role applies, the next load collects Copilot Studio agents. Until then, it reports them as "Not collected: permission missing".',
        `${REPAIR}: it finds the role and stops asking.`,
      ],
    },
  ];
}

/**
 * Admin consent for the Fabric app's Microsoft Graph permissions, when this run couldn't grant it. The audit
 * history loads once it's granted.
 * @param {InstallConfig} config
 * @param {DoneOptions} opts
 * @returns {Ask[]}
 */
function consentDone(config, opts) {
  if (config.target === 'azure' || opts.consented !== false) return [];
  const days = opts.backfillDays ?? config.history?.days ?? 30;
  const runNow = RUN_NOW_DAYS.includes(days) ? `, or open the installer again, set Audit history to "Reload the last ${days} days of audit history" and choose Run now` : '';
  return [{ ...fabricConsentAsk(config), label: 'Admin consent', after: [`Then load the audit history: run "${commandLine(`run --backfill-days ${days}`)}"${runNow}.`] }];
}

/**
 * The Entra admin center's steps that revoke some of an app's admin consent.
 * @param {string} name
 * @param {string} appId
 */
const revokeConsentSteps = (name, appId) => [
  `In the Microsoft Entra admin center, go to Entra ID > Enterprise apps > All applications, search for ${appId} and open "${name}".`,
  'Choose Permissions, then the Admin consent tab.',
  'For each of these permissions, choose … (More options) next to it, then Revoke permission, and confirm.',
];

/**
 * The Graph application permissions Analytics Hub no longer uses that the Fabric app still has. For an app the
 * installer made, those the run couldn't take off its API permissions, for an app admin or one of its owners, and
 * those whose admin consent it couldn't take back, for a role admin: the record keeps them until a run finds them
 * gone. For an app you brought, which the installer leaves alone, an optional ask to take back the consent this run
 * read, noting that its owner or an app admin takes them off its API permissions.
 * @param {InstallConfig} config
 * @param {DoneOptions} opts
 * @returns {Ask[]}
 */
function retiredAppDone(config, opts) {
  const app = config.app;
  if (config.target === 'azure' || !app?.appId) return [];
  const name = app.displayName ?? APP_NAME;
  const which = `the app registration "${name}" (client ID ${app.appId})`;
  const page = apiPermissionsUrl(app.appId);
  const consentAfter = `${REPAIR}: it checks the app's admin consent again, and stops listing these once they're gone.`;
  /** @param {string[]} names */
  const takeBack = (names) => `take back admin consent for these Microsoft Graph application permissions of ${which}, as Analytics Hub no longer uses them: ${names.join(', ')}.`;
  if (app.existing !== false) {
    const brought = opts.broughtRetired ?? [];
    if (!brought.length) return [];
    return [
      {
        admin: 'role-admin',
        optional: true,
        label: 'Admin consent to take back',
        text: `Optional: ${takeBack(brought)}${numberedLines(revokeConsentSteps(name, app.appId))}`,
        note:
          'The installer leaves an app you brought as it is, in case something else uses these permissions: send this only if nothing does. ' +
          `Taking them off the app's API permissions too needs one of its owners, an Application Administrator or a Cloud Application Administrator: ${page}`,
        after: [consentAfter],
      },
    ];
  }
  /** @type {Ask[]} */
  const asks = [];
  if (app.retiredPermissions?.length) {
    asks.push({
      admin: 'app-admin',
      who: APP_OWNER_ADMIN,
      label: 'API permissions to remove',
      text:
        `Remove these Microsoft Graph application permissions from ${which}, as Analytics Hub no longer uses them: ${app.retiredPermissions.join(', ')}.` +
        numberedLines([`Open its API permissions page: ${page}`, 'For each of them, choose … (More options) next to it, then Remove permission, and confirm.']),
      after: [`${REPAIR}: it checks the app's API permissions again, and stops listing these once they're gone.`],
    });
  }
  if (app.retiredConsent?.length) {
    asks.push({
      admin: 'role-admin',
      label: 'Admin consent to take back',
      text: `${capitalise(takeBack(app.retiredConsent))}${numberedLines(revokeConsentSteps(name, app.appId))}`,
      after: [consentAfter],
    });
  }
  return asks;
}

/**
 * The SharePoint sites the Azure drop folder left while the jobs had read on them, or a grant of it was waiting for an
 * admin: an optional ask each, for a SharePoint Administrator to take that read back. Removing a site permission isn't
 * supported with delegated permissions, so the installer can't, and the commands run from an app-only PnP connection.
 * Each stays until you say it's done, or the drop folder moves back to its site.
 * @param {InstallConfig} config
 * @returns {Ask[]}
 */
function retiredDropsDone(config) {
  const az = config.target === 'azure' ? config.azure : undefined;
  return (az?.retiredDrops ?? []).map((d) => {
    const appId = d.appId ?? az?.outputs?.identityClientId;
    const identity = appId ? String(appId) : `"${az?.namePrefix ?? 'vlens'} jobs"`;
    const commands = [
      `Get-PnPAzureADAppSitePermission -Site ${d.siteUrl} -AppIdentity ${identity}`,
      `Revoke-PnPAzureADAppSitePermission -Site ${d.siteUrl} -PermissionId <the Id it shows>`,
    ];
    return /** @type {Ask} */ ({
      admin: 'sharepoint-admin',
      kind: 'drop-site-revoke',
      optional: true,
      label: 'Drop site access to take back',
      text:
        `Optional: take the Analytics Hub jobs' read off ${d.siteUrl}, the SharePoint site their drop folder was on, as they no longer read it. ` +
        "Removing a site permission isn't supported with delegated permissions, so run these in PnP PowerShell connected app-only, as an app with the " +
        "Sites.FullControl.All application permission. The first shows the permission's Id: put it in the second. If the first shows nothing, there's nothing to remove." +
        `${PNP_SHELL}${commands.join('\n  ')}`,
      after: [
        "Run the installer again without --yes and choose Repair or change. At the end, when it asks whether a SharePoint Administrator has taken the jobs' read " +
          'off the old drop site, choose "Yes, it\'s done".',
      ],
    });
  });
}

/**
 * The Azure AI roles are given on Fabric whenever the consumption module has a subscription to read, and on Azure when
 * it reads Azure AI through the API too. Pay-as-you-go subscriptions are only tried once Azure AI has access.
 * @param {InstallConfig} config
 */
const azureAiOn = (config) =>
  !!config.modules?.consumption &&
  !!config.consumption?.azureSubscriptionId &&
  (config.target !== 'azure' || (config.azure?.sampleData !== true && config.dataSources?.azureAi === 'api'));

/**
 * The roles that let the load read Azure AI costs and metrics, until the record says it has them.
 * @param {AskContext} c
 * @returns {Ask[]}
 */
function azureAiDone(c) {
  const { config } = c;
  const cc = config.consumption;
  if (!azureAiOn(config) || cc?.azureAccess) return [];
  const sub = /** @type {string} */ (cc.azureSubscriptionId);
  const names = AZURE_AI_ROLES.map((r) => r.name);
  const principal = loadObjectId(config);
  const where = cc.azureSubscriptionName ? `${cc.azureSubscriptionName} (${sub})` : sub;
  return [
    {
      admin: 'azure-owner',
      label: 'Azure AI costs and metrics',
      text:
        forLoad(c, `the ${andList(names)} roles on the Azure subscription ${where}, so Analytics Hub can read Azure AI costs and metrics.`) +
        (principal ? `${CLOUD_SHELL}${names.map((n) => roleAssignmentCommand(principal, n, `/subscriptions/${sub}`)).join('\n  ')}` : ''),
      after: [`${REPAIR_ASKS} "It already has these roles". Until then, Azure AI is left out of the pipeline.`],
    },
  ];
}

/**
 * Cost Management Reader on each pay-as-you-go subscription the record doesn't have access to. They're tried only after
 * Azure AI has access, so after a refusal there, none of them was.
 * @param {AskContext} c
 * @returns {Ask[]}
 */
function paygDone(c) {
  const { config } = c;
  if (!azureAiOn(config)) return [];
  const principal = loadObjectId(config);
  return (config.consumption?.paygSubscriptions ?? [])
    .filter((p) => !p.access)
    .map((p) => {
      const scope = `/subscriptions/${p.subscriptionId}`;
      const where = p.name ? `${p.name} (${p.subscriptionId})` : p.subscriptionId;
      return /** @type {Ask} */ ({
        admin: 'azure-owner',
        label: 'Pay-as-you-go costs',
        text:
          forLoad(c, `the Cost Management Reader role on the Azure subscription ${where}, so Analytics Hub can read its Copilot pay-as-you-go costs.`) +
          (principal ? `${CLOUD_SHELL}${roleAssignmentCommand(principal, 'Cost Management Reader', scope)}` : ''),
        after: [
          `${REPAIR_ASKS} "It already has this role" for each pay-as-you-go subscription. Until then, the subscription's Copilot pay-as-you-go costs are left out.`,
        ],
      });
    });
}

/**
 * Reader for Foundry on the scope Resource Graph reads, until the record says the load has it.
 * @param {AskContext} c
 * @returns {Ask[]}
 */
function foundryDone(c) {
  const { config } = c;
  const rg = config.resourceGraph;
  const azure = config.target === 'azure';
  if (!resourceGraphOn(config) || (azure && config.azure?.sampleData === true) || rg?.foundry === false) return [];
  if (azure ? rg?.azureAccess : rg?.access) return [];
  return [
    {
      admin: 'azure-owner',
      label: RG_FOUNDRY,
      text: foundryText(c),
      after: [`${REPAIR_ASKS} "It already has access". Until then, the load reports Foundry as not readable.`],
    },
  ];
}

/**
 * User names in the Microsoft 365 usage reports, for a Global Administrator, unless you're one: then it's your card.
 * @param {InstallConfig} config
 * @param {DoneOptions} opts
 * @returns {Ask[]}
 */
function namesDone(config, opts) {
  const names = namesWanted(config, opts.dataCheck);
  if (!names || opts.globalAdmin) return [];
  return [
    {
      admin: 'global-admin',
      label: 'Concealed names',
      text:
        `Show user names in the Microsoft 365 usage reports. ${CONCEALED_NAMES_WHY}${names.unsure ? " If the reports already show names, there's nothing to do." : ''}` +
        `${numberedLines(CONCEALED_NAMES_STEPS)}\n  Microsoft 365 admin center: ${M365_ADMIN_URL}`,
      after: [CONCEALED_NAMES_AFTER],
    },
  ];
}

/**
 * The emailed product feedback export the Fabric feedback flow saves, for a Microsoft 365 admin.
 * @param {InstallConfig} config
 * @param {DoneOptions} opts
 * @returns {Ask[]}
 */
function feedbackDone(config, opts) {
  if (config.target === 'azure' || !flowsWanted(config).includes('feedback')) return [];
  const flow = FLOW_NAMES.feedback;
  const steps = [
    `In the Microsoft 365 admin center, open Health > Product feedback: ${FEEDBACK_EXPORT_URL}`,
    `Choose Export and schedule it to be emailed to ${opts.from ?? 'the mailbox the flow reads'}, with the subject "${FEEDBACK_SUBJECT}".`,
  ];
  return [
    {
      admin: 'm365-admin',
      label: 'Product feedback export',
      text:
        'Schedule the Microsoft 365 product feedback export for Analytics Hub. A flow saves it when it arrives by email.' +
        `${numberedLines(steps)}\n  The subject must be exactly "${FEEDBACK_SUBJECT}", so the flow picks it up.`,
      note: `If the ${flow} flow's Outlook connection signs in as another mailbox, change the address to that one before you send it.`,
      after: [`Once the ${flow} flow is signed in and on, it saves the CSV files attached to each export email, and the next load reads them.`],
    },
  ];
}

/**
 * The Viva Insights query a Dataflow reads Cowork credits from, rather than an uploaded export. Optional, and Fabric
 * only: Azure reads Cowork credits from the export.
 * @param {InstallConfig} config
 * @returns {Ask[]}
 */
function vivaDone(config) {
  const cc = config.consumption;
  if (config.target === 'azure' || !config.modules?.consumption || config.dataSources?.coworkCredits !== 'csv') return [];
  if (isVivaId(cc?.vivaPartition) && isVivaId(cc?.vivaQuery)) return [];
  const steps = [
    'In Viva Insights > Create analysis > Create custom query, choose Consumption query and keep the preselected credit metrics.',
    'Turn on Auto-refresh, and run it.',
    'In Analysis results, choose the link icon next to it and copy the partition ID and the query ID.',
  ];
  return [
    {
      admin: 'viva',
      optional: true,
      label: 'Cowork credits query',
      text:
        'Set up a Viva Insights query for Analytics Hub, which reads Copilot Cowork credits from it every day.' +
        `${numberedLines(steps)}\n  Then send me the partition ID and the query ID. They look like 00000000-0000-0000-0000-000000000000.\n  Guide: ${DATAFLOW_GUIDE}`,
      note: 'With it, a Dataflow reads Cowork credits on every run, rather than someone uploading the Consumption Dashboard export.',
      after: ['Run the installer again and choose Connected (Dataflow) for Cowork credits, with the two IDs.'],
      back: VIVA_BACK,
    },
  ];
}

/**
 * Whether audit logging is on in Microsoft Purview, because something found audit records: this run's data check, or
 * else the last one the Lakehouse holds, loaded or left out some, or the last audit check's search found some.
 * @param {InstallConfig} config
 * @param {DoneOptions['dataCheck']} dataCheck
 */
const auditRecordsFound = (config, dataCheck) =>
  Number(dataCheck?.tables?.audit?.rows ?? 0) > 0 ||
  Number(dataCheck?.auditExcluded?.parsed ?? 0) > 0 ||
  ['records', 'no-copilot'].includes(config.auditCheck?.result ?? '');

/**
 * The asks of the rows preflight and the flows' check showed in this run that a finished install doesn't settle: audit
 * logging in Microsoft Purview until something finds audit records, Power Automate Premium for the flows' owner, the data
 * policy until every flow is on, and the Fabric tenant settings the install record doesn't prove are on, as settingsLeft
 * recomputes them. A finished install settles every other row's ask, or the record's own asks above ask for it.
 * @param {AskContext} c
 * @param {DoneOptions} opts
 * @returns {Ask[]}
 */
function carriedDone(c, opts) {
  const { config } = c;
  const rows = opts.carried ?? [];
  /** @type {AskContext} */
  const cc = { ...c, status: (id) => rows.find((r) => r.id === id)?.status, ppApi: false };
  const flows = flowsWanted(config);
  const off = flows.filter((k) => !flowConnected(config, k) || !!config.uploads?.flowFiles?.[k]);
  const update = commandLine('update');
  return rows
    .filter((it) => needsSomeoneElse(it, cc))
    .flatMap((it) => {
      const asks = () => ROW_ASKS[it.id]?.(it, cc) ?? [];
      /** @param {Ask[]} these @param {string[]} after */
      const carry = (these, after) => these.map((a) => ({ label: it.label, ...a, ...(after.length ? { after } : {}) }));
      switch (it.id) {
        case 'consent-role':
        case 'audit-ingestion': {
          if (auditRecordsFound(config, opts.dataCheck)) return [];
          // Azure runs no live audit search to test it with.
          const test = config.target === 'azure' ? [] : [`If they turned it on, new records take from 60 minutes to 24 hours to appear. Then run "${commandLine('check-audit')}" to test it.`];
          return carry(asks().filter((a) => a.label === PURVIEW_LABEL), test);
        }
        case 'power-automate-premium':
          return flows.length ? carry(asks(), off.length ? [`Run "${update}": it turns on each flow that's off, once its connections are signed in.`] : []) : [];
        case 'data-policy':
          return off.length ? carry(asks(), [`Run "${update}": it saves any flow the policy turned down, and turns on each flow that's off once its connections are signed in.`]) : [];
        case 'tenant-settings': {
          // Only when preflight asked: settings you could read, you turn on yourself.
          if (!asks().length) return [];
          const left = settingsLeft(config);
          if (!left.settings.length) return [];
          const xmla = left.xmla
            ? [`Apply org-scoped access: run "${commandLine('access')}", choose "Org-scoped access: who sees which orgs", then "Apply now". Until then, people outside the workspace see nothing.`]
            : [];
          const after = [
            ...(left.create ? [`${REPAIR}: it creates what the install couldn't.`] : []),
            ...(left.app ? [`Run "${commandLine('deploy-app')}" to deploy the Analytics Hub app.`] : []),
            ...xmla,
          ];
          return [...carry([settingsAsk(left.settings)], after), ...(left.xmla ? carry([xmlaAsk()], xmla) : [])];
        }
        default:
          return [];
      }
    });
}

/**
 * What's left for admins at the end of an install or Repair: one request per admin, in the order of ADMINS, from the
 * install record and this run rather than your roles. Each asks for everything that admin does, once, as a message
 * signed by `from`, with notes for you before you send it and what you do once it's done. Of the rows preflight and the
 * flows' check showed in this run, `carried`, only the asks a finished install doesn't settle are asked for again
 * (carriedDone): by the end, the rest were met, let through, or asked for from the record. A request per `who` when
 * asks name one, such as each environment's System Administrator.
 * @param {InstallConfig} config
 * @param {DoneOptions} [opts]
 * @returns {AdminRequest[]}
 */
export function doneRequests(config, opts = {}) {
  const azure = config.target === 'azure';
  const actions = azure ? config.azure?.status?.pendingAdminActions ?? [] : [];
  const roles = azure ? pendingGraphRoles(config.azure?.graphRoles) : [];
  const retired = azure ? config.azure?.graphRoles?.retired ?? [] : [];
  /** @type {AskContext} */
  const c = {
    config,
    status: () => undefined,
    ppApi: false,
    pendingConsent: actions.some((a) => a.startsWith(CONSENT_PENDING)),
    pendingTeams: actions.some((a) => a.startsWith(`${TEAMS_APP_PENDING}: `)),
  };
  const pending = pendingAsks(actions, roles, retired, [], c).map((a) => {
    const done = PENDING_DONE[a.kind ?? 'other'] ?? PENDING_DONE.other;
    return { ...a, label: done.label, after: [done.after] };
  });
  const asks = placeConsent([
    ...globalReaderDone(c),
    ...consentDone(config, opts),
    ...retiredAppDone(config, opts),
    ...pending,
    ...retiredDropsDone(config),
    ...azureAiDone(c),
    ...paygDone(c),
    ...foundryDone(c),
    ...namesDone(config, opts),
    ...feedbackDone(config, opts),
    ...vivaDone(config),
    ...carriedDone(c, opts),
    ...(opts.transcripts ?? []),
    ...(opts.vault ?? []),
  ]);
  return requestsFor(asks, opts.from, true);
}

/**
 * One request per admin from their asks, in the order of ADMINS, and one per `who` when asks name one. Each asks for
 * everything that admin does, once, as a message signed by `from`, with notes for you before you send it, what you do
 * once it's done, and what the admin sends back.
 * @param {Ask[]} asks
 * @param {string | undefined} from
 * @param {boolean} installed  The install has finished, as at its end; else it's under way.
 * @returns {AdminRequest[]}
 */
export function requestsFor(asks, from, installed) {
  return /** @type {AdminKey[]} */ (Object.keys(ADMINS)).flatMap((admin) => {
    const mine = asks.filter((a) => a.admin === admin);
    return [...new Set(mine.map((a) => a.who ?? ADMINS[admin]))].map((who) => {
      const these = mine.filter((a) => (a.who ?? ADMINS[admin]) === who);
      const texts = [...new Set(these.map((a) => a.text))];
      const notes = [...new Set(these.flatMap((a) => (a.note ? [a.note] : [])))];
      const after = [...new Set(these.flatMap((a) => a.after ?? []))];
      const back = [...new Set(these.flatMap((a) => (a.back ? [a.back] : [])))];
      const intro = `${installed ? 'I\'ve installed' : 'I\'m installing'} Analytics Hub, and I need your help with ${texts.length === 1 ? 'this' : 'these'}:`;
      return /** @type {AdminRequest} */ ({
        admin,
        who,
        rows: [...new Set(these.map((a) => a.label ?? PENDING_LABEL))],
        asks: texts,
        message: letter([intro, '', ...texts.map((t) => `- ${t}`)], from),
        ...(these.every((a) => a.optional) ? { optional: true } : {}),
        ...(notes.length ? { notes } : {}),
        ...(after.length ? { after } : {}),
        ...(back.length ? { back } : {}),
      });
    });
  });
}
