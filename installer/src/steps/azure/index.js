// @ts-check
/** Azure target installer steps. */
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { GRAPH_APP_ID, azureGraphRolesFor, collectedLabels, ESSENTIAL_MODULES, MODULES, OPTIONAL_MODULES } from '../../catalog.js';
import { semanticModelDefinition } from '../../clients/fabric.js';
import { POWER_BI_APP_ID, adminConsentUrl, apiPermissionsUrl, resolveAppRoles } from '../../clients/graph.js';
import { armErrors, ROLES } from '../../clients/azure.js';
import { HttpError } from '../../http.js';
import { commandLine } from '../../launch.js';
import { rlsOn, rlsSettings } from '../../transform/access.js';
import { buildConsumptionModel, buildModel, loadTemplateModel, PBISM } from '../../transform/model.js';
import { deployModel, MODEL_UPDATE_NOTE, modelSignature, REFRESH_POLL_MS, settleReloads } from '../model.js';
import { addMonths, OPTIONAL_PERMISSION_EFFECTS, OPTIONAL_PERMISSIONS, SECRET_LIFETIME_MONTHS } from '../identity.js';
import { addTrackedSecret, promoteSecret, removeRetired } from '../secrets.js';
import { manifestVersion, writeTeamsPackage } from '../../azure/teams.js';
import { askToPublishTeamsApp, checkCatalogAccess, publishTeamsApp, removeTeamsApp, signInForTeamsApp, TEAMS_APP_PENDING, teamsAppPlanRow } from './teams-catalog.js';
import { APP_ALIAS, CONSUMPTION_ALIAS } from '../app.js';
import { AZURE_AI_ROLES, ensureAzureAiAccess, planConsumption } from '../consumption.js';
import { AZURE_LANDING_DIRS, azureDropLabel, azureDropsToSharePoint, ensureFlows, flowsSummary, flowsWanted, offerStudioRun, planFlows } from '../flows.js';
import { DEFAULT_CURRENCY } from '../../currency.js';
import { askMoreHistory, askReportingCurrency, editSchedule, HISTORY_CHOICES, keepAwake, planCosts, reloadDetail, reloadLine } from '../plan.js';
import { ensureResourceGraphAccess, planResourceGraph, resourceGraphGrants, resourceGraphKinds, resourceGraphOn, scopeName } from '../resource-graph.js';
import { DATA_SOURCES } from '../../uploads.js';
import { normaliseResourceGraph } from '../../config.js';
import { accessReview, accessSummaryLines, ensureViewerGroup, grantModelAccess, planAccess, publicAccess } from '../access.js';
import { ensureOrgAccess, verifyOrgAccess } from '../org-access.js';
import { askAdvanced, asksAdvanced } from '../advanced.js';
import { askGrants, askLine, askMode, askParameters, ensureAzureAskAccess, planAzureAsk } from './ask.js';
import { checkRegions, noRegionMessage, regionNotes, regionProblems, sqlProblem } from './regions.js';
import { BIG_CAPACITY_SEATS, copilotSeats, LARGE_TENANT_SEATS, seatCount } from '../../seats.js';

/** @typedef {import('../../install.js').Ctx} Ctx */

export const AZURE_PROVIDERS = ['Microsoft.App', 'Microsoft.Sql', 'Microsoft.Storage', 'Microsoft.OperationalInsights', 'Microsoft.ManagedIdentity'];
/** Extra resource providers for private networking: the VNet and private endpoints, and the Power BI VNet data gateway's subnet delegation. */
export const PRIVATE_PROVIDERS = ['Microsoft.Network', 'Microsoft.PowerPlatform'];
/** For the Ask model, when the installer creates one. */
export const ASK_PROVIDERS = ['Microsoft.CognitiveServices'];
export const PRIVATE_FEATURE = /** @type {[string, string]} */ (['Microsoft.Network', 'AllowBringYourOwnPublicIpAddress']);
/** Capacities that can host a Power BI VNet data gateway: F (including trial), P and A4+; not PPU, EM or A1-A3. */
export const supportsVnetGateway = (/** @type {{ sku?: string }} */ cap) => /^(F|FT|P\d|A[4-9])/i.test(String(cap.sku ?? '')) && !/^PP/i.test(String(cap.sku ?? ''));
export const isPrivate = (/** @type {import('../../config.js').AzureConfig | undefined} */ az) => az?.publicNetworkAccess === false;
export const AZURE_SUPPORTED_MODULES = /** @type {const} */ (['core', 'orgData', 'm365Activity', 'consumption', 'defender']);
export const WEB_APP_NAME = 'Analytics Hub (Azure)';
/** Delegated: lets admins and group owners add and remove viewers from the app. Graph still checks they own the group or are a directory admin. */
export const GROUP_SCOPE = 'GroupMember.ReadWrite.All';
export const SQL_READER_NAME = 'Analytics Hub SQL Reader';
/** The SQL reader secret's name on its app, before the ref of the run that made it. */
const SQL_READER_SECRET_LABEL = 'Power BI SQL credential';
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
const ARM = JSON.parse(readFileSync(new URL('../../azure/main.arm.json', import.meta.url), 'utf8'));
export const REQUIRED_ARM_PARAMETERS = [
  'location', 'sqlLocation', 'namePrefix', 'installId', 'tags', 'imageRegistry', 'imageTag', 'imageRegistryResourceId', 'runSchedule', 'runSteps', 'sampleData', 'sqlAdminLogin', 'sqlAdminObjectId',
  'sqlAdminPrincipalType', 'sqlMinCapacity', 'sqlMaxCapacity', 'sqlAutoPauseDelayMinutes', 'sqlUseFreeLimit', 'publicNetworkAccess', 'privateDnsZoneMode', 'privateDnsZonesResourceGroupId', 'deployWeb',
  'webMinReplicas', 'webClientId', 'webAppIdUri', 'webAccess', 'modules', 'auditHistoryDays', 'powerBiWorkspaceId', 'semanticModels', 'sqlReaderName', 'sqlReaderClientId',
  'azureAiSubscriptionId', 'paygSubscriptionIds', 'dropSiteId', 'dropDriveId', 'dropFolder', 'argManagementGroup', 'argAgents', 'argFoundry', 'reportingCurrency', 'exchangeRate',
  'askMode', 'askEndpoint', 'askDeployment', 'askModelName', 'askModelVersion', 'askSku', 'askCapacity', 'askLocation',
];

const last = (/** @type {string} */ path) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;
const pkgVersion = () => JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')).version;
const param = (/** @type {any} */ value) => ({ value });
export const armParameterNames = () => Object.keys(ARM.parameters ?? {});
export const DEFAULT_IMAGE_REGISTRY = 'ghcr.io/microsoft';
/** The image tag to deploy: the installer's version unless the record pins another (`azure.images.tag`). */
const imageTag = (/** @type {import('../../config.js').AzureConfig} */ az) => az.images?.tag || pkgVersion();

/** @param {import('../../catalog.js').ModuleChoice} modules */
export function azureModuleChoices(modules) {
  const box = (/** @type {import('../../catalog.js').ModuleId} */ id) => ({
    name: MODULES[id].label,
    value: id,
    description: MODULES[id].azure.supported ? MODULES[id].description : `${MODULES[id].description} Coming soon on Azure.`,
    disabled: MODULES[id].azure.supported ? (ESSENTIAL_MODULES.includes(/** @type {any} */ (id)) ? 'Always collected' : false) : 'Coming soon on Azure',
    checked: MODULES[id].azure.supported && (ESSENTIAL_MODULES.includes(/** @type {any} */ (id)) || !!modules[id]),
  });
  return [...ESSENTIAL_MODULES, ...OPTIONAL_MODULES].map(box);
}

/** @param {string} text */
export function parseTags(text) {
  /** @type {Record<string, string>} */
  const tags = {};
  for (const raw of text.split(/[;,\n]/).map((s) => s.trim()).filter(Boolean)) {
    const at = raw.indexOf('=');
    if (at <= 0) throw new Error(`Tag "${raw}" must be key=value.`);
    tags[raw.slice(0, at).trim()] = raw.slice(at + 1).trim();
  }
  return tags;
}

/** @param {{ frequency: 'daily' | 'weekly', time: string, weekday: string }} schedule */
export function azureCron(schedule) {
  const [h, m] = schedule.time.split(':').map(Number);
  if (schedule.frequency === 'weekly') {
    const days = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 };
    return `${m} ${h} * * ${days[/** @type {keyof typeof days} */ (schedule.weekday)] ?? 0}`;
  }
  return `${m} ${h} * * *`;
}

/**
 * Each policy behind a RequestDisallowedByPolicy, however deep ARM nested it (validation errors
 * put it in details; failed deployments nest it under DeploymentFailed and each module).
 * @param {any} err
 * @returns {{ resource?: string, definition?: string, definitionId?: string, assignment?: string, assignmentId?: string, message?: string }[]}
 */
export function policyViolations(err) {
  const body = err instanceof HttpError ? err.body : (err?.body ?? err);
  const denials = armErrors(body).filter((e) => e.leaf && /RequestDisallowedByPolicy/i.test(e.code ?? ''));
  if (!denials.length) {
    const text = typeof body === 'string' ? body : `${err?.message ?? ''} ${JSON.stringify(body ?? {})}`;
    if (/RequestDisallowedByPolicy/i.test(text)) denials.push({ message: text, leaf: true });
  }
  return denials.flatMap((e) => {
    const message = e.message ?? '';
    const resource = /Resource '([^']+)' was disallowed/i.exec(message)?.[1] ?? e.target?.split('/').pop();
    /** @type {any[]} */
    let infos = (e.additionalInfo ?? []).filter((a) => a?.type === 'PolicyViolation' && a.info).map((a) => a.info);
    if (!infos.length) {
      const ids = /Policy identifiers: '(\[.*\])'/i.exec(message)?.[1];
      try {
        infos = ids ? JSON.parse(ids).map((/** @type {any} */ x) => ({ policyAssignmentName: x.policyAssignment?.name, policyAssignmentId: x.policyAssignment?.id, policyDefinitionName: x.policyDefinition?.name, policyDefinitionId: x.policyDefinition?.id })) : [];
      } catch {
        infos = [];
      }
    }
    if (!infos.length) infos = [{ policyAssignmentDisplayName: /policy assignment '?([^'".]+)'?/i.exec(message)?.[1] }];
    return infos.map((i) => ({
      resource,
      definition: i.policyDefinitionDisplayName ?? i.policyDefinitionName,
      definitionId: i.policyDefinitionId,
      assignment: i.policyAssignmentDisplayName ?? i.policyAssignmentName,
      assignmentId: i.policyAssignmentId,
      message,
    }));
  });
}

/**
 * @param {any} err
 * @param {import('../../config.js').AzureConfig} [az]  The install being deployed; omitted when the networking choice isn't known yet.
 */
export function policyMessage(err, az) {
  const found = policyViolations(err);
  if (!found.length) return '';
  const lines = [...new Set(found.map((v) => {
    const by = v.assignment ? ` (assignment "${v.assignment}"${v.assignmentId ? `, ${v.assignmentId}` : ''})` : '';
    return `  - ${v.definition ? `"${v.definition}"` : 'a policy'}${v.resource ? ` on ${v.resource}` : ''}${by}${v.definitionId ? ` [${v.definitionId}]` : ''}`;
  }))];
  const hints = [];
  if (found.some((v) => /^privatelink\./i.test(v.resource ?? '') || /privateDnsZones/i.test(`${v.message} ${v.definition} ${v.definitionId}`))) {
    hints.push('Your organisation manages private DNS zones centrally (common in Azure Landing Zones): run the installer again, choose advanced options and Private networking, then use the existing private DNS zones or leave DNS to Azure Policy.');
  }
  if (found.some((v) => /^(cae|ca|job)-/i.test(v.resource ?? '') || /Microsoft\.App\//i.test(v.message ?? '') || /container ?apps?/i.test(v.definition ?? ''))) {
    hints.push('The web app needs public ingress on its Container Apps environment, so a policy that keeps Container Apps internal-only needs an exemption for this resource group.');
  }
  hints.push(isPrivate(az) ? 'Otherwise ask your Azure admin for an exemption on this resource group, or for the setting the policy expects.'
    : az ? 'Otherwise ask for an exemption on this resource group, or run the installer again, choose advanced options and Private networking.'
    : 'Otherwise ask for an exemption on this resource group. If the policy is about public network access, run the installer again, choose advanced options and Private networking.');
  return `Azure Policy blocked the deployment:\n${lines.join('\n')}\n${hints.join('\n')}`;
}

/** @param {any} err @param {import('../../config.js').AzureConfig} [az] */
export function publicAccessMessage(err, az) {
  if (isPrivate(az)) return '';
  const body = err instanceof HttpError ? err.body : err;
  const text = typeof body === 'string' ? body : JSON.stringify(body ?? {});
  if (!/DenyPublicEndpointEnabled|PublicNetworkAccess.{0,40}(Disabled|denied)|public network access .{0,40}(disabled|not allowed)/i.test(text)) return '';
  const firewall = /firewall rules? when public network interface/i.test(`${text} ${err?.message ?? ''}`)
    ? 'Azure Policy switched off public network access on the Azure SQL server, so its firewall can\'t take the rule that lets Azure services in. '
    : 'This subscription keeps public network access switched off on Azure SQL or Storage (common on managed and MCAPS subscriptions). ';
  if (az?.outputs?.sqlServerFqdn) return `${firewall}This install uses public endpoints, and networking can't change in place: uninstall and install again with Private networking, or ask your Azure admin for an exemption on this resource group.`;
  return `${firewall}Re-run the installer and choose Private networking: it adds a VNet, private endpoints and a Power BI VNet data gateway.`;
}

/** @param {any} err @param {import('../../config.js').AzureConfig} [az] */
const explain = (err, az) => policyMessage(err, az) || publicAccessMessage(err, az) || regionCapacityMessage(err) || askModelMessage(err);

/** @param {any} err */
export function askModelMessage(err) {
  const body = err instanceof HttpError ? err.body : err;
  const text = typeof body === 'string' ? body : JSON.stringify(body ?? {});
  if (!/InsufficientQuota|DeploymentModelNotSupported|ModelNotSupported|ServiceModelDeprecated|SkuNotSupported/i.test(text) || !/CognitiveServices|deployment|model/i.test(text)) return '';
  return 'Azure couldn\'t deploy the Ask model (quota, region or model version). Run the installer again, choose advanced options, and point Ask at an existing deployment or leave it off; everything else is unaffected.';
}

/** @param {any} err */
export function regionCapacityMessage(err) {
  const body = err instanceof HttpError ? err.body : err;
  const text = typeof body === 'string' ? body : JSON.stringify(body ?? {});
  if (!/RegionDoesNotAllowProvisioning/i.test(text)) return '';
  const detail = /Location '([^']+)' is not accepting creation of new ([^.]+?) at this time/i.exec(text);
  return `${detail ? `Azure region ${detail[1]} is not accepting new ${detail[2]}` : 'An Azure region is not accepting new resources of this type'} on this subscription right now. Re-run the installer and pick a different Azure SQL region (for example ukwest, swedencentral or francecentral); everything else stays where it is.`;
}

/** @param {any[]} changes */
export function whatIfSummary(changes) {
  /** @type {Record<string, { create: string[], modify: string[], nochange: string[], delete: string[] }>} */
  const grouped = {};
  for (const c of changes ?? []) {
    const type = c.resourceType ?? c.type ?? 'Resource';
    grouped[type] ??= { create: [], modify: [], nochange: [], delete: [] };
    const kind = String(c.changeType ?? c.kind ?? 'NoChange').toLowerCase();
    const name = c.name ?? last(c.resourceId ?? c.id ?? type);
    if (kind.includes('create')) grouped[type].create.push(name);
    else if (kind.includes('modify') || kind.includes('deploy')) grouped[type].modify.push(name);
    else if (kind.includes('delete')) grouped[type].delete.push(name);
    else grouped[type].nochange.push(name);
  }
  return grouped;
}

