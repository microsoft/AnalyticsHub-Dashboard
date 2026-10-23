// @ts-check
// Sizing the Azure path for a large tenant: the size question, first in Azure placement and started from the people
// counted; the Power BI capacity it recommends; and the paid Azure SQL and always-on web app it offers. A new large
// install starts on carrying on past the free allowance, and the plan shows what it costs. --yes never opts into
// extra spend: a new large install stops before anything is deployed unless --sql-scale-up or --sql-free-offer
// chooses. Smaller tenants see no change, and Repair or change keeps what an install chose. Expectations come from the
// constants, so changing the recommended size after the Azure speed test stays a one-line change.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { help, main, parseCli } from '../src/cli.js';
import { install } from '../src/install.js';
import { azureDeployment, azurePlanReview, capacityUnits, confirmAzurePlan, largeAzureTenant, planAzure, plannedSql, SQL_SCALE_UP_COST, sqlChoiceNeeded, sqlFlagFabricError } from '../src/steps/azure/index.js';
import { SIZE_QUESTION } from '../src/steps/plan.js';
import { AZURE_LARGE_TENANT_SKU, AZURE_LARGE_TENANT_SQL_VCORES, COPILOT_PLAN, LARGE_TENANT_PEOPLE } from '../src/seats.js';
import { createUi } from '../src/ui.js';
import { armEvaluator, RUNTIME_FUNCTIONS, validateArmTemplate } from './arm-expressions.js';
import { fakeArm, fakeCtx, fakeFabric, fakePowerBi, fakeUi, httpError } from './fakes.js';

const TEMPLATE = JSON.parse(readFileSync(new URL('../src/azure/main.arm.json', import.meta.url), 'utf8'));
const SCOPE = { subscriptionId: '11111111-1111-1111-1111-111111111111', resourceGroup: 'rg-analytics-hub' };
const PRE = { subscriptions: [{ subscriptionId: 'sub-1', displayName: 'Sub' }], canConsent: true, canCreateApps: true, capacities: [], tenantSettings: [] };
const SQL = 'Azure SQL compute';
const WEB = 'Web app';
const CAPACITY = 'Capacity for the Power BI workspace';
const SKU = AZURE_LARGE_TENANT_SKU;
const VCORES = AZURE_LARGE_TENANT_SQL_VCORES;
/** What a tenant up to 10,000 people deploys, as before large tenants were sized. */
const SMALL = { sqlMinCapacity: '0.5', sqlMaxCapacity: 2, sqlAutoPauseDelayMinutes: 60, sqlUseFreeLimit: true, sqlFreeLimitExhaustionBehavior: 'AutoPause', webMinReplicas: 0 };
/** Azure SQL scaled up and carrying on past the free allowance, with the web app still scaling to zero. */
const SCALED_UP = { ...SMALL, sqlMaxCapacity: VCORES, sqlFreeLimitExhaustionBehavior: 'BillOverUsage' };
const SIZED_UP = { ...SCALED_UP, webMinReplicas: 1 };
const SHARED_WARNING = /on shared capacity, where a semantic model is limited to 1 GB/;
/** An install that has deployed, as Repair or change finds it. @type {import('../src/config.js').AzureConfig} */
const DEPLOYED = {
  subscriptionId: 'sub-1', resourceGroup: 'rg-analytics-hub', resourceGroupMode: 'existing', location: 'uksouth', namePrefix: 'vlens', tags: {},
  outputs: { sqlServerFqdn: 'vlens-sql.database.windows.net', sqlDatabaseName: 'valuelens' },
};

/** @param {string} id @param {string} sku */
const cap = (id, sku) => ({ id, displayName: sku, sku, region: 'UK South', state: 'Active' });
/** @param {number} capacity @param {any} properties */
const liveDb = (capacity, properties) => ({ sku: { capacity }, properties: { minCapacity: 0.5, autoPauseDelay: 60, ...properties } });
/** @param {any} r */
const list = (r) => (Array.isArray(r) ? r : Object.values(r ?? {}));
/** People with a licence and an enabled account, as the checks count them. @param {number} count @returns {import('../src/seats.js').Headcount} */
const people = (count) => ({ count, source: 'licensed' });

/**
 * A context for planAzure whose selects are recorded and can be answered by question. With `yes`, it runs as --yes
 * does, and the size and sizing questions are answered the way an unattended run answers them. `armCalls` lists the
 * Azure Resource Manager calls made.
 * @param {{ answers?: Record<string, any>, yes?: boolean, capacities?: any[], groups?: any[], workspaceCapacities?: Record<string, string>, workspaceUnreadable?: boolean, azure?: any, sqlDatabase?: any }} [o]
 */
