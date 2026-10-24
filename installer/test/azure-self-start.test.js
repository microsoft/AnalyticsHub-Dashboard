// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ROLES } from '../src/clients/azure.js';
import { firstLoadEstimate } from '../src/estimate.js';
import { HttpError } from '../src/http.js';
import { azurePlanReview, azureStatus, installAzure } from '../src/steps/azure/index.js';
import { roleCondition, TEMPLATE_ROLES } from '../src/steps/azure/least-privilege.js';
import { ensureRunJobSelfStart, RUN_JOB_START_PENDING, runJobId, selfStartCommand } from '../src/steps/azure/self-start.js';
import { fakeArm, fakeAzureGraph, fakeCtx, fakeFabric, fakePowerBi, fakeUi } from './fakes.js';

const OPERATOR = ROLES.containerAppsJobsOperator;
const JOB = '/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.App/jobs/vlens-run';
const GIVE = `assignRole ${JOB} ${OPERATOR} run-sp ServicePrincipal`;
const COMMAND = `az role assignment create --assignee-object-id run-sp --assignee-principal-type ServicePrincipal --role ${OPERATOR} --scope ${JOB}`;
const PENDING = `${RUN_JOB_START_PENDING}: ${COMMAND}`;
const forbidden = () => new HttpError('403 Forbidden', { method: 'PUT', url: 'x', status: 403 });

/** As Azure records the role once an admin has given it. @param {string} [principalId] */
const given = (principalId = 'run-sp') => ({ properties: { roleDefinitionId: `/subscriptions/sub-1/providers/Microsoft.Authorization/roleDefinitions/${OPERATOR}`, principalId, scope: JOB } });

/**
 * Refuses the role on the run job, as Azure refuses a Role Based Access Control Administrator whose condition allows
 * only the template's roles, and passes any other role on.
 * @param {ReturnType<typeof fakeArm>} arm
 * @param {Error} [err]
 */
function refuse(arm, err = forbidden()) {
  const assign = /** @type {any} */ (arm.api).assignRole;
  /** @type {any} */ (arm.api).assignRole = async (/** @type {string} */ scope, /** @type {string} */ role, /** @type {string} */ principal, /** @type {string} */ type) => {
    if (role !== OPERATOR) return assign(scope, role, principal, type);
    arm.calls.push(`assignRole ${scope} ${role} ${principal} ${type}`);
    throw err;
  };
}

/** A plain Azure install, with no first load. @param {Partial<import('../src/config.js').AzureConfig>} [az] */
function azureInstall(az = {}) {
  const arm = fakeArm();
  const powerBi = fakePowerBi();
  powerBi.setDatasources([{ datasourceType: 'Sql', gatewayId: 'gw', datasourceId: 'ds', connectionDetails: { server: 'vlens-sql.database.windows.net', database: 'valuelens' } }]);
  const ui = fakeUi();
  const { ctx, config } = fakeCtx({ arm: arm.api, graph: fakeAzureGraph().api, fabric: fakeFabric().api, powerBi: powerBi.api, ui: ui.ui });
  Object.assign(config, {
    target: 'azure',
    azure: { subscriptionId: 'sub-1', resourceGroup: 'rg', location: 'uksouth', namePrefix: 'vlens', installId: 'install-1', tags: {}, deployments: [], outputs: {}, graphRoles: { assigned: [], pending: [] }, publicNetworkAccess: true, workspaceName: 'Analytics Hub', ...az },
  });
  ctx.runFirstLoad = false;
  const az_ = () => /** @type {import('../src/config.js').AzureConfig} */ (config.azure);
  return {
    arm,
    ui,
    ctx,
    config,
    az: az_,
    gives: () => arm.calls.filter((c) => c.startsWith('assignRole') && c.includes(OPERATOR)),
    pending: () => (az_().status?.pendingAdminActions ?? []).filter((a) => a.startsWith(RUN_JOB_START_PENDING)),
  };
}

/** The step alone, after a deploy that output the run job's own identity. @param {Partial<import('../src/config.js').AzureConfig>} [az] */
function afterDeploy(az = {}) {
  const arm = fakeArm();
  const ui = fakeUi();
  const { ctx, config } = fakeCtx({ arm: arm.api, ui: ui.ui });
  config.target = 'azure';
  config.azure = { subscriptionId: 'sub-1', resourceGroup: 'rg', location: 'uksouth', namePrefix: 'vlens', installId: 'install-1', tags: {}, deployments: [], outputs: { runJobName: 'vlens-run', runJobPrincipalId: 'run-sp' }, graphRoles: { assigned: [], pending: [] }, ...az };
  return { arm, ui, ctx, az: config.azure };
}

