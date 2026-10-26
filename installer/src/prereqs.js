// @ts-check
/**
 * Read-only checks of what the signed-in user has and lacks for an install: roles, licences,
 * capacities, Azure access and environments. Nothing here writes anything, and each check
 * reports "unknown" rather than failing when it can't be read.
 */
import { allowsAction, ROLES } from './clients/azure.js';
import { orgUrl } from './clients/dataverse.js';
import { CONSENT_ROLES, CREATE_APPS_ROLES, DELEGATED_CONSENT_ROLES, FABRIC_ADMIN_ROLE, INSIGHTS_ANALYST_ROLE, POWER_PLATFORM_ADMIN_ROLE, TEAMS_PUBLISH_ROLES } from './clients/graph.js';
import { secretMode } from './config.js';
import { commandLine } from './launch.js';
import { copilotLicences } from './seats.js';
import { AUDIT_CHECK_FAILS, AUDIT_CHECK_LABELS, AUDIT_ROLE, PURVIEW_AUDIT_URL } from './steps/audit-check.js';
import { adoptableApps, AZURE_APPS, appsRecorded, webAppGranted } from './steps/azure/apps.js';
import { dataPolicyAsk, FLOW_NAMES, flowsWanted, INVENTORY_SIGNER, PP_API_SIGNER, ppApiFlows, PREMIUM_OWNER } from './steps/flows.js';
import { canWriteSecrets } from './steps/identity.js';
import { WORKSPACE_ROLE } from './steps/fabric.js';
import { blockedSettings, CREATE_WORKSPACES_FIX, createWorkspacesAccess, myGroups, POWER_BI_SETTINGS, settingLabel, usableCapacity, workspacesOnCapacity } from './steps/plan.js';
import { rlsOn } from './transform/access.js';

/**
 * "handoff" is optional admin work someone else does while you carry on: it never stops an install,
 * and never counts as missing or as needing attention.
 * @typedef {'met' | 'missing' | 'eligible' | 'unknown' | 'handoff'} PrereqStatus
 */
/**
 * @typedef {object} Prereq
 * @property {string} id
 * @property {string} label
 * @property {PrereqStatus} status
 * @property {string} detail  What was found.
 * @property {string} neededFor
 * @property {string} howTo  How to get it when it's missing; for a hand-off, who does it.
 * @property {string} [who]  Who confirms or does it when that's someone else, such as the data policy's Power Platform administrator.
 * @property {boolean} [optional]  Only some features need it.
 * @property {{ name: string, status: PrereqStatus, detail?: string }[]} [rows]  Per subscription or environment.
 * @property {boolean} [assignsDirectoryRoles]  On the consent-role row: false when it's met without a Global
 *   Administrator or Privileged Role Administrator, which on Azure an Application Administrator can do.
 */
/**
 * What install preflight checked and showed, so the rows for flows chosen after it show once, before anything is created.
 * @typedef {object} PreflightSeen
 * @property {Prereq[] | null} items  From preflightChecks; null when the checks couldn't run.
 * @property {Map<string, string>} shown  Each row shown so far, by ID, as asShown reads it.
 */

/** Subscriptions and environments checked one by one; more than this would slow the home screen down. */
export const MAX_SUBSCRIPTIONS = 10;
const MAX_ENVIRONMENTS = 20;

/** Power BI Pro and Premium Per User service plans. */
const PRO_PLANS = { BI_AZURE_P2: 'Power BI Pro', BI_AZURE_P3: 'Power BI Premium Per User' };

/** Service plans that give Defender advanced hunting over devices, or Cloud Discovery. */
export const DEFENDER_PLANS = { WINDEFATP: 'Defender for Endpoint P2', MTP: 'Microsoft Defender XDR', ADALLOM_S_STANDALONE: 'Defender for Cloud Apps' };

/**
 * Service plans that let a user run flows with premium connectors, such as "HTTP with Microsoft Entra ID".
 * Names from Microsoft Learn's "Product names and service plan identifiers for licensing".
 */
export const PREMIUM_FLOW_PLANS = {
  POWER_AUTOMATE_ATTENDED_RPA: 'Power Automate Premium',
  POWER_AUTOMATE_ATTENDED_RPA_GCC: 'Power Automate Premium',
  FLOW_PER_USER: 'Power Automate per user',
  FLOW_PER_USER_GCC: 'Power Automate per user',
  FLOW_P2: 'Power Automate Plan 2',
  FLOW_P1_GOV: 'Power Automate Plan 1',
};

export { COPILOT_PLAN } from './seats.js';

const PIM_URL = 'https://entra.microsoft.com/#view/Microsoft_Azure_PIMCommon/ActivationMenuBlade/~/aadmigratedroles';
const ADMIN_CONSENT_URL = 'https://learn.microsoft.com/entra/identity/enterprise-apps/grant-admin-consent';
const TENANT_SETTINGS_URL = 'https://learn.microsoft.com/fabric/admin/tenant-settings-index';
const FABRIC_TRIAL_URL = 'https://learn.microsoft.com/fabric/fundamentals/fabric-trial';
const VIVA_ROLES_URL = 'https://learn.microsoft.com/viva/insights/advanced/setup-maint/assign-user-roles';
/** Teams admin center > Teams apps > Manage apps, as in steps/azure/teams-catalog.js. */
const TEAMS_MANAGE_APPS_URL = 'https://admin.teams.microsoft.com/policies/manage-apps';
const XMLA_SETTING = 'Allow XMLA endpoints and Analyze in Excel with on-premises semantic models';
/** Ends an Entra role row's detail when the roles you could activate through PIM can't be read. */
const PIM_UNREAD = ' Couldn\'t check for roles you could activate yourself.';
/**
 * A flow's connection signs in whenever the flow runs, and PIM ends each activation after at most 24 hours, as the
 * organisation sets it per role.
 */
const PIM_FLOW_SIGNER =
  ' The flows\' Power Platform API connection needs the role active whenever the flows run, and an activation lasts at most 24 hours, as your organisation sets it. Have someone with the role assigned permanently sign in to that connection.';
/**
 * The installer doesn't read data policies (DLP): Learn documents the admin center, PowerShell and the Power
 * Platform for Admins connector for that, but no public REST API. So the data policy row is always "couldn't check".
 */
const DATA_POLICY_UNREAD =
  'Couldn\'t check: the installer can\'t read data policies (DLP). If one blocks the flows\' connectors, or puts them in different data groups, Power Automate won\'t save the flows or turn them on.';

/**
 * The data policy row for the flows chosen: always "couldn't check", naming what a Power Platform administrator
 * confirms. It isn't tagged optional, since whatever the policy says applies to the flows, but it never blocks and
 * never counts as missing.
 * @param {import('./config.js').InstallConfig} config
 * @returns {Prereq}
 */
export function dataPolicyPrereq(config) {
  let howTo = 'Ask a Power Platform administrator to confirm that the flows\' connectors are allowed, and in the same data group, in the environment the flows go in.';
  try {
    howTo = dataPolicyAsk(config) || howTo;
  } catch {
    // Without the flow definitions, the general ask.
  }
  return {
    id: 'data-policy',
    label: 'Data policy',
    status: 'unknown',
    detail: DATA_POLICY_UNREAD,
    neededFor: `Only the Power Automate flows: ${flowsWanted(config).map((k) => FLOW_NAMES[k]).join(', ')}.`,
    howTo,
    who: 'A Power Platform administrator',
  };
}

/**
 * The Power Platform Administrator row, warning that a role you can only activate won't keep the flows' Power
 * Platform API connection signed in.
 * @param {Prereq} it
 * @param {import('./config.js').InstallConfig} config
 * @returns {Prereq}
 */