function planCtx(o = {}) {
  const arm = fakeArm();
  const fabric = fakeFabric();
  const powerBi = fakePowerBi();
  const u = fakeUi({ yes: o.yes });
  /** @type {Record<string, { choices: any[], def: any }>} */
  const selects = {};
  const select = u.ui.select;
  const unattended = createUi({ yes: true, write: () => {} });
  u.ui.select = async (message, choices, def) => {
    selects[message] = { choices, def };
    if (o.answers && message in o.answers) {
      u.asked.push(message);
      return o.answers[message];
    }
    if (o.yes && [SIZE_QUESTION, SQL, WEB].includes(message)) {
      u.asked.push(message);
      return unattended.select(message, choices, def);
    }
    return select(message, choices, def);
  };
  if (o.capacities) fabric.api.listCapacities = async () => /** @type {any[]} */ (o.capacities);
  if (o.groups) /** @type {any} */ (powerBi.api).groups = async () => o.groups;
  Object.assign(fabric.workspaceCapacities, o.workspaceCapacities ?? {});
  if (o.workspaceUnreadable) fabric.api.getWorkspace = async () => {
    throw httpError(403, 'Forbidden');
  };
  if (o.sqlDatabase) /** @type {any} */ (arm.api).getSqlDatabase = async () => o.sqlDatabase;
  /** @type {string[]} */
  const armCalls = [];
  for (const [name, fn] of Object.entries(arm.api)) {
    if (typeof fn === 'function') /** @type {any} */ (arm.api)[name] = (/** @type {any[]} */ ...args) => {
      armCalls.push(name);
      return /** @type {(...a: any[]) => any} */ (fn)(...args);
    };
  }
  const t = fakeCtx({ ui: u.ui, arm: arm.api, fabric: fabric.api, powerBi: powerBi.api });
  delete t.config.fabric.workspaceId;
  if (o.azure) t.config.azure = structuredClone(o.azure);
  return { ...t, u, selects, armCalls, az: () => /** @type {import('../src/config.js').AzureConfig} */ (t.config.azure) };
}

/** The sizing an install deploys. @param {import('../src/install.js').Ctx} ctx */
async function sizing(ctx) {
  const p = (await azureDeployment(ctx, { pass: 1 })).properties.parameters;
  return {
    sqlMinCapacity: p.sqlMinCapacity.value, sqlMaxCapacity: p.sqlMaxCapacity.value, sqlAutoPauseDelayMinutes: p.sqlAutoPauseDelayMinutes.value,
    sqlUseFreeLimit: p.sqlUseFreeLimit.value, sqlFreeLimitExhaustionBehavior: p.sqlFreeLimitExhaustionBehavior.value, webMinReplicas: p.webMinReplicas.value,
  };
}

/** @param {import('../src/install.js').Ctx} ctx */
const costLine = (ctx) => String(azurePlanReview(ctx).runsOn.find((r) => r.what === 'Cost')?.where);

test('Azure sizing: a tenant up to 10,000 people is asked its size and nothing else new, and deploys what it did before', async () => {
  for (const pre of [{}, { seats: 9_000 }, { seats: 3_000, headcount: people(LARGE_TENANT_PEOPLE) }]) {
    const what = JSON.stringify(pre);
    const t = planCtx();
    await planAzure(t.ctx, { ...PRE, ...pre });
    assert.equal(t.selects[SIZE_QUESTION].def, 'standard', what);
    assert.equal(t.config.scale, 'standard', what);
    assert.ok(!t.u.asked.includes(SQL) && !t.u.asked.includes(WEB), `${what}: no sizing questions`);
    assert.equal(t.az().sqlScaleUp, undefined);
    assert.equal(t.az().webAlwaysOn, undefined);
    assert.equal(t.selects[CAPACITY].def, 'cap-f', 'the first capacity, as before');
    assert.ok(t.selects[CAPACITY].choices.every((c) => c.description === undefined), 'no capacity advice');
    assert.doesNotMatch(t.u.text(), /can be sized up|or larger is recommended/);
    assert.doesNotMatch(t.u.text(), SHARED_WARNING);
    assert.deepEqual(await sizing(t.ctx), SMALL);
    assert.doesNotMatch(costLine(t.ctx), /You chose/);
  }
  const shared = planCtx({ answers: { [CAPACITY]: '' } });
  await planAzure(shared.ctx, { ...PRE, headcount: people(2_000) });
  assert.doesNotMatch(shared.u.text(), SHARED_WARNING, 'shared capacity is fine for a small tenant');
});

test('Azure sizing: the size question comes first in Azure placement, started from the people counted', async () => {
  const t = planCtx();
  await planAzure(t.ctx, { ...PRE, seats: 3_000, headcount: people(61_234) });
  const at = (/** @type {string} */ q) => t.u.asked.indexOf(q);
  assert.ok(at(SIZE_QUESTION) >= 0, 'asked without the advanced settings');
  for (const later of ['Azure subscription', SQL, WEB, CAPACITY]) assert.ok(at(SIZE_QUESTION) < at(later), `before "${later}"`);
  const size = t.selects[SIZE_QUESTION];
  assert.deepEqual(size.choices.map((c) => [c.name, c.value]), [['Up to 10,000', 'standard'], ['More than 10,000', 'large']]);
  assert.match(size.choices[1].description, new RegExp(`recommends ${SKU} or larger for Power BI, and asks whether Azure SQL carries on past the free offer's monthly allowance, at a cost you see first\\.`));
  assert.equal(size.def, 'large', 'more than 10,000 people, though only 3,000 have Copilot');
  assert.equal(t.config.scale, 'large');
  assert.match(t.u.text(), /We found 61,234 people with a licence and an enabled account\./);
  assert.match(t.u.text(), new RegExp(`${SKU} or larger is recommended for a large organisation \\(61,234 people\\)\\.`));

  const answered = planCtx({ answers: { [SIZE_QUESTION]: 'standard' } });
  await planAzure(answered.ctx, { ...PRE, headcount: people(61_234) });
  assert.equal(answered.config.scale, 'standard', 'the answer wins over the count');
  assert.ok(!answered.u.asked.includes(SQL), 'sized for up to 10,000, so Azure SQL isn\'t offered');
  assert.deepEqual(await sizing(answered.ctx), SMALL);

  const smaller = planCtx({ answers: { [SIZE_QUESTION]: 'large' } });
  await planAzure(smaller.ctx, { ...PRE, headcount: people(5_000) });
  assert.equal(smaller.config.scale, 'large');
  assert.ok(smaller.u.asked.includes(SQL), 'sized for a large organisation, so Azure SQL is offered');
  assert.match(smaller.u.text(), new RegExp(`${SKU} or larger is recommended for a large organisation\\.`), 'without the smaller count');
});