test('Azure self-start: after the final deploy, the run job\'s own identity gets Container Apps Jobs Operator on that job only', async () => {
  const t = azureInstall();
  assert.equal(await installAzure(t.ctx, { wait: true }), true);
  assert.deepEqual(t.gives(), [GIVE], "to the run job's own principal, at the job's scope, as a service principal");
  assert.ok(t.arm.calls.indexOf(GIVE) > t.arm.calls.map((c) => c.startsWith('deployTemplate')).lastIndexOf(true), 'after the deploy that creates the identity');
  assert.ok(!t.arm.calls.some((c) => c.startsWith('assignRole') && c.includes('mi-sp') && c.includes(OPERATOR)), 'not the identity the jobs share with the web app');
  assert.equal(t.az().runJobSelfStart, true);
  assert.deepEqual(t.pending(), []);
  assert.match(t.ui.text(), /Gave the run job's own identity Container Apps Jobs Operator on that job, so a long first load starts its next run straight away/);

  // An update or repair reads the role first, and gives nothing again.
  t.arm.calls.length = 0;
  assert.equal(await installAzure(t.ctx, { wait: true }), true);
  assert.deepEqual(t.gives(), []);
  assert.equal(t.az().runJobSelfStart, true);
  assert.match(t.ui.text(), /The run job can start its next run itself/);
});

test('Azure self-start: the role stays out of the template\'s roles, so the least-privilege condition still allows only those', () => {
  assert.equal(ROLES.containerAppsJobsOperator, 'b9a307c4-5aa3-4b52-ba60-2b17c136cd7b', 'Container Apps Jobs Operator, as Azure names it');
  assert.ok(!TEMPLATE_ROLES.some((r) => r.id === OPERATOR));
  assert.equal(TEMPLATE_ROLES.length, 4);
  assert.ok(!roleCondition().includes(OPERATOR), 'a condition-limited admin is refused it, and hands it on');
  assert.equal(runJobId(/** @type {any} */ ({ subscriptionId: 'sub-1', resourceGroup: 'rg', outputs: { runJobName: 'vlens-run' } })), JOB);
  assert.equal(selfStartCommand('run-sp', JOB), COMMAND);
});

test('Azure self-start: a 403 leaves the command for an admin, and the install carries on; once an admin has run it, the next update clears it', async () => {
  const t = azureInstall();
  refuse(t.arm);
  assert.equal(await installAzure(t.ctx, { wait: true }), true, 'the install carries on');
  assert.deepEqual(t.gives(), [GIVE]);
  assert.equal(t.az().runJobSelfStart, false);
  assert.deepEqual(t.pending(), [PENDING], 'the exact command, under a prefix an admin pack can find');
  const out = t.ui.text();
  assert.ok(out.includes(`Couldn't give the run job's own identity Container Apps Jobs Operator on that job (403 Forbidden). Until an admin does, a long first load carries on at each scheduled run, not straight away. An Owner or User Access Administrator on the resource group can run: ${COMMAND}`));

  await azureStatus(t.ctx);
  assert.ok(t.ui.text().includes(`Pending admin action: ${PENDING}`), 'status shows it with the other pending admin actions');

  // An admin runs the command. A condition-limited caller's PUT would be refused before Azure checks for a duplicate,
  // so the installer reads first: it finds the role, gives nothing and clears the action.
  t.arm.roleAssignments.push(given());
  t.arm.calls.length = 0;
  assert.equal(await installAzure(t.ctx, { wait: true }), true);
  assert.deepEqual(t.gives(), []);
  assert.equal(t.az().runJobSelfStart, true);
  assert.deepEqual(t.pending(), []);
});

test('Azure self-start: any other error is handed on the same way, and a read that fails falls back to giving it', async () => {
  const broken = afterDeploy();
  refuse(broken.arm, new HttpError('500 Internal Server Error\nmore detail', { method: 'PUT', url: 'x', status: 500 }));
  await ensureRunJobSelfStart(broken.ctx);
  assert.equal(broken.az.runJobSelfStart, false);
  assert.deepEqual(broken.az.status?.pendingAdminActions, [PENDING]);
  assert.match(broken.ui.text(), /Couldn't give the run job's own identity Container Apps Jobs Operator on that job \(500 Internal Server Error\)\./, 'the first line of the error');

  const unread = afterDeploy();
  unread.arm.failures.myRoleAssignments = [new HttpError('403 Forbidden', { method: 'GET', url: 'x', status: 403 })];
  await ensureRunJobSelfStart(unread.ctx);
  assert.deepEqual(unread.arm.calls, [GIVE]);
  assert.equal(unread.az.runJobSelfStart, true);
});

test('Azure self-start: a 409 means Azure has it already, which counts as done', async () => {
  const t = afterDeploy({ status: { pendingAdminActions: [PENDING] } });
  // The client turns a 409 RoleAssignmentExists into false (org-access.test.js checks that), here past a read that
  // didn't see it.
  /** @type {any} */ (t.arm.api).assignRole = async () => false;
  await ensureRunJobSelfStart(t.ctx);
  assert.equal(t.az.runJobSelfStart, true);
  assert.deepEqual(t.az.status?.pendingAdminActions, []);
  assert.match(t.ui.text(), /The run job can start its next run itself/);
  assert.doesNotMatch(t.ui.text(), /Gave the run job/);
});

test('Azure self-start: the pending action is matched by how it starts, as a recreated job has a new principal', async () => {
  const other = 'Grant-PnPAzureADAppSitePermission -AppId x -DisplayName y -Site https://contoso.sharepoint.com/sites/Analytics -Permissions Read';
  const stale = `${RUN_JOB_START_PENDING}: ${selfStartCommand('old-sp', JOB)}`;
  const t = afterDeploy({ status: { pendingAdminActions: [stale, other] } });
  refuse(t.arm);
  await ensureRunJobSelfStart(t.ctx);
  assert.deepEqual(t.az.status?.pendingAdminActions, [other, PENDING], 'one, for the principal the job has now; the others are kept');

  t.arm.roleAssignments.push(given('old-sp'));
  await ensureRunJobSelfStart(t.ctx);
  assert.deepEqual(t.az.status?.pendingAdminActions, [other, PENDING], "the old principal's role doesn't count");

  t.arm.roleAssignments.push(given());
  await ensureRunJobSelfStart(t.ctx);
  assert.deepEqual(t.az.status?.pendingAdminActions, [other]);
  assert.equal(t.az.runJobSelfStart, true);
});

test('Azure self-start: demo mode, and a deploy without the output, give nothing and leave nothing pending', async () => {
  const demo = afterDeploy({ sampleData: true, runJobSelfStart: true, status: { pendingAdminActions: [PENDING] } });
  await ensureRunJobSelfStart(demo.ctx);
  assert.deepEqual(demo.arm.calls, []);
  assert.equal(demo.az.runJobSelfStart, undefined, 'a sample run never carries a load on');
  assert.deepEqual(demo.az.status?.pendingAdminActions, []);

  const older = afterDeploy({ outputs: { runJobName: 'vlens-run' } });
  await ensureRunJobSelfStart(older.ctx);
  assert.deepEqual(older.arm.calls, []);
  assert.equal(older.az.runJobSelfStart, undefined);
  assert.equal(older.az.status, undefined, 'nothing written when there was nothing to clear');

  const sample = azureInstall({ sampleData: true });
  assert.equal(await installAzure(sample.ctx, { wait: true }), true);
  assert.deepEqual(sample.gives(), []);
});

test('Azure self-start: the plan review lists the role, worded for either outcome, except in demo mode', () => {
  const t = azureInstall();
  const row = azurePlanReview(t.ctx).grants.find((g) => g.what === 'Container Apps Jobs Operator');
  assert.deepEqual(row, {
    who: "Run job's own identity",
    what: 'Container Apps Jobs Operator',
    where: 'The run job only',
    detail: 'The run job can start itself (Container Apps Jobs Operator on that job only), to carry on a long first load. Installer assigns it after the deploy, or records admin action if blocked.',
  });
  t.az().sampleData = true;
  assert.ok(!azurePlanReview(t.ctx).grants.some((g) => g.what === 'Container Apps Jobs Operator'));
});

test('Azure self-start: when a reload starts, the note says what carries it on, with the role and while it waits for an admin', async () => {
  const held = azureInstall();
  assert.equal(await installAzure(held.ctx, { wait: true }), true);
  held.ctx.reloadHistoryDays = 90;
  assert.equal(await installAzure(held.ctx, { wait: true }), true);
  assert.match(held.ui.text(), /Started run job \(vlens-run-exec\) with 90 days of audit history/);
  assert.ok(held.ui.text().includes(firstLoadEstimate(90, undefined, 'azure', { reload: true, selfStart: true }).trim()));
  assert.match(held.ui.text(), /so the reports fill in after each run\. The next run then starts by itself and carries on where it stopped, until the history is loaded\./);

  const waiting = azureInstall();
  refuse(waiting.arm);
  assert.equal(await installAzure(waiting.ctx, { wait: true }), true);
  waiting.ctx.reloadHistoryDays = 90;
  assert.equal(await installAzure(waiting.ctx, { wait: true }), true);
  assert.match(waiting.ui.text(), /The next scheduled run carries on where it stopped, or start one sooner with "valuelens-install run"\. An admin can let the next run start straight away: see the pending admin action in "valuelens-install status"\./);
  assert.doesNotMatch(waiting.ui.text(), /starts by itself/);
});