function withFlowSigner(it, config) {
  if (it.status !== 'eligible' || !ppApiWanted(config) || it.detail.endsWith(PIM_FLOW_SIGNER)) return it;
  return { ...it, detail: `${it.detail}${PIM_FLOW_SIGNER}` };
}

/**
 * The Fabric tenant settings this install needs, by their names in the admin portal, for someone who
 * can't read them to ask a Fabric administrator to confirm.
 * @param {import('./config.js').InstallConfig} config
 * @returns {string[]}
 */
export function settingsToConfirm(config) {
  const azure = config.target === 'azure';
  // Only while there's no workspace: the installer then creates one, unless you choose an existing one.
  const workspace = azure ? config.azure?.powerBi?.workspaceId : config.fabric?.workspaceId;
  return [
    ...(workspace ? [] : [`"Create workspaces" (only to create a new workspace, not to use an existing one you're an ${WORKSPACE_ROLE} of)`]),
    ...(azure ? [] : ['"Users can create Fabric items"']),
    // As blockedSettings is asked below: the app's settings on Fabric, and on Azure the one its web app needs; the reports' always.
    ...POWER_BI_SETTINGS.filter((s) => !azure || !s.app || s.web).map((s) => settingLabel(s)),
    ...(rlsOn(config) ? [`"${XMLA_SETTING}"`] : []),
  ];
}

/**
 * Whether the signed-in user has Global Administrator or Privileged Role Administrator active, so they
 * can assign directory roles (and grant admin consent) themselves.
 * @param {import('./install.js').Apis} api
 */
export async function canAssignDirectoryRoles(api) {
  return (await api.graph.myDirectoryRoles()).some((r) => Object.hasOwn(CONSENT_ROLES, r.roleTemplateId));
}

const AZURE_ROLE_NAMES = {
  [ROLES.owner]: 'Owner',
  [ROLES.contributor]: 'Contributor',
  [ROLES.userAccessAdministrator]: 'User Access Administrator',
  [ROLES.rbacAdministrator]: 'Role Based Access Control Administrator',
};

/** @param {any} err */
const why = (err) => {
  const status = err?.status ? `${err.status} ` : '';
  const msg = String(err?.message ?? err ?? '').split('\n')[0].slice(0, 160);
  return `${status}${msg}`.trim();
};

/** Last segment of an ARM role definition ID. @param {string} [id] */
const roleGuid = (id) => String(id ?? '').split('/').pop()?.toLowerCase() ?? '';

/**
 * What an ARM permission set lets the user do in a subscription.
 * @param {{ actions?: string[], notActions?: string[] }[]} perms
 */
export function azureAccess(perms) {
  return {
    create: allowsAction(perms, 'Microsoft.Resources/subscriptions/resourceGroups/write') && allowsAction(perms, 'Microsoft.Resources/deployments/write'),
    assign: allowsAction(perms, 'Microsoft.Authorization/roleAssignments/write'),
  };
}

/** The resource group row's verdict, leading the Azure access detail. */
const RESOURCE_GROUP_VERDICT = { met: 'enough to install there.', eligible: 'activate your role first.', missing: 'not enough to install there.', unknown: 'couldn\'t check.' };

/**
 * What the user can do in the existing resource group they picked. Deploying and assigning roles there
 * is enough to install, whether it comes from the subscription or from roles on just that group.
 * @param {import('./install.js').Apis} api
 * @param {string} subscriptionId
 * @param {string} resourceGroup
 * @param {string[]} ids  The user's ID, then their groups'.
 * @returns {Promise<{ name: string, status: PrereqStatus, detail: string }>}
 */
async function resourceGroupAccess(api, subscriptionId, resourceGroup, ids) {
  const scope = `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}`;
  const name = `Resource group ${resourceGroup}`;
  /** @param {{ properties: { roleDefinitionId: string } }[]} list */
  const roleNames = (list) => [...new Set(list.map((a) => AZURE_ROLE_NAMES[roleGuid(a.properties.roleDefinitionId)]).filter(Boolean))];
  try {
    const perms = await api.arm.permissions(scope);
    const deploy = allowsAction(perms, 'Microsoft.Resources/deployments/write');
    const assign = allowsAction(perms, 'Microsoft.Authorization/roleAssignments/write');
    const names = roleNames(await api.arm.myRoleAssignments(scope, ids).catch(() => []));
    const has = names.length ? ` (${names.join(', ')})` : '';
    if (deploy && assign) return { name, status: 'met', detail: `Can deploy and assign roles in this resource group${has}` };
    const eligNames = roleNames(await api.arm.myEligibleRoles(scope, ids).catch(() => []));
    if (eligNames.length) return { name, status: 'eligible', detail: `Not active yet: ${eligNames.join(', ')}. You can activate it in Privileged Identity Management.` };
    const lacks = deploy
      ? 'Can deploy here but not assign roles (no Role Based Access Control Administrator or User Access Administrator)'
      : assign ? 'Can assign roles here but not deploy (no Contributor)' : 'Can\'t deploy or assign roles in this resource group';
    return { name, status: 'missing', detail: `${lacks}${has}` };
  } catch (err) {
    return { name, status: 'unknown', detail: `Couldn't check: ${why(err)}` };
  }
}

/** How long one check may take in install and update preflight before it counts as "couldn't check". */
export const PREFLIGHT_CHECK_TIMEOUT_MS = 15_000;

/** @param {number} ms */
const duration = (ms) => (ms < 1000 ? `${ms} ms` : `${Math.round(ms / 1000)} s`);

/**
 * @param {{ api: import('./install.js').Apis, user: import('./install.js').User, config: import('./config.js').InstallConfig }} ctx
 * @param {{ timeoutMs?: number }} [opts]  timeoutMs: a check still running after this shows as "couldn't check".
 * @returns {Promise<Prereq[]>}
 */
