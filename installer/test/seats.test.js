// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { graphApi } from '../src/clients/graph.js';
import { createClient } from '../src/http.js';
import { azureSizingWarnings } from '../src/steps/azure/index.js';
import { defaultScale, plan, SIZE_QUESTION, sizingWarnings } from '../src/steps/plan.js';
import {
  AZURE_LARGE_TENANT_SKU, AZURE_LARGE_TENANT_SQL_VCORES, BIG_CAPACITY_PEOPLE, COPILOT_PLAN, copilotLicences, copilotSeats, ENABLED_PEOPLE, headcountNoun,
  headcountPhrase, LARGE_TENANT_PEOPLE, LICENSED_PEOPLE, scaleFor, seatCount, tenantHeadcount, tenantLine,
} from '../src/seats.js';
import { fakeCtx, fakeFabric, fakeUi } from './fakes.js';

/** @param {string} skuPartNumber @param {number} consumedUnits @param {string} [servicePlanName] */
const sku = (skuPartNumber, consumedUnits, servicePlanName = COPILOT_PLAN) => ({ skuPartNumber, consumedUnits, servicePlans: [{ servicePlanName }] });
/** People with a licence and an enabled account. @param {number} count @returns {import('../src/seats.js').Headcount} */
const people = (count) => ({ count, source: 'licensed' });
/** Copilot seats, when people couldn't be counted. @param {number} count @returns {import('../src/seats.js').Headcount} */
const seatsOnly = (count) => ({ count, source: 'seats' });

test('seats: assigned Copilot seats are summed across every Copilot SKU and nothing else', () => {
  const found = copilotLicences([sku('Microsoft_365_Copilot', 25_000), sku('M365_Copilot_EDU', 1_500), sku('ENTERPRISEPACK', 90_000, 'EXCHANGE_S_ENTERPRISE')]);
  assert.deepEqual(found, { names: ['Microsoft_365_Copilot', 'M365_Copilot_EDU'], assigned: 26_500, found: true });
  assert.deepEqual(copilotLicences([]), { names: [], assigned: 0, found: false });
  assert.equal(seatCount(40_000), '40,000');
});

test('seats: a tenant whose licences can\'t be read falls back to sizing by capacity', async () => {
  const api = /** @type {any} */ ({ graph: { subscribedSkus: async () => [sku('Microsoft_365_Copilot', 32_000)] } });
  assert.equal(await copilotSeats(api), 32_000);
  assert.equal(await copilotSeats(/** @type {any} */ ({ graph: { subscribedSkus: async () => { throw new Error('403'); } } })), undefined);
  assert.equal(await copilotSeats(/** @type {any} */ ({ graph: {} })), undefined);
});

test('tenant size: more than 10,000 people starts a new install as large; an F64 does only when people couldn\'t be counted', () => {
  assert.equal(defaultScale({ sku: 'F8' }, people(LARGE_TENANT_PEOPLE + 1)), 'large');
  assert.equal(defaultScale({ sku: 'F8' }, people(LARGE_TENANT_PEOPLE)), 'standard');
  assert.equal(defaultScale(undefined, people(40_000)), 'large');
  assert.equal(defaultScale({ sku: 'F64' }, people(2_000)), 'standard', 'people counted: the count decides, whatever the capacity');
  assert.equal(defaultScale({ sku: 'F64' }, undefined), 'large', 'nothing counted: the capacity says it');
  assert.equal(defaultScale({ sku: 'F64' }, seatsOnly(500)), 'large', 'seats undercount the people, so the capacity still says it');
  assert.equal(defaultScale({ sku: 'F8' }, seatsOnly(LARGE_TENANT_PEOPLE + 1)), 'large', 'more seats than 10,000 means more people than 10,000');
  assert.equal(defaultScale({ sku: 'F8' }, undefined), 'standard');
  assert.equal(scaleFor(undefined), 'standard');
});

test('tenant size: a trial capacity counts as the F size it matches when only seats were counted', () => {
  assert.equal(defaultScale({ sku: 'FTL64' }, seatsOnly(24)), 'large');
  assert.equal(defaultScale({ sku: 'FTL4' }, seatsOnly(24)), 'standard');
  assert.equal(defaultScale({ sku: 'FT1' }, seatsOnly(24)), 'standard', 'a trial SKU without a size isn\'t assumed to be F64');

  assert.deepEqual(sizingWarnings({ headcount: people(40_000), capacity: { sku: 'FTL64' }, scale: 'large' }), []);
  const [small] = sizingWarnings({ headcount: people(40_000), capacity: { sku: 'FTL4', displayName: 'Trial' }, scale: 'large' });
  assert.match(small, /the capacity Trial is FTL4, below F64/);
});

