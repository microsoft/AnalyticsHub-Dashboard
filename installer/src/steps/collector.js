// @ts-check
/**
 * The optional data-collector account. Some sources only take a person's sign-in, never the app's:
 * the flows' Power Platform API connection (Copilot Studio credits and the agent inventory) and the
 * Cowork credits Dataflow's Viva Insights and Lakehouse connections. By default whoever runs the
 * installer signs in to them, so they stop when that person leaves, loses their role or resets their
 * password. In this mode a dedicated account an admin creates signs in to them once instead.
 *
 * The installer only keeps the account's name. It never creates the account, assigns its roles or
 * licences, or holds its password or tokens: Power Platform and Fabric keep those in their own
 * connection stores, as for any connection.
 */
import { signedInAs } from '../clients/connections.js';
import { BILLING_ADMIN_ROLE, POWER_PLATFORM_ADMIN_ROLE } from '../clients/graph.js';
import { commandLine } from '../launch.js';
import { c } from '../ui.js';
import { coworkConnections, coworkDataflowUrl } from './consumption.js';
import { flowsWanted, ppApiSignIn } from './flows.js';

/** @typedef {import('../install.js').Ctx} Ctx */

const UPN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Whether a value looks like a user principal name. @param {string} v */
export const isUpn = (v) => UPN.test(v.trim());

/**
 * The data-collector account's UPN, lower case, or undefined when whoever runs the installer signs in.
 * @param {import('../config.js').InstallConfig} config
 */
export const collectorAccount = (config) => config.collectorAccount?.trim().toLowerCase() || undefined;

/**
 * @typedef {object} DelegatedSignIn
 * @property {'ppApi' | 'viva' | 'lakehouse'} id
 * @property {string} label
 * @property {string} needs  What the account needs for this sign-in to work.
 */

/**
 * The connections that only take a person's sign-in, for the sources chosen.
 * @param {import('../config.js').InstallConfig} config
 * @returns {DelegatedSignIn[]}
 */
export function delegatedSignIns(config) {
  /** @type {DelegatedSignIn[]} */
  const out = [];
  const kinds = flowsWanted(config);
  if (kinds.includes('studio') || kinds.includes('agents')) {
    out.push({
      id: 'ppApi',
      label: 'Analytics Hub - Power Platform API (Power Automate flows)',
      needs: kinds.includes('agents') ? 'Power Platform Administrator, and a Power Automate Premium licence' : 'Power Platform Administrator or Billing Administrator, and a Power Automate Premium licence',
    });
  }
  if (config.target !== 'azure' && config.modules.consumption && config.dataSources.coworkCredits === 'api') {
    out.push(
      { id: 'viva', label: 'Viva Insights (Cowork credits Dataflow)', needs: 'Insights Analyst, or access to the Cowork query' },
      { id: 'lakehouse', label: 'Lakehouse (Cowork credits Dataflow)', needs: `Contributor on ${config.fabric.workspaceName ?? 'the workspace'}` },
    );
  }
  return out;
}

/**
 * Whether a connection is signed in to as the data-collector account. True when there's no
 * data-collector account; undefined when Power Platform doesn't say who signed in.
 * @param {import('../clients/connections.js').Connection | undefined} conn
 * @param {string | undefined} upn
 * @returns {boolean | undefined}
 */
export function accountMatches(conn, upn) {
  if (!upn) return true;
  const who = signedInAs(conn);
  return who === undefined ? undefined : who === upn.toLowerCase();
}

/**
 * Asks who signs in to the delegated connections. Only asked when the chosen sources have any.
 * Choosing yourself clears the account.
 * @param {Ctx} ctx
 */