export async function checkPrereqs(ctx, opts = {}) {
  const { api, user, config } = ctx;
  const { timeoutMs } = opts;
  const azure = config.target === 'azure';

  const roles = api.graph.myDirectoryRoles();
  const eligible = api.graph.myEligibleRoles(user.id);
  const groups = api.graph.myGroupIds().catch(() => /** @type {string[]} */ ([]));
  const subs = api.arm.listSubscriptions().then((s) => s.filter((x) => x.state === 'Enabled'));
  // Unhandled until awaited by a check; these keep a rejected lookup from crashing the process.
  for (const p of [roles, eligible, subs]) p.catch(() => {});
  /** @type {ReturnType<typeof api.graph.myLicenseDetails> | undefined} */
  let licenceList;
  const licences = () => (licenceList ??= api.graph.myLicenseDetails());
  /** @type {ReturnType<typeof api.graph.subscribedSkus> | undefined} */
  let skuList;
  const skus = () => (skuList ??= api.graph.subscribedSkus());
  /** Service plans assigned to the signed-in user and provisioned, by name. */
  const myPlans = async () => (await licences()).flatMap((l) => l.servicePlans ?? []).filter((p) => p.provisioningStatus === 'Success').map((p) => p.servicePlanName);

  /**
   * @param {Omit<Prereq, 'status' | 'detail'>} base
   * @param {() => Promise<Pick<Prereq, 'status' | 'detail'> & Partial<Prereq>>} fn
   * @returns {Promise<Prereq>}
   */
  const guard = async (base, fn) => {
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    try {
      const check = fn();
      const result = timeoutMs
        ? await Promise.race([
            check,
            /** @type {Promise<never>} */ (new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error(`it took longer than ${duration(timeoutMs)}`)), timeoutMs);
            })),
          ])
        : await check;
      return { ...base, ...result };
    } catch (err) {
      return { ...base, status: 'unknown', detail: `Couldn't check: ${why(err)}` };
    } finally {
      clearTimeout(timer);
    }
  };

  /**
   * Whether the user holds an Entra role: active, one they can activate through PIM, or missing. With `handoff`, a
   * role the user lacks is a hand-off instead: someone else does that work while the install carries on.
   * @param {Record<string, string>} wanted  Template ID to name.
   * @param {{ detail: string, howTo?: string }} [handoff]  What to say instead of "missing", and who does it.
   * @returns {Promise<Pick<Prereq, 'status' | 'detail'> & Partial<Prereq>>}
   */
  const roleCheck = async (wanted, handoff) => {
    const active = (await roles).filter((r) => wanted[r.roleTemplateId]);
    if (active.length) return { status: 'met', detail: `Active: ${[...new Set(active.map((r) => wanted[r.roleTemplateId]))].join(', ')}` };
    /** @type {{ roleDefinitionId: string }[] | null} */
    let elig = null;
    try {
      elig = (await eligible).filter((r) => wanted[r.roleDefinitionId]);
    } catch {
      // Reading PIM eligibility needs its own permission; without it, only active roles are known.
    }
    if (elig?.length) {
      return { status: 'eligible', detail: `Not active yet: ${[...new Set(elig.map((r) => wanted[r.roleDefinitionId]))].join(', ')}. You can activate this role in Entra (Privileged Identity Management): ${PIM_URL} Then check again.` };
    }
    const unread = elig ? '' : PIM_UNREAD;
    if (handoff) return { status: 'handoff', detail: `${handoff.detail}${unread}`, ...(handoff.howTo ? { howTo: handoff.howTo } : {}) };
    return { status: 'missing', detail: `You don't have ${Object.values(wanted).join(' or ')} active.${unread}` };
  };

  /**
   * An Entra role, as roleCheck finds it.
   * @param {Omit<Prereq, 'status' | 'detail'>} base
   * @param {Record<string, string>} wanted  Template ID to name.
   * @param {{ detail: string, howTo?: string }} [handoff]
   */
  const entraRole = (base, wanted, handoff) => guard(base, () => roleCheck(wanted, handoff));

  /** Owner, or Contributor plus User Access Administrator, per subscription; and in the existing resource group picked, which least privilege covers. */
  const azureRbac = guard(
    {
      id: 'azure-rbac',
      label: 'Azure: Owner, or Contributor and User Access Administrator',
      neededFor: azure
        ? 'The Azure target creates its resource group, SQL database, container jobs and role assignments.'
        : 'Creating the Key Vault for the app secret, and the Azure role assignments for credit consumption.',
      howTo: `Ask a subscription owner for Owner, or for Contributor and User Access Administrator, on the subscription you'll use.${azure ? ' Or, for least privilege, ask your Azure admin to create the resource group and give you Contributor and a condition-limited Role Based Access Control Administrator on just that group (docs/AZURE-LEAST-PRIVILEGE.md).' : ''}`,
      optional: !azure,
    },
    async () => {
      const az = config.azure;
      const rgName = azure && az?.resourceGroupMode === 'existing' && az.subscriptionId ? az.resourceGroup : undefined;
      const ids = [user.id, ...(await groups)];
      const rgRow = rgName ? await resourceGroupAccess(api, /** @type {string} */ (az?.subscriptionId), rgName, ids) : undefined;
      /** @param {string} rest */
      const withGroup = (rest) => (rgRow ? `Resource group ${rgName}: ${RESOURCE_GROUP_VERDICT[rgRow.status]}${rest ? ` Subscription-wide, ${rest}` : ''}` : rest);
      const list = rgRow ? await subs.catch(() => []) : await subs;
      if (!list.length) {
        if (rgRow) return { status: rgRow.status, detail: withGroup(''), rows: [rgRow] };
        return {
          status: 'missing',
          detail: 'No enabled Azure subscription you can see.',
          ...(azure ? {} : { howTo: 'Ask for Contributor (and User Access Administrator for credit consumption) on a subscription. Without one, choose no Key Vault (--no-key-vault): the app secret goes in the notebooks, where anyone with a role in the workspace can read it.' }),
        };
      }
      const first = config.azure?.subscriptionId ?? config.keyVault.subscriptionId;
      const ordered = [...list].sort((a, b) => Number(b.subscriptionId === first) - Number(a.subscriptionId === first));
      const rows = await Promise.all(ordered.slice(0, MAX_SUBSCRIPTIONS).map(async (s) => {
        const scope = `/subscriptions/${s.subscriptionId}`;
        const name = s.displayName ?? s.subscriptionId;
        try {
          const access = azureAccess(await api.arm.permissions(scope));
          const assigned = await api.arm.myRoleAssignments(scope, ids).catch(() => []);
          const names = [...new Set(assigned.map((a) => AZURE_ROLE_NAMES[roleGuid(a.properties.roleDefinitionId)]).filter(Boolean))];
          const has = names.length ? ` (${names.join(', ')})` : '';
          if (access.create && access.assign) return { name, status: /** @type {PrereqStatus} */ ('met'), detail: `Can create resources and assign roles${has}` };
          const elig = await api.arm.myEligibleRoles(scope, ids).catch(() => []);
          const eligNames = [...new Set(elig.map((a) => AZURE_ROLE_NAMES[roleGuid(a.properties.roleDefinitionId)]).filter(Boolean))];
          if (eligNames.length) return { name, status: /** @type {PrereqStatus} */ ('eligible'), detail: `Not active yet: ${eligNames.join(', ')}. You can activate it in Privileged Identity Management.` };
          const lacks = access.create ? 'Can create resources but not assign roles (no User Access Administrator)' : access.assign ? 'Can assign roles but not create resources (no Contributor)' : 'Can\'t create resources or assign roles';
          return { name, status: /** @type {PrereqStatus} */ ('missing'), detail: `${lacks}${has}` };
        } catch (err) {
          return { name, status: /** @type {PrereqStatus} */ ('unknown'), detail: `Couldn't check: ${why(err)}` };
        }
      }));
      const status = /** @type {PrereqStatus} */ (['met', 'eligible', 'missing', 'unknown'].find((st) => rows.some((r) => r.status === st)) ?? 'unknown');
      const met = rows.filter((r) => r.status === 'met').length;
      const more = list.length > MAX_SUBSCRIPTIONS ? ` Checked the first ${MAX_SUBSCRIPTIONS} of ${list.length}.` : '';
      const detail = withGroup(`${met} of ${rows.length} ${rows.length === 1 ? 'subscription' : 'subscriptions'} give you this.${more}`);
      // The resource group picked decides, unless it couldn't be checked.
      if (rgRow) return { status: rgRow.status === 'unknown' ? status : rgRow.status, detail, rows: [rgRow, ...rows] };
      return { status, detail, rows };
    },
  );

  /** System Administrator in at least one environment; the Power Platform Administrator row reads it too. */
  const environments = guard(
    {
      id: 'environments',
      label: 'Power Platform environments, System Administrator in each',
      neededFor: 'Agent Evaluator reads Copilot Studio transcripts from Dataverse, and the flows are created in an environment.',
      howTo: 'Ask an environment admin for the System Administrator security role, or a Power Platform Administrator to add the app for you.',
      optional: true,
    },
    async () => {
      const envs = (await api.discovery.instances()).filter((i) => i.Url && (i.State ?? 0) === 0);
      if (!envs.length) return { status: 'missing', detail: 'No Dataverse environments you can see.' };
      const rows = envs.slice(0, MAX_ENVIRONMENTS).map((i) => ({
        name: i.FriendlyName ?? i.UniqueName ?? i.Url,
        status: /** @type {PrereqStatus} */ (i.IsUserSysAdmin === true ? 'met' : i.IsUserSysAdmin === false ? 'missing' : 'unknown'),
        detail: i.IsUserSysAdmin === true ? 'System Administrator' : i.IsUserSysAdmin === false ? 'Not a System Administrator' : 'Couldn\'t tell',
      }));
      const admin = rows.filter((r) => r.status === 'met').length;
      const more = envs.length > MAX_ENVIRONMENTS ? ` Showing the first ${MAX_ENVIRONMENTS} of ${envs.length}.` : '';
      const status = /** @type {PrereqStatus} */ (admin ? 'met' : rows.some((r) => r.status === 'unknown') ? 'unknown' : 'missing');
      return { status, detail: `System Administrator in ${admin} of ${rows.length} ${rows.length === 1 ? 'environment' : 'environments'}.${more}`, rows };
    },
  );

  /** @type {Promise<Prereq>[]} */
  const checks = [
    azure
      ? guard(
          {
            id: 'consent-role',
            label: 'Application Administrator, Cloud Application Administrator, Privileged Role Administrator or Global Administrator',
            neededFor: 'Approving the web app\'s delegated permissions (Power BI and Microsoft Graph), so people can use the web app.',
            howTo: 'An Application Administrator, Cloud Application Administrator, Privileged Role Administrator or Global Administrator approves the web app\'s delegated permissions (Power BI and Microsoft Graph) from the consent link. The admin script grants them too.',
            optional: true,
          },
          async () => {
            const it = await roleCheck(DELEGATED_CONSENT_ROLES, { detail: 'You don\'t need this yourself: after the deploy, the installer gives you a consent link to send, and carries on. People can use the web app once it\'s approved.' });
            // An Application Administrator meets this row, but can't assign directory roles as the web session's other checks need.
            const assignsDirectoryRoles = (await roles.catch(() => [])).some((r) => Object.hasOwn(CONSENT_ROLES, r.roleTemplateId));
            if (it.status !== 'met' && (await webAppGranted(api, config))) {
              return { status: 'met', detail: 'Already approved: the web app has its delegated permissions for everyone.', assignsDirectoryRoles };
            }
            return { ...it, assignsDirectoryRoles };
          },
        )
      : entraRole(
          {
            id: 'consent-role',
            label: 'Global Administrator or Privileged Role Administrator',
            neededFor: 'Granting admin consent for the app registration\'s Microsoft Graph permissions.',
            howTo: `A Privileged Role Administrator or Global Administrator approves the app's Microsoft Graph permissions from the installer's consent link. An Application Administrator or Cloud Application Administrator can't: ${ADMIN_CONSENT_URL}`,
            optional: true,
          },
          CONSENT_ROLES,
          { detail: 'You don\'t need this yourself: the installer gives you an admin consent link to send, and carries on.' },
        ),
    entraRole(
      {
        id: 'fabric-admin',
        label: 'Fabric Administrator',
        neededFor: 'Reading the Fabric tenant settings the model, reports and app need, and turning on any that are off.',
        howTo: `A Fabric administrator confirms the settings under "Fabric tenant settings" are on, and turns on any that are off, in Fabric under Admin portal > Tenant settings: ${TENANT_SETTINGS_URL}`,
        optional: true,
      },
      { [FABRIC_ADMIN_ROLE]: 'Fabric Administrator' },
      { detail: 'You don\'t need this role yourself: a Fabric administrator turns on, or confirms, the tenant settings for you.' },
    ),
    entraRole(
      {
        id: 'power-platform-admin',
        label: 'Power Platform Administrator',
        neededFor: 'Adding the app to Power Platform environments for Agent Evaluator and the flows when you aren\'t a System Administrator there, and signing in to the flows\' Power Platform API connection.',
        howTo: 'Ask a Global Administrator for the Power Platform Administrator role, or be a System Administrator in each environment you use.',
        optional: true,
      },
      { [POWER_PLATFORM_ADMIN_ROLE]: 'Power Platform Administrator' },
    ).then(async (it) => {
      // A System Administrator in an environment makes the flows there; only their Power Platform API connection needs an admin to sign in.
      if (it.status === 'missing' && (await environments).status === 'met') {
        return {
          ...it,
          status: /** @type {PrereqStatus} */ ('handoff'),
          detail: 'You\'re a System Administrator in an environment, so you can make the flows there yourself. Only the flows\' Power Platform API connection needs an admin to sign in to it, and the installer gives you the steps to send them.',
          howTo: `With the Copilot Studio credits flow, that connection signs in as ${PP_API_SIGNER}. With only the agent inventory flow, it signs in as ${INVENTORY_SIGNER}.`,
        };
      }
      return withFlowSigner(it, config);
    }),
    ...(azure
      ? [
          entraRole(
            {
              id: 'teams-admin',
              label: 'Teams Administrator or Global Administrator',
              neededFor: 'Publishing the Teams app to your org\'s app catalog, so people find Analytics Hub in Teams, Outlook and the Microsoft 365 Copilot app.',
              howTo: `A Teams Administrator or Global Administrator uploads the Teams package in the Teams admin center, under Teams apps > Manage apps: ${TEAMS_MANAGE_APPS_URL}`,
              optional: true,
            },
            TEAMS_PUBLISH_ROLES,
            { detail: 'You don\'t need this yourself: the installer prints the steps for a Teams Administrator to upload the Teams package, and carries on.' },
          ),
        ]
      : []),
    guard(
      {
        id: 'register-apps',
        label: 'Register apps in Entra',
        neededFor: azure
          ? `Creating the two app registrations: "${AZURE_APPS[0].name}", for signing in to the web app, and "${AZURE_APPS[1].name}", for Power BI.`
          : 'Creating the app registration that collects the data.',
        howTo: azure
          ? 'Ask for the Application Administrator, Cloud Application Administrator or Application Developer role. Or, in the plan, choose \'Use the apps an admin created for me\' if an admin has made them, or \'An admin will create the apps for me\': the plan writes a script for an Application Administrator or Cloud Application Administrator, and stops before anything is deployed.'
          : 'Ask for the Application Administrator, Cloud Application Administrator or Application Developer role, use an app registration you already have, or get the admin pack for an admin to register it.',
      },
      async () => {
        if (azure && appsRecorded(config.azure)) {
          return { status: 'met', detail: `Uses the app registrations ${AZURE_APPS.map((a) => config.azure?.[a.key]?.clientId).join(' and ')}.` };
        }
        if (!azure && config.app.appId) return { status: 'met', detail: `Uses the app registration ${config.app.appId}.` };
        const admin = (await roles).find((x) => Object.hasOwn(CREATE_APPS_ROLES, x.roleTemplateId));
        if (admin) return { status: 'met', detail: `Your ${admin.displayName} role allows it.` };
        if (!azure) {
          return (await api.graph.usersCanRegisterApps())
            ? { status: 'met', detail: 'Users in this tenant can register apps.' }
            : { status: 'missing', detail: 'Users in this tenant can\'t register apps, and you have no app admin role.' };
        }
        /** @type {boolean | Error} */
        const users = await api.graph.usersCanRegisterApps().catch((/** @type {Error} */ err) => err);
        if (users === true) return { status: 'met', detail: 'Users in this tenant can register apps.' };
        // Apps an admin created for you, which the plan adopts: one of each name that no install has finished.
        const left = AZURE_APPS.filter((a) => !config.azure?.[a.key]?.clientId);
        const found = await Promise.all(left.map((a) => adoptableApps(api, a.name).catch(() => [])));
        if (found.every((f) => f.length === 1)) {
          return { status: 'met', detail: `An admin created ${left.length === 1 ? 'the app' : 'the apps'} for you: ${found.map((f) => `"${f[0].displayName}" (${f[0].appId})`).join(' and ')}. The plan uses ${left.length === 1 ? 'it' : 'them'}.` };
        }
        if (users instanceof Error) throw users;
        // An admin made only one of the two: the plan uses it, and asks only about the other.
        const used = found.flatMap((f) => (f.length === 1 ? [`"${f[0].displayName}" (${f[0].appId})`] : []));
        const needed = left.filter((_, k) => !found[k].length).map((a) => `"${a.name}"`);
        if (used.length && needed.length) {
          return { status: 'missing', detail: `An admin created ${used[0]} for you, and the plan uses it. ${needed[0]} still needs creating: the plan offers to have an admin create it.` };
        }
        return { status: 'missing', detail: `Users in this tenant can't register apps, and you have no app admin role. The plan offers to have an admin create ${needed.length === 1 ? needed[0] : 'the two apps'} for you.` };
      },
    ),
    guard(
      {
        id: 'audit-ingestion',
        label: `Audit log access for Copilot interactions (${AUDIT_ROLE})`,
        neededFor: 'Loading Copilot interactions from the audit log, which most pages are built on. Without admin consent, or with audit logging off in Purview, the audit load finds 0 records.',
        howTo: azure
          ? `After the deploy, a Privileged Role Administrator or Global Administrator gives the jobs' managed identity its Microsoft Graph roles, including ${AUDIT_ROLE}; the installer lists them. A Compliance Administrator checks audit logging is on in Microsoft Purview > Audit: ${PURVIEW_AUDIT_URL} After install, run ${commandLine('check-audit')} to test it.`
          : `A Global Administrator or Privileged Role Administrator grants admin consent for ${AUDIT_ROLE} (the installer gives you a link). A Compliance Administrator checks audit logging is on in Microsoft Purview > Audit: ${PURVIEW_AUDIT_URL} After install, run ${commandLine('check-audit')} to test it.`,
      },
      async () => {
        const last = config.auditCheck ? ` Last audit check (${config.auditCheck.at.slice(0, 10)}): ${AUDIT_CHECK_LABELS[config.auditCheck.result] ?? config.auditCheck.result}.` : '';
        if (azure) {
          const g = config.azure?.graphRoles;
          if (g?.assigned?.includes(AUDIT_ROLE)) return { status: 'met', detail: `The jobs' managed identity has it.${last}` };
          if (g?.pending?.includes(AUDIT_ROLE)) return { status: 'handoff', detail: `The jobs' managed identity doesn't have it yet, so the audit load finds 0 records until a Privileged Role Administrator or Global Administrator grants it.${last}` };
        } else if (config.app.servicePrincipalId) {
          const graphSp = await api.graph.graphServicePrincipal();
          const role = graphSp.appRoles?.find((/** @type {{ value: string }} */ r) => r.value === AUDIT_ROLE);
          const assigned = await api.graph.appRoleAssignments(config.app.servicePrincipalId);
          if (role && assigned.some((/** @type {{ resourceId: string, appRoleId: string }} */ a) => a.resourceId === graphSp.id && a.appRoleId === role.id)) {
            return { status: AUDIT_CHECK_FAILS.includes(/** @type {any} */ (config.auditCheck?.result)) ? 'missing' : 'met', detail: `Admin consent is in place for the app ${config.app.appId}.${last}` };
          }
        }
        const admin = (await roles).find((x) => CONSENT_ROLES[/** @type {keyof typeof CONSENT_ROLES} */ (x.roleTemplateId)]);
        if (admin) return { status: 'met', detail: `Not granted yet, but your ${admin.displayName} role lets the installer grant it.${last}` };
        return azure
          ? { status: 'handoff', detail: `Not granted yet, so the audit load finds 0 records until a Privileged Role Administrator or Global Administrator grants it to the jobs' managed identity.${last}` }
          : { status: 'handoff', detail: `Not granted yet, so the audit load finds 0 records until a Privileged Role Administrator or Global Administrator approves it.${last}` };
      },
    ),
    guard(
      {
        id: 'power-bi-pro',
        label: 'Power BI Pro or Premium Per User licence',
        neededFor: azure
          ? 'Publishing the semantic model and reports to the Power BI workspace.'
          : 'Publishing and sharing the semantic model, reports and Analytics Hub app.',
        howTo: 'Ask your licence admin to assign you Power BI Pro (included in Microsoft 365 E5) or Premium Per User.',
      },
      async () => {
        const found = (await myPlans())
          .map((name) => PRO_PLANS[/** @type {keyof typeof PRO_PLANS} */ (name)])
          .filter(Boolean);
        return found.length
          ? { status: 'met', detail: [...new Set(found)].join(', ') }
          : { status: 'missing', detail: 'No Power BI Pro or Premium Per User licence is assigned to you.' };
      },
    ),
    guard(
      {
        id: 'copilot-licences',
        label: 'Microsoft 365 Copilot licences in the tenant',
        neededFor: 'The Copilot usage and licence pages. Without Microsoft 365 Copilot licences assigned, only Copilot Chat usage shows.',
        howTo: 'Nothing to do for the install: once Microsoft 365 Copilot licences are assigned, their usage shows after the next load.',
        optional: true,
      },
      async () => {
        const licences = copilotLicences(await skus());
        const names = licences.names.join(', ');
        const { assigned } = licences;
        if (assigned) return { status: 'met', detail: `${assigned} assigned (${names}).` };
        return licences.found
          ? { status: 'missing', detail: `The tenant has ${names}, but none are assigned yet.` }
          : { status: 'missing', detail: 'No Microsoft 365 Copilot licences found in this tenant.' };
      },
    ),
    guard(
      {
        id: 'power-automate-premium',
        label: 'Power Automate Premium licence',
        neededFor: `Only the Power Automate flows: Copilot Studio credits, the agent inventory and the product feedback export, which use premium connectors. ${PREMIUM_OWNER}`,
        howTo: 'Ask your licence admin for Power Automate Premium for yourself, as the flows\' owner. Without it, upload the CSV exports instead.',
        optional: true,
      },
      async () => {
        const found = (await myPlans())
          .map((name) => PREMIUM_FLOW_PLANS[/** @type {keyof typeof PREMIUM_FLOW_PLANS} */ (name)])
          .filter(Boolean);
        return found.length
          ? { status: 'met', detail: [...new Set(found)].join(', ') }
          : { status: 'missing', detail: 'No Power Automate Premium licence is assigned to you, and you\'ll own the flows. Ask your licence admin for one, or upload the CSV exports instead.' };
      },
    ),
    ...(flowsWanted(config).length ? [Promise.resolve(dataPolicyPrereq(config))] : []),
    ...(azure
      ? []
      : [
          guard(
            {
              id: 'fabric-capacity',
              label: 'Active Fabric capacity',
              neededFor: 'The Analytics Hub workspace, Lakehouse, notebooks and pipeline run on it.',
              howTo: `To create the workspace on a capacity, or move one onto it, you need to be that capacity's admin or contributor. Ask its capacity admin, or start a Fabric trial: ${FABRIC_TRIAL_URL} Or ask to be an Admin or Member of a workspace that's already on a capacity.`,
            },
            async () => {
              const listed = await api.fabric.listCapacities();
              const caps = listed.filter(usableCapacity);
              if (!caps.length) {
                const onCapacity = await workspacesOnCapacity(api, config, listed).catch(() => []);
                if (!onCapacity.length) return { status: 'missing', detail: 'No active Fabric capacity (F2 or larger, or a trial) you can create a workspace on, and no workspace you\'re an Admin or Member of that\'s already on one.' };
                const names = onCapacity.slice(0, 3).map((w) => `"${w.displayName ?? w.id}"`);
                return {
                  status: 'met',
                  detail: `No capacity you can create a workspace on, but you can use a workspace that's already on one: ${names.join(', ')}${onCapacity.length > 3 ? ', ...' : ''}. The installer can't create a new workspace, and can't check that capacity's size or state.`,
                };
              }
              const names = caps.slice(0, 3).map((cap) => `${cap.displayName ?? cap.id}${cap.sku ? ` (${cap.sku})` : ''}`);
              return { status: 'met', detail: `${caps.length} available: ${names.join(', ')}${caps.length > 3 ? ', ...' : ''}` };
            },
          ),
        ]),
    azureRbac,
    ...(azure
      ? []
      : [
          guard(
            {
              id: 'key-vault',
              label: 'Key Vault access for the app secret',
              neededFor: 'Keeping the app registration\'s client secret in Azure Key Vault (--key-vault), where the notebooks read it. Optional: by default on Fabric, the secret goes in the notebooks instead.',
              howTo: 'Ask for Contributor on a subscription to create a vault, or Key Vault Secrets User on an existing one (a vault admin then adds the secret). Or keep the default, no Key Vault (--no-key-vault): anyone with a role in the workspace can then read the secret.',
              optional: true,
            },
            async () => {
              if (secretMode(config) === 'notebook') return { status: 'met', detail: 'No Key Vault: the secret is kept in the notebooks, so no vault is needed.' };
              const kv = config.keyVault;
              if (kv.id) {
                const vault = await api.arm.getVault(kv.id);
                return (await canWriteSecrets(/** @type {any} */ ({ api, user }), vault))
                  ? { status: 'met', detail: `You can write secrets to ${vault.name ?? kv.name}.` }
                  : { status: 'missing', detail: `You can't write secrets to ${vault.name ?? kv.name}. A vault admin can add the secret for you, or give you Key Vault Secrets Officer.` };
              }
              const rbac = await azureRbac;
              if (rbac.rows?.some((r) => /^Can create resources/.test(r.detail ?? ''))) return { status: 'met', detail: 'You can create a new vault in one of your subscriptions.' };
              if (rbac.status === 'unknown') return { status: 'unknown', detail: 'Couldn\'t check your Azure access.' };
              return { status: rbac.status === 'eligible' ? 'eligible' : 'missing', detail: 'You can\'t create a vault in any subscription you can see. You can use an existing vault you can read, or choose no Key Vault and keep the secret in the notebooks.' };
            },
          ),
        ]),
    environments,
    entraRole(
      {
        id: 'viva-analyst',
        label: 'Viva Insights analyst',
        neededFor: 'Only Copilot Cowork credits read straight from Viva Insights: someone with the Insights Analyst role creates the query the installer reads. You can add it later, and use the CSV export meanwhile.',
        howTo: `An Insights Analyst creates the Cowork credits query and sends you its partition and query IDs. Or a Global Administrator assigns you Insights Analyst in the Microsoft 365 admin center (Settings > Viva > Viva Insights, or Role assignments), or a Privileged Role Administrator does in Privileged Identity Management if your organisation uses it: ${VIVA_ROLES_URL}`,
        optional: true,
      },
      { [INSIGHTS_ANALYST_ROLE]: 'Insights Analyst' },
      { detail: 'You don\'t need it yourself: an Insights Analyst can create the Cowork credits query and share it with you. Only Cowork credits read from Viva Insights need it, and the CSV export works meanwhile.' },
    ),
    ...(config.modules.defender
      ? [
          guard(
            {
              id: 'defender-licence',
              label: 'Microsoft Defender for Endpoint P2 or Defender for Cloud Apps',
              neededFor: 'The Defender source: shadow AI on devices needs Defender for Endpoint P2, Cloud Discovery needs Defender for Cloud Apps.',
              howTo: 'Carry on without it: probes the tenant isn\'t licensed for are skipped, and the Shadow AI section says which.',
              optional: true,
            },
            async () => {
              const found = (await skus())
                .filter((s) => (s.capabilityStatus ?? 'Enabled') === 'Enabled')
                .flatMap((s) => s.servicePlans ?? [])
                .map((p) => DEFENDER_PLANS[/** @type {keyof typeof DEFENDER_PLANS} */ (p.servicePlanName)])
                .filter(Boolean);
              return found.length
                ? { status: 'met', detail: [...new Set(found)].join(', ') }
                : { status: 'missing', detail: 'No Defender for Endpoint P2, Defender XDR or Defender for Cloud Apps plan found in this tenant.' };
            },
          ),
        ]
      : []),
    guard(
      {
        id: 'tenant-settings',
        label: 'Fabric tenant settings',
        neededFor: azure
          ? 'Creating the Power BI workspace, the model\'s connection, the web app\'s queries and the reports\' custom visuals each need a tenant setting on.'
          : 'Creating the workspace and its items, the model\'s connection, the app\'s queries and the reports\' custom visuals each need a tenant setting on.',
        howTo: `A Fabric administrator turns them on, for everyone or for a group you're in, in Fabric under Admin portal > Tenant settings: ${TENANT_SETTINGS_URL}`,
      },
      async () => {
        /** @type {any[] | undefined} */
        let list;
        try {
          list = await api.fabric.tenantSettings();
        } catch {
          // Only Fabric administrators can read them.
        }
        // An empty list says nothing about them, so it's no more "on" than an unreadable one.
        if (!list?.length) {
          const xmla = rlsOn(config) ? ' The capacity\'s XMLA endpoint must also be Read Write, which a capacity admin sets.' : '';
          const why = list ? 'Fabric returned no tenant settings. Ask a Fabric administrator' : 'only a Fabric administrator can read tenant settings. Ask one';
          return {
            status: 'unknown',
            detail: `Couldn't check: ${why} to confirm these are on for you, or for a group you're in: ${settingsToConfirm(config).join('; ')}.${xmla}`,
          };
        }
        const byName = Object.fromEntries(list.map((s) => [s.settingName, s]));
        const off = blockedSettings(byName, { app: !azure, web: azure, reports: true });
        // Only while there's no workspace yet. An existing one you're an Admin or Member of works without it.
        const workspace = azure ? config.azure?.powerBi?.workspaceId : config.fabric?.workspaceId;
        const create = workspace ? undefined : await createWorkspacesAccess(list, myGroups(api));
        const offLine = off.length ? `Off: ${off.map((s) => settingLabel(s, byName[s.name]?.title)).join('; ')}.` : '';
        const existing = `Or use an existing workspace you're an ${WORKSPACE_ROLE} of.`;
        if (create?.status === 'missing') {
          return { status: 'missing', detail: [offLine, `${create.reason} ${CREATE_WORKSPACES_FIX} ${existing}`].filter(Boolean).join(' ') };
        }
        const unsure = create?.status === 'unknown' ? `Couldn't confirm "Create workspaces": ${create.reason} If it leaves you out, use an existing workspace you're an ${WORKSPACE_ROLE} of.` : '';
        if (off.length) return { status: 'missing', detail: [offLine, unsure].filter(Boolean).join(' ') };
        return unsure
          ? { status: 'unknown', detail: `The other settings Analytics Hub needs are on. ${unsure}` }
          : { status: 'met', detail: 'The settings Analytics Hub needs are on.' };
      },
    ),
    ...(config.dataSources?.resourceGraph === 'api' ? [resourceGraphPrereq(api, config, guard)] : []),
  ];
  return Promise.all(checks);
}