/** What the Azure target is, in plain words. */
export const AZURE_TARGET_DESCRIPTION =
  'Runs the data collection in your Azure subscription (scheduled jobs in Azure Container Apps) and publishes to a Power BI workspace.';

/** @param {Ctx} ctx */
export async function askTarget(ctx) {
  ctx.config.target ??= 'fabric';
  if (ctx.config.target === 'azure' || ctx.config.fabric.workspaceId || ctx.config.azure?.subscriptionId) return;
  ctx.ui.heading('Where should Analytics Hub run?');
  ctx.config.target = await ctx.ui.select('Where should Analytics Hub run?', [
    { name: 'Microsoft Fabric', value: 'fabric', description: 'Use Fabric workspaces, Lakehouse, notebooks and pipeline.' },
    { name: 'Your Azure subscription', value: 'azure', description: AZURE_TARGET_DESCRIPTION },
  ], ctx.config.target);
}

/**
 * The resources in a resource group, or none when the group doesn't exist (a first deploy can fail before creating it).
 * @param {Ctx['api']['arm']} arm @param {string | undefined} subscriptionId @param {string | undefined} resourceGroup
 */
export async function resourcesIn(arm, subscriptionId, resourceGroup) {
  if (!subscriptionId || !resourceGroup) return [];
  return arm.listResources(subscriptionId, resourceGroup).catch((err) => (err instanceof HttpError && err.status === 404 ? [] : Promise.reject(err)));
}

/**
 * Whether an earlier attempt left something to reuse, so subscription, resource group and prefix must stay.
 * @param {import('../../config.js').AzureConfig} az @param {{ tags?: Record<string, string> }[]} resources
 */
export const deploymentPinned = (az, resources) =>
  !!az.outputs?.sqlServerFqdn || !!az.deployments?.length || resources.some((r) => r.tags?.['valuelens-install-id'] === az.installId);