test('tenant size: warnings name the step to change and allow for policy', () => {
  assert.deepEqual(sizingWarnings({ headcount: undefined, capacity: { sku: 'F2' }, scale: 'standard' }), []);
  assert.deepEqual(sizingWarnings({ headcount: people(5_000), capacity: { sku: 'F2' }, scale: 'standard' }), []);
  assert.deepEqual(sizingWarnings({ headcount: people(40_000), capacity: { sku: 'F64' }, scale: 'large' }), []);

  const [small] = sizingWarnings({ headcount: people(BIG_CAPACITY_PEOPLE), capacity: { sku: 'F32', displayName: 'Shared' }, scale: 'large' });
  assert.match(small, /^30,000 people have a licence and an enabled account, and the capacity Shared is F32, below F64/);
  assert.match(small, /In Fabric placement, choose an F64 or larger capacity/);
  assert.match(small, /policy keeps you on this capacity, setup still works/);
  assert.deepEqual(sizingWarnings({ headcount: people(BIG_CAPACITY_PEOPLE - 1), capacity: { sku: 'F32' }, scale: 'large' }), [], 'below 30,000 an F32 is fine');

  const both = sizingWarnings({ headcount: people(40_000), capacity: { sku: 'F8' }, scale: 'standard' });
  assert.equal(both.length, 2);
  assert.match(both[1], /tenant size is "Up to 10,000"\. In Fabric placement, choose "More than 10,000"/);
  for (const w of both) assert.doesNotMatch(w, / {2}|advanced settings|in the terminal/);

  const [seats] = sizingWarnings({ headcount: seatsOnly(40_000), capacity: { sku: 'F8' }, scale: 'large' });
  assert.match(seats, /^40,000 Copilot seats are assigned, and the capacity/, 'only seats counted: says so');
});

/** @param {import('../src/ui.js').Ui} ui @param {Record<string, any>} pre */
function fabricPlan(ui, pre) {
  const t = fakeCtx({ ui, fabric: fakeFabric().api });
  return {
    ...t,
    pre: /** @type {any} */ ({ subscriptions: [{ subscriptionId: 'sub-1', displayName: 'Sub' }], canConsent: true, canCreateApps: true, tenantSettings: [], ...pre }),
  };
}

test('plan: a new install of 40,000 people on an F8 is sized large in the main flow and warned about the capacity', async () => {
  const t = fakeUi();
  const { ctx, config, pre } = fabricPlan(t.ui, { capacities: [{ id: 'cap-1', displayName: 'Small', sku: 'F8', region: 'UK South', state: 'Active' }], seats: 3_000, headcount: people(40_000) });
  delete config.scale;
  await plan(ctx, pre);
  assert.equal(ctx.advanced, false, 'not under the advanced settings');
  assert.ok(t.asked.includes(SIZE_QUESTION));
  assert.match(t.text(), /We found 40,000 people with a licence and an enabled account\./);
  assert.equal(config.scale, 'large', 'from the people, not the 3,000 seats');
  assert.match(t.text(), /40,000 people have a licence and an enabled account, and the capacity Small is F8, below F64/);
  assert.doesNotMatch(t.text(), /tenant size is "Up to 10,000"/);
});

test('plan: an existing install keeps the size it saved, and is told to change it when the people outgrow it', async () => {
  for (const yes of [false, true]) {
    const t = fakeUi({ yes });
    const { ctx, config, pre } = fabricPlan(t.ui, { capacities: [{ id: 'cap-1', displayName: 'Big', sku: 'F64', region: 'UK South', state: 'Active' }], seats: 500, headcount: people(12_000) });
    config.scale = 'standard';
    await plan(ctx, pre);
    assert.equal(config.scale, 'standard', 'never changed behind the admin\'s back');
    assert.match(t.text(), /This install is set up for up to 10,000 people, and stays so unless you choose otherwise\./);
    assert.match(t.text(), /12,000 people have a licence and an enabled account, but the tenant size is "Up to 10,000"/);
  }
});