/**
 * Rows install and update preflight leave out even when not met: the Fabric capacity, which preflight
 * checks and stops on itself; and the Fabric administrator role, which the tenant settings row covers.
 */
const PREFLIGHT_HIDDEN = new Set(['fabric-capacity', 'fabric-admin']);

/**
 * Whether a flow this install makes signs in to the Power Platform API connection.
 * @param {import('./config.js').InstallConfig} config
 */
function ppApiWanted(config) {
  try {
    return ppApiFlows(config).length > 0;
  } catch {
    // Without the flow definitions, assume every flow but feedback's might.
    return flowsWanted(config).some((k) => k !== 'feedback');
  }
}

/**
 * What install and update preflight make of the checks: what stops an install before anything is
 * created, what to show and carry on with, what to hand off to someone else, and what to confirm with
 * someone because nobody can check it. Met rows, rows for features not chosen, and optional rows that
 * couldn't be checked are left out; the data policy row, which can never be checked, is one to confirm.
 * A row that couldn't be checked, or took too long, never blocks, and nor does a hand-off or a row to
 * confirm. An update never blocks: it's already installed.
 * @param {Prereq[]} items
 * @param {{ config: import('./config.js').InstallConfig, yes?: boolean, update?: boolean }} opts
 *   yes: --yes, so nobody is asked and a choice that can't work fails late.
 * @returns {{ block: Prereq[], warn: Prereq[], handoff: Prereq[], confirm: Prereq[] }}
 */