/** @param {Ctx} ctx @param {any} pre @param {string} [section] */
export async function planAzure(ctx, pre, section) {
  const { ui, config, api } = ctx;
  const az = (config.azure ??= {});
  config.target = 'azure';

  const editing = (/** @type {string} */ id) => !section || section === id;
  if (editing('data')) {
    ui.heading('What to collect');
    const picked = await ui.checkbox('Tick the data you want. Unsupported modules are coming soon on Azure.', azureModuleChoices(config.modules));
    config.modules = /** @type {import('../../catalog.js').ModuleChoice} */ ({ orgData: true, m365Activity: picked.includes('m365Activity'), agent365: false, productFeedback: false, consumption: picked.includes('consumption'), agentEvaluator: false, defender: picked.includes('defender') });
    config.dataSources.productFeedback = 'skip';
    config.dataSources.defender = config.modules.defender ? 'api' : 'skip';
    if (!section) await askAdvanced(
      ctx,
      'demo mode, the Azure SQL region, the name prefix, tags, networking, who can view, audit history, the schedule, where credits come from, agent configuration and Foundry, the first load and the Value page currency',
    );
  }
  const advanced = !!section || asksAdvanced(ctx);
  if (editing('data')) {
    az.sampleData = !advanced
      ? az.sampleData === true
      : await ui.select('Which data should the dashboard show?', [
        { name: "Your tenant's data", value: false, description: 'Collect from the audit log, Microsoft Graph and the modules you ticked.' },
        { name: 'Demo mode (sample data)', value: true, description: 'Show a synthetic sample, moved forward to end last week, to try Analytics Hub before connecting tenant data. Run the installer again and pick your tenant\'s data to switch.' },
      ], az.sampleData === true);
  }
  const subs = pre.subscriptions.length ? pre.subscriptions : (await api.arm.listSubscriptions()).filter((s) => s.state === 'Enabled');
  if (editing('placement')) {
    ui.heading('Azure');
    const attempted = section && ui.web && (!!az.deploymentConfig || !!az.outputs?.sqlServerFqdn);
    const existing = attempted ? await resourcesIn(api.arm, az.subscriptionId, az.resourceGroup) : [];
    const pinned = attempted && deploymentPinned(az, existing);
    if (pinned) {
      ui.note(`Keeping subscription ${az.subscriptionName ?? az.subscriptionId} and resource group ${az.resourceGroup} to reuse this deployment's resources.`);
    } else {
      az.subscriptionId = await ui.select('Azure subscription', subs.map((s) => ({ name: `${s.displayName} (${s.subscriptionId})`, value: s.subscriptionId })), az.subscriptionId ?? subs[0]?.subscriptionId);
      az.subscriptionName = subs.find((s) => s.subscriptionId === az.subscriptionId)?.displayName;
      const subscriptionId = /** @type {string} */ (az.subscriptionId);
      const rgs = await api.arm.listResourceGroups(subscriptionId).catch(() => []);
      const rgChoice = await ui.select('Resource group', [{ name: 'Create a new resource group', value: 'new' }, ...rgs.map((g) => ({ name: `Use existing "${g.name}" (${g.location})`, value: g.name }))], az.resourceGroupMode === 'existing' && az.resourceGroup ? az.resourceGroup : 'new');
      if (rgChoice === 'new') {
        az.resourceGroupMode = 'new';
        const base = az.resourceGroup ?? 'rg-analytics-hub';
        let name = base;
        for (let i = 2; ; i++) {
          const existing = await api.arm.getResourceGroup(subscriptionId, name).catch(() => null);
          if (!existing || existing.tags?.['valuelens-install-id']) break;
          name = `${base}-${i}`;
        }
        az.resourceGroup = await ui.input('New resource group name', { default: name, validate: (v) => (v.trim() ? true : 'Required') });
      } else {
        az.resourceGroupMode = 'existing';
        az.resourceGroup = rgChoice;
      }
      // Only a group this run creates is deleted by uninstall; never one picked from the list.
      az.createdResourceGroup = false;
    }
    const subscriptionId = /** @type {string} */ (az.subscriptionId);
    const rg = az.resourceGroup ? await api.arm.getResourceGroup(subscriptionId, az.resourceGroup).catch(() => null) : null;
    const locations = await api.arm.listLocations(subscriptionId).catch(() => []);
    // A first install offers only the regions policy allows and everything is offered in; a re-run keeps its resources where they are.
    const check = az.outputs?.sqlServerFqdn ? undefined : await checkRegions(api.arm, { subscriptionId, scope: `/subscriptions/${subscriptionId}${rg ? `/resourceGroups/${az.resourceGroup}` : ''}`, newResourceGroup: !rg, locations });
    ctx.azureRegions = check;
    const sqlApart = advanced || !!az.sqlLocation;
    const offered = check ? check.regions.filter((l) => !regionProblems(check, l.name, { sql: !sqlApart }).length) : locations;
    if (check) for (const line of regionNotes(check, offered.map((l) => l.name), { sql: !sqlApart })) ui.note(line);
    if (check?.regions.length && !offered.length) throw new Error(noRegionMessage(check, { sql: !sqlApart }));
    const defaultLocation = [az.location, rg?.location, 'uksouth'].find((r) => r && offered.some((l) => l.name === r)) ?? offered[0]?.name ?? rg?.location ?? az.location ?? 'uksouth';
    const sqlNote = (/** @type {string} */ name) => (advanced && check && sqlProblem(check, name) ? { description: `${sqlProblem(check, name)}: pick another Azure SQL region next.` } : {});
    if (section && ui.web) {
      const resources = pinned ? existing : [];
      const has = (/** @type {RegExp} */ type) => resources.some((r) => r.tags?.['valuelens-install-id'] === az.installId && type.test(r.type ?? ''));
      const regionLocked = !!(az.outputs?.storageAccountName || az.outputs?.environmentName || az.outputs?.webName) || has(/^Microsoft\.(App|Storage|OperationalInsights|ManagedIdentity)\//i);
      const sqlLocked = !!az.outputs?.sqlServerFqdn || has(/^Microsoft\.Sql\/servers$/i);
      const regionChoices = offered.map((l) => ({ name: l.displayName ?? l.name, value: l.name }));
      if (regionLocked && az.location && !regionChoices.some((l) => l.value === az.location)) regionChoices.push({ name: az.location, value: az.location });
      const sqlChoices = (check ? check.regions.filter((l) => !sqlProblem(check, l.name)) : locations).map((l) => ({ name: l.displayName ?? l.name, value: l.name }));
      if (sqlLocked && az.sqlLocation && !sqlChoices.some((l) => l.value === az.sqlLocation)) sqlChoices.push({ name: az.sqlLocation, value: az.sqlLocation });
      const values = await ui.form('Azure placement', [
        { id: 'location', label: 'Azure region', default: regionLocked ? /** @type {string} */ (az.location) : defaultLocation, choices: regionChoices,
          ...(regionLocked ? { readOnly: 'Existing resources cannot be moved to another region.' } : {}) },
        { id: 'sqlLocation', label: 'Azure SQL region', default: az.sqlLocation ?? '', ...(sqlLocked ? { readOnly: 'The SQL server already exists and cannot move regions.' } : {}), choices: [
            { name: 'Same as Azure region (checked before deployment)', value: '' },
            ...sqlChoices,
          ] },
        { id: 'namePrefix', label: 'Name prefix', default: az.namePrefix ?? 'vlens', ...(pinned ? { readOnly: 'Keep the prefix to reuse existing resources.' } : {}), validate: (v) => /^[a-z][a-z0-9-]{1,9}$/.test(v) ? true : 'Use 2-10 lowercase letters, digits or hyphens, starting with a letter.' },
        { id: 'tags', label: 'Extra tags (key=value, comma-separated)', default: Object.entries(az.tags ?? {}).map(([k, v]) => `${k}=${v}`).join(', '), validate: (v) => {
            try { parseTags(v); return true; } catch (err) { return /** @type {Error} */ (err).message; }
          } },
      ]);
      if (!values) throw Object.assign(new Error('Changes cancelled'), { name: 'SettingsCancelled' });
      az.location = values.location;
      az.sqlLocation = values.sqlLocation || undefined;
      az.namePrefix = values.namePrefix;
      az.tags = parseTags(values.tags);
    } else {
      az.location = await ui.select('Azure region', offered.length ? offered.map((l) => ({ name: l.displayName ?? l.name, value: l.name, ...sqlNote(l.name) })) : [{ name: defaultLocation, value: defaultLocation }], defaultLocation);
    }
    // With SQL's public access off (a deny, or a modify that switches it off after create), its firewall
    // can't take the rule that lets Azure services in, so public endpoints fail with DenyPublicEndpointEnabled.
    const sqlPrivate = check?.sqlPrivate ?? [];
    const sqlPolicy = sqlPrivate.map((n) => `"${n}"`).join(', ');
    if (sqlPrivate.length && az.publicNetworkAccess !== false) {
      if (section && ui.web) ui.warn(`Azure Policy ${sqlPolicy} keeps Azure SQL's public access off. Review the Networking category before deployment; changing placement does not change your networking choice.`);
      else {
        ui.note(`Azure Policy ${sqlPolicy} keeps public network access off on Azure SQL, so the installer uses Private networking: the jobs reach SQL through a private endpoint and Power BI through a VNet data gateway.`);
        az.publicNetworkAccess = false;
      }
    }
    if (advanced && !(section && ui.web)) {
      const sameOk = !check || !sqlProblem(check, /** @type {string} */ (az.location));
      const sqlChoices = [...(sameOk ? [{ name: 'Same as above', value: '' }] : []), ...(check ? check.regions.filter((l) => !sqlProblem(check, l.name)) : locations).filter((l) => l.name !== az.location).map((l) => ({ name: l.displayName ?? l.name, value: l.name }))];
      if (check && !sqlChoices.length) throw new Error(noRegionMessage(check, { sql: true }));
      const sqlChoice = await ui.select('Azure SQL region', sqlChoices, sqlChoices.some((c) => c.value === (az.sqlLocation ?? '')) ? az.sqlLocation ?? '' : sqlChoices[0].value);
      az.sqlLocation = sqlChoice || undefined;
      az.namePrefix = await ui.input('Name prefix', { default: az.namePrefix ?? 'vlens', validate: (v) => (/^[a-z][a-z0-9-]{1,9}$/.test(v) ? true : 'Use 2-10 lowercase letters, digits or hyphens, starting with a letter.') });
      az.tags = parseTags(await ui.input('Extra tags (key=value, comma-separated)', { default: Object.entries(az.tags ?? {}).map(([k, v]) => `${k}=${v}`).join(', ') }));
    } else if (!advanced) {
      if (az.sqlLocation === az.location) az.sqlLocation = undefined;
      az.namePrefix ??= 'vlens';
      az.tags ??= {};
    }
  }
  if (editing('networking')) {
    const previousAccess = az.publicNetworkAccess;
    const sqlPrivate = ctx.azureRegions?.sqlPrivate ?? [];
    const sqlPolicy = sqlPrivate.map((n) => `"${n}"`).join(', ');
    if (sqlPrivate.length) az.publicNetworkAccess = false;
    if (section && ui.web) {
      const resources = az.deploymentConfig ? await resourcesIn(api.arm, az.subscriptionId, az.resourceGroup) : [];
      const networkLocked = !!az.outputs?.environmentName || resources.some((r) => r.tags?.['valuelens-install-id'] === az.installId && /^Microsoft\.App\/managedEnvironments$/i.test(r.type ?? ''));
      if (networkLocked) az.publicNetworkAccess = previousAccess;
      const values = await ui.form('Networking', [
        { id: 'access', label: 'Networking', default: az.publicNetworkAccess === false ? 'private' : 'public',
          ...(networkLocked ? { readOnly: 'The Container Apps environment already exists; networking cannot change in place.' } : {}), choices: [
            { name: 'Public endpoints', value: 'public', disabled: sqlPrivate.length && !networkLocked ? `Blocked by Azure Policy ${sqlPolicy}` : false },
            { name: 'Private networking (requires Fabric or Premium capacity)', value: 'private' },
          ] },
        { id: 'dns', label: 'Private DNS zones (used with private networking)', default: az.privateDns?.mode ?? 'create', choices: [
            { name: 'Create in this resource group', value: 'create' },
            { name: 'Use existing zones', value: 'existing' },
            { name: 'Leave DNS to Azure Policy or the network team', value: 'none' },
          ] },
        { id: 'dnsGroup', label: 'Existing DNS resource group ID (only for existing zones)', default: az.privateDns?.resourceGroupId ?? '' },
      ]);
      if (!values) throw Object.assign(new Error('Changes cancelled'), { name: 'SettingsCancelled' });
      if (values.access === 'private' && values.dns === 'existing' && !/^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+$/i.test(values.dnsGroup.trim())) throw new Error('Existing DNS zones need /subscriptions/<id>/resourceGroups/<name>.');
      az.publicNetworkAccess = values.access === 'public';
      az.privateDns = { mode: /** @type {'create' | 'existing' | 'none'} */ (values.dns), ...(values.dns === 'existing' ? { resourceGroupId: values.dnsGroup.trim() } : {}) };
    } else if (advanced) {
      az.publicNetworkAccess = await ui.select('Networking', [
        { name: 'Public endpoints', value: true, description: sqlPrivate.length ? `Azure Policy ${sqlPolicy} keeps Azure SQL's public access off, so this deployment would fail.` : 'Azure SQL and Storage accept connections from Azure services only (firewall + Entra auth).' },
        { name: 'Private networking', value: false, description: 'VNet, private endpoints and a Power BI VNet data gateway. Needed where policy keeps public access off. Needs a Fabric or Premium capacity.' },
      ], az.publicNetworkAccess !== false);
      if (az.publicNetworkAccess === false) {
        const mode = /** @type {'create' | 'existing' | 'none'} */ (await ui.select('Private DNS zones', [
          { name: 'Create them in this resource group', value: 'create', description: 'privatelink zones for SQL, Storage and Ask, linked to the new VNet.' },
          { name: 'Use existing zones in another resource group', value: 'existing', description: 'For Azure Landing Zones that keep privatelink zones in a hub. Links the VNet to them; needs Private DNS Zone Contributor there.' },
          { name: 'Leave DNS to Azure Policy or the network team', value: 'none', description: 'No zones, links or DNS zone groups. The jobs can\'t reach SQL and Storage until policy or your network team adds them.' },
        ], az.privateDns?.mode ?? 'create'));
        az.privateDns = mode === 'existing'
          ? { mode, resourceGroupId: (await ui.input('Resource ID of the resource group holding the privatelink zones', { default: az.privateDns?.resourceGroupId ?? '', validate: (v) => (/^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+$/i.test(v.trim()) ? true : 'Use /subscriptions/<id>/resourceGroups/<name>.') })).trim() }
          : { mode };
      }
    } else az.publicNetworkAccess = az.publicNetworkAccess !== false;
  }

  if (editing('powerbi')) {
    ui.heading('Power BI');
    az.powerBi ??= {};
    const sqlPrivate = ctx.azureRegions?.sqlPrivate ?? [];
    const sqlPolicy = sqlPrivate.map((n) => `"${n}"`).join(', ');
    const capacities = (await api.fabric.listCapacities().catch(() => [])).filter((cap) => cap.state === 'Active' && (!isPrivate(az) || supportsVnetGateway(cap)));
    if (isPrivate(az) && !capacities.length) throw new Error(`${sqlPrivate.length ? `Azure Policy ${sqlPolicy} keeps Azure SQL's public access off, so Analytics Hub needs Private networking here. ` : ''}Private networking needs an active Fabric (F or trial) or Power BI Premium (P, A4+) capacity you can assign workspaces to, to host the VNet data gateway. Start a Fabric trial or ask a capacity admin, then try again.`);
    const capacityChoices = capacities.map((cap) => ({ name: `${cap.displayName} (${cap.sku}, ${cap.region})`, value: cap.id }));
    az.powerBi.capacityId = await ui.select(
      isPrivate(az) ? 'Capacity for the Power BI workspace and VNet data gateway' : 'Capacity for the Power BI workspace',
      isPrivate(az) ? capacityChoices : [...capacityChoices, { name: 'None (shared capacity, Pro)', value: '' }],
      capacities.some((cap) => cap.id === az.powerBi?.capacityId) ? az.powerBi.capacityId : (capacityChoices[0]?.value ?? ''),
    ) || undefined;
    const groups = await api.powerBi.groups().catch(() => []);
    const wsChoice = await ui.select('Power BI workspace', [{ name: 'Create a new workspace', value: 'new' }, ...groups.map((g) => ({ name: `Use "${g.name}"`, value: g.id }))], az.powerBi?.workspaceId ?? 'new');
    if (wsChoice === 'new') {
      if (az.powerBi.workspaceId && (az.deploymentConfig || az.powerBi.datasetId || az.powerBi.gatewayId)) throw new Error('The workspace is already in use by this install. Keep it; use a separate install record for a different workspace.');
      delete az.powerBi.workspaceId;
      az.workspaceName = await ui.input('New Power BI workspace name', { default: az.workspaceName ?? 'Analytics Hub' });
    }
    else az.powerBi.workspaceId = wsChoice;
  }
  if (editing('access')) {
    await planAccess(ctx);
  }

  if (editing('schedule')) {
    if (azureHistoryLoaded(az)) await askMoreHistory(ctx);
    else {
      delete ctx.reloadHistoryDays;
      if (advanced) config.history.days = await ui.select('How much audit history should the first load pull?', HISTORY_CHOICES, config.history.days);
    }
    config.schedule.timeZone = 'UTC';
    if (section && ui.web) await editSchedule(ctx);
    else if (advanced) {
      ui.heading('Schedule');
      config.schedule.frequency = await ui.select('How often should the job run?', [{ name: 'Daily', value: 'daily' }, { name: 'Weekly', value: 'weekly' }], config.schedule.frequency);
      if (config.schedule.frequency === 'weekly') config.schedule.weekday = await ui.select('Which day?', ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((d) => ({ name: d, value: d })), config.schedule.weekday);
      config.schedule.time = await ui.input('Time (UTC, 24-hour)', { default: config.schedule.time, validate: (v) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? true : 'Use HH:MM.') });
    }
    // A reload runs the job straight after setup anyway.
    ctx.runFirstLoad = ctx.reloadHistoryDays ? false : !advanced || (await ui.confirm('Run the first load as soon as setup finishes?', true));
    if (advanced) await askReportingCurrency(ctx);
  }
  if (editing('sources')) await planAzureConsumption(ctx, subs);
  if (editing('governance')) await planAzureResourceGraph(ctx);
  if (editing('ask')) await planAzureAsk(ctx);
  if (!section) await azurePreflight(ctx);
}

/**
 * The run job has run: its collector keeps a high-water mark, so more history needs a reload.
 * @param {import('../../config.js').AzureConfig} az
 */
export const azureHistoryLoaded = (az) => !!(az.outputs?.runJobName && az.status?.lastRun);

/** The setting the run job's collector reads to load more history once, despite its high-water mark. */
export const BACKFILL_ENV = 'VALUELENS_AUDIT_BACKFILL_DAYS';

/**
 * The job's containers, with extra settings, for one execution. Container Apps runs a start request's
 * template instead of the job's, so each container keeps its image, command, resources and settings.
 * @param {any} job  The job resource.
 * @param {{ name: string, value: string }[]} env
 * @param {{ args?: string[] }} [opts]  Arguments that replace the containers' own, e.g. other steps.
 * @returns {{ containers: any[], initContainers?: any[] } | undefined}  undefined when the job has no containers to copy.
 */
export function jobTemplateWith(job, env, opts = {}) {
  const template = job?.properties?.template;
  const containers = template?.containers ?? [];
  if (!containers.length) return undefined;
  const names = new Set(env.map((e) => e.name));
  return {
    containers: containers.map((/** @type {any} */ ct) => ({
      name: ct.name,
      image: ct.image,
      ...(ct.command ? { command: ct.command } : {}),
      ...(opts.args ? { args: opts.args } : ct.args ? { args: ct.args } : {}),
      ...(ct.resources ? { resources: ct.resources } : {}),
      env: [...(ct.env ?? []).filter((/** @type {any} */ e) => !names.has(e.name)), ...env],
    })),
    ...(template.initContainers?.length ? { initContainers: template.initContainers } : {}),
  };
}

/** Credit consumption is collected: the module is on and the jobs read tenant data. @param {import('../../config.js').InstallConfig} config */
export const azureConsumptionOn = (config) => !!config.modules.consumption && config.azure?.sampleData !== true;

/** Microsoft Graph application permissions the jobs' managed identity needs. @param {import('../../config.js').InstallConfig} config */
export const azureGraphRoles = (config) => [...azureGraphRolesFor(config.modules), ...(azureConsumptionOn(config) && azureDropsToSharePoint(config.azure) ? ['Sites.Selected'] : [])];

/**
 * Credit consumption on Azure: where Copilot Studio and Cowork credits come from, the subscriptions the
 * jobs read Azure AI and pay-as-you-go costs from, the Studio flow's environment, and, with private
 * networking, the SharePoint folder the flow and uploads land in.
 * @param {Ctx} ctx
 * @param {{ subscriptionId: string, displayName: string }[]} subs
 */
export async function planAzureConsumption(ctx, subs) {
  const { ui, config } = ctx;
  const ds = config.dataSources;
  const az = /** @type {import('../../config.js').AzureConfig} */ (config.azure);
  if (config.modules.consumption && az.sampleData) ui.note('Demo mode has no credit consumption sample, so credit consumption is collected once you switch to your tenant\'s data.');
  if (!azureConsumptionOn(config)) {
    ds.studioCredits = 'skip';
    ds.coworkCredits = 'skip';
    ds.azureAi = 'skip';
    return;
  }
  ui.heading('Credit consumption');
  const studio = ds.studioCredits === 'csv' || ds.studioCredits === 'skip' ? ds.studioCredits : 'api';
  const cowork = ds.coworkCredits === 'skip' ? 'skip' : 'csv';
  if (!asksAdvanced(ctx)) {
    ds.studioCredits = studio;
    ds.coworkCredits = cowork;
  } else {
    ds.studioCredits = await ui.select('Where should Copilot Studio credits come from?', [
      { name: 'Power Platform licensing API (recommended)', value: 'api', description: 'A daily Power Automate flow, signed in as you, saves them for the jobs. The first run loads about six months.' },
      { name: 'CSV exports', value: 'csv', description: `Drop the Power Platform admin center's Copilot Studio exports in the ${AZURE_LANDING_DIRS.studio} folder yourself.` },
      { name: 'Leave Copilot Studio out', value: 'skip' },
    ], studio);
    ds.coworkCredits = await ui.select('Cowork credits', [
      { name: 'CSV export', value: 'csv', description: `Drop the Consumption Dashboard's Viva Insights export in the ${AZURE_LANDING_DIRS.viva} folder.` },
      { name: 'Leave Cowork out', value: 'skip' },
    ], cowork);
  }
  ds.azureAi = 'api';
  await planConsumption(ctx, /** @type {import('../plan.js').Preflight} */ (/** @type {unknown} */ ({ subscriptions: subs })));
  if (config.uploads.flowIdentity === 'app' && ds.studioCredits === 'api') ui.warn('On Azure the Studio flow signs in as you; --flow-identity app is Fabric only for now.');
  await planFlows(ctx);
  if (isPrivate(az) && (ds.studioCredits !== 'skip' || ds.coworkCredits !== 'skip')) {
    ui.note(`Private networking keeps ${az.namePrefix ?? 'the'} storage off the internet, where Power Automate runs, so the flow and your uploads go to a SharePoint folder the jobs read instead.`);
    const folderUrl = await ui.input('SharePoint folder for credit files (the address of a folder in a document library)', {
      default: az.drop?.folderUrl ?? '',
      validate: (v) => {
        try {
          parseDropFolder(v);
          return true;
        } catch (err) {
          return /** @type {Error} */ (err).message;
        }
      },
    });
    const parsed = parseDropFolder(folderUrl);
    az.drop = { ...parsed, granted: az.drop?.siteId === parsed.siteId ? az.drop?.granted : false };
  } else delete az.drop;
}

/**
 * Agent configuration and Foundry from Azure Resource Graph: whether the jobs read them, where, and the
 * agent inventory flow for when Resource Graph returns no agents.
 * @param {Ctx} ctx
 */
export async function planAzureResourceGraph(ctx) {
  const { ui, config } = ctx;
  const ds = config.dataSources;
  const az = /** @type {import('../../config.js').AzureConfig} */ (config.azure);
  if (az.sampleData) {
    ds.resourceGraph = 'skip';
    return;
  }
  const source = DATA_SOURCES.find((s) => s.id === 'resourceGraph');
  if (asksAdvanced(ctx)) {
    ui.heading('Agent configuration and Foundry');
    ds.resourceGraph = await ui.select(`${source?.label ?? 'Azure Resource Graph'}?`, [
      { name: 'Read from Azure Resource Graph', value: 'api', description: source?.hints?.api },
      { name: 'Leave it out', value: 'skip' },
    ], ds.resourceGraph === 'api' ? 'api' : 'skip');
  } else ds.resourceGraph = ds.resourceGraph === 'api' ? 'api' : 'skip';
  await planResourceGraph(ctx);
  if (!resourceGraphOn(config) || config.resourceGraph?.agents === false) return;
  if (isPrivate(az) && !azureDropsToSharePoint(az)) {
    ui.note('With private networking and no SharePoint drop folder, there is no agent inventory flow: the jobs read agents from Resource Graph only.');
    return;
  }
  if (!config.uploads.flowEnvironment) await planFlows(ctx);
}

/**
 * Works out, offline, where a SharePoint folder lives: the site for the flow's connector and the jobs'
 * Graph calls, and the folder's path. Accepts the folder's address or an AllItems.aspx link to it.
 * @param {string} input
 * @returns {import('../../config.js').AzureDrop}
 */
export function parseDropFolder(input) {
  const text = String(input ?? '').trim();
  /** @type {URL} */
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error('Paste the folder\'s https:// address, like https://contoso.sharepoint.com/sites/Analytics/Shared Documents/ValueLens.');
  }
  if (url.protocol !== 'https:' || !/\.sharepoint\.com$/i.test(url.hostname)) throw new Error('Use a SharePoint Online folder address (https://<tenant>.sharepoint.com/...).');
  const fromId = url.searchParams.get('id');
  let path = (fromId ?? decodeURIComponent(url.pathname)).replace(/\/+$/, '');
  path = path.replace(/\/Forms\/[^/]+\.aspx$/i, '').replace(/\/[^/]+\.aspx$/i, '');
  const site = /^\/(sites|teams)\/[^/]+/i.exec(path)?.[0] ?? '';
  const rest = path.slice(site.length).replace(/^\/+/, '');
  if (!rest) throw new Error('That is a site, not a folder. Open a document library folder and copy its address.');
  return {
    folderUrl: `${url.origin}${site}/${rest}`,
    siteUrl: `${url.origin}${site}`,
    sitePath: `/${rest}`,
    siteId: site ? `${url.hostname}:${site}` : url.hostname,
    driveId: '',
    drivePath: rest,
  };
}

/**
 * Credit consumption access: Azure roles for the jobs' managed identity to read Azure AI and
 * pay-as-you-go costs, and write access to wherever the credit files land.
 * @param {Ctx} ctx
 */
async function ensureAzureConsumptionAccess(ctx) {
  const { config } = ctx;
  const az = /** @type {import('../../config.js').AzureConfig} */ (config.azure);
  const principalId = az.outputs?.identityPrincipalId;
  if (!principalId) throw new Error('The ARM deployment did not return identityPrincipalId.');
  if (config.dataSources.azureAi === 'api') await ensureAzureAiAccess(ctx, { id: principalId, name: 'The jobs\' managed identity', appId: az.outputs?.identityClientId });
  else ctx.ui.note('Azure AI is left out.');
  if (config.dataSources.studioCredits === 'skip' && config.dataSources.coworkCredits === 'skip') return;
  if (azureDropsToSharePoint(az)) await grantDropSite(ctx);
  else await grantLandingWrite(ctx);
}

/**
 * Resource Graph access: Reader on the management group for the jobs' managed identity, so they can
 * list Foundry, and write access for the agent inventory flow to wherever its files land.
 * @param {Ctx} ctx
 */
async function ensureAzureResourceGraphAccess(ctx) {
  const { config } = ctx;
  const az = /** @type {import('../../config.js').AzureConfig} */ (config.azure);
  const principalId = az.outputs?.identityPrincipalId;
  if (!principalId) throw new Error('The ARM deployment did not return identityPrincipalId.');
  await ensureResourceGraphAccess(ctx, { id: principalId, name: 'The jobs\' managed identity', appId: az.outputs?.identityClientId }, 'azureAccess');
  if (flowsWanted(config).includes('agents') && !azureDropsToSharePoint(az)) await grantLandingWrite(ctx);
}

