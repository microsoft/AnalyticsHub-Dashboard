// @ts-check
/**
 * A long first load on Azure carries itself on: when a run stops at its time limit, the run job starts its next run
 * straight away, until the history is loaded (azure/jobs/valuelens_jobs/continue_run.py). It starts it as its own
 * system-assigned identity, which only the run job has, with Container Apps Jobs Operator on that job only.
 *
 * The installer gives the role after the deploy that creates the identity. It's outside the template's roles, so the
 * least-privilege condition, which allows only those, refuses it: then the installer leaves the command for an admin
 * and carries on, and the scheduled runs carry the load on until an admin runs it.
 */
import { ROLES } from '../../clients/azure.js';

/** @typedef {import('../../install.js').Ctx} Ctx */
/** @typedef {import('../../config.js').AzureConfig} AzureConfig */

/** How the pending admin action starts, whatever the principal, so it can be found and cleared. */
export const RUN_JOB_START_PENDING = 'Let the run job start its next run';

/** The run job's resource ID: the role's scope. @param {AzureConfig} az */
export const runJobId = (az) => `/subscriptions/${az.subscriptionId}/resourceGroups/${az.resourceGroup}/providers/Microsoft.App/jobs/${az.outputs?.runJobName}`;

/**
 * The command an admin runs to give the run job's own identity the role on that job.
 * @param {string} principalId
 * @param {string} scope
 */
export const selfStartCommand = (principalId, scope) =>
  `az role assignment create --assignee-object-id ${principalId} --assignee-principal-type ServicePrincipal --role ${ROLES.containerAppsJobsOperator} --scope ${scope}`;

/**
 * The plan review's line for the role. The plan comes before the deploy, so it says what happens either way.
 * @param {AzureConfig} az
 * @returns {{ who: string, what: string, where: string, detail?: string }[]}
 */
export const selfStartGrants = (az) => (az.sampleData ? [] : [{
  who: "Run job's own identity",
  what: 'Container Apps Jobs Operator',
  where: 'The run job only',
  detail: 'The run job can start itself (Container Apps Jobs Operator on that job only), to carry on a long first load. Installer assigns it after the deploy, or records admin action if blocked.',
}]);

/**
 * Replaces the pending admin action, or removes it with no `action`. Matched by how it starts: a recreated job has a
 * new principal ID.
 * @param {AzureConfig} az
 * @param {string} [action]
 */
function setPending(az, action) {
  const list = az.status?.pendingAdminActions ?? [];
  const rest = list.filter((a) => !a.startsWith(`${RUN_JOB_START_PENDING}: `));
  if (!action && rest.length === list.length) return;
  az.status ??= {};
  az.status.pendingAdminActions = action ? [...rest, action] : rest;
}

/**
 * Gives the run job's own identity Container Apps Jobs Operator on the run job, after the final deploy, and records
 * whether the run job can start itself. It reads first: a condition-limited caller is refused before Azure checks
 * for a duplicate, so an assignment an admin has made would otherwise go unnoticed. If the installer can't give it,
 * it leaves a pending admin action with the command and carries on. Demo mode never carries a load on, so it gives
 * nothing.
 * @param {Ctx} ctx
 */
export async function ensureRunJobSelfStart(ctx) {
  const { ui, api } = ctx;
  const az = /** @type {AzureConfig} */ (ctx.config.azure);
  /** @type {string | undefined} */
  const principal = az.outputs?.runJobPrincipalId;
  if (az.sampleData || !principal || !az.outputs?.runJobName) {
    setPending(az);
    delete az.runJobSelfStart;
    ctx.save();
    return;
  }
  const scope = runJobId(az);
  const role = ROLES.containerAppsJobsOperator;
  try {
    const assigned = await api.arm.myRoleAssignments(scope, [principal]).catch(() => []);
    const held = assigned.some((a) => String(a.properties?.roleDefinitionId ?? '').toLowerCase().endsWith(`/${role}`));
    // false: Azure already had it (409).
    if (held || (await api.arm.assignRole(scope, role, principal, 'ServicePrincipal')) === false) ui.ok('The run job can start its next run itself');
    else ui.ok("Gave the run job's own identity Container Apps Jobs Operator on that job, so a long first load starts its next run straight away");
    az.runJobSelfStart = true;
    setPending(az);
  } catch (err) {
    const command = selfStartCommand(principal, scope);
    ui.warn(`Couldn't give the run job's own identity Container Apps Jobs Operator on that job (${/** @type {Error} */ (err).message.split('\n')[0]}). ` +
      `Until an admin does, a long first load carries on at each scheduled run, not straight away. An Owner or User Access Administrator on the resource group can run: ${command}`);
    az.runJobSelfStart = false;
    setPending(az, `${RUN_JOB_START_PENDING}: ${command}`);
  }
  ctx.save();
}