export function preflightVerdict(items, { config, yes = false, update = false }) {
  const azure = config.target === 'azure';
  const status = (/** @type {string} */ id) => items.find((it) => it.id === id)?.status;
  const flows = flowsWanted(config).length > 0;
  const environments = !!config.modules?.agentEvaluator || flows;
  /** Optional rows only matter for some choices. @type {Record<string, boolean>} */
  const relevant = {
    // Consent is still to grant: on a re-run that already has it, the role doesn't matter. On Azure the row is the web app's
    // delegated consent, which its own check covers, not the managed identity's audit role.
    'consent-role': azure || status('audit-ingestion') !== 'met',
    // As a hand-off, the role only signs in to the flows' Power Platform API connection. Only eligible, it would sign in
    // for a day at most, so it's worth a warning whenever that connection is wanted.
    'power-platform-admin':
      status('power-platform-admin') === 'handoff'
        ? ppApiWanted(config)
        : (environments && status('environments') !== 'met') || (status('power-platform-admin') === 'eligible' && ppApiWanted(config)),
    environments,
    'power-automate-premium': flows,
    'data-policy': flows,
    // On Fabric, Azure access is only for the Key Vault (its own row) and credit consumption.
    'azure-rbac': azure || !!config.modules?.consumption,
    // Only Cowork credits read from Viva Insights, which is Fabric only.
    'viva-analyst': !azure && !!config.modules?.consumption && config.dataSources?.coworkCredits === 'api',
  };
  /** @type {Prereq[]} */
  const block = [];
  /** @type {Prereq[]} */
  const warn = [];
  /** @type {Prereq[]} */
  const handoff = [];
  /** @type {Prereq[]} */
  const confirm = [];
  for (const it of items) {
    if (it.status === 'met' || PREFLIGHT_HIDDEN.has(it.id) || relevant[it.id] === false) continue;
    if (it.status === 'handoff') {
      handoff.push(it);
      continue;
    }
    // Nobody may need to do anything, so it's neither missing nor a hand-off: just something to confirm.
    if (it.id === 'data-policy') {
      confirm.push(it);
      continue;
    }
    if (it.status === 'unknown' && it.optional) continue;
    // Only a Fabric administrator can read them, so "couldn't check" is the usual answer: it only matters with a model.
    if (it.id === 'tenant-settings' && it.status === 'unknown' && !azure && !config.semanticModel?.enabled) continue;
    // Asked, the plan offers an app you already have or the admin pack. With --yes it would try to create one, and fail.
    // On Azure the plan has an admin create the two apps instead, and stops before anything is deployed.
    if (!update && yes && !azure && it.id === 'register-apps' && it.status === 'missing' && !config.app.appId && !config.app.adminPack) block.push(it);
    else warn.push(it);
  }
  return { block, warn, handoff, confirm };
}