test('azure sizing: a large tenant is warned about the SQL free limit, vCores, job size and shared Power BI', () => {
  const base = { headcount: people(40_000), sqlFreeLimit: true, sqlMaxVcores: 2, powerBiCapacityId: undefined };
  const all = azureSizingWarnings(base);
  assert.equal(all.length, 4);
  assert.match(all[0], /^40,000 people have a licence and an enabled account, and Azure SQL uses the free offer/);
  assert.match(all[0], /free offer.*Azure placement, choose to carry on past the free allowance \(about \$30-80 a month\), or run the installer again with --sql-scale-up.*Compute \+ storage.*continue using it for additional charges.*policy keeps the free limit/);
  const vcores = AZURE_LARGE_TENANT_SQL_VCORES;
  assert.match(all[1], new RegExp(`scales up to 2 vCores.*Azure placement, choose to scale it up to ${vcores} vCores.*max vCores to ${vcores} or more`));
  assert.match(all[2], /4 vCPU and 8 GiB and up to 4 hours.*the next run carries on reading the audit log from where it stopped.*Schedule and loading, start with 30 days/);
  assert.match(all[3], new RegExp(`shared capacity.*1 GB.*In Power BI, choose a Fabric capacity of ${AZURE_LARGE_TENANT_SKU} or larger \\(or its Premium equivalent\\)`));

  assert.deepEqual(azureSizingWarnings({ ...base, sqlFreeLimit: false, sqlMaxVcores: 8, powerBiCapacityId: 'cap-1', headcount: people(20_000) }), []);
  assert.equal(azureSizingWarnings({ ...base, headcount: people(20_000) }).length, 2, 'from 10,000 people: the free limit and shared capacity only');
  assert.deepEqual(azureSizingWarnings({ ...base, headcount: people(9_000) }), []);
  assert.deepEqual(azureSizingWarnings({ ...base, sampleData: true }), [], 'demo data is small');
  assert.deepEqual(azureSizingWarnings({ ...base, headcount: undefined }), []);
  assert.equal(azureSizingWarnings({ ...base, headcount: people(20_000), sharedCapacity: false }).length, 1, 'an existing workspace on its own capacity is not shared');
  assert.equal(azureSizingWarnings({ ...base, headcount: people(20_000), powerBiCapacityId: 'cap-1', sharedCapacity: true }).length, 2);
  assert.match(azureSizingWarnings({ ...base, headcount: seatsOnly(20_000) })[0], /^20,000 Copilot seats are assigned, and Azure SQL/);

  const outgrown = azureSizingWarnings({ ...base, headcount: people(20_000), scale: 'standard' });
  assert.equal(outgrown.length, 3);
  assert.match(outgrown[0], /^20,000 people have a licence and an enabled account, but this install is sized for up to 10,000 people\. In Azure placement, choose "More than 10,000"/);
  assert.equal(azureSizingWarnings({ ...base, headcount: people(20_000), scale: 'large' }).length, 2);

  for (const headcount of [undefined, people(9_000), seatsOnly(3_000)]) {
    const sized = azureSizingWarnings({ ...base, headcount, scale: 'large' });
    assert.equal(sized.length, 2, 'sized for a large organisation, with fewer counted: the free limit and shared capacity');
    assert.match(sized[0], /^This install is sized for a large organisation, and Azure SQL uses the free offer.*--sql-scale-up/);
    assert.match(sized[1], /^This install is sized for a large organisation, and the Power BI workspace is on shared capacity/);
  }
  assert.deepEqual(azureSizingWarnings({ ...base, headcount: undefined, scale: 'standard' }), []);
  assert.deepEqual(azureSizingWarnings({ ...base, headcount: undefined, scale: 'large', sampleData: true }), []);
});