export async function planCollector(ctx) {
  const { ui, config } = ctx;
  const signIns = delegatedSignIns(config);
  if (!signIns.length) return;
  const current = collectorAccount(config);
  ui.heading('Delegated sign-ins');
  ui.note(`These only take a person's sign-in, not the app's: ${signIns.map((s) => s.label).join('; ')}.`);
  ui.note('By default you sign in to them, and the daily runs stop if you leave, your admin role lapses or your password is reset.');
  const mode = await ui.select(
    'Who signs in to them?',
    [
      { name: 'You, as now', value: 'you', description: 'Nothing else to set up.' },
      {
        name: 'A dedicated data-collector account',
        value: 'collector',
        description: 'An account an admin creates for this, so the runs outlive any one person. You sign in as it once on each connection. The installer never holds its password or tokens.',
      },
    ],
    current ? 'collector' : 'you',
  );
  if (mode !== 'collector') {
    delete config.collectorAccount;
    return;
  }
  const upn = await ui.input('The data-collector account\'s user principal name', {
    default: current,
    validate: (v) => (isUpn(v) ? true : 'Type a user principal name, like analytics-collector@contoso.com.'),
  });
  config.collectorAccount = upn.trim().toLowerCase();
  showCollectorSetup(ctx, config.collectorAccount, signIns);
}

/**
 * The admin's steps and commands to set the account up. The installer prints them and runs none.
 * @param {string} upn
 * @param {DelegatedSignIn[]} signIns
 * @returns {{ title: string, lines: string[] }[]}
 */
export function collectorAdminSteps(upn, signIns) {
  const cowork = signIns.some((s) => s.id === 'viva');
  const flows = signIns.some((s) => s.id === 'ppApi');
  const roleBody = (/** @type {string} */ role) => `'{"principalId":"<object ID>","roleDefinitionId":"${role}","directoryScopeId":"/"}'`;
  return [
    {
      title: 'Create the account: cloud-only, with MFA. No mailbox or Teams needed.',
      lines: [
        `az ad user create --display-name "Analytics Hub data collector" --user-principal-name ${upn} --password "<temporary password>" --force-change-password-next-sign-in true`,
        `az ad user show --id ${upn} --query id -o tsv    # its object ID, for the next step`,
        'Keep MFA on for it (phishing-resistant if you can) and leave it out of no MFA policy.',
      ],
    },
    {
      title: 'Give it only what it needs, as permanent (active) assignments for this account only. Not Global Administrator.',
      lines: [
        ...(flows
          ? [
              `Power Platform Administrator: az rest --method POST --url https://graph.microsoft.com/v1.0/roleManagement/directory/roleAssignments --body ${roleBody(POWER_PLATFORM_ADMIN_ROLE)}`,
              `  Or, for Copilot Studio credits only, Billing Administrator (${BILLING_ADMIN_ROLE}). Whether a smaller Power Platform role is enough is unverified.`,
              'A Power Automate Premium licence (a purchase): Microsoft 365 admin center > Users > Active users > the account > Licenses and apps.',
            ]
          : []),
        ...(cowork
          ? [
              'Insights Analyst in Viva Insights, assigned by an Insights Administrator: https://learn.microsoft.com/viva/insights/advanced/setup-maint/assign-user-roles. Or share the Cowork query with the account.',
              'Contributor on the Analytics Hub workspace in Fabric: the workspace > Manage access.',
            ]
          : []),
      ],
    },
    {
      title: `Run the installer with the account named: choose "A dedicated data-collector account", or add --collector-account ${upn}.`,
      lines: [],
    },
    {
      title: `When the installer shows the sign-in links, sign in as ${upn} once on each one. A private browser window keeps your own account out of the way.`,
      lines: [`Then "${commandLine('status')}" shows who each connection is signed in as.`],
    },
  ];
}

/**
 * @param {Ctx} ctx
 * @param {string} upn
 * @param {DelegatedSignIn[]} signIns
 */
function showCollectorSetup(ctx, upn, signIns) {
  const { ui } = ctx;
  ui.info(`Before the sign-ins, an admin sets up ${c.bold(upn)}. The installer runs none of this: it doesn't create the account, assign roles or buy licences.`);
  collectorAdminSteps(upn, signIns).forEach((step, i) => {
    ui.info(`  ${i + 1}. ${step.title}`);
    for (const line of step.lines) ui.info(`     ${line}`);
  });
  ui.note('  The account\'s sign-ins last while the daily runs use them. 90 days without a run, or a password reset, ends them: then run update and sign in again.');
  ui.note('  docs/PERMISSIONS.md, "Data-collector account", has the hardening guidance.');
}