/**
 * The hand-offs preflight shows. On Fabric the app's admin consent includes its audit log permission,
 * so that's one ask, not two. On Azure they're different asks: the web app's consent, and the jobs'
 * managed identity's Graph role.
 * @param {Prereq[]} handoff
 * @param {import('./config.js').InstallConfig} config
 * @returns {Prereq[]}
 */
function handoffsToShow(handoff, config) {
  const consent = handoff.find((it) => it.id === 'consent-role');
  const audit = handoff.find((it) => it.id === 'audit-ingestion');
  if (config.target === 'azure' || !consent || !audit) return handoff;
  return handoff
    .filter((it) => it !== audit)
    .map((it) => {
      if (it !== consent) return it;
      // The audit note follows the consent sentence it refers to; "couldn't check" stays last.
      const unread = it.detail.endsWith(PIM_UNREAD) ? PIM_UNREAD : '';
      return {
        ...it,
        detail: `${it.detail.slice(0, it.detail.length - unread.length)} That consent includes ${AUDIT_ROLE}: until it's approved, the audit load finds 0 records.${unread}`,
        howTo: `${it.howTo} A Compliance Administrator checks audit logging is on in Microsoft Purview > Audit: ${PURVIEW_AUDIT_URL} After install, run ${commandLine('check-audit')} to test it.`,
      };
    });
}