test('Azure sizing: a new large install starts on carrying on past the free allowance, and the plan shows the cost', async () => {
  const t = planCtx();
  await planAzure(t.ctx, { ...PRE, headcount: people(61_234) });
  assert.match(t.u.text(), /For a large organisation, Azure SQL and the web app can be sized up, at extra cost\./);
  const sql = t.selects[SQL];
  assert.deepEqual(sql.choices.map((c) => [c.name, c.value]), [
    ['Keep the free offer, up to 2 vCores (no extra cost)', false],
    [`Scale up to ${VCORES} vCores and carry on past the free allowance (recommended; about ${SQL_SCALE_UP_COST} a month)`, true],
  ]);
  assert.match(sql.choices[0].description, /When the month's free allowance runs out, Azure pauses the database until next month, and the jobs stop until then\./);
  assert.match(sql.choices[1].description, /can't switch the database back to pausing\. An indicative list price: check https:\/\/azure\.microsoft\.com\/pricing\/calculator\/\./);
  assert.equal(sql.def, true, 'pre-selected');
  const web = t.selects[WEB];
  assert.deepEqual(web.choices.map((c) => [c.name, c.value]), [
    ['Scale to zero when idle (no extra cost)', false],
    ['Keep one replica running (about $10-20 a month)', true],
  ]);
  assert.match(web.choices[0].description, /first visit after a quiet spell waits/);
  assert.equal(web.def, false, 'the web app still scales to zero unless chosen');
  assert.equal(t.az().sqlScaleUp, true);
  assert.equal(t.az().webAlwaysOn, false);
  assert.deepEqual(await sizing(t.ctx), SCALED_UP);
  assert.match(costLine(t.ctx), / You chose Azure SQL sized up \(about \$30-80\/month\)\.$/);

  const kept = planCtx({ answers: { [SQL]: false } });
  await planAzure(kept.ctx, { ...PRE, headcount: people(61_234) });
  assert.equal(kept.az().sqlScaleUp, false, 'keeping the free offer is still a choice');
  assert.deepEqual(await sizing(kept.ctx), SMALL);
  assert.doesNotMatch(costLine(kept.ctx), /You chose/);
});

test('Azure sizing: --yes stops a new large install before anything is deployed, unless a flag chooses what Azure SQL does', async () => {
  const pre = { ...PRE, seats: 3_000, headcount: people(61_234) };
  const t = planCtx({ yes: true });
  await assert.rejects(planAzure(t.ctx, pre), { message: sqlChoiceNeeded(people(61_234)) });
  assert.equal(
    sqlChoiceNeeded(people(61_234)),
    "61,234 people is more than the free Azure SQL offer suits: it pauses the database, and the jobs, when the month's allowance runs out. " +
      'Choose one and run again: add --sql-scale-up to carry on past the allowance (about $30-80 a month), or --sql-free-offer to keep the free offer. Nothing has been deployed.',
  );
  assert.deepEqual(t.armCalls, [], 'no Azure Resource Manager call');
  assert.ok(!t.u.asked.includes(SQL));
  assert.equal(t.az().sqlScaleUp, undefined);

  const up = planCtx({ yes: true });
  up.ctx.sqlChoice = true;
  await planAzure(up.ctx, pre);
  assert.ok(!up.u.asked.includes(SQL), '--sql-scale-up answers it');
  assert.equal(up.az().sqlScaleUp, true);
  assert.equal(up.az().webAlwaysOn, false, '--yes leaves the web app scaling to zero');
  assert.deepEqual(await sizing(up.ctx), SCALED_UP);

  const free = planCtx({ yes: true });
  free.ctx.sqlChoice = false;
  await planAzure(free.ctx, pre);
  assert.equal(free.az().sqlScaleUp, false);
  assert.deepEqual(await sizing(free.ctx), SMALL);

  // A choice already recorded, by an earlier run that stopped before deploying, chooses too.
  for (const azure of [{ sqlScaleUp: false }, { sqlScaleUp: true }, { sqlFreeOffer: false }]) {
    const recorded = planCtx({ yes: true, azure });
    await planAzure(recorded.ctx, pre);
    assert.equal(recorded.az().sqlScaleUp, azure.sqlScaleUp === true, JSON.stringify(azure));
  }
  // So does a size recorded as up to 10,000, and demo mode.
  const standard = planCtx({ yes: true });
  standard.config.scale = 'standard';
  await planAzure(standard.ctx, pre);
  assert.equal(standard.config.scale, 'standard');
  await planAzure(planCtx({ yes: true, azure: { sampleData: true } }).ctx, pre);
});

test('Azure sizing: the Azure SQL flags work at any size, and --sql-free-offer leaves a database billed past the allowance as it is', async () => {
  const up = planCtx({ azure: DEPLOYED });
  up.ctx.sqlChoice = true;
  await planAzure(up.ctx, { ...PRE, headcount: people(2_000) });
  assert.ok(!up.u.asked.includes(SQL));
  assert.equal(up.az().sqlScaleUp, true);
  assert.deepEqual(await sizing(up.ctx), SCALED_UP);

  for (const yes of [false, true]) {
    const billed = planCtx({ yes, azure: { ...DEPLOYED, sqlScaleUp: true }, sqlDatabase: liveDb(VCORES, { useFreeLimit: true, freeLimitExhaustionBehavior: 'BillOverUsage' }) });
    billed.ctx.sqlChoice = false;
    await planAzure(billed.ctx, { ...PRE, headcount: people(61_234) });
    assert.ok(!billed.u.asked.includes(SQL));
    assert.match(billed.u.text(), /Azure SQL already carries on past the free offer's monthly allowance, and the installer doesn't switch a database back to pausing, so --sql-free-offer leaves it as it is\./);
    assert.equal(billed.az().sqlScaleUp, true, 'and the record with it');
    const s = await sizing(billed.ctx);
    assert.deepEqual([s.sqlMaxCapacity, s.sqlUseFreeLimit, s.sqlFreeLimitExhaustionBehavior], [VCORES, true, 'BillOverUsage']);
  }

  const paid = planCtx({ azure: DEPLOYED, sqlDatabase: liveDb(2, { useFreeLimit: false }) });
  paid.ctx.sqlChoice = false;
  await planAzure(paid.ctx, { ...PRE, headcount: people(61_234) });
  assert.match(paid.u.text(), /Azure SQL isn't on the free offer, so --sql-free-offer leaves it as it is\./);
  assert.equal(paid.az().sqlScaleUp, undefined);
});

test('Azure sizing: Repair keeps the size it recorded, and never pre-selects spend', async () => {
  for (const yes of [false, true]) {
    const how = yes ? '--yes' : 'every default';
    const standard = planCtx({ yes, azure: DEPLOYED });
    standard.config.scale = 'standard';
    await planAzure(standard.ctx, { ...PRE, headcount: people(61_234) });
    assert.equal(standard.selects[SIZE_QUESTION].def, 'standard', how);
    assert.equal(standard.config.scale, 'standard', how);
    assert.match(standard.u.text(), /We found 61,234 people with a licence and an enabled account\. This install is set up for up to 10,000 people, and stays so unless you choose otherwise\./);
    assert.ok(!standard.u.asked.includes(SQL), `${how}: sized for up to 10,000`);

    const large = planCtx({ yes, azure: DEPLOYED });
    large.config.scale = 'large';
    await planAzure(large.ctx, { ...PRE, headcount: people(5_000) });
    assert.equal(large.config.scale, 'large', how);
    assert.equal(large.selects[SQL].def, false, `${how}: an existing database isn't moved past the free allowance by default`);
    assert.equal(large.az().sqlScaleUp, false, how);

    // A record from before the size was asked on Azure starts from the people counted, and still adds no spend.
    const before = planCtx({ yes, azure: DEPLOYED });
    await planAzure(before.ctx, { ...PRE, headcount: people(61_234) });
    assert.equal(before.config.scale, 'large', how);
    assert.equal(before.selects[SQL].def, false, how);
    assert.deepEqual(await sizing(before.ctx), SMALL, how);
  }
});

test('Azure sizing: with the size asked first, a Repair with --yes or every default still keeps a Pro install off a capacity', async () => {
  for (const yes of [false, true]) {
    const how = yes ? '--yes' : 'every default';
    const t = planCtx({ yes, capacities: [cap('cap-rec', SKU)], azure: { ...DEPLOYED, powerBi: { workspaceId: 'pbi-ws-1', createdWorkspace: true, sharedCapacity: true } } });
    await planAzure(t.ctx, { ...PRE, headcount: people(61_234) });
    assert.ok(t.u.asked.indexOf(SIZE_QUESTION) < t.u.asked.indexOf(CAPACITY), how);
    assert.equal(t.config.scale, 'large', `${how}: sized for the people counted`);
    assert.equal(t.selects[CAPACITY].def, '', `${how}: None, where the workspace is`);
    assert.equal(t.az().powerBi?.capacityId, undefined, how);
    assert.equal(t.az().powerBi?.sharedCapacity, true, how);
    assert.match(t.u.text(), SHARED_WARNING, `${how}: still warned`);
  }
});

test('Azure sizing: a large tenant that opts in deploys more vCores past the free allowance and one web replica, and the plan shows the cost', async () => {
  const t = planCtx({ answers: { [SQL]: true, [WEB]: true } });
  await planAzure(t.ctx, { ...PRE, headcount: people(20_000) });
  assert.equal(t.az().sqlScaleUp, true);
  assert.equal(t.az().webAlwaysOn, true);
  assert.deepEqual(await sizing(t.ctx), SIZED_UP);
  assert.match(costLine(t.ctx), / You chose Azure SQL sized up \(about \$30-80\/month\) and one web app replica always running \(about \$10-20\/month\)\.$/);

  const web = planCtx({ answers: { [SQL]: false, [WEB]: true } });
  await planAzure(web.ctx, { ...PRE, headcount: people(20_000) });
  assert.deepEqual(await sizing(web.ctx), { ...SMALL, webMinReplicas: 1 });
  assert.match(costLine(web.ctx), / You chose one web app replica always running \(about \$10-20\/month\)\.$/);
});

test('Azure sizing: Repair or change keeps what the install chose, with or without --yes, whatever the count now', async () => {
  const chosen = { ...DEPLOYED, outputs: {}, sqlScaleUp: true, webAlwaysOn: true };
  for (const yes of [false, true]) {
    const t = planCtx({ yes, azure: chosen });
    await planAzure(t.ctx, { ...PRE, seats: 5_000 }, 'placement');
    assert.equal(t.selects[SQL].def, true);
    assert.equal(t.selects[WEB].def, true);
    assert.equal(t.az().sqlScaleUp, true);
    assert.equal(t.az().webAlwaysOn, true);
    assert.doesNotMatch(t.u.text(), /can be sized up/, 'no longer a large tenant, so no pitch');
    assert.deepEqual(await sizing(t.ctx), SIZED_UP);
  }
  // Repair asks nothing: it deploys from the record.
  assert.deepEqual(await sizing(planCtx({ azure: chosen }).ctx), SIZED_UP);
  assert.deepEqual(await sizing(planCtx({ azure: { ...chosen, sqlScaleUp: false, webAlwaysOn: false } }).ctx), SMALL);
});

test('plannedSql: an existing database keeps its own settings, and carrying on past the free allowance sticks', () => {
  assert.deepEqual(plannedSql({}, {}), { minCapacity: '0.5', maxCapacity: 2, autoPauseDelay: 60, useFreeLimit: true, freeLimitExhaustionBehavior: 'AutoPause' });
  const live = { capacity: 8, minCapacity: 1, autoPauseDelay: 120, useFreeLimit: false };
  const kept = { minCapacity: '1', maxCapacity: 8, autoPauseDelay: 120, useFreeLimit: false, freeLimitExhaustionBehavior: 'AutoPause' };
  assert.deepEqual(plannedSql({}, live), kept);
  assert.deepEqual(plannedSql({ sqlScaleUp: true }, live), kept, 'never scales down a database sized up in the Azure portal');
  assert.equal(plannedSql({}, { useFreeLimit: true, freeLimitExhaustionBehavior: 'BillOverUsage' }).freeLimitExhaustionBehavior, 'BillOverUsage', 'Azure can\'t switch it back');
  assert.deepEqual(plannedSql({ sqlFreeOffer: false, sqlScaleUp: true }, {}), { minCapacity: '0.5', maxCapacity: VCORES, autoPauseDelay: 60, useFreeLimit: false, freeLimitExhaustionBehavior: 'AutoPause' }, 'no free offer to carry on past');
});

test('Azure sizing: the Azure SQL question starts from the live database', async () => {
  // Only Copilot seats could be read here, and they're enough to start the size from.
  const seats = { ...PRE, seats: 20_000 };
  const big = planCtx({ azure: DEPLOYED, sqlDatabase: liveDb(VCORES * 2, { useFreeLimit: false }) });
  await planAzure(big.ctx, seats, 'placement');
  assert.ok(!big.u.asked.includes(SQL));
  assert.match(big.u.text(), new RegExp(`Azure SQL already scales up to ${VCORES * 2} vCores, so it stays as it is\\.`));
  assert.ok(big.u.asked.includes(WEB), 'the web app is still offered');
  assert.equal((await sizing(big.ctx)).sqlMaxCapacity, VCORES * 2);

  const billed = planCtx({ azure: DEPLOYED, sqlDatabase: liveDb(VCORES, { useFreeLimit: true, freeLimitExhaustionBehavior: 'BillOverUsage' }) });
  await planAzure(billed.ctx, seats, 'placement');
  assert.ok(!billed.u.asked.includes(SQL));
  assert.match(billed.u.text(), new RegExp(`Azure SQL already scales up to ${VCORES} vCores and carries on past the free offer's monthly allowance, so it stays as it is\\.`));

  const paid = planCtx({ azure: DEPLOYED, sqlDatabase: liveDb(2, { useFreeLimit: false }) });
  await planAzure(paid.ctx, seats, 'placement');
  const offered = paid.selects[SQL].choices;
  assert.deepEqual(offered.map((c) => c.name), ['Keep up to 2 vCores (no extra cost)', `Scale up to ${VCORES} vCores (recommended; about $30-80 a month)`]);
  assert.equal(offered[0].description, 'Large loads take longer.');
  assert.doesNotMatch(offered[1].description, /free allowance/);
  assert.equal(paid.selects[SQL].def, false, 'an existing database isn\'t moved to spend by default');

  const free = planCtx({ azure: DEPLOYED, sqlDatabase: liveDb(VCORES, { useFreeLimit: true, freeLimitExhaustionBehavior: 'AutoPause' }), answers: { [SQL]: true } });
  await planAzure(free.ctx, seats, 'placement');
  assert.deepEqual(free.selects[SQL].choices.map((c) => c.name), [`Keep the free offer, up to ${VCORES} vCores (no extra cost)`, 'Carry on past the free allowance (recommended; about $30-80 a month)']);
  const s = await sizing(free.ctx);
  assert.deepEqual([s.sqlMaxCapacity, s.sqlUseFreeLimit, s.sqlFreeLimitExhaustionBehavior], [VCORES, true, 'BillOverUsage']);
});

test('Azure sizing: demo mode on a large tenant asks nothing new and warns about nothing', async () => {
  const t = planCtx({ azure: { sampleData: true }, capacities: [] });
  const scale = t.config.scale;
  await planAzure(t.ctx, { ...PRE, headcount: people(61_234), seats: 20_000 });
  assert.ok(!t.u.asked.includes(SIZE_QUESTION) && !t.u.asked.includes(SQL) && !t.u.asked.includes(WEB));
  assert.equal(t.config.scale, scale, 'demo mode isn\'t sized');
  assert.doesNotMatch(t.u.text(), /can be sized up|or larger is recommended|We found/);
  assert.doesNotMatch(t.u.text(), SHARED_WARNING);
  assert.deepEqual(await sizing(t.ctx), SMALL);
  assert.equal(azurePlanReview(t.ctx, { headcount: people(61_234), seats: 20_000 }).sizedFor, undefined, 'and the review doesn\'t say what it\'s sized for');
  const demo = planCtx({ yes: true, azure: { sampleData: true } });
  await planAzure(demo.ctx, { ...PRE, headcount: people(61_234) });
  assert.deepEqual(await sizing(demo.ctx), SMALL, '--yes doesn\'t stop demo mode');
});

test(`Azure sizing: a large tenant is pointed at ${SKU} or larger for the Power BI workspace`, async () => {
  const units = /** @type {number} */ (capacityUnits(SKU));
  const caps = [cap('cap-small', 'F2'), cap('cap-ppu', 'PP3'), cap('cap-rec', SKU), cap('cap-bigger', `F${units * 2}`)];
  const large = planCtx({ capacities: caps });
  await planAzure(large.ctx, { ...PRE, seats: 20_000 });
  assert.match(large.u.text(), new RegExp(`${SKU} or larger is recommended for a large organisation \\(20,000 Copilot seats\\)\\.`));
  const offered = large.selects[CAPACITY];
  assert.equal(offered.def, 'cap-rec', 'the first capacity big enough');
  assert.deepEqual(offered.choices.map((c) => [c.value, c.description]), [
    ['cap-small', `Below the recommended ${SKU} for a tenant this size.`],
    ['cap-ppu', undefined],
    ['cap-rec', undefined],
    ['cap-bigger', undefined],
    ['', 'Not recommended for a tenant this size: a semantic model there is limited to 1 GB.'],
  ]);
  assert.equal(large.az().powerBi?.capacityId, 'cap-rec');
  assert.doesNotMatch(large.u.text(), SHARED_WARNING);

  const small = planCtx({ capacities: caps });
  await planAzure(small.ctx, { ...PRE, seats: 2_000 });
  assert.equal(small.selects[CAPACITY].def, 'cap-small', 'smaller tenants keep the first capacity');

  const none = planCtx({ capacities: [cap('cap-small', 'F2'), cap('cap-ppu', 'PP3')] });
  await planAzure(none.ctx, { ...PRE, seats: 20_000 });
  assert.equal(none.selects[CAPACITY].def, 'cap-small', 'nothing big enough: the first, as before');

  const kept = planCtx({ capacities: caps, azure: { powerBi: { capacityId: 'cap-small' } } });
  await planAzure(kept.ctx, { ...PRE, seats: 20_000 });
  assert.equal(kept.selects[CAPACITY].def, 'cap-small', 'Repair or change keeps the capacity chosen');

  const shared = planCtx({ capacities: [] });
  await planAzure(shared.ctx, { ...PRE, seats: 20_000 });
  assert.equal(shared.selects[CAPACITY].def, '');
  assert.match(shared.u.text(), new RegExp(`20,000 Copilot seats are assigned, and the Power BI workspace is on shared capacity, where a semantic model is limited to 1 GB\\. In Power BI, choose a Fabric capacity of ${SKU} or larger \\(or its Premium equivalent\\)`));

  const counted = planCtx({ capacities: [] });
  await planAzure(counted.ctx, { ...PRE, headcount: people(61_234), seats: 3_000 });
  assert.match(counted.u.text(), /61,234 people have a licence and an enabled account, and the Power BI workspace is on shared capacity/);
});

test('Azure sizing: a large tenant is warned when the semantic model would sit on shared capacity', async () => {
  const groups = [{ id: 'grp-1', name: 'Analytics' }];
  /** @param {Parameters<typeof planCtx>[0]} o @param {number} [seats] */
  const warned = async (o, seats = 20_000) => {
    const t = planCtx({ groups, ...o });
    await planAzure(t.ctx, { ...PRE, seats });
    return SHARED_WARNING.test(t.u.text());
  };
  assert.equal(await warned({ answers: { [CAPACITY]: '' } }), true, 'a new workspace with no capacity');
  assert.equal(await warned({ answers: { [CAPACITY]: '', 'Power BI workspace': 'grp-1' } }), true, 'an existing workspace on shared capacity');
  assert.equal(await warned({ answers: { [CAPACITY]: '', 'Power BI workspace': 'grp-1' }, workspaceCapacities: { 'grp-1': 'cap-x' } }), false, 'an existing workspace on its own capacity');
  assert.equal(await warned({ answers: { [CAPACITY]: '', 'Power BI workspace': 'grp-1' }, workspaceUnreadable: true }), false, 'can\'t tell, so no warning');
  assert.equal(await warned({}), false, 'a capacity chosen');
  assert.equal(await warned({ answers: { [CAPACITY]: '' } }, 9_000), false, 'a smaller tenant');
});

test('capacityUnits: F, trial, P, A and EM SKUs in Fabric capacity units, and nothing for a SKU without a known size', () => {
  const table = { F2: 2, F64: 64, f128: 128, FTL64: 64, FTL4: 4, P1: 64, P2: 128, P3: 256, A1: 8, A4: 64, EM1: 8, EM3: 32 };
  for (const [sku, units] of Object.entries(table)) assert.equal(capacityUnits(sku), units, sku);
  for (const sku of ['PP3', 'FT1', 'P0', 'X64', '', undefined]) assert.equal(capacityUnits(sku), undefined, String(sku));
  assert.ok((capacityUnits(SKU) ?? 0) > 0, 'the recommended SKU has a known size');
});

test('largeAzureTenant: sized for more than 10,000 people, collecting tenant data; before the size is answered, the people counted', () => {
  assert.equal(largeAzureTenant({}, people(LARGE_TENANT_PEOPLE)), false);
  assert.equal(largeAzureTenant({}, people(LARGE_TENANT_PEOPLE + 1)), true);
  assert.equal(largeAzureTenant({}, { count: 20_000, source: 'seats' }), true, 'Copilot seats, when people couldn\'t be counted');
  assert.equal(largeAzureTenant(undefined, people(20_000)), true);
  assert.equal(largeAzureTenant({ azure: { sampleData: true } }, people(20_000)), false);
  assert.equal(largeAzureTenant({}, undefined), false);
  assert.equal(largeAzureTenant({ scale: 'standard' }, people(20_000)), false, 'the answer wins over the count');
  assert.equal(largeAzureTenant({ scale: 'large' }, undefined), true);
  assert.equal(largeAzureTenant({ scale: 'large', azure: { sampleData: true } }, undefined), false);
});

/** @param {any} [more] */
async function installerParameters(more = {}) {
  const { ctx, config } = fakeCtx();
  config.target = 'azure';
  config.azure = { subscriptionId: SCOPE.subscriptionId, resourceGroup: SCOPE.resourceGroup, location: 'uksouth', namePrefix: 'vlens', installId: '7d1c0f3e-2a55-4f7b-9a0e-3c1d2b4e5f60', tags: {}, deployments: [], outputs: {}, graphRoles: { assigned: [], pending: [] }, ...more };
  return (await azureDeployment(ctx, { pass: 1 })).properties.parameters;
}

/**
 * The Azure SQL database the template creates, evaluated with the parameters the installer sends.
 * @param {Record<string, { value: any }>} params
 */
function sqlDatabase(params) {
  const outer = armEvaluator(TEMPLATE, params, SCOPE);
  const mod = list(TEMPLATE.resources).find((r) => r.name === 'vl-sql');
  // Values only known while deploying, such as the managed identity's object id, get a stand-in.
  const inner = Object.fromEntries(Object.entries(mod.properties.parameters).map(([k, v]) => [k, RUNTIME_FUNCTIONS.test(JSON.stringify(v)) ? { value: 'runtime' } : outer.evalValue(v)]));
  const db = list(mod.properties.template.resources).find((r) => r.type === 'Microsoft.Sql/servers/databases');
  const ev = armEvaluator(mod.properties.template, inner, SCOPE);
  const props = ev.evalValue(db.properties);
  return { capacity: ev.evalValue(db.sku).capacity, minCapacity: props.minCapacity, autoPauseDelay: props.autoPauseDelay, useFreeLimit: props.useFreeLimit, freeLimitExhaustionBehavior: props.freeLimitExhaustionBehavior };
}

test('the template creates the Azure SQL database and web app the installer plans, sized up or not', async () => {
  const declared = TEMPLATE.parameters.sqlFreeLimitExhaustionBehavior;
  assert.deepEqual([declared.defaultValue, declared.allowedValues], ['AutoPause', ['AutoPause', 'BillOverUsage']]);
  const apps = list(TEMPLATE.resources).find((r) => r.name === 'vl-containerapps');

  const small = await installerParameters();
  assert.deepEqual(validateArmTemplate(TEMPLATE, small, SCOPE).errors, []);
  assert.deepEqual(sqlDatabase(small), { capacity: 2, minCapacity: 0.5, autoPauseDelay: 60, useFreeLimit: true, freeLimitExhaustionBehavior: 'AutoPause' });
  assert.deepEqual(armEvaluator(TEMPLATE, small, SCOPE).evalValue(apps.properties.parameters.webMinReplicas), { value: 0 });

  const sized = await installerParameters({ sqlScaleUp: true, webAlwaysOn: true });
  assert.deepEqual(validateArmTemplate(TEMPLATE, sized, SCOPE).errors, []);
  assert.deepEqual(sqlDatabase(sized), { capacity: VCORES, minCapacity: 0.5, autoPauseDelay: 60, useFreeLimit: true, freeLimitExhaustionBehavior: 'BillOverUsage' });
  assert.deepEqual(armEvaluator(TEMPLATE, sized, SCOPE).evalValue(apps.properties.parameters.webMinReplicas), { value: 1 });

  const paid = await installerParameters({ sqlFreeOffer: false, sqlScaleUp: true });
  assert.deepEqual(validateArmTemplate(TEMPLATE, paid, SCOPE).errors, []);
  assert.deepEqual(sqlDatabase(paid), { capacity: VCORES, minCapacity: 0.5, autoPauseDelay: 60, useFreeLimit: false, freeLimitExhaustionBehavior: null });
  for (const p of [small, sized, paid]) assert.ok(declared.allowedValues.includes(p.sqlFreeLimitExhaustionBehavior.value));
});

test('confirmAzurePlan: shows what a large tenant chose to pay for, and drops the warnings that choice answers', async () => {
  // Graph won't count people here, so the plan sizes from the Copilot seats and says so.
  const graph = { subscribedSkus: async () => [{ skuPartNumber: 'Microsoft_365_Copilot', consumedUnits: 20_000, servicePlans: [{ servicePlanName: COPILOT_PLAN }] }] };
  /** @param {any} more */
  const plan = async (more) => {
    const u = fakeUi({ answers: [true] });
    const t = fakeCtx({ ui: u.ui, graph, fabric: fakeFabric().api });
    t.config.target = 'azure';
    t.config.azure = { subscriptionId: 'sub-1', resourceGroup: 'rg', location: 'uksouth', namePrefix: 'vlens', powerBi: { capacityId: 'cap-f' }, ...more };
    assert.equal(await confirmAzurePlan(t.ctx), true);
    assert.equal(u.asked.at(-1), 'Go ahead?');
    return u.text();
  };
  const declined = await plan({ sqlScaleUp: false, webAlwaysOn: false });
  assert.match(declined, /Tenant: {6}20,000 Copilot seats \(people couldn't be counted\)/);
  assert.match(declined, /Tenant size: large \(more than 10,000 people\)/);
  assert.doesNotMatch(declined, /SQL compute: |Web app: {5}one replica/);
  assert.match(declined, /20,000 Copilot seats are assigned, and Azure SQL uses the free offer/);
  assert.doesNotMatch(declined, SHARED_WARNING);

  const chosen = await plan({ sqlScaleUp: true, webAlwaysOn: true });
  assert.match(chosen, new RegExp(`SQL compute: up to ${VCORES} vCores, carrying on past the free offer \\(about \\$30-80 a month\\)`));
  assert.match(chosen, /Web app: {5}one replica always running \(about \$10-20 a month\)/);
  assert.doesNotMatch(chosen, /Azure SQL uses the free offer/);

  assert.match(await plan({ powerBi: {} }), SHARED_WARNING, 'no capacity and a new workspace');
});

test('confirmAzurePlan: shows the people counted, and warns an existing large install still on the free offer to run again with --sql-scale-up', async () => {
  /** @type {[('standard' | 'large' | undefined), import('../src/seats.js').Headcount][]} */
  const cases = [[undefined, people(61_234)], ['large', people(5_000)]];
  for (const [scale, headcount] of cases) {
    const what = `${scale} ${headcount.count}`;
    const u = fakeUi({ answers: [true] });
    const arm = fakeArm();
    /** @type {any} */ (arm.api).getSqlDatabase = async () => liveDb(2, { useFreeLimit: true, freeLimitExhaustionBehavior: 'AutoPause' });
    const t = fakeCtx({ ui: u.ui, arm: arm.api, fabric: fakeFabric().api });
    t.config.target = 'azure';
    t.config.scale = scale;
    t.config.azure = { ...DEPLOYED, powerBi: { capacityId: 'cap-f' }, sqlScaleUp: false };
    assert.equal(await confirmAzurePlan(t.ctx, { headcount, seats: 3_000 }), true, what);
    const text = u.text();
    assert.match(text, new RegExp(`Tenant: {6}${headcount.count.toLocaleString('en-US')} people \\(licensed, enabled accounts\\), 3,000 Copilot seats`), what);
    assert.match(text, /Tenant size: large \(more than 10,000 people\)/, what);
    assert.match(text, /Azure SQL uses the free offer.*run the installer again with --sql-scale-up/, what);
  }
});

test('cli: --sql-scale-up or --sql-free-offer, one of them, chooses what Azure SQL does for an install, and the help says what each means', () => {
  assert.equal(parseCli(['install', '--sql-scale-up']).sqlScaleUp, true);
  assert.equal(parseCli(['install', '--target', 'azure', '--yes', '--sql-free-offer']).sqlScaleUp, false);
  assert.equal(parseCli(['install', '--yes']).sqlScaleUp, undefined);
  assert.throws(() => parseCli(['install', '--sql-scale-up', '--sql-free-offer']), { message: 'Choose one of --sql-scale-up and --sql-free-offer.' });
  assert.throws(() => parseCli(['update', '--sql-scale-up']), { message: '--sql-scale-up goes with install.' });
  assert.throws(() => parseCli(['status', '--sql-free-offer']), { message: '--sql-free-offer goes with install.' });
  assert.throws(() => parseCli(['install', '--target', 'fabric', '--sql-scale-up']), { message: '--sql-scale-up is for the Azure target only.' });
  assert.throws(() => parseCli(['--ui', '--sql-free-offer']), { message: 'With --ui, choose Azure SQL compute in Azure placement. Leave out --sql-free-offer.' });

  const text = help().replace(/\s+/g, ' ');
  assert.ok(text.includes(
    `--sql-scale-up With install, Azure: let Azure SQL carry on past the free offer's monthly allowance and scale up to ${VCORES} vCores ` +
      `(about ${SQL_SCALE_UP_COST} a month). Needed with --yes for a new install of a large organisation. Later runs keep the choice`,
  ));
  assert.ok(text.includes("--sql-free-offer With install, Azure: keep the free Azure SQL offer. When the month's allowance runs out, the database pauses, and the jobs stop, until next month"));
});

test('cli: --sql-scale-up with a Fabric install record stops before signing in', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-sizing-'));
  const file = join(dir, 'fabric-record.json');
  writeFileSync(file, JSON.stringify({ version: 1, target: 'fabric', fabric: { workspaceId: 'ws-1' } }));
  const write = process.stderr.write;
  let err = '';
  process.stderr.write = /** @type {any} */ ((/** @type {string} */ s) => {
    err += s;
    return true;
  });
  try {
    assert.equal(await main(['install', '--config', file, '--yes', '--sql-scale-up']), 1);
  } finally {
    process.stderr.write = write;
    rmSync(dir, { recursive: true, force: true });
  }
  assert.match(err, /--sql-scale-up is for the Azure target only\./);
  assert.doesNotMatch(err, /Signing in/);
});

test('install: a new install that chooses Fabric with --sql-scale-up or --sql-free-offer stops before the tenant checks', async () => {
  for (const choice of [true, false]) {
    /** @type {string[]} */
    const calls = [];
    const graph = new Proxy({}, { get: (_target, name) => async () => (calls.push(String(name)), []) });
    const t = fakeUi({ answers: ['fabric'] });
    const { ctx, config } = fakeCtx({ ui: t.ui, graph });
    delete config.fabric.workspaceId;
    ctx.sqlChoice = choice;
    await assert.rejects(install(ctx, { wait: false }), { message: sqlFlagFabricError(choice) });
    assert.equal(sqlFlagFabricError(choice), `${choice ? '--sql-scale-up' : '--sql-free-offer'} is for the Azure target only.`);
    assert.deepEqual(t.asked, ['Where should Analytics Hub run?']);
    assert.deepEqual(calls, [], 'preflight never ran');
  }
});