/**
 * The plan review's line for who signs in to the delegated connections, or undefined by default.
 * @param {import('../config.js').InstallConfig} config
 */
export function collectorSummary(config) {
  const upn = collectorAccount(config);
  return upn && delegatedSignIns(config).length ? `${upn} (data-collector account)` : undefined;
}

/**
 * What the data-collector account needs, for the plan review. The installer grants none of it.
 * @param {import('../config.js').InstallConfig} config
 * @param {string} workspace  Where the Cowork Dataflow is, as the review names it.
 * @returns {import('./plan.js').ReviewGrant[]}
 */
export function collectorGrants(config, workspace) {
  const upn = collectorAccount(config);
  const signIns = delegatedSignIns(config);
  if (!upn || !signIns.length) return [];
  const who = `${upn} (data-collector account)`;
  const detail = 'Not granted by the installer: an admin gives it, as a permanent assignment for this account only.';
  /** @type {import('./plan.js').ReviewGrant[]} */
  const out = [];
  const pp = signIns.find((s) => s.id === 'ppApi');
  if (pp) out.push({ who, what: pp.needs, where: 'Your tenant (Entra ID and Microsoft 365 admin center)', detail: `${detail} Not Global Administrator.` });
  if (signIns.some((s) => s.id === 'viva')) {
    out.push({ who, what: 'Insights Analyst', where: 'Viva Insights', detail });
    out.push({ who, what: 'Contributor', where: workspace, detail: 'Not granted by the installer. So its Lakehouse sign-in can write the Cowork credits.' });
  }
  return out;
}

/**
 * For status: who the delegated connections are signed in as, where the APIs say, and which need a
 * new sign-in. Reads only, and never throws.
 * @param {Ctx} ctx
 */
export async function printSignIns(ctx) {
  const { ui, config } = ctx;
  try {
    const signIns = delegatedSignIns(config);
    if (!signIns.length) return;
    const upn = collectorAccount(config);
    const wantsFlows = signIns.some((s) => s.id === 'ppApi');
    const wantsCowork = signIns.some((s) => s.id === 'viva') && !!config.consumption?.dataflowId;
    const pp = wantsFlows ? await ppApiSignIn(ctx).catch(() => undefined) : undefined;
    const cowork = wantsCowork ? await coworkConnections(ctx) : undefined;
    if (!pp && !cowork && !upn) return;
    ui.heading('Sign-ins');
    if (upn) ui.info(`Data-collector account: ${upn}`);
    if (pp) {
      const label = `Flows (${pp.displayName})`;
      const as = upn ? `, signing in as ${upn}` : '';
      if (!pp.connected) ui.fail(`${label}: needs a new sign-in. Open ${pp.page}, find it and click Fix connection${as}.`);
      else if (upn && pp.who && pp.who !== upn) ui.warn(`${label}: signed in as ${pp.who}, not ${upn}. Run "${commandLine('update')}" for a link to sign in again as ${upn}.`);
      else if (pp.who) ui.ok(`${label}: signed in as ${pp.who}`);
      else ui.ok(`${label}: signed in. Power Platform doesn't say as whom.`);
    } else if (wantsFlows && upn) ui.note('Flows: couldn\'t read their Power Platform API connection.');
    if (cowork === 'bound') ui.ok('Cowork credits Dataflow: saved with its connections. Fabric doesn\'t say who signed in.');
    else if (cowork === 'unbound') {
      const url = coworkDataflowUrl(config);
      ui.warn(`Cowork credits Dataflow: needs its sign-ins${upn ? `, as ${upn}` : ''}. Open ${url ?? 'it in the workspace'}, configure both connections and save.`);
    } else if (cowork === 'unknown') ui.note('Cowork credits Dataflow: couldn\'t tell whether it\'s signed in.');
    if (upn) ui.note('A password reset, or 90 days without a run, ends these sign-ins: then sign in to them again.');
  } catch {
    // Status carries on without it.
  }
}