/**
 * The prerequisite checks in install and update preflight, run in parallel, each with a timeout.
 * Never rejects: when the checks can't run at all, there's nothing to show.
 * @param {{ api: import('./install.js').Apis, user: import('./install.js').User, config: import('./config.js').InstallConfig }} ctx
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<Prereq[] | null>}
 */
export async function preflightChecks(ctx, opts = {}) {
  try {
    return await checkPrereqs(ctx, { timeoutMs: opts.timeoutMs ?? PREFLIGHT_CHECK_TIMEOUT_MS });
  } catch {
    return null;
  }
}

/**
 * The flows' environment, as asShown keeps it, or '' before it's picked.
 * @param {import('./config.js').InstallConfig} config
 */
const flowEnvironmentKey = (config) => {
  const url = config.uploads?.flowEnvironment?.url;
  try {
    return url ? orgUrl(url) : '';
  } catch {
    return url ?? '';
  }
};

/**
 * How a row read when it was shown, so the same row isn't shown twice. Its how-to is left out, but the data
 * policy row keeps the environment its ask names, after a last "|".
 * @param {Prereq} it
 * @param {import('./config.js').InstallConfig} config
 */
const asShown = (it, config) => `${it.status}|${it.detail}|${it.neededFor}${it.id === 'data-policy' ? `|${flowEnvironmentKey(config)}` : ''}`;

/**
 * Whether a row reads as it did when it was shown. The data policy ask shown before the flows' environment was
 * picked still does once it names one, since that alone isn't news; naming another environment is.
 * @param {Prereq} it
 * @param {string | undefined} was  asShown when it was shown.
 * @param {string} now  asShown now.
 */
const asWhenShown = (it, was, now) => was === now || (it.id === 'data-policy' && was !== undefined && was.endsWith('|') && now.startsWith(was));

/**
 * Prints the rows that need attention, then the hand-offs, then the rows to confirm, each group with its line.
 * @param {import('./ui.js').Ui} ui
 * @param {{ shown: Prereq[], handoff: Prereq[], confirm: Prereq[] }} groups
 * @param {string} carry  Said once, after the first group's line: " The install carries on.", or nothing before a stop.
 */