/**
 * Gives the jobs' managed identity read on the drop folder's site (Sites.Selected). Needs a SharePoint
 * or Global administrator; otherwise it's left as an admin action.
 * @param {Ctx} ctx
 */
async function grantDropSite(ctx) {
  const { ui, api } = ctx;
  const az = /** @type {import('../../config.js').AzureConfig} */ (ctx.config.azure);
  const drop = az.drop;
  const appId = az.outputs?.identityClientId;
  if (!drop?.siteId || !appId) return;
  const name = `${az.namePrefix ?? 'vlens'} jobs`;
  if (drop.granted) {
    ui.ok(`The jobs can read ${drop.siteUrl}`);
    return;
  }
  const action = `Grant-PnPAzureADAppSitePermission -AppId ${appId} -DisplayName "${name}" -Site ${drop.siteUrl} -Permissions Read`;
  try {
    const site = await api.graph.site(drop.siteId);
    await api.graph.grantSiteRead(site.id, appId, name);
    drop.granted = true;
    az.status ??= {};
    az.status.pendingAdminActions = (az.status.pendingAdminActions ?? []).filter((a) => a !== action);
    ui.ok(`Gave the jobs read on ${drop.siteUrl}`);
  } catch (err) {
    ui.warn(`Couldn't give the jobs read on ${drop.siteUrl} (${/** @type {Error} */ (err).message.split('\n')[0]}). A SharePoint administrator can run: ${action}`);
    az.status ??= {};
    az.status.pendingAdminActions = [...new Set([...(az.status.pendingAdminActions ?? []), action])];
  }
  ctx.save();
}

/**
 * Gives the person installing Storage Blob Data Contributor on the storage account, so the Studio
 * flow's storage connection, signed in as them, can write to the landing container.
 * @param {Ctx} ctx
 * @param {string} [why]  What the role is for, e.g. "for the Studio flow".
 * @returns {Promise<boolean>} false when you can't assign it.
 */
export async function grantLandingWrite(ctx, why = 'for the Studio flow') {
  const { ui, api, user } = ctx;
  const az = /** @type {import('../../config.js').AzureConfig} */ (ctx.config.azure);
  const account = az.outputs?.storageAccountName;
  if (!account) return false;
  if (az.storageRole) return true;
  const scope = `/subscriptions/${az.subscriptionId}/resourceGroups/${az.resourceGroup}/providers/Microsoft.Storage/storageAccounts/${account}`;
  try {
    await api.arm.assignRole(scope, ROLES.storageBlobDataContributor, user.id, 'User');
    az.storageRole = true;
    ui.ok(`Gave you Storage Blob Data Contributor on ${account}, ${why}`);
  } catch (err) {
    if (!(err instanceof HttpError) || err.status !== 403) throw err;
    ui.warn(`You can't assign roles on ${account}. Someone needs Storage Blob Data Contributor on it ${why}.`);
    return false;
  } finally {
    ctx.save();
  }
  return true;
}

/** @param {Ctx} ctx */
export async function azurePreflight(ctx) {
  const { ui, config, api } = ctx;
  const az = /** @type {import('../../config.js').AzureConfig} */ (config.azure);
  ui.heading('Checking Azure');
  az.installId ??= randomUUID();
  for (const ns of [...AZURE_PROVIDERS, ...(isPrivate(az) ? PRIVATE_PROVIDERS : []), ...(askMode(az) === 'create' ? ASK_PROVIDERS : [])]) await api.arm.ensureProvider(/** @type {string} */ (az.subscriptionId), ns).catch((err) => ui.warn(`Couldn't register ${ns}: ${err.message}`));
  // A VNet-integrated Container Apps environment fails with SubscriptionNotRegisteredForFeature unless this flag is on.
  if (isPrivate(az)) await api.arm.ensureFeature(/** @type {string} */ (az.subscriptionId), ...PRIVATE_FEATURE).catch((err) => ui.warn(`Couldn't register the ${PRIVATE_FEATURE.join('/')} feature: ${err.message}`));
  if (isPrivate(az) && !az.powerBi?.capacityId) throw new Error('Private networking needs a Fabric or Premium capacity for the Power BI VNet data gateway. Run the installer without --yes to choose one.');
  const envName = String(az.outputs?.environmentName ?? '');
  if (envName && isPrivate(az) !== envName.endsWith('-vnet')) throw new Error(`This install already runs with ${envName.endsWith('-vnet') ? 'private networking' : 'public endpoints'}. Container Apps can't change networking in place, so uninstall and install again to switch.`);
  az.status ??= {};
  ctx.teamsCatalog ??= await checkCatalogAccess(ctx);
  if (!az.outputs?.sqlServerFqdn) {
    const sqlRegion = az.sqlLocation || /** @type {string} */ (az.location);
    const cap = await api.arm.sqlCapability(/** @type {string} */ (az.subscriptionId), sqlRegion).catch(() => null);
    if (cap && !/^(Available|Default)$/i.test(String(cap.status))) {
      throw new Error(`This subscription can't create Azure SQL servers in ${sqlRegion}${cap.reason ? `: ${cap.reason}` : '.'} Re-run the installer and pick a different Azure SQL region (for example ukwest, swedencentral or francecentral); everything else stays in ${az.location}.`);
    }
  }
  // ARM validate and what-if need the resource group, and nothing is created before the plan is approved.
  const rgExists = await api.arm.getResourceGroup(/** @type {string} */ (az.subscriptionId), /** @type {string} */ (az.resourceGroup)).then((g) => !!g, () => false);
  if (!rgExists) {
    ui.note(`Resource group ${az.resourceGroup} is new, so every resource will be created. Azure checks policy when it deploys.`);
    az.status.whatIf = [
      { resourceType: 'Microsoft.Resources/resourceGroups', name: az.resourceGroup, changeType: 'Create' },
      ...newResourceGroupResources(az),
    ];
    return;
  }
  const deployment = await azureDeployment(ctx, { pass: 1 });
  try {
    await api.arm.validateDeployment(/** @type {string} */ (az.subscriptionId), /** @type {string} */ (az.resourceGroup), 'valuelens-validate', deployment);
  } catch (err) {
    const msg = explain(err, az);
    if (msg) throw new Error(msg);
    throw err;
  }
  const changes = await api.arm.whatIfDeployment(/** @type {string} */ (az.subscriptionId), /** @type {string} */ (az.resourceGroup), 'valuelens-whatif', deployment).catch((err) => {
    const msg = explain(err, az);
    if (msg) throw new Error(msg);
    throw err;
  });
  az.status.whatIf = changes?.properties?.changes ?? changes?.changes ?? [];
  await stopOnUntaggedCollisions(ctx);
}

/**
 * What a first deployment into a new resource group creates, for the plan review.
 * @param {import('../../config.js').AzureConfig} az
 */
export function newResourceGroupResources(az) {
  const p = az.namePrefix ?? 'vlens';
  return [
    ['Microsoft.ManagedIdentity/userAssignedIdentities', `${p}-jobs identity`],
    ['Microsoft.Storage/storageAccounts', 'ADLS Gen2 data lake'],
    ['Microsoft.OperationalInsights/workspaces', 'Log Analytics'],
    ['Microsoft.Sql/servers', 'Azure SQL server and serverless database'],
    ['Microsoft.App/managedEnvironments', 'Container Apps environment'],
    ['Microsoft.App/jobs', 'run and migrate jobs'],
    ['Microsoft.App/containerApps', 'web app'],
    ...(isPrivate(az) ? [
      ['Microsoft.Network/virtualNetworks', 'VNet with apps, private endpoint and Power BI gateway subnets'],
      ['Microsoft.Network/networkSecurityGroups', 'network security group on the VNet\'s subnets'],
      ['Microsoft.Network/privateEndpoints', `private endpoints for SQL, blob, dfs and table${askMode(az) === 'create' ? ', and Ask' : ''}`],
      ...(az.privateDns?.mode === 'existing' ? [['Microsoft.Network/privateDnsZones/virtualNetworkLinks', 'links from the VNet to the existing private DNS zones']]
        : az.privateDns?.mode === 'none' ? [] : [['Microsoft.Network/privateDnsZones', 'private DNS zones linked to the VNet']]),
    ] : []),
    ...(askMode(az) === 'create' ? [['Microsoft.CognitiveServices/accounts', `Azure AI Services account and ${az.ask?.deployment ?? 'model'} deployment for Ask`]] : []),
  ].map(([resourceType, name]) => ({ resourceType, name, changeType: 'Create' }));
}

/** @param {Ctx} ctx */
async function stopOnUntaggedCollisions(ctx) {
  const az = /** @type {import('../../config.js').AzureConfig} */ (ctx.config.azure);
  const resources = await ctx.api.arm.listResources(/** @type {string} */ (az.subscriptionId), /** @type {string} */ (az.resourceGroup)).catch(() => []);
  const offenders = resources.filter((r) => String(r.name ?? '').toLowerCase().startsWith(String(az.namePrefix).toLowerCase()) && r.tags?.['valuelens-install-id'] !== az.installId);
  if (offenders.length) throw new Error(`Resource name collision: ${offenders.map((r) => `${r.type}/${r.name}`).join(', ')} already exists without this install's tag. Analytics Hub will not modify resources it did not create.`);
}

/** @param {Ctx} ctx @param {{ pass: 1 | 2 }} o */
export async function azureDeployment(ctx, o) {
  const { config, user } = ctx;
  const az = /** @type {import('../../config.js').AzureConfig} */ (config.azure ?? {});
  const liveSql = /** @type {{ minCapacity?: number, capacity?: number, autoPauseDelay?: number, useFreeLimit?: boolean }} */ (await liveSqlSettings(ctx).catch(() => ({})));
  const params = {
    location: param(az.location), sqlLocation: param(az.sqlLocation ?? ''), namePrefix: param(az.namePrefix ?? 'vlens'), installId: param(az.installId ?? randomUUID()),
    tags: param({ ...(az.tags ?? {}), 'valuelens-install-id': az.installId }), imageRegistry: param(az.images?.registry || DEFAULT_IMAGE_REGISTRY), imageTag: param(imageTag(az)),
    imageRegistryResourceId: param(az.images?.registryResourceId ?? ''),
    runSchedule: param(azureCron(config.schedule)), runSteps: param('collect,process,publish,refresh'), sampleData: param(az.sampleData === true),
    // The jobs' managed identity stays the Entra admin (empty = identity) so migrate can run DDL.
    // The SQL reader only gets db_datareader, created by SID from sqlReaderClientId.
    sqlAdminLogin: param(''), sqlAdminObjectId: param(''), sqlAdminPrincipalType: param('Application'),
    sqlMinCapacity: param(String(liveSql.minCapacity ?? '0.5')), sqlMaxCapacity: param(liveSql.capacity ?? 2), sqlAutoPauseDelayMinutes: param(liveSql.autoPauseDelay ?? 60), sqlUseFreeLimit: param(liveSql.useFreeLimit ?? az.sqlFreeOffer ?? true),
    publicNetworkAccess: param(az.publicNetworkAccess === false ? 'Disabled' : 'Enabled'), deployWeb: param(true), webMinReplicas: param(0),
    privateDnsZoneMode: param(az.privateDns?.mode ?? 'create'), privateDnsZonesResourceGroupId: param(az.privateDns?.mode === 'existing' ? (az.privateDns.resourceGroupId ?? '') : ''),
    webClientId: param(o.pass === 2 ? (az.webApp?.clientId ?? '') : ''), webAppIdUri: param(o.pass === 2 ? (az.webApp?.appIdUri ?? '') : ''), webAccess: param(webAccess(config)),
    modules: param([...enabledAzureModuleIds(config.modules, az), ...(azureResourceGraphOn(config) ? ['resourceGraph'] : [])].join(',')), auditHistoryDays: param(Math.max(config.history.days, ctx.reloadHistoryDays ?? 0)), powerBiWorkspaceId: param(az.powerBi?.workspaceId ?? ''),
    semanticModels: param(JSON.stringify(azureSemanticModels(az))),
    sqlReaderName: param(SQL_READER_NAME), sqlReaderClientId: param(o.pass === 2 ? (az.sqlReader?.clientId ?? '') : ''),
    reportingCurrency: param(config.reporting?.currency ?? DEFAULT_CURRENCY), exchangeRate: param(config.reporting?.exchangeRate ? String(config.reporting.exchangeRate) : ''),
    ...consumptionParameters(config),
    ...argParameters(config),
    ...askParameters(config),
  };
  return { properties: { mode: 'Incremental', template: ARM, parameters: params } };
}

/**
 * The models the web app may query, by the alias the pages use.
 * @param {import('../../config.js').AzureConfig} az
 */
export function azureSemanticModels(az) {
  const pbi = az.powerBi ?? {};
  return {
    ...(pbi.datasetId ? { [APP_ALIAS]: { workspaceId: pbi.workspaceId, itemId: pbi.datasetId } } : {}),
    ...(pbi.consumptionDatasetId ? { [CONSUMPTION_ALIAS]: { workspaceId: pbi.workspaceId, itemId: pbi.consumptionDatasetId } } : {}),
  };
}

/**
 * The models the viewer group needs Build on: the ones the web app queries.
 * @param {import('../../config.js').InstallConfig} config
 * @returns {import('../access.js').ModelRef[]}
 */
export function azureViewerModels(config) {
  const pbi = config.azure?.powerBi ?? {};
  if (!pbi.workspaceId) return [];
  return [
    ...(pbi.datasetId ? [{ workspaceId: pbi.workspaceId, datasetId: pbi.datasetId, name: config.semanticModel.name }] : []),
    ...(pbi.consumptionDatasetId ? [{ workspaceId: pbi.workspaceId, datasetId: pbi.consumptionDatasetId, name: config.consumption.model.name }] : []),
  ];
}

/**
 * Who the web app lets in besides its app roles, and who people ask for access. Empty without a group.
 * @param {import('../../config.js').InstallConfig} config
 */
export function webAccess(config) {
  const access = publicAccess(config);
  return access ? JSON.stringify(access) : '';
}

/**
 * What the run job reads for credit consumption: the Azure AI and pay-as-you-go subscriptions it has
 * access to, and with private networking, the SharePoint drop folder.
 * @param {import('../../config.js').InstallConfig} config
 */
export function consumptionParameters(config) {
  const on = azureConsumptionOn(config);
  const cc = config.consumption;
  const drop = on ? config.azure?.drop : undefined;
  return {
    azureAiSubscriptionId: param(on && config.dataSources.azureAi === 'api' && cc.azureAccess && cc.azureSubscriptionId ? cc.azureSubscriptionId : ''),
    paygSubscriptionIds: param(on && config.dataSources.azureAi === 'api' ? (cc.paygSubscriptions ?? []).filter((p) => p.access).map((p) => p.subscriptionId).join(',') : ''),
    dropSiteId: param(drop?.siteId ?? ''),
    dropDriveId: param(drop?.driveId ?? ''),
    dropFolder: param(drop?.drivePath ?? ''),
  };
}

/**
 * The jobs read agent configuration and Foundry from Azure Resource Graph: the source is on and they read tenant data.
 * @param {import('../../config.js').InstallConfig} config
 */
export const azureResourceGraphOn = (config) => resourceGraphOn(config) && config.azure?.sampleData !== true;

/**
 * What the run job reads from Azure Resource Graph: the management group (blank for the tenant root) and what to read there.
 * @param {import('../../config.js').InstallConfig} config
 */
