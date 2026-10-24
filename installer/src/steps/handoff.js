// @ts-check
/**
 * "Copy a request for your admin": for the prerequisites someone else has to do, a message to copy and send,
 * one per admin, asking for everything that admin does. It builds text only: it writes no files, and puts no
 * client secrets, keys, tokens, passwords or sign-in codes in a request.
 */
import { apiPermissionsUrl } from '../clients/graph.js';
import { secretMode } from '../config.js';
import { ppApiWanted, preflightVerdict, settingsToConfirm } from '../prereqs.js';
import { AUDIT_ROLE, PURVIEW_AUDIT_URL } from './audit-check.js';
import { AZURE_APPS } from './azure/apps.js';
import { MANAGE_APPS_URL, TEAMS_APP_PENDING } from './azure/teams-catalog.js';
import { flowsWanted, ppApiSigner } from './flows.js';
import { letter } from './next-steps.js';

/** @typedef {import('../prereqs.js').Prereq} Prereq */
/** @typedef {import('../prereqs.js').PrereqStatus} PrereqStatus */
/** @typedef {import('../config.js').InstallConfig} InstallConfig */

/** Who each request goes to, in the order they're shown: the least role that does what it asks. */
export const ADMINS = {
  'app-admin': 'An Application Administrator or Cloud Application Administrator',
  'role-admin': 'A Privileged Role Administrator or Global Administrator',
  'fabric-admin': 'A Fabric administrator',
  'capacity-admin': 'A Fabric capacity admin',
  compliance: 'A Compliance Administrator',
  'power-platform': 'A Power Platform administrator',
  teams: 'A Teams Administrator',
  'azure-owner': 'An Azure Owner or User Access Administrator',
  viva: 'An Insights Analyst',
  licence: 'Your licence admin',
  other: 'An admin',
};

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
 */
/**
 * @typedef {object} Ask
 * @property {AdminKey} admin
 * @property {string} text
 * @property {string} [label]  The prerequisite it's for. The row's own label when absent.
 * @property {boolean} [consent]  Approves the Azure web app's delegated permissions, which an admin can do with another ask.
 * @property {boolean} [coversConsent]  Approves those permissions too, so no separate ask is needed.
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
const TENANT_SETTINGS_URL = 'https://learn.microsoft.com/fabric/admin/tenant-settings-index';
/** In the tenant settings row when only a Fabric administrator could read them. */
const SETTINGS_UNREAD = ' to confirm these are on for you';
const XMLA_UNREAD = 'XMLA endpoint must also be Read Write';
const WEB_CONSENT = 'the Analytics Hub web app\'s delegated permissions (Power BI and Microsoft Graph)';
const RG_AGENTS = 'Copilot Studio agents';
const RG_FOUNDRY = 'Foundry resources';

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
 * The Microsoft Graph roles an Azure install couldn't give the jobs' managed identity, each once: a role can be
 * listed more than once.
 * @param {InstallConfig} config
 */
const pendingGraphRoles = (config) => {
  const g = config.azure?.graphRoles;
  const assigned = new Set(g?.assigned ?? []);
  return [...new Set(g?.pending ?? [])].filter((r) => !assigned.has(r));
};

/**
 * @param {InstallConfig} config
 * @param {string[]} roles
 */