function printPrereqGroups(ui, { shown, handoff, confirm }, carry) {
  if (shown.length) {
    const n = shown.length === 1 ? '1 prerequisite needs' : `${shown.length} prerequisites need`;
    ui.warn(`${n} attention.${carry}`);
    ui.prereqs(shown);
  }
  if (handoff.length) {
    const one = handoff.length === 1;
    // Said once: the attention line already says the install carries on.
    ui.info(`${one ? 'Hand-off' : 'Hand-offs'}: someone else does ${one ? 'this' : 'these'}.${shown.length ? '' : carry}`);
    ui.prereqs(handoff);
  }
  if (confirm.length) {
    ui.info(`To confirm: the installer can't check ${confirm.length === 1 ? 'this' : 'these'}.`);
    ui.prereqs(confirm);
  }
}

/**
 * Prints only what needs attention, then what to hand off to someone else, then what to confirm with
 * someone, before anything is created, and points to the full list. On install, stops when one is a
 * true blocker. Keeps what it checked and showed on `ctx`, for reportFlowPrereqs.
 * @param {{ ui: import('./ui.js').Ui, config: import('./config.js').InstallConfig, preflightSeen?: PreflightSeen }} ctx
 * @param {Prereq[] | null} items  From preflightChecks.
 * @param {{ update?: boolean }} [opts]
 * @returns {{ block: Prereq[], warn: Prereq[], handoff: Prereq[], confirm: Prereq[] }}
 */
export function reportPreflight(ctx, items, opts = {}) {
  const { ui, config } = ctx;
  const full = `Run "${commandLine('prereqs')}" for the full list.`;
  if (!items) {
    ctx.preflightSeen = { items: null, shown: new Map() };
    ui.note(`Couldn't check the prerequisites. ${full}`);
    return { block: [], warn: [], handoff: [], confirm: [] };
  }
  const verdict = preflightVerdict(items, { config, yes: ui.yes, update: opts.update });
  const handoff = handoffsToShow(verdict.handoff, config);
  const { confirm } = verdict;
  const shown = [...verdict.block, ...verdict.warn];
  ctx.preflightSeen = { items, shown: new Map([...shown, ...handoff, ...confirm].map((it) => [it.id, asShown(it, config)])) };
  if (!shown.length && !handoff.length && !confirm.length) {
    ui.ok('Prerequisites: nothing missing for what you chose');
    return { ...verdict, handoff };
  }
  if (!shown.length) ui.ok(handoff.length ? 'Prerequisites: you have what you need yourself' : 'Prerequisites: nothing missing for what you chose');
  printPrereqGroups(ui, { shown, handoff, confirm }, verdict.block.length ? '' : ` The ${opts.update ? 'update' : 'install'} carries on.`);
  ui.note(full);
  if (verdict.block.length) {
    ui.fail(`Stopped before creating anything: ${verdict.block.map((it) => it.label).join('; ')}.`);
    throw new Error(
      verdict.block.some((it) => it.id === 'register-apps')
        ? 'You can\'t register apps in this tenant and have no app admin role, so with --yes the installer can\'t create its app registration. ' +
            'Run it without --yes to choose an app registration you already have or get the admin pack for an admin, or ask for the Application Administrator or Cloud Application Administrator role.'
        : verdict.block.map((it) => it.howTo).join(' '),
    );
  }
  return { ...verdict, handoff };
}

/** The rows that depend on which flows are chosen. */
const FLOW_ROWS = ['power-platform-admin', 'power-automate-premium', 'environments', 'data-policy'];

/**
 * Once the flows and their environment are chosen, the rows for them that install preflight would have shown
 * had they been chosen then, each once: the Power Automate Premium licence, the Power Platform Administrator
 * role (with its PIM warning, or as a hand-off), the environments, and the data policy. In the terminal, a new
 * install checks the prerequisites before its plan asks about the flows. The data policy ask shows again only for
 * another environment than the one it named. Reads nothing from the tenant, and never stops the install. Without a
 * preflight, does nothing.
 * @param {{ ui: import('./ui.js').Ui, config: import('./config.js').InstallConfig, preflightSeen?: PreflightSeen }} ctx
 */
export function reportFlowPrereqs(ctx) {
  const { ui, config } = ctx;
  const seen = ctx.preflightSeen;
  if (!seen || !flowsWanted(config).length) return;
  const rows = [
    ...(seen.items ?? [])
      .filter((it) => FLOW_ROWS.includes(it.id) && it.id !== 'data-policy')
      .map((it) => (it.id === 'power-platform-admin' ? withFlowSigner(it, config) : it)),
    dataPolicyPrereq(config),
  ];
  const verdict = preflightVerdict(rows, { config, yes: ui.yes });
  const fresh = (/** @type {Prereq[]} */ list) => list.filter((it) => !asWhenShown(it, seen.shown.get(it.id), asShown(it, config)));
  const groups = { shown: fresh([...verdict.block, ...verdict.warn]), handoff: fresh(handoffsToShow(verdict.handoff, config)), confirm: fresh(verdict.confirm) };
  const printed = [...groups.shown, ...groups.handoff, ...groups.confirm];
  if (!printed.length) return;
  printPrereqGroups(ui, groups, ' The install carries on.');
  for (const it of printed) seen.shown.set(it.id, asShown(it, config));
}

const ARG_PROBES = {
  agents: { name: 'Copilot Studio agents', query: "PowerPlatformResources | where type =~ 'microsoft.copilotstudio/agents' | take 1" },
  foundry: { name: 'Foundry resources', query: "resources | where type in~ ('microsoft.cognitiveservices/accounts','microsoft.cognitiveservices/accounts/projects') | take 1" },
};

/**
 * What you can see in Resource Graph. The load runs as the app or the jobs' identity, which needs the
 * same roles, so this is a guide rather than proof.
 * @param {import('./install.js').Apis} api
 * @param {import('./config.js').InstallConfig} config
 * @param {(base: Omit<Prereq, 'status' | 'detail'>, fn: () => Promise<Pick<Prereq, 'status' | 'detail'> & Partial<Prereq>>) => Promise<Prereq>} guard
 */
function resourceGraphPrereq(api, config, guard) {
  const rg = config.resourceGraph;
  return guard(
    {
      id: 'resource-graph',
      label: 'Azure Resource Graph: agents and Foundry',
      neededFor: 'Agent configuration and Foundry resources. This checks what you can see; whoever runs the load needs the same.',
      howTo: 'For agents: Global Reader, Power Platform Administrator or AI Administrator in Entra. For Foundry: Reader on the management group, or the tenant root group.',
      optional: true,
    },
    async () => {
      const probes = [...(rg?.agents !== false ? [ARG_PROBES.agents] : []), ...(rg?.foundry !== false ? [ARG_PROBES.foundry] : [])];
      const rows = await Promise.all(
        probes.map(async (p) => {
          try {
            const found = (await api.arm.resourceGraph(p.query, rg?.managementGroup || undefined))?.data?.length ?? 0;
            return found
              ? { name: p.name, status: /** @type {PrereqStatus} */ ('met'), detail: 'You can see them.' }
              : { name: p.name, status: /** @type {PrereqStatus} */ ('unknown'), detail: 'None you can see: there may be none, or you lack the role.' };
          } catch (err) {
            const refused = [401, 403].includes(/** @type {any} */ (err)?.status);
            return { name: p.name, status: /** @type {PrereqStatus} */ (refused ? 'missing' : 'unknown'), detail: refused ? 'Refused: you lack the role.' : `Couldn't check: ${why(err)}` };
          }
        }),
      );
      const status = /** @type {PrereqStatus} */ (['missing', 'unknown', 'met'].find((st) => rows.some((r) => r.status === st)) ?? 'unknown');
      return { status, detail: rows.map((r) => `${r.name}: ${r.detail}`).join(' '), rows };
    },
  );
}
