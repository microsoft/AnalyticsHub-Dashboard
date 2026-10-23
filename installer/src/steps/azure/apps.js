// @ts-check
/**
 * The Azure install's two Entra app registrations: their names, the web app's delegated scopes and
 * grants, and which apps an admin made can be adopted. Shared by the plan, the prerequisites and the
 * admin script, so it imports nothing from the install steps.
 */
import { GRAPH_APP_ID } from '../../catalog.js';
import { POWER_BI_APP_ID } from '../../clients/graph.js';

export const WEB_APP_NAME = 'Analytics Hub (Azure)';
/** Delegated: lets admins and group owners add and remove viewers from the app. Graph still checks they own the group or are a directory admin. */
export const GROUP_SCOPE = 'GroupMember.ReadWrite.All';
/** Delegated, with GROUP_SCOPE: lets Share find people by email and show members' names. Basic profiles only, not User.Read.All. */
export const PEOPLE_SCOPE = 'User.ReadBasic.All';
export const SQL_READER_NAME = 'Analytics Hub SQL Reader';
/**
 * The Microsoft clients that run the Teams app's tab and get its sign-in token, pre-authorised on the web app's
 * `access_as_user` scope: Teams, and Outlook and the Microsoft 365 app, which show the personal tab too.
 * See https://learn.microsoft.com/microsoftteams/platform/tabs/how-to/authentication/tab-sso-register-aad
 */
export const TEAMS_CLIENTS = [
  '1fec8e78-bce4-4aaf-ab1b-5451cc387264', // Teams desktop and mobile
  '5e3ce6c0-2b1f-4285-8d4b-75ee78787346', // Teams web
  '4765445b-32c6-49b0-83e6-1d93765276ca', // Microsoft 365 web
  '0ec893e0-5785-4de6-99da-4ed124e5296c', // Microsoft 365 desktop
  'd3590ed6-52b3-4102-aeff-aad2292ab01c', // Microsoft 365 mobile and Outlook desktop
  'bc59ab01-8403-45c6-8796-ac3ef710b3e3', // Outlook web
  '27922004-5251-4030-b22d-91ecd9a37ea4', // Outlook mobile
];

/** @typedef {'webApp' | 'sqlReader'} AzureAppKey */

/** The two app registrations, by their key in the install record. */
export const AZURE_APPS = /** @type {const} */ ([
  { key: 'webApp', name: WEB_APP_NAME },
  { key: 'sqlReader', name: SQL_READER_NAME },
]);

/**
 * Whether an install has yet to finish this app, so it can be adopted: the web app has no redirect URIs and the
 * SQL reader no secret. A finished one belongs to another install, and finishing it again would replace that
 * install's redirect URIs and identifier URI.
 * @param {string} name @param {any} app
 */
export function unfinishedApp(name, app) {
  if (name === WEB_APP_NAME) return !app?.spa?.redirectUris?.length;
  if (name === SQL_READER_NAME) return !app?.passwordCredentials?.length;
  return false;
}

/** @param {import('../../config.js').AzureConfig | undefined} az */
export const appsRecorded = (az) => AZURE_APPS.every((a) => !!az?.[a.key]?.clientId);

/**
 * The apps the signed-in user owns with exactly this name that no install has finished.
 * @param {import('../../install.js').Apis} api @param {string} name
 * @returns {Promise<any[]>}
 */
export async function adoptableApps(api, name) {
  const owned = (await api.graph.ownedApplications?.(name)) ?? [];
  return owned.filter((app) => app?.displayName === name && unfinishedApp(name, app));
}

/**
 * The web app's delegated scopes in this tenant, for its registration and its grants. With viewer access, admins
 * and group owners manage the group from Share in the app, as themselves, and find people by email.
 * @param {import('../../install.js').Apis} api @param {import('../../config.js').InstallConfig} config
 */
export async function webAppScopes(api, config) {
  const graphSp = await api.graph.servicePrincipalByAppId(GRAPH_APP_ID);
  const pbiSp = await api.graph.servicePrincipalByAppId(POWER_BI_APP_ID);
  /** @param {any} sp @param {string} value @returns {string | undefined} */
  const scope = (sp, value) => sp.oauth2PermissionScopes?.find((/** @type {{ value: string }} */ s) => s.value === value)?.id;
  const graphUserReadScopeId = scope(graphSp, 'User.Read');
  const pbiScopeId = scope(pbiSp, 'Dataset.Read.All');
  if (!graphUserReadScopeId || !pbiScopeId) throw new Error('Could not find Graph User.Read or Power BI Dataset.Read.All delegated scopes in this tenant.');
  const groups = !!config.access;
  const registration = {
    pbiScopeId, graphUserReadScopeId,
    graphGroupScopeId: groups ? scope(graphSp, GROUP_SCOPE) : undefined,
    graphPeopleScopeId: groups ? scope(graphSp, PEOPLE_SCOPE) : undefined,
    groupClaims: groups, teamsClientIds: TEAMS_CLIENTS,
  };
  return { graphSp, pbiSp, registration };
}

/** @typedef {Awaited<ReturnType<typeof webAppScopes>>} WebAppScopes */

/**
 * The delegated grants, for all users, that the web app's service principal needs.
 * @param {WebAppScopes} scopes
 * @returns {{ resourceId: string, resource: 'Power BI' | 'Microsoft Graph', scope: string }[]}
 */
export function webAppGrants({ graphSp, pbiSp, registration }) {
  return [
    { resourceId: pbiSp.id, resource: 'Power BI', scope: 'Dataset.Read.All' },
    { resourceId: graphSp.id, resource: 'Microsoft Graph', scope: 'User.Read' },
    ...(registration.graphGroupScopeId ? [{ resourceId: graphSp.id, resource: /** @type {const} */ ('Microsoft Graph'), scope: GROUP_SCOPE }] : []),
    ...(registration.graphPeopleScopeId ? [{ resourceId: graphSp.id, resource: /** @type {const} */ ('Microsoft Graph'), scope: PEOPLE_SCOPE }] : []),
  ];
}

/**
 * Whether the recorded web app's service principal already holds every delegated grant it needs, for all users,
 * as grantOauth2Permission reads them. False when there's no web app yet, or the grants can't be read.
 * @param {import('../../install.js').Apis} api @param {import('../../config.js').InstallConfig} config
 */
export async function webAppGranted(api, config) {
  const spId = config.azure?.webApp?.servicePrincipalId;
  if (!spId) return false;
  try {
    const wanted = webAppGrants(await webAppScopes(api, config));
    const grants = (await api.graph.oauth2Grants(spId)).filter((g) => g.consentType === 'AllPrincipals');
    return wanted.every((w) => grants.some((g) => g.resourceId === w.resourceId && String(g.scope ?? '').split(' ').includes(w.scope)));
  } catch {
    return false;
  }
}