export function argParameters(config) {
  const rg = normaliseResourceGraph(config.resourceGraph);
  return {
    argManagementGroup: param(rg.managementGroup ?? ''),
    argAgents: param(rg.agents),
    argFoundry: param(rg.foundry),
  };
}

/** @param {import('../../catalog.js').ModuleChoice} modules @param {import('../../config.js').AzureConfig} [az] */
export function enabledAzureModuleIds(modules, az) {
  return AZURE_SUPPORTED_MODULES.filter((id) => id === 'core' || (id === 'consumption' && az?.sampleData === true ? false : modules[/** @type {keyof import('../../catalog.js').ModuleChoice} */ (id)]));
}

/** @param {Ctx} ctx */
async function liveSqlSettings(ctx) {
  const az = ctx.config.azure;
  const out = az?.outputs ?? {};
  if (!out.sqlServerFqdn || !out.sqlDatabaseName) return {};
  if (!az?.subscriptionId || !az.resourceGroup) return {};
  const server = String(out.sqlServerFqdn).split('.')[0];
  const db = await ctx.api.arm.getSqlDatabase(/** @type {string} */ (az.subscriptionId), /** @type {string} */ (az.resourceGroup), server, String(out.sqlDatabaseName));
  return { capacity: db?.sku?.capacity, minCapacity: db?.properties?.minCapacity, autoPauseDelay: db?.properties?.autoPauseDelay, useFreeLimit: db?.properties?.useFreeLimit };
}

/** @param {Ctx} ctx */
export function azurePlanReview(ctx) {
  const az = /** @type {import('../../config.js').AzureConfig} */ (ctx.config.azure);
  const grouped = whatIfSummary(az.status?.whatIf ?? []);
  /** @type {{ kind: string, name: string, detail?: string, isNew: boolean }[]} */
  const creates = Object.entries(grouped).flatMap(([type, g]) => [
    ...g.create.map((name) => ({ kind: type, name, isNew: true })),
    ...g.modify.map((name) => ({ kind: type, name, isNew: false, detail: 'Modify' })),
    ...g.nochange.map((name) => ({ kind: type, name, isNew: false, detail: 'No change' })),
    ...g.delete.map((name) => ({ kind: type, name, isNew: false, detail: 'Delete never (incremental deployment)' })),
  ]);
  if (!creates.length) creates.push({ kind: 'Azure resources', name: `${az.namePrefix} in ${az.resourceGroup}`, isNew: !az.outputs?.webName, detail: 'ARM what-if returned no changes.' });
  creates.push({ kind: 'Teams package', name: 'AnalyticsHub-Teams.zip', isNew: !az.teamsPackage, detail: 'Written next to the install record.' });
  creates.push(teamsAppPlanRow(ctx, manifestVersion(pkgVersion())));
  const access = accessReview(ctx.config, `Power BI workspace ${az.powerBi?.workspaceId ?? az.workspaceName ?? 'Analytics Hub'}`);
  creates.push(...access.creates);
  if (isPrivate(az)) {
    creates.push({ kind: 'Power BI VNet data gateway', name: gatewayName(az), isNew: !az.powerBi?.gatewayId, detail: `On capacity ${az.powerBi?.capacityId ?? 'not chosen'}, in the VNet's Power BI subnet.` });
    creates.push({ kind: 'Power BI connection', name: connectionName(az), isNew: !az.powerBi?.connectionId, detail: 'Azure SQL through the VNet data gateway, signed in as the SQL reader app.' });
  }
  const consumption = azureConsumptionOn(ctx.config);
  const cc = ctx.config.consumption;
  if (az.powerBi?.datasetId) creates.push({ kind: 'Semantic model', name: ctx.config.semanticModel.name, isNew: false, detail: MODEL_UPDATE_NOTE });
  if (consumption && ctx.sources.consumptionModelFile) creates.push({ kind: 'Semantic model', name: cc.model.name, isNew: !az.powerBi?.consumptionDatasetId, detail: `Credit consumption, reading Azure SQL like the main model.${az.powerBi?.consumptionDatasetId ? ` ${MODEL_UPDATE_NOTE}` : ''}` });
  if (consumption && flowsWanted(ctx.config).includes('studio')) creates.push({ kind: 'Power Automate flow', name: 'Copilot Studio credits', isNew: !ctx.config.uploads.flowIds?.studio, detail: `Daily, signed in as you; saves to ${azureDropLabel(az)}. The installer helps you sign in to its connections, then turns it on.` });
  if (flowsWanted(ctx.config).includes('agents')) creates.push({ kind: 'Power Automate flow', name: 'Agent inventory', isNew: !ctx.config.uploads.flowIds?.agents, detail: `Daily, signed in as an admin; saves to ${azureDropLabel(az, AZURE_LANDING_DIRS.argInventory)} for when Resource Graph returns no agents. The installer helps you sign in to its connections, then turns it on.` });
  /** @type {{ who: string, what: string, where: string, detail?: string }[]} */
  const consumptionGrants = [];
  if (consumption && cc.azureSubscriptionId && ctx.config.dataSources.azureAi === 'api') consumptionGrants.push({ who: 'Collector managed identity', what: AZURE_AI_ROLES.map((r) => r.name).join(', '), where: `Subscription ${cc.azureSubscriptionName ?? cc.azureSubscriptionId}`, detail: 'Azure AI costs and metrics.' });
  if (consumption && cc.paygSubscriptions?.length) consumptionGrants.push({ who: 'Collector managed identity', what: 'Cost Management Reader', where: cc.paygSubscriptions.map((p) => p.name ?? p.subscriptionId).join(', '), detail: 'Copilot pay-as-you-go billed in Azure.' });
  if (consumption && az.drop) consumptionGrants.push({ who: 'Collector managed identity', what: 'Sites.Selected (read)', where: az.drop.siteUrl ?? az.drop.folderUrl, detail: 'Reads the credit files. Needs a SharePoint or Global administrator.' });
  else if (consumption && (ctx.config.dataSources.studioCredits !== 'skip' || ctx.config.dataSources.coworkCredits !== 'skip')) consumptionGrants.push({ who: 'You', what: 'Storage Blob Data Contributor', where: 'The storage account', detail: 'So the Studio flow, signed in as you, and your uploads can write to the landing container.' });
  else if (flowsWanted(ctx.config).includes('agents') && !az.drop) consumptionGrants.push({ who: 'You', what: 'Storage Blob Data Contributor', where: 'The storage account', detail: 'So the agent inventory flow can write to the landing container.' });
  const argGrants = azureResourceGraphOn(ctx.config) ? resourceGraphGrants(ctx.config, ctx.user?.tenantId ?? '', 'Collector managed identity', 'azureAccess') : [];
  return {
    creates,
    grants: [
      { who: 'Collector managed identity', what: `Microsoft Graph application permissions: ${azureGraphRoles(ctx.config).join(', ')}`, where: 'Microsoft Graph', detail: 'Installer assigns app roles or records admin action if blocked.' },
      { who: WEB_APP_NAME, what: `Delegated Power BI Dataset.Read.All and Graph User.Read${ctx.config.access ? ', GroupMember.ReadWrite.All' : ''}; app roles AnalyticsHub.User and AnalyticsHub.Admin`, where: 'Entra ID', ...(ctx.config.access ? { detail: 'GroupMember.ReadWrite.All lets admins and group owners manage viewers from Share in the app, as themselves.' } : {}) },
      { who: 'Managed identity', what: 'Member', where: az.powerBi?.workspaceId ? `Power BI workspace ${az.powerBi.workspaceId}` : `Power BI workspace ${az.workspaceName ?? 'Analytics Hub'}` },
      ...access.grants,
      ...consumptionGrants,
      ...argGrants,
      ...askGrants(az),
    ],
    runsOn: [
      { what: 'Azure resources', where: `${az.subscriptionName ?? az.subscriptionId} / ${az.resourceGroup} / ${az.location}`, detail: `Incremental ARM deployment. Deletes are not applied by the template.${az.sqlLocation ? ` Azure SQL goes in ${az.sqlLocation}.` : ''}` },
      { what: 'Scheduled jobs', where: `Container Apps job, ${ctx.config.schedule.frequency} at ${ctx.config.schedule.time} UTC`, ...(az.sampleData ? { detail: 'Demo mode: each run publishes the synthetic sample instead of tenant data.' } : {}) },
      { what: 'Cost', where: `Indicative Azure cost: about $5-40/month small tenants or $60-160/month large tenants, plus Power BI Pro/PPU licences.${isPrivate(az) ? ' Private networking adds about $30-40/month (4 private endpoints and DNS zones); the VNet data gateway uses capacity units on your Fabric/Premium capacity while refreshing.' : ''}` },
      ...(ctx.reloadHistoryDays ? [{ what: 'History reload', where: reloadLine(ctx.reloadHistoryDays), detail: `The run job, once, with ${BACKFILL_ENV}=${ctx.reloadHistoryDays}. ${reloadDetail(ctx.reloadHistoryDays)}` }] : []),
    ],
    costs: planCosts(ctx.config),
  };
}

/**
 * What to tell someone whose Azure sizing looks too small for the seats assigned. Says which setting
 * changes it, and how to carry on when policy rules the change out. Only warns: nothing is resized.
 * @param {{ seats?: number, sampleData?: boolean, sqlFreeLimit?: boolean, sqlMaxVcores?: number, powerBiCapacityId?: string }} o
 * @returns {string[]}
 */
export function azureSizingWarnings({ seats, sampleData, sqlFreeLimit, sqlMaxVcores, powerBiCapacityId }) {
  if (!seats || sampleData || seats <= LARGE_TENANT_SEATS) return [];
  const n = seatCount(seats);
  /** @type {string[]} */
  const out = [];
  if (sqlFreeLimit !== false) {
    out.push(
      `${n} Copilot seats are assigned and Azure SQL uses the free offer (100,000 vCore seconds and 32 GB a month). A tenant this size will likely use that up, and the database then pauses until next month. ` +
        'After setup, open the database\'s Compute + storage in the Azure portal and choose to continue using it for additional charges when the free limit is reached, or ask your Azure admin to. If your organisation\'s policy keeps the free limit, expect the jobs to stop when it runs out.',
    );
  }
  if (seats >= BIG_CAPACITY_SEATS && (sqlMaxVcores ?? DEFAULT_SQL_MAX_VCORES) < 4) {
    out.push(
      `${n} Copilot seats are assigned and Azure SQL scales up to ${sqlMaxVcores ?? DEFAULT_SQL_MAX_VCORES} vCores. After setup, raise the database's max vCores to 4 or more in the Azure portal (Compute + storage), or ask your Azure admin to; a policy that caps vCores means slower loads.`,
    );
  }
  if (seats >= BIG_CAPACITY_SEATS) {
    out.push(
      `${n} Copilot seats are assigned. Each run of the collector job has ${RUN_JOB_SIZE} and up to 4 hours, so a long first load may not fit in one run. In Schedule and loading, start with 30 days of history and reload more once the first load finishes.`,
    );
  }
  if (!powerBiCapacityId) {
    out.push(
      `${n} Copilot seats are assigned and the Power BI workspace is on shared capacity, where a semantic model is limited to 1 GB. In Power BI, choose a Fabric (F) or Premium capacity, or ask your capacity admin for one. If policy keeps you on shared capacity, the model may stop refreshing as the data grows.`,
    );
  }
  return out;
}

/** What the collector run job gets per run (azure/infra/modules/containerapps.bicep). */
const RUN_JOB_SIZE = '4 vCPU and 8 GiB';
/** azure/infra/modules/sql.bicep maxCapacity, used when the database doesn't exist yet. */
const DEFAULT_SQL_MAX_VCORES = 2;

/** @param {Ctx} ctx */
export async function confirmAzurePlan(ctx) {
  const { ui, config } = ctx;
  const az = /** @type {import('../../config.js').AzureConfig} */ (config.azure);
  ui.heading('Ready to set up');
  ui.info('Target:      Your Azure subscription');
  ui.info(`Data:        ${az.sampleData ? 'Demo mode (synthetic sample data)' : collectedLabels(config.modules).join(', ')}`);
  const seats = await copilotSeats(ctx.api);
  if (seats && !az.sampleData) ui.info(`Tenant:      ${seatCount(seats)} Microsoft 365 Copilot seats assigned`);
  ui.info(`Azure:       ${az.subscriptionName ?? az.subscriptionId} / ${az.resourceGroup} / ${az.location}`);
  if (az.sqlLocation) ui.info(`Azure SQL:   ${az.sqlLocation}`);
  ui.info(`Networking:  ${isPrivate(az) ? 'Private (VNet, private endpoints, Power BI VNet data gateway)' : 'Public endpoints'}`);
  ui.info(`Prefix:      ${az.namePrefix}`);
  ui.info(`Power BI:    ${az.powerBi?.workspaceId ? `Workspace ${az.powerBi.workspaceId}` : `New workspace ${az.workspaceName ?? 'Analytics Hub'}`}`);
  ui.info(`Schedule:    ${config.schedule.frequency === 'weekly' ? `${config.schedule.weekday}s` : 'Daily'} at ${config.schedule.time} UTC`);
  if (azureConsumptionOn(config)) {
    const ds = config.dataSources;
    const studio = { api: 'Power Platform licensing API (daily flow)', csv: 'CSV exports', skip: 'Left out' }[ds.studioCredits] ?? ds.studioCredits;
    ui.info(`Studio:      ${studio}${ds.studioCredits === 'skip' ? '' : `, in ${azureDropLabel(az)}`}`);
    ui.info(`Cowork:      ${ds.coworkCredits === 'csv' ? 'CSV export' : 'Left out'}`);
    ui.info(`Azure AI:    ${ds.azureAi === 'api' && config.consumption.azureSubscriptionId ? config.consumption.azureSubscriptionName ?? config.consumption.azureSubscriptionId : 'Left out'}`);
  }
  if (azureResourceGraphOn(config)) ui.info(`Governance:  ${resourceGraphKinds(config)} from Azure Resource Graph, in ${scopeName(config)}`);
  ui.info(`Ask:         ${askLine(az)}`);
  if (ctx.reloadHistoryDays) ui.info(`History:     ${reloadLine(ctx.reloadHistoryDays)}`);
  const liveSql = /** @type {{ capacity?: number, useFreeLimit?: boolean }} */ (await liveSqlSettings(ctx).catch(() => ({})));
  const sizing = azureSizingWarnings({
    seats, sampleData: az.sampleData, sqlFreeLimit: liveSql.useFreeLimit ?? az.sqlFreeOffer ?? true,
    sqlMaxVcores: liveSql.capacity, powerBiCapacityId: az.powerBi?.capacityId,
  });
  for (const w of sizing) ui.warn(w);
  // Before the review, which shows the answer. The web UI takes a question after the review as the plan's own.
  await askToPublishTeamsApp(ctx, manifestVersion(pkgVersion()));
  ui.review(azurePlanReview(ctx));
  ui.note(keepAwake());
  return ui.confirm('Go ahead?', true);
}

/**
 * @param {Ctx} ctx @param {{ wait: boolean }} opts
 * @returns {Promise<boolean>} false when a model owed a reload couldn't be reloaded, or (waiting) didn't finish.
 */