test('tenantHeadcount: people with a licence and an enabled account, then enabled member accounts, then Copilot seats', async () => {
  /**
   * A Graph that counts each filter as given, or refuses it.
   * @param {Record<string, number>} counts @param {number | Error} [seats]
   */
  const graph = (counts, seats = 4_000) => {
    /** @type {string[]} */
    const asked = [];
    const api = /** @type {any} */ ({
      graph: {
        countUsers: async (/** @type {string} */ filter) => {
          asked.push(filter);
          if (!(filter in counts)) throw new Error('400 Request_UnsupportedQuery');
          return counts[filter];
        },
        subscribedSkus: async () => {
          asked.push('subscribedSkus');
          if (seats instanceof Error) throw seats;
          return [sku('Microsoft_365_Copilot', seats)];
        },
      },
    });
    return { api, asked };
  };

  const licensed = graph({ [LICENSED_PEOPLE]: 61_234, [ENABLED_PEOPLE]: 70_000 });
  assert.deepEqual(await tenantHeadcount(licensed.api), { count: 61_234, source: 'licensed' });
  assert.deepEqual(licensed.asked, [LICENSED_PEOPLE], 'the first count that works is the answer');

  const enabled = graph({ [ENABLED_PEOPLE]: 70_000 });
  assert.deepEqual(await tenantHeadcount(enabled.api), { count: 70_000, source: 'enabled' });
  assert.deepEqual(enabled.asked, [LICENSED_PEOPLE, ENABLED_PEOPLE]);

  const none = graph({ [LICENSED_PEOPLE]: 0, [ENABLED_PEOPLE]: 70_000 });
  assert.deepEqual(await tenantHeadcount(none.api), { count: 70_000, source: 'enabled' }, 'nobody licensed means the filter found nothing to go on');

  const seats = graph({});
  assert.deepEqual(await tenantHeadcount(seats.api), { count: 4_000, source: 'seats' });
  assert.deepEqual(seats.asked, [LICENSED_PEOPLE, ENABLED_PEOPLE, 'subscribedSkus']);

  const read = graph({});
  assert.deepEqual(await tenantHeadcount(read.api, { seats: 2_500 }), { count: 2_500, source: 'seats' });
  assert.ok(!read.asked.includes('subscribedSkus'), 'seats read already aren\'t read again');
  assert.equal(await tenantHeadcount(graph({}).api, { seats: undefined }), undefined, 'seats that couldn\'t be read aren\'t read again');

  assert.equal(await tenantHeadcount(graph({}, new Error('403')).api), undefined, 'nothing counted: the size is asked with nothing to start from');
  assert.equal(await tenantHeadcount(graph({}, 0).api), undefined, 'no Copilot seats either');
  assert.equal(await tenantHeadcount(/** @type {any} */ ({ graph: {} })), undefined);
});

test('countUsers: asks Graph to count with ConsistencyLevel eventual and reads the plain-text number', async () => {
  /** @type {{ url: URL, headers: Record<string, string> }[]} */
  const calls = [];
  /** @type {() => Response} */
  let reply = () => new Response('893', { status: 200, headers: { 'Content-Type': 'text/plain' } });
  const fetchImpl = /** @type {typeof fetch} */ (/** @type {unknown} */ (async (/** @type {string} */ input, /** @type {any} */ init) => {
    calls.push({ url: new URL(String(input)), headers: init.headers });
    return reply();
  }));
  const graph = graphApi(createClient({ baseUrl: 'https://graph.microsoft.com/v1.0', getToken: async () => 'token', fetchImpl, sleep: async () => {} }));

  assert.equal(await graph.countUsers(LICENSED_PEOPLE), 893);
  const [call] = calls;
  assert.equal(call.url.pathname, '/v1.0/users/$count');
  assert.equal(call.url.searchParams.get('$filter'), LICENSED_PEOPLE);
  assert.equal(call.headers.ConsistencyLevel, 'eventual', '$count and ne are advanced queries');
  assert.equal(call.headers.Accept, 'text/plain');

  reply = () => new Response(new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('61234')]), { status: 200 });
  assert.equal(await graph.countUsers(ENABLED_PEOPLE), 61_234, 'with a byte order mark');
  reply = () => new Response('{"value":[]}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  await assert.rejects(graph.countUsers(ENABLED_PEOPLE), /GET \/users\/\$count returned .*not a count/);
  reply = () => new Response(JSON.stringify({ error: { code: 'Authorization_RequestDenied', message: 'Insufficient privileges to complete the operation.' } }), { status: 403, headers: { 'Content-Type': 'application/json' } });
  await assert.rejects(graph.countUsers(ENABLED_PEOPLE), (/** @type {any} */ e) => e.status === 403);
});

test('headcount wording: people when they were counted, Copilot seats when only those were', () => {
  assert.equal(headcountNoun(people(61_234)), '61,234 people');
  assert.equal(headcountNoun(people(1)), '1 person');
  assert.equal(headcountNoun(seatsOnly(20_000)), '20,000 Copilot seats');
  assert.equal(headcountPhrase(people(61_234)), '61,234 people have a licence and an enabled account');
  assert.equal(headcountPhrase({ count: 70_000, source: 'enabled' }), '70,000 member accounts are enabled');
  assert.equal(headcountPhrase(seatsOnly(20_000)), '20,000 Copilot seats are assigned');

  assert.equal(tenantLine(people(61_234), 4_000), '61,234 people (licensed, enabled accounts), 4,000 Copilot seats');
  assert.equal(tenantLine({ count: 70_000, source: 'enabled' }, undefined), '70,000 people (enabled accounts)');
  assert.equal(tenantLine(seatsOnly(4_000), 4_000), '4,000 Copilot seats (people couldn\'t be counted)');
  assert.equal(tenantLine(undefined, 1), '1 Copilot seat (people couldn\'t be counted)');
  assert.equal(tenantLine(undefined, undefined), undefined);
});