const graphRolesText = (config, roles) => {
  const id = config.azure?.outputs?.identityPrincipalId;
  return `Give the Analytics Hub jobs' managed identity${id ? ` (object ID ${id})` : ''} these Microsoft Graph application permissions: ${roles.join(', ')}.`;
};

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
      const pack = config.app?.adminPack ? ` (${fileName(config.app.adminPack)})` : '';
      return [{ admin: 'app-admin', text: `Register the app Analytics Hub uses to collect data, in Microsoft Entra. I'll send you the installer's admin pack${pack}, which says how, and what to send back.` }];
    }
    const script = config.azure?.adminScript;
    if (script) {
      return [
        {
          admin: 'app-admin',
          coversConsent: true,
          text: `Run the script in ${fileName(script)}, which I'll send you, in Azure Cloud Shell (Bash). It creates Analytics Hub's app registrations and approves ${WEB_CONSENT}. It makes no secrets.`,
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
      const pending = pendingGraphRoles(config);
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
  'fabric-capacity': () => [
    { admin: 'capacity-admin', text: 'Make me a contributor on a Fabric capacity (F2 or larger) for Analytics Hub\'s workspace, or an Admin or Member of a workspace that\'s already on one.' },
  ],
  'azure-rbac': (it, c) => {
    const { config } = c;
    const azure = config.target === 'azure';
    const subId = config.azure?.subscriptionId ?? config.keyVault?.subscriptionId;
    const sub = subId ? `the subscription ${subId}` : 'a subscription I can use';
    if (azure && config.azure?.resourceGroupMode === 'existing' && config.azure.resourceGroup) {
      return [{ admin: 'azure-owner', text: `Give me Contributor and a condition-limited Role Based Access Control Administrator (or Owner) on the resource group "${config.azure.resourceGroup}" in ${sub}.` }];
    }
    const least = azure ? ' Or, for least privilege, create the resource group and give me Contributor and a condition-limited Role Based Access Control Administrator on just that group (docs/AZURE-LEAST-PRIVILEGE.md).' : '';
    return [{ admin: 'azure-owner', text: `Give me Owner, or Contributor and User Access Administrator, on ${sub}.${least}` }];
  },
  'key-vault': (it, c) => {
    const kv = c.config.keyVault;
    // No Key Vault is the default on Fabric until one is chosen, and a vault admin who adds the secret has their own steps.
    if (secretMode(c.config) !== 'keyvault' || !(kv.id || kv.name || kv.uri || kv.subscriptionId)) return [];
    if (kv.id) return [{ admin: 'azure-owner', text: `Give me Key Vault Secrets Officer on the Key Vault "${kv.name ?? kv.id.split('/').pop()}", which Analytics Hub uses.` }];
    return [{ admin: 'azure-owner', text: 'Give me Contributor on an Azure subscription, so I can create a Key Vault for Analytics Hub, or Key Vault Secrets User on an existing vault.' }];
  },
  'viva-analyst': () => [
    {
      admin: 'viva',
      text: 'Create the Copilot Cowork credits query in Viva Insights (Consumption query, the preselected credit metrics, Auto-refresh on), and send me its partition ID and query ID.',
    },
  ],
  'defender-licence': null,
  'tenant-settings': (it, c) => {
    // Readable settings mean you're a Fabric administrator, and can turn them on yourself.
    if (!it.detail.includes(SETTINGS_UNREAD)) return [];
    return [
      {
        admin: 'fabric-admin',
        text: `Confirm these Fabric tenant settings are on for me, or for a group I'm in, and turn on any that are off: ${settingsToConfirm(c.config).join('; ')}. They're in Fabric under Admin portal > Tenant settings: ${TENANT_SETTINGS_URL}`,
      },
      ...(it.detail.includes(XMLA_UNREAD)
        ? [/** @type {Ask} */ ({ admin: 'capacity-admin', text: 'Set the XMLA endpoint to Read Write on the Fabric capacity Analytics Hub\'s workspace uses.' })]
        : []),
    ];
  },
  'resource-graph': (it) => {
    const missing = it.rows?.length ? it.rows.filter((r) => r.status === 'missing').map((r) => r.name) : [RG_AGENTS, RG_FOUNDRY];
    return [
      ...(missing.includes(RG_AGENTS)
        ? [/** @type {Ask} */ ({ admin: 'role-admin', text: 'Give me Global Reader, Power Platform Administrator or AI Administrator in Entra, so I can see Copilot Studio agents in Azure Resource Graph.' })]
        : []),
      ...(missing.includes(RG_FOUNDRY)
        ? [/** @type {Ask} */ ({ admin: 'azure-owner', text: 'Give me Reader on the management group, or the tenant root group, so I can see Foundry resources in Azure Resource Graph.' })]
        : []),
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
 * identity is still waiting for, and the actions it lists. Known actions are matched by how they start; any other
 * goes to "An admin" as it is.
 * @param {string[]} actions
 * @param {string[]} roles  Graph roles, from pendingGraphRoles.
 * @param {Prereq[]} rows
 * @param {AskContext} c
 * @returns {Ask[]}
 */
function pendingAsks(actions, roles, rows, c) {
  const labelFor = (/** @type {string} */ id) => rows.find((r) => r.id === id)?.label ?? PENDING_LABEL;
  // The audit row asks for the same roles while it's a hand-off; otherwise they're only pending.
  const audit = rows.find((r) => r.id === 'audit-ingestion' && r.status === 'handoff');
  /** @type {Ask[]} */
  const graph = roles.length ? [{ admin: 'role-admin', label: audit?.label ?? PENDING_LABEL, text: graphRolesText(c.config, roles) }] : [];
  return [
    ...graph,
    ...actions.flatMap((action) => {
      if (action.startsWith(CONSENT_PENDING)) {
        if (settled(c.status('consent-role'))) return [];
        return [{ admin: /** @type {AdminKey} */ ('app-admin'), consent: true, label: labelFor('consent-role'), text: `Approve ${WEB_CONSENT}: open ${action.slice(CONSENT_PENDING.length).trim()} and select "Grant admin consent".` }];
      }
      if (action.startsWith(`${TEAMS_APP_PENDING}: `)) {
        if (settled(c.status('teams-admin'))) return [];
        return [{ admin: /** @type {AdminKey} */ ('teams'), label: labelFor('teams-admin'), text: teamsAsk(action) }];
      }
      if (action.includes(' as an owner of "')) {
        return [{ admin: /** @type {AdminKey} */ ('app-admin'), label: PENDING_LABEL, text: stop(action.startsWith(OWNER_PENDING) ? `Add ${action.slice(OWNER_PENDING.length)}` : action) }];
      }
      return [{ admin: /** @type {AdminKey} */ ('other'), label: PENDING_LABEL, text: action }];
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
  const roles = pendingOn ? pendingGraphRoles(config) : [];
  const pendingConsent = actions.some((a) => a.startsWith(CONSENT_PENDING)) && !settled(status('consent-role'));
  const pendingTeams = actions.some((a) => a.startsWith(`${TEAMS_APP_PENDING}: `)) && !settled(status('teams-admin'));
  /** @type {AskContext} */
  const c = { config, status, ppApi: ppApiWanted(config), pendingConsent, pendingTeams };
  const fromRows = rows
    .filter((it) => (!it.optional || counted.has(it.id)) && needsSomeoneElse(it, c))
    .flatMap((it) => (ROW_ASKS[it.id]?.(it, c) ?? []).map((a) => ({ label: it.label, ...a })));
  const asks = placeConsent([...fromRows, ...pendingAsks(actions, roles, rows, c)]);
  return /** @type {AdminKey[]} */ (Object.keys(ADMINS)).flatMap((admin) => {
    const mine = asks.filter((a) => a.admin === admin);
    if (!mine.length) return [];
    const texts = [...new Set(mine.map((a) => a.text))];
    const intro = `I'm installing Analytics Hub, and I need your help with ${texts.length === 1 ? 'this' : 'these'}:`;
    return [
      {
        admin,
        who: ADMINS[admin],
        rows: [...new Set(mine.map((a) => a.label ?? PENDING_LABEL))],
        asks: texts,
        message: letter([intro, '', ...texts.map((t) => `- ${t}`)], opts.from),
      },
    ];
  });
}