export async function installAzure(ctx, opts) {
  const { ui, config, api } = ctx;
  const az = /** @type {import('../../config.js').AzureConfig} */ (config.azure ??= {});
  az.installId ??= randomUUID();
  ctx.save();
  // Any sign-in comes now, while whoever approved the plan is still there, not at the end.
  await signInForTeamsApp(ctx, manifestVersion(pkgVersion()));
  az.imageTag = imageTag(az);
  const consumption = azureConsumptionOn(config);
  const resourceGraph = azureResourceGraphOn(config);
  const flows = flowsWanted(config).length > 0;
  const withAccess = !!config.access;
  const askAccess = askMode(az) === 'existing';
  const titles = [
    'Resource group', 'Azure resources', 'Entra applications', 'Microsoft Graph permissions', ...(consumption ? ['Credit consumption'] : []), ...(resourceGraph ? ['Resource Graph access'] : []),
    ...(askAccess ? ['Ask model access'] : []),
    'Power BI model', ...(withAccess ? ['Viewer access'] : []), 'Azure resources (final)', 'Database migration', ...(rlsOn(config) ? ['Org-scoped access'] : []),
    ...(flows ? ['Power Automate flow'] : []), 'Teams app', ...(ctx.reloadHistoryDays ? ['Reload audit history'] : ctx.runFirstLoad ? ['First load'] : []),
  ];
  let n = 0;
  const step = (/** @type {string} */ title) => ui.step(++n, titles.length, title);

  step('Resource group');
  const rg = await api.arm.getResourceGroup(/** @type {string} */ (az.subscriptionId), /** @type {string} */ (az.resourceGroup)).catch(() => null);
  if (!rg) {
    await api.arm.ensureResourceGroup(/** @type {string} */ (az.subscriptionId), /** @type {string} */ (az.resourceGroup), /** @type {string} */ (az.location), { ...(az.tags ?? {}), 'valuelens-install-id': az.installId });
    az.createdResourceGroup = true;
    ui.ok(`Created resource group ${az.resourceGroup}`);
  } else ui.ok(`Using resource group ${az.resourceGroup}`);
  // Recorded once the group exists: a failure before this leaves nothing to reuse, so placement stays editable.
  az.deploymentConfig = {
    subscriptionId: az.subscriptionId, resourceGroup: az.resourceGroup, namePrefix: az.namePrefix,
    location: az.location, sqlLocation: az.sqlLocation, publicNetworkAccess: az.publicNetworkAccess,
  };
  ctx.save();

  step('Azure resources');
  recordDeployment(az, await deployOrExplain(ctx, { pass: 1 }));
  ctx.save();

  step('Entra applications');
  await ensureAzureWebApp(ctx);
  const sqlSecret = await ensureSqlReader(ctx);
  ctx.save();

  step('Microsoft Graph permissions');
  await assignManagedIdentityGraphRoles(ctx);
  ctx.save();

  if (consumption) {
    step('Credit consumption');
    await ensureAzureConsumptionAccess(ctx);
    ctx.save();
  }

  if (resourceGraph) {
    step('Resource Graph access');
    await ensureAzureResourceGraphAccess(ctx);
    ctx.save();
  }

  if (askAccess) {
    step('Ask model access');
    await ensureAzureAskAccess(ctx);
  }

  step('Power BI model');
  await ensureAzurePowerBi(ctx, sqlSecret.value);
  await useSqlSecret(ctx, sqlSecret);
  ctx.save();

  if (withAccess) {
    step('Viewer access');
    if (await ensureViewerGroup(ctx)) await grantModelAccess(ctx, azureViewerModels(config));
  }

  step('Azure resources (final)');
  recordDeployment(az, await deployOrExplain(ctx, { pass: 2 }));
  ctx.save();

  step('Database migration');
  const migration = await startAndWaitJob(ctx, 'migrate', { wait: true, timeoutMs: 15 * 60_000 });
  if (!migration.ok) {
    throw new Error(`The database migration job did not succeed (${migration.status}), so setup stopped before the first load. ` +
      `See its logs with: az containerapp job logs show -g ${az.resourceGroup} -n ${az.outputs?.migrateJobName} --execution ${az.status?.lastMigrate?.name} --container migrate. ` +
      'Re-run install once it is fixed; finished steps are skipped.');
  }

  const loads = !!(ctx.runFirstLoad || ctx.reloadHistoryDays);
  if (rlsOn(config)) {
    step('Org-scoped access');
    // A first load refreshes the models itself, after loading the scopes into SQL.
    const refresh = !loads;
    const applied = await ensureOrgAccess(ctx, { refresh });
    if (applied && refresh) await verifyOrgAccess(ctx);
  }
  // A model owed a reload is reloaded from the database now, rather than trusting a load that runs on after setup.
  const reloads = await restoreAzureModels(ctx, opts);

  if (flows) {
    step('Power Automate flow');
    await ensureFlows(ctx);
  }

  step('Teams app');
  await writeAzureTeamsPackage(ctx);

  if (consumption && flows) await offerStudioRun(ctx, { pipelineNext: !!(ctx.reloadHistoryDays || ctx.runFirstLoad), quietWhenOff: true });
  if (ctx.reloadHistoryDays) {
    step('Reload audit history');
    const days = ctx.reloadHistoryDays;
    try {
      await startAndWaitJob(ctx, 'run', { wait: false, backfillDays: days });
      config.history.days = days;
      ctx.save();
    } catch (err) {
      ui.fail(`The history reload didn't start: ${/** @type {Error} */ (err).message}`);
      ui.info(`Try again with "${commandLine(`run --backfill-days ${days}`)}".`);
    }
  } else if (ctx.runFirstLoad) {
    step('First load');
    await startAndWaitJob(ctx, 'run', { wait: false });
  }
  await azureSummary(ctx, reloads);
  return reloads.ok;
}

/**
 * Refreshes the models owed a reload from the Azure SQL database, unless a refresh that started
 * after their update already finished (the org-scoped access job's, say).
 * @param {Ctx} ctx @param {{ wait: boolean }} opts
 * @returns {Promise<{ ok: boolean, pending: string[] }>}
 */
async function restoreAzureModels(ctx, opts) {
  const result = await settleReloads(ctx, { wait: opts.wait, load: 'none', reachable: (m) => !!m.id });
  if (!result.ok) ctx.ui.fail(`The models weren't reloaded, so reports show no data or the old version until they are. Fix the problem above, then run "${commandLine('refresh')}", or "${commandLine('update')}" again.`);
  return result;
}

/** @param {Ctx} ctx @param {{ pass: 1 | 2 }} o */
async function deployOrExplain(ctx, o) {
  const az = /** @type {import('../../config.js').AzureConfig} */ (ctx.config.azure);
  const deploy = async () => ctx.api.arm.deployTemplate(/** @type {string} */ (az.subscriptionId), /** @type {string} */ (az.resourceGroup), 'valuelens', await azureDeployment(ctx, o));
  try {
    try {
      return await deploy();
    } catch (err) {
      const turnedDown = await sqlFreeOfferTurnedDown(ctx, err);
      if (!turnedDown) throw err;
      ctx.ui.warn(`Azure turned down the Azure SQL free offer for a new database (${turnedDown}). This subscription may have used its free databases. Creating it at the usual serverless price instead: it pauses after an hour without use.`);
      az.sqlFreeOffer = false;
      return await deploy();
    }
  } catch (err) {
    const msg = explain(err, az);
    // A deployment that ran and failed (waitForDeployment) stays in the resource group with its full error.
    const more = !(err instanceof HttpError) && /** @type {any} */ (err)?.body?.error ? `\nFull error: az deployment group show -g ${az.resourceGroup} -n valuelens --query properties.error` : '';
    if (msg) throw new Error(`${msg}\n${/** @type {Error} */ (err).message}${more}`, { cause: err });
    if (more && err instanceof Error) err.message += more;
    throw err;
  }
}

/**
 * Whether a deployment failed on a new Azure SQL database that asked for the free offer. Azure can turn
 * the free offer down with only InternalServerError, for one when the subscription has used its free
 * databases. An existing database is never retried, so one already on the free offer stays on it.
 * @param {Ctx} ctx @param {any} err
 * @returns {Promise<string | undefined>}  the error code Azure gave, when it was turned down.
 */
export async function sqlFreeOfferTurnedDown(ctx, err) {
  const az = /** @type {import('../../config.js').AzureConfig} */ (ctx.config.azure);
  if (az.sqlFreeOffer === false) return undefined;
  /** @type {import('../../clients/azure.js').FailedOperation[]} */
  const ops = err?.operations ?? [];
  const failed = ops.find((f) => /^Microsoft\.Sql\/servers\/databases$/i.test(f.resourceType ?? ''));
  const [server, database] = String(failed?.resourceName ?? '').split('/');
  if (!failed || !server || !database) return undefined;
  const existing = await ctx.api.arm.getSqlDatabase(/** @type {string} */ (az.subscriptionId), /** @type {string} */ (az.resourceGroup), server, database).catch(() => undefined);
  return existing === null ? failed.code ?? 'Failed' : undefined;
}

/** @param {import('../../config.js').AzureConfig} az @param {any} deployment */
function recordDeployment(az, deployment) {
  const outputs = deployment?.properties?.outputs ?? deployment?.outputs ?? {};
  const flat = Object.fromEntries(Object.entries(outputs).map(([k, v]) => [k, /** @type {any} */ (v).value ?? v]));
  az.outputs = { ...(az.outputs ?? {}), ...flat };
  az.deployments ??= [];
  az.deployments.push({ at: new Date().toISOString(), name: deployment?.name ?? 'valuelens', outputs: flat });
}

/** @param {Ctx} ctx */
async function ensureAzureWebApp(ctx) {
  const { config, api, user, ui } = ctx;
  const az = /** @type {import('../../config.js').AzureConfig} */ (config.azure);
  const fqdn = az.outputs?.webFqdn;
  if (!fqdn) throw new Error('The ARM deployment did not return webFqdn, so the web app sign-in cannot be set up.');
  const graphSp = await api.graph.servicePrincipalByAppId(GRAPH_APP_ID);
  const pbiSp = await api.graph.servicePrincipalByAppId(POWER_BI_APP_ID);
  const graphUserReadScopeId = graphSp.oauth2PermissionScopes?.find((s) => s.value === 'User.Read')?.id;
  const pbiScopeId = pbiSp.oauth2PermissionScopes?.find((s) => s.value === 'Dataset.Read.All')?.id;
  if (!graphUserReadScopeId || !pbiScopeId) throw new Error('Could not find Graph User.Read or Power BI Dataset.Read.All delegated scopes in this tenant.');
  // With a viewer group, admins and group owners manage it from Share in the app, as themselves.
  const groups = !!config.access;
  const graphGroupScopeId = groups ? graphSp.oauth2PermissionScopes?.find((s) => s.value === GROUP_SCOPE)?.id : undefined;
  const registration = { pbiScopeId, graphUserReadScopeId, graphGroupScopeId, groupClaims: groups, teamsClientIds: TEAMS_CLIENTS };
  az.webApp ??= {};
  let app = az.webApp.clientId ? await api.graph.findApplication(az.webApp.clientId).catch(() => null) : null;
  if (!app) {
    app = await api.graph.createAzureWebApplication({ displayName: WEB_APP_NAME, fqdn, ...registration });
    Object.assign(az.webApp, { created: true, clientId: app.appId, objectId: app.id });
    ui.ok(`Created app registration ${WEB_APP_NAME}`);
  }
  await api.graph.updateAzureWebApplication(app, { fqdn, clientId: /** @type {string} */ (az.webApp.clientId), ...registration });
  az.webApp.appIdUri = `api://${fqdn}/${az.webApp.clientId}`;
  let sp = az.webApp.servicePrincipalId ? await api.graph.findServicePrincipal(/** @type {string} */ (az.webApp.clientId)).catch(() => null) : null;
  if (!sp) sp = await api.graph.createServicePrincipal(/** @type {string} */ (az.webApp.clientId));
  az.webApp.servicePrincipalId = sp.id;
  try {
    await api.graph.addFederatedIdentityCredential(app.id, { name: 'managed-identity', issuer: `https://login.microsoftonline.com/${user.tenantId}/v2.0`, subject: az.outputs?.identityPrincipalId, audiences: ['api://AzureADTokenExchange'] });
  } catch (err) {
    if (!(err instanceof HttpError && err.status === 409)) throw err;
  }
  try {
    await api.graph.grantOauth2Permission({ clientId: sp.id, resourceId: pbiSp.id, scope: 'Dataset.Read.All' });
    await api.graph.grantOauth2Permission({ clientId: sp.id, resourceId: graphSp.id, scope: 'User.Read' });
    if (graphGroupScopeId) await api.graph.grantOauth2Permission({ clientId: sp.id, resourceId: graphSp.id, scope: GROUP_SCOPE });
    if (az.status?.pendingAdminActions) az.status.pendingAdminActions = az.status.pendingAdminActions.filter((a) => !a.startsWith('Grant delegated consent'));
  } catch (err) {
    ui.warn(`Couldn't grant delegated admin consent (${err instanceof Error ? err.message.split('\n')[0] : err}). Send this to an admin: ${adminConsentUrl(user.tenantId, /** @type {string} */ (az.webApp.clientId))}`);
    az.status ??= {};
    const action = `Grant delegated consent on ${apiPermissionsUrl(/** @type {string} */ (az.webApp.clientId))}`;
    az.status.pendingAdminActions = [...new Set([...(az.status.pendingAdminActions ?? []), action])];
  }
  await ensureInstallerIsAdmin(ctx, sp.id);
}

/**
 * The web API only answers users holding AnalyticsHub.User or AnalyticsHub.Admin, so give the person
 * installing the Admin role. Everyone else is assigned in Entra (Enterprise applications > Users and groups).
 * @param {Ctx} ctx @param {string} spId
 */
async function ensureInstallerIsAdmin(ctx, spId) {
  const { config, api, user, ui } = ctx;
  const az = /** @type {import('../../config.js').AzureConfig} */ (config.azure);
  const usersUrl = `https://portal.azure.com/#view/Microsoft_AAD_IAM/ManagedAppMenuBlade/~/Users/objectId/${spId}/appId/${az.webApp?.clientId}`;
  try {
    // Role IDs are generated when the app is first patched, so read them back rather than trusting the local object.
    const app = await api.graph.findApplication(/** @type {string} */ (az.webApp?.clientId));
    const roles = /** @type {any[]} */ (app?.appRoles ?? []);
    const admin = roles.find((r) => r.value === 'AnalyticsHub.Admin');
    if (!admin?.id) throw new Error('the AnalyticsHub.Admin app role is missing');
    const assigned = /** @type {any[]} */ (await api.graph.appRoleAssignedTo(spId));
    const roleIds = new Set(roles.map((r) => r.id));
    if (!assigned.some((a) => a.principalId === user.id && roleIds.has(a.appRoleId))) {
      try {
        await api.graph.assignPrincipalToAppRole(user.id, spId, admin.id);
      } catch (err) {
        if (!(err instanceof HttpError && /already exists/i.test(err.message))) throw err;
      }
      ui.ok(`Gave ${user.upn} the Analytics Hub Admin role. Assign other users or groups at ${usersUrl}`);
    }
  } catch (err) {
    ui.warn(`Couldn't give you the Analytics Hub Admin role (${err instanceof Error ? err.message.split('\n')[0] : err}). Without a role the app's charts stay empty. Assign it at ${usersUrl}`);
  }
}

/** @param {Ctx} ctx */
async function ensureSqlReader(ctx) {
  const { config, api, ui } = ctx;
  const az = /** @type {import('../../config.js').AzureConfig} */ (config.azure);
  az.sqlReader ??= {};
  let app = az.sqlReader.clientId ? await api.graph.findApplication(az.sqlReader.clientId).catch(() => null) : null;
  if (!app) {
    app = await api.graph.createApplication(SQL_READER_NAME, []);
    Object.assign(az.sqlReader, { clientId: app.appId, objectId: app.id, created: true });
    ui.ok(`Created app registration ${SQL_READER_NAME}`);
  }
  let sp = az.sqlReader.servicePrincipalId ? await api.graph.findServicePrincipal(/** @type {string} */ (az.sqlReader.clientId)).catch(() => null) : null;
  if (!sp) sp = await api.graph.createServicePrincipal(/** @type {string} */ (az.sqlReader.clientId));
  az.sqlReader.servicePrincipalId = sp.id;
  const r = az.sqlReader;
  r.objectId = app.id;
  await removeRetired(ctx, r, app.id);
  // Tracked from before Entra is asked. It stays pending until Power BI's credential uses it, and
  // the one it replaces is removed only then.
  const cred = await addTrackedSecret(ctx, r, app.id, SQL_READER_SECRET_LABEL, addMonths(ctx.now(), SECRET_LIFETIME_MONTHS));
  ui.ok(`Created SQL reader secret expiring ${cred.endDateTime.slice(0, 10)}`);
  return { value: cred.secretText, keyId: cred.keyId, expires: cred.endDateTime };
}

/**
 * Power BI's credential now uses the new SQL reader secret: it becomes the current one, and the
 * one before and any a stopped run left pending are removed from the app.
 * @param {Ctx} ctx
 * @param {{ keyId: string, expires: string }} secret
 */
async function useSqlSecret(ctx, secret) {
  const r = /** @type {NonNullable<import('../../config.js').AzureConfig['sqlReader']>} */ (ctx.config.azure?.sqlReader);
  r.secretExpiry = secret.expires;
  await promoteSecret(ctx, r, r.objectId, secret.keyId);
}

/** @param {Ctx} ctx */
async function assignManagedIdentityGraphRoles(ctx) {
  const { config, api, ui } = ctx;
  const az = /** @type {import('../../config.js').AzureConfig} */ (config.azure);
  const principalId = az.outputs?.identityPrincipalId;
  if (!principalId) throw new Error('The ARM deployment did not return identityPrincipalId.');
  const graphSp = await api.graph.graphServicePrincipal();
  const wanted = azureGraphRoles(config);
  const { roles, missing } = resolveAppRoles(graphSp, wanted, OPTIONAL_PERMISSIONS);
  for (const m of missing) {
    ui.warn(`Microsoft Graph in this tenant has no ${m} permission yet. ${OPTIONAL_PERMISSION_EFFECTS[/** @type {keyof typeof OPTIONAL_PERMISSION_EFFECTS} */ (m)] ?? ''}`.trim());
  }
  az.graphRoles ??= { assigned: [], pending: [] };
  for (const role of roles) {
    if (az.graphRoles.assigned.includes(role.value)) continue;
    try {
      await api.graph.assignPrincipalToAppRole(principalId, graphSp.id, role.id);
      az.graphRoles.assigned.push(role.value);
      ui.ok(`Granted ${role.value} to the managed identity`);
    } catch (err) {
      if (err instanceof HttpError && err.status === 403) {
        az.graphRoles.pending.push(role.value);
        ui.warn(`An admin must grant ${role.value} to the managed identity.`);
      } else throw err;
    }
  }
}

/** @param {Ctx} ctx @param {string} sqlReaderSecret */
async function ensureAzurePowerBi(ctx, sqlReaderSecret) {
  const { config, api, ui, sources } = ctx;
  const az = /** @type {import('../../config.js').AzureConfig} */ (config.azure);
  az.powerBi ??= {};
  if (!az.powerBi.workspaceId) {
    const g = await api.powerBi.createGroup(az.workspaceName ?? 'Analytics Hub');
    az.powerBi.workspaceId = g.id;
    az.powerBi.createdWorkspace = true;
    ui.ok(`Created Power BI workspace ${az.workspaceName ?? 'Analytics Hub'}`);
    ctx.save();
  }
  await ensureWorkspaceCapacity(ctx);
  if (az.outputs?.identityClientId) await api.powerBi.addGroupUser(/** @type {string} */ (az.powerBi.workspaceId), { identifier: az.outputs.identityPrincipalId ?? az.outputs.identityClientId, principalType: 'App', groupUserAccessRight: 'Member' }).catch((err) => { if (!/AddingAlreadyExists/i.test(String(err?.message) + JSON.stringify(err?.body ?? ''))) ui.warn(`Couldn't add the managed identity to the Power BI workspace: ${err.message}`); });
  if (!sources.modelFile) throw new Error('This checkout has no ValueLens model template to deploy.');
  config.fabric.workspaceId = /** @type {string} */ (az.powerBi.workspaceId);
  const sm = config.semanticModel;
  const server = String(az.outputs?.sqlServerFqdn ?? 'server.database.windows.net');
  const database = String(az.outputs?.sqlDatabaseName ?? 'valuelens');
  await deployModel(ctx, sm, {
    signature: `azure;${modelSignature(server, database, config.modules)}`,
    definition: () => semanticModelDefinition(buildModel(loadTemplateModel(/** @type {string} */ (sources.modelFile)), { server, database, modules: config.modules, resourceGraph: azureResourceGraphOn(config), currency: config.reporting?.currency, access: rlsSettings(config) }), PBISM),
  }).catch((err) => {
    if (err instanceof HttpError && err.status >= 400 && /FeatureNotAvailable|capacity|Premium|Fabric/i.test(JSON.stringify(err.body ?? err.message))) throw new Error('Power BI semantic model definition APIs are not available in this Pro workspace. The .pbix Imports fallback is planned but not implemented yet.');
    throw err;
  });
  az.powerBi.datasetId = sm.id;
  Object.assign(sm, { server, database, bound: true });
  const cc = await ensureAzureConsumptionModel(ctx, server, database);
  if (isPrivate(az)) await bindThroughVnetGateway(ctx, sqlReaderSecret);
  else await bindPowerBiCredentials(ctx, sqlReaderSecret);
  for (const id of [az.powerBi.datasetId, cc]) if (id) await api.powerBi.setRefreshSchedule(/** @type {string} */ (az.powerBi.workspaceId), id, refreshScheduleBody(ctx));
}

/**
 * The Consumption model, reading Azure SQL like the main model. Returns its ID, or undefined when
 * credit consumption is off or this checkout has no template.
 * @param {Ctx} ctx @param {string} server @param {string} database
 */
async function ensureAzureConsumptionModel(ctx, server, database) {
  const { config, sources } = ctx;
  const az = /** @type {import('../../config.js').AzureConfig} */ (config.azure);
  const pbi = /** @type {NonNullable<import('../../config.js').AzureConfig['powerBi']>} */ (az.powerBi);
  if (!azureConsumptionOn(config)) return undefined;
  const file = sources.consumptionModelFile;
  if (!file) {
    ctx.ui.note('This checkout has no credit consumption report, so only the jobs collect credit consumption.');
    return undefined;
  }
  const m = config.consumption.model;
  await deployModel(ctx, m, {
    signature: `azure;${server};${database}`,
    definition: () => semanticModelDefinition(buildConsumptionModel(loadTemplateModel(file), { server, database, resourceGraph: azureResourceGraphOn(config), access: rlsSettings(config) }), PBISM),
  });
  pbi.consumptionDatasetId = m.id;
  ctx.save();
  return m.id;
}

/** The Power BI models on this install. @param {import('../../config.js').AzureConfig} az */
const azureDatasetIds = (az) => /** @type {string[]} */ ([az.powerBi?.datasetId, az.powerBi?.consumptionDatasetId].filter(Boolean));

/** @param {Ctx} ctx @param {string} secret */
async function bindPowerBiCredentials(ctx, secret) {
  const az = /** @type {import('../../config.js').AzureConfig} */ (ctx.config.azure);
  for (const id of azureDatasetIds(az)) await bindPowerBiCredential(ctx, secret, id);
}

/** @param {Ctx} ctx @param {string} secret @param {string} datasetId */
async function bindPowerBiCredential(ctx, secret, datasetId) {
  const az = /** @type {import('../../config.js').AzureConfig} */ (ctx.config.azure);
  const sources = await ctx.api.powerBi.datasources(/** @type {string} */ (az.powerBi?.workspaceId), datasetId);
  const ds = sources.find((d) => String(d.datasourceType).toLowerCase() === 'sql') ?? sources[0];
  if (!ds?.gatewayId || !ds?.datasourceId) throw new Error('Power BI did not return a SQL data source to bind.');
  await whileSqlResumes(ctx.ui, () => ctx.api.powerBi.updateDatasource(/** @type {string} */ (ds.gatewayId), /** @type {string} */ (ds.datasourceId), {
    credentialDetails: {
      credentialType: 'ServicePrincipal',
      credentials: JSON.stringify({ credentialData: [
        { name: 'tenantId', value: ctx.user.tenantId },
        { name: 'servicePrincipalClientId', value: az.sqlReader?.clientId },
        { name: 'servicePrincipalSecret', value: secret },
      ] }),
      encryptedConnection: 'Encrypted',
      encryptionAlgorithm: 'None',
      privacyLevel: 'Organizational',
    },
  }));
}

/** @param {import('../../config.js').AzureConfig} az */
export const gatewayName = (az) => `Analytics Hub ${az.resourceGroup ?? az.namePrefix} ${String(az.installId ?? '').slice(0, 8)}`.trim();
/** @param {import('../../config.js').AzureConfig} az */
export const connectionName = (az) => `Analytics Hub SQL ${az.resourceGroup ?? az.namePrefix} ${String(az.installId ?? '').slice(0, 8)}`.trim();

/**
 * Puts the Power BI workspace on the chosen capacity. A workspace the installer didn't create that already sits on
 * another capacity stays there.
 * @param {Ctx} ctx
 */
async function ensureWorkspaceCapacity(ctx) {
  const { api, ui } = ctx;
  const az = /** @type {import('../../config.js').AzureConfig} */ (ctx.config.azure);
  const capacityId = az.powerBi?.capacityId;
  const workspaceId = /** @type {string} */ (az.powerBi?.workspaceId);
  if (!capacityId) return;
  const ws = await api.fabric.getWorkspace(workspaceId).catch(() => null);
  if (ws?.capacityId?.toLowerCase() === capacityId.toLowerCase()) return;
  if (ws?.capacityId && !az.powerBi?.createdWorkspace) {
    ui.note(`The Power BI workspace is already on capacity ${ws.capacityId}, so it stays there.`);
    return;
  }
  await api.fabric.assignToCapacity(workspaceId, capacityId);
  ui.ok('Power BI workspace assigned to the capacity');
}

/**
 * Creates (or adopts) the Power BI VNet data gateway in the VNet's delegated subnet.
 * Only a gateway recorded in this install, or one with our name in our VNet, is reused.
 * @param {Ctx} ctx
 */
async function ensureVnetGateway(ctx) {
  const { api, ui, user } = ctx;
  const az = /** @type {import('../../config.js').AzureConfig} */ (ctx.config.azure);
  const vnet = az.outputs?.vnetName;
  const subnet = az.outputs?.gatewaySubnetName;
  if (!vnet || !subnet) throw new Error('The ARM deployment did not return the VNet and gateway subnet, so the Power BI VNet data gateway cannot be created.');
  const name = gatewayName(az);
  const inOurVnet = (/** @type {any} */ g) => g.virtualNetworkAzureResource?.virtualNetworkName === vnet && g.virtualNetworkAzureResource?.resourceGroupName?.toLowerCase() === String(az.resourceGroup).toLowerCase();
  const gateways = await api.fabric.listGateways().catch(() => []);
  const existing = gateways.find((g) => g.id === az.powerBi?.gatewayId) ?? gateways.find((g) => g.type === 'VirtualNetwork' && g.displayName === name && inOurVnet(g));
  if (existing) return existing.id;
  try {
    const g = await api.fabric.createGateway({
      type: 'VirtualNetwork',
      displayName: name,
      capacityId: az.powerBi?.capacityId,
      virtualNetworkAzureResource: { subscriptionId: az.subscriptionId, resourceGroupName: az.resourceGroup, virtualNetworkName: vnet, subnetName: subnet },
      inactivityMinutesBeforeSleep: 30,
      numberOfMemberGateways: 1,
    });
    Object.assign(/** @type {any} */ (az.powerBi), { gatewayId: g.id, createdGateway: true });
    ctx.save();
    ui.ok(`Created Power BI VNet data gateway ${name}`);
    return /** @type {string} */ (g.id);
  } catch (err) {
    const text = JSON.stringify(err instanceof HttpError ? err.body : /** @type {any} */ (err)?.message ?? '');
    if (/DuplicateGatewayName/i.test(text)) throw new Error(`A Power BI gateway called "${name}" already exists outside this install's VNet. Remove or rename it, then run the installer again.`);
    if (/SubnetNotConfiguredForDelegation|vnetaccesslinks/i.test(text)) throw new Error(`The subnet ${subnet} isn't delegated to Microsoft.PowerPlatform/vnetaccesslinks yet. Check that the Microsoft.PowerPlatform provider is registered on subscription ${az.subscriptionId}, then run the installer again.`);
    if (err instanceof HttpError && (err.status === 401 || err.status === 403)) throw new Error(`${user.upn ?? 'You'} can't create Power BI VNet data gateways. Ask a Fabric admin to allow you under "Manage connections and gateways" (or to run the installer), and check you have Network Contributor on ${az.resourceGroup}.`);
    throw err;
  }
}

/** @param {Ctx} ctx @param {string} secret */
function sqlConnectionCredentials(ctx, secret) {
  const az = /** @type {import('../../config.js').AzureConfig} */ (ctx.config.azure);
  return {
    singleSignOnType: 'None',
    connectionEncryption: 'Encrypted',
    // The reader's database user is created later by the migrate job, so a test login here would fail.
    skipTestConnection: true,
    credentials: { credentialType: 'ServicePrincipal', servicePrincipalClientId: az.sqlReader?.clientId, servicePrincipalSecret: secret, tenantId: ctx.user.tenantId },
  };
}

/** Transient while connecting: serverless Azure SQL resuming from auto-pause (40613), or a just-created app secret not yet replicated (AADSTS7000215). @param {any} err */
export const isSqlResuming = (err) => /40613|is not currently available|AADSTS7000215/i.test(`${err?.message ?? ''} ${JSON.stringify(err?.body ?? '')}`);

/**
 * Retries a call that connects to Azure SQL while the serverless database resumes.
 * @template T @param {{ note: (s: string) => void }} ui @param {() => Promise<T>} fn @returns {Promise<T>}
 */
export async function whileSqlResumes(ui, fn, { attempts = 8, delayMs = 30_000 } = {}) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts || !isSqlResuming(err)) throw err;
      if (i === 1) ui.note('Azure SQL is resuming, or the new secret is still replicating; retrying in a moment...');
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

/**
 * Private networking: the model reaches Azure SQL through a VNet data gateway connection signed in as the SQL reader app.
 * @param {Ctx} ctx @param {string} secret
 */
async function bindThroughVnetGateway(ctx, secret) {
  const { api, ui } = ctx;
  const az = /** @type {import('../../config.js').AzureConfig} */ (ctx.config.azure);
  const pbi = /** @type {NonNullable<import('../../config.js').AzureConfig['powerBi']>} */ (az.powerBi);
  const gatewayId = await ensureVnetGateway(ctx);
  pbi.gatewayId = gatewayId;
  const name = connectionName(az);
  const server = String(az.outputs?.sqlServerFqdn);
  const database = String(az.outputs?.sqlDatabaseName ?? 'valuelens');
  let conn = pbi.connectionId ? await api.fabric.getConnection(pbi.connectionId).catch(() => null) : null;
  conn ??= (await api.fabric.listConnections().catch(() => [])).find((c) => c.displayName === name && c.gatewayId === gatewayId) ?? null;
  if (conn) {
    const id = conn.id;
    await whileSqlResumes(ui, () => api.fabric.updateConnection(id, { connectivityType: 'VirtualNetworkGateway', privacyLevel: 'Organizational', credentialDetails: sqlConnectionCredentials(ctx, secret) }));
    ui.ok(`Updated Power BI connection ${name}`);
  } else {
    conn = await whileSqlResumes(ui, () => api.fabric.createConnection({
      connectivityType: 'VirtualNetworkGateway',
      gatewayId,
      displayName: name,
      connectionDetails: { type: 'SQL', creationMethod: 'SQL', parameters: [{ dataType: 'Text', name: 'server', value: server }, { dataType: 'Text', name: 'database', value: database }] },
      privacyLevel: 'Organizational',
      credentialDetails: sqlConnectionCredentials(ctx, secret),
    }));
    ui.ok(`Created Power BI connection ${name}`);
  }
  pbi.connectionId = conn.id;
  ctx.save();
  for (const id of azureDatasetIds(az)) await api.powerBi.bindToGateway(/** @type {string} */ (pbi.workspaceId), id, { gatewayObjectId: gatewayId, datasourceObjectIds: [/** @type {string} */ (conn.id)] });
  ui.ok(`Bound the model${azureDatasetIds(az).length > 1 ? 's' : ''} to the VNet data gateway`);
}

/** @param {Ctx} ctx */
function refreshScheduleBody(ctx) {
  const [hour, minute] = ctx.config.schedule.time.split(':').map(Number);
  return { value: { enabled: true, localTimeZoneId: 'UTC', times: [`${String((hour + 1) % 24).padStart(2, '0')}:${String(minute).padStart(2, '0')}`], days: ctx.config.schedule.frequency === 'weekly' ? [ctx.config.schedule.weekday] : undefined } };
}

/**
 * Starts the run or migrate job, and waits for it when asked. `steps` runs only those steps of the run
 * job; such a run isn't recorded as the last run, which tells whether the history was loaded.
 * @param {Ctx} ctx @param {'run' | 'migrate'} kind
 * @param {{ wait: boolean, timeoutMs?: number, backfillDays?: number, steps?: string }} opts
 */
export async function startAndWaitJob(ctx, kind, opts) {
  const az = /** @type {import('../../config.js').AzureConfig} */ (ctx.config.azure);
  const name = kind === 'run' ? az.outputs?.runJobName : az.outputs?.migrateJobName;
  if (!name) throw new Error(`The ARM deployment did not return ${kind} job name.`);
  const sub = /** @type {string} */ (az.subscriptionId);
  const rg = /** @type {string} */ (az.resourceGroup);
  let template;
  if (opts.backfillDays) {
    template = jobTemplateWith(await ctx.api.arm.getContainerAppJob(sub, rg, name), [{ name: BACKFILL_ENV, value: String(opts.backfillDays) }]);
    if (!template) throw new Error(`Couldn't read the ${name} job's containers, so it can't be started with ${opts.backfillDays} days of history.`);
  } else if (opts.steps) {
    template = jobTemplateWith(await ctx.api.arm.getContainerAppJob(sub, rg, name), [], { args: ['run', '--steps', opts.steps] });
    if (!template) throw new Error(`Couldn't read the ${name} job's containers, so it can't be started with only ${opts.steps}.`);
  }
  const label = opts.steps ? `${kind} job (${opts.steps})` : `${kind} job`;
  const key = opts.steps ? 'lastAccess' : kind === 'run' ? 'lastRun' : 'lastMigrate';
  const started = await ctx.api.arm.startContainerAppJob(sub, rg, name, template);
  const executionName = started?.name ?? started?.properties?.name ?? started?.id?.split('/').pop();
  ctx.ui.ok(`Started ${label}${executionName ? ` (${executionName})` : ''}${opts.backfillDays ? ` with ${opts.backfillDays} days of audit history` : ''}`);
  if (opts.backfillDays) {
    ctx.ui.note(`${reloadDetail(opts.backfillDays)} Job images older than this installer ignore ${BACKFILL_ENV} and run as usual: run "${commandLine('update')}" first if yours is.`);
  }
  az.status ??= {};
  az.status[key] = { name: executionName, status: 'Running', startedAt: ctx.now().toISOString() };
  ctx.save();
  if (!opts.wait) return { ok: true, status: 'Running' };
  if (!executionName) {
    ctx.ui.warn(`Azure didn't say which run of the ${label} this is, so the installer can't follow it to the end. Check it in the portal, or with "${commandLine('status')}".`);
    return { ok: false, status: 'Unknown' };
  }
  const progress = ctx.ui.progress(kind === 'run' ? 'Run job' : 'Migrate job');
  const deadline = Date.now() + (opts.timeoutMs ?? 15 * 60_000);
  /** @type {any} */
  let job;
  try {
    for (;;) {
      job = await ctx.api.arm.getContainerAppJobExecution(/** @type {string} */ (az.subscriptionId), /** @type {string} */ (az.resourceGroup), name, executionName);
      const state = job?.properties?.status ?? job?.status ?? 'Unknown';
      progress.update(state);
      if (/Succeeded|Completed|Failed|Canceled|Cancelled/i.test(state) || Date.now() > deadline) break;
      await ctx.sleep(REFRESH_POLL_MS);
    }
  } finally {
    progress.done();
  }
  const state = job?.properties?.status ?? job?.status ?? 'Unknown';
  az.status[key] = { name: executionName, status: state, finishedAt: /Succeeded|Completed|Failed|Canceled|Cancelled/i.test(state) ? ctx.now().toISOString() : undefined };
  ctx.save();
  if (/Succeeded|Completed/i.test(state)) {
    ctx.ui.ok(`${kind === 'run' ? 'Run' : 'Migration'} job finished`);
    return { ok: true, status: state };
  }
  ctx.ui.fail(`${kind === 'run' ? 'Run' : 'Migration'} job ${/Failed|Canceled|Cancelled/i.test(state) ? 'failed' : 'did not finish'} (${state}). Check Log Analytics for the Container Apps job logs.`);
  return { ok: false, status: state };
}

/** @param {Ctx} ctx */
async function writeAzureTeamsPackage(ctx) {
  const az = /** @type {import('../../config.js').AzureConfig} */ (ctx.config.azure);
  const fqdn = az.outputs?.webFqdn;
  if (!fqdn || !az.webApp?.clientId || !az.webApp.appIdUri) return ctx.ui.warn('Skipped the Teams app because the web app identity is not complete.');
  const outFile = join(dirname(ctx.file), 'AnalyticsHub-Teams.zip');
  const result = await writeTeamsPackage({ clientId: az.webApp.clientId, fqdn, appIdUri: az.webApp.appIdUri, version: pkgVersion(), outFile });
  if (result.skipped) return ctx.ui.warn(`${result.reason} The coordinator must vendor it before packaging.`);
  az.teamsPackage = outFile;
  ctx.save();
  ctx.ui.ok(`Wrote Teams package ${outFile}`);
  await publishTeamsApp(ctx, result);
}

/**
 * Starts the run job. With `backfillDays` it reloads that much audit history, once.
 * @param {Ctx} ctx
 * @param {{ backfillDays?: number }} [opts]
 */
export async function azureRun(ctx, opts = {}) {
  if (azureConsumptionOn(ctx.config)) await offerStudioRun(ctx, { pipelineNext: true });
  const result = await startAndWaitJob(ctx, 'run', { wait: false, backfillDays: opts.backfillDays });
  if (opts.backfillDays && opts.backfillDays > ctx.config.history.days) {
    ctx.config.history.days = opts.backfillDays;
    ctx.save();
  }
  return result;
}

/** @param {Ctx} ctx */
export async function azureRefresh(ctx) {
  const az = ctx.config.azure;
  if (!az?.powerBi?.workspaceId || !az.powerBi.datasetId) throw new Error('No Azure Power BI model is recorded.');
  const requestId = await ctx.api.powerBi.refresh(az.powerBi.workspaceId, az.powerBi.datasetId, { type: 'full', commitMode: 'transactional', retryCount: 1 });
  ctx.ui.ok(`Started a refresh of ${ctx.config.semanticModel.name}`);
  if (az.powerBi.consumptionDatasetId) {
    await ctx.api.powerBi.refresh(az.powerBi.workspaceId, az.powerBi.consumptionDatasetId, { type: 'full', commitMode: 'transactional', retryCount: 1 });
    ctx.ui.ok(`Started a refresh of ${ctx.config.consumption.model.name}`);
  }
  return { ok: true, status: requestId };
}

/** @param {Ctx} ctx */
export async function azureStatus(ctx) {
  const { ui, config, api } = ctx;
  const az = config.azure;
  if (!az?.subscriptionId || !az.resourceGroup) return ui.warn('Nothing is installed yet.');
  ui.heading('Analytics Hub on Azure');
  ui.info(`Resource group: ${az.resourceGroup} (${az.location})`);
  if (az.outputs?.webUrl) ui.info(`Web app:        ${az.outputs.webUrl}`);
  if (az.powerBi?.workspaceId) ui.info(`Power BI:       ${az.powerBi.workspaceId}${az.powerBi.datasetId ? ` / ${az.powerBi.datasetId}` : ''}`);
  if (az.powerBi?.consumptionDatasetId) ui.info(`Consumption:    ${az.powerBi.consumptionDatasetId}`);
  if (azureConsumptionOn(config) && config.dataSources.studioCredits !== 'skip') ui.info(`Credit files:   ${azureDropLabel(az)}`);
  if (az.teamsApp) ui.info(`Teams app:      Analytics Hub ${az.teamsApp.version} in your org's app catalog`);
  expiry(ctx, 'SQL reader secret', az.sqlReader?.secretExpiry);
  for (const p of az.graphRoles?.pending ?? []) ui.warn(`Pending admin action: grant ${p} to the managed identity.`);
  for (const action of az.status?.pendingAdminActions ?? []) ui.warn(`Pending admin action: ${action}`);
  for (const [label, name] of [['Run job', az.outputs?.runJobName], ['Migrate job', az.outputs?.migrateJobName]]) {
    if (!name) continue;
    ui.heading(label);
    const runs = await api.arm.listContainerAppJobExecutions(az.subscriptionId, az.resourceGroup, String(name)).catch(() => []);
    for (const r of runs.slice(0, 5)) ui.info(`${r.name ?? last(r.id ?? '')}: ${r.properties?.status ?? r.status ?? 'Unknown'}`);
  }
}

/** @param {Ctx} ctx */
export async function azureRotateSecret(ctx) {
  const secret = await ensureSqlReader(ctx);
  if (isPrivate(ctx.config.azure)) await bindThroughVnetGateway(ctx, secret.value);
  else await bindPowerBiCredentials(ctx, secret.value);
  await useSqlSecret(ctx, secret);
  ctx.save();
  ctx.ui.ok('Rotated the SQL reader secret and rebound the Power BI data source credential.');
}

/** @param {Ctx} ctx */
export async function azureUpdate(ctx) {
  await azurePreflight(ctx);
  if (!(await confirmAzurePlan(ctx))) return true;
  return installAzure(ctx, { wait: true });
}

/** @param {Ctx} ctx */
export async function azureUninstall(ctx) {
  const { ui, config, api } = ctx;
  const az = config.azure;
  if (!az?.subscriptionId || !az.resourceGroup) throw new Error('Nothing is installed yet.');
  ui.heading('Uninstalling Analytics Hub on Azure');
  // First, so any sign-in it needs comes before the long deletes.
  await removeTeamsApp(ctx);
  // The gateway holds a service association link on its subnet, so it must go before the VNet.
  if (az.powerBi?.connectionId) {
    await api.fabric.deleteConnection(az.powerBi.connectionId).then(() => ui.ok('Deleted the Power BI gateway connection'), (err) => ui.warn(`Couldn't delete Power BI connection ${az.powerBi?.connectionId}: ${err.message}`));
  }
  if (az.powerBi?.createdGateway && az.powerBi.gatewayId) {
    await api.fabric.deleteGateway(az.powerBi.gatewayId).then(() => ui.ok('Deleted the Power BI VNet data gateway'), (err) => ui.warn(`Couldn't delete Power BI gateway ${az.powerBi?.gatewayId}: ${err.message}`));
  }
  if (az.createdResourceGroup) {
    await api.arm.deleteResourceGroup(az.subscriptionId, az.resourceGroup);
    ui.ok(`Deleted resource group ${az.resourceGroup}`);
  } else {
    const resources = await api.arm.listResources(az.subscriptionId, az.resourceGroup);
    const ours = resources.filter((r) => r.tags?.['valuelens-install-id'] === az.installId);
    for (const r of ours) await api.arm.deleteResource(r.id);
    ui.ok(`Deleted ${ours.length} tagged Azure resources and left everything else alone`);
  }
  for (const app of [az.webApp, az.sqlReader]) if (app?.created && app.objectId) await api.graph.deleteApplication(app.objectId).catch((err) => ui.warn(`Couldn't delete app registration ${app.clientId}: ${err.message}`));
}

/** @param {Ctx} ctx @param {{ ok?: boolean, pending?: string[] }} [opts]  pending: models still reloading after their update. */
export async function azureSummary(ctx, opts = {}) {
  const { ui, config } = ctx;
  const az = /** @type {import('../../config.js').AzureConfig} */ (config.azure);
  const pending = opts.pending ?? [];
  ui.heading(opts.ok === false ? 'Analytics Hub is set up, but not finished' : pending.length ? 'Analytics Hub is set up, still reloading' : 'Analytics Hub is set up');
  if (opts.ok !== false && pending.length) {
    ui.warn(`${pending.join(' and ')} ${pending.length === 1 ? 'is' : 'are'} still reloading: reports on ${pending.length === 1 ? 'it' : 'them'} can show no data or miss new columns until that finishes.`);
  }
  ui.info(`Azure:      ${az.resourceGroup} in ${az.location}`);
  if (az.outputs?.webUrl) ui.info(`App:        ${az.outputs.webUrl}`);
  if (az.powerBi?.workspaceId) ui.info(`Power BI:   workspace ${az.powerBi.workspaceId}, model ${az.powerBi.datasetId ?? 'not deployed'}`);
  if (az.powerBi?.consumptionDatasetId) ui.info(`Credits:    model ${az.powerBi.consumptionDatasetId}`);
  const teamsPending = az.status?.pendingAdminActions?.find((a) => a.startsWith(`${TEAMS_APP_PENDING}: `));
  if (teamsPending) ui.info(`Teams:      Not published yet. A Teams Administrator needs to ${teamsPending.slice(TEAMS_APP_PENDING.length + 2)}`);
  else if (az.teamsApp) ui.info(`Teams:      Analytics Hub ${az.teamsApp.version} in your org's app catalog, for Teams, Outlook and the Microsoft 365 Copilot app.`);
  else if (az.teamsPackage) ui.info(`Teams:      ${az.teamsPackage}`);
  ui.info(`Ask:        ${askLine(az)}`);
  for (const line of accessSummaryLines(config)) ui.info(line);
  if (flowsWanted(config).length) flowsSummary(ctx);
  ui.info('Record:     Keep valuelens-install.json. It holds no secrets.');
}

/** @param {Ctx} ctx @param {string} label @param {string | undefined} expires */
function expiry(ctx, label, expires) {
  if (!expires) return;
  const days = Math.floor((Date.parse(expires) - ctx.now().getTime()) / 86_400_000);
  const msg = `${label} expires ${expires.slice(0, 10)} (${days} days)`;
  if (days <= 30) ctx.ui.warn(`${msg}. Run "${commandLine('rotate-secret')}".`);
  else ctx.ui.info(msg);
}
