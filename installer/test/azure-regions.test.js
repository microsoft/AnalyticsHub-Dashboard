// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planAzureAsk } from '../src/steps/azure/ask.js';
import { planAzure } from '../src/steps/azure/index.js';
import { allowedFor, allowedLocationRules, ASK_TYPE, checkRegions, locationRule, regionNotes, regionProblems, sqlProblem } from '../src/steps/azure/regions.js';
import { fakeArm, fakeCtx, fakeFabric, fakePowerBi, fakeUi, httpError } from './fakes.js';

const SUB = '/subscriptions/sub-1';
const BUILT_IN = '/providers/Microsoft.Authorization/policyDefinitions/e56962a6-4747-49cd-b67b-bf8b01975c4c';
const BUILT_IN_RG = '/providers/Microsoft.Authorization/policyDefinitions/e765b5de-1225-4ba3-bd56-1ac6695af988';
const REGIONS = [
  { name: 'uksouth', displayName: 'UK South' },
  { name: 'ukwest', displayName: 'UK West' },
  { name: 'westeurope', displayName: 'West Europe' },
  { name: 'swedencentral', displayName: 'Sweden Central' },
  { name: 'eastus2', displayName: 'East US 2' },
  { name: 'europe', displayName: 'Europe', metadata: { regionType: 'Logical' } },
];
const PRE = /** @type {any} */ ({
  subscriptions: [{ subscriptionId: 'sub-1', displayName: 'Sub' }],
  canConsent: true,
  canCreateApps: true,
  capacities: [{ id: 'cap-1', displayName: 'F64', sku: 'F64', region: 'UK South', state: 'Active' }],
  tenantSettings: [],
});

/** @param {string} name @param {string} definition @param {any} [parameters] @param {any} [more] */
const assignment = (name, definition, parameters, more = {}) => ({ name, properties: { displayName: name, policyDefinitionId: definition, parameters, ...more } });
/** @param {string[]} list */
const allowed = (list) => ({ listOfAllowedLocations: { value: list } });

/** A fake ARM with the regions above. */
function arm() {
  const a = fakeArm();
  a.regions.locations = REGIONS;
  return a;
}

/** @param {ReturnType<typeof fakeArm>} a @param {boolean} [newResourceGroup] */
const check = (a, newResourceGroup = true) => checkRegions(a.api, { subscriptionId: 'sub-1', scope: SUB, newResourceGroup, locations: a.regions.locations });

test('locationRule: reads a custom deny on location, from a parameter or a literal, and ignores audits', () => {
  const def = {
    properties: {
      parameters: { places: { defaultValue: ['uksouth'] }, effect: { defaultValue: 'Deny' } },
      policyRule: { if: { allOf: [{ field: 'location', notIn: "[parameters('places')]" }, { field: 'location', notEquals: 'global' }] }, then: { effect: "[parameters('effect')]" } },
    },
  };
  assert.deepEqual(locationRule(def, undefined), { locations: ['uksouth'], resourceGroups: false });
  assert.deepEqual(locationRule(def, { places: { value: ['UK West', 'westeurope'] } }), { locations: ['ukwest', 'westeurope'], resourceGroups: false });
  assert.equal(locationRule(def, { effect: { value: 'Audit' } }), null);
  const not = { properties: { policyRule: { if: { not: { field: 'location', in: ['swedencentral'] } }, then: { effect: 'deny' } } } };
  assert.deepEqual(locationRule(not, undefined), { locations: ['swedencentral'], resourceGroups: false });
  const rg = { properties: { policyRule: { if: { allOf: [{ field: 'type', equals: 'Microsoft.Resources/subscriptions/resourceGroups' }, { field: 'location', notIn: ['uksouth'] }] }, then: { effect: 'Deny' } } } };
  assert.deepEqual(locationRule(rg, undefined), { locations: ['uksouth'], resourceGroups: true });
  const sql = { properties: { policyRule: { if: { allOf: [{ field: 'type', in: ['Microsoft.Sql/servers'] }, { field: 'location', notIn: ['ukwest'] }] }, then: { effect: 'Deny' } } } };
  assert.deepEqual(locationRule(sql, undefined), { locations: ['ukwest'], resourceGroups: false, types: ['Microsoft.Sql/servers'] });
  assert.equal(locationRule({ properties: { policyRule: { if: { field: 'tags', exists: false }, then: { effect: 'Deny' } } } }, undefined), null);
});

test('allowedLocationRules: built-ins direct and in an initiative, custom ones, skips what isn\'t enforced here', async () => {
  const a = arm();
  const set = '/providers/Microsoft.Management/managementGroups/mg/providers/Microsoft.Authorization/policySetDefinitions/guardrails';
  const custom = '/subscriptions/sub-1/providers/Microsoft.Authorization/policyDefinitions/sql-places';
  a.regions.custom = [{ id: custom, properties: { policyRule: { if: { allOf: [{ field: 'type', equals: 'Microsoft.Sql/servers' }, { field: 'location', notIn: ['ukwest', 'uksouth'] }] }, then: { effect: 'Deny' } } } }];
  a.regions.builtIn[set] = { id: set, properties: { parameters: { regions: {} }, policyDefinitions: [{ policyDefinitionId: BUILT_IN_RG, parameters: { listOfAllowedLocations: { value: "[parameters('regions')]" } } }, { policyDefinitionId: '/providers/Microsoft.Authorization/policyDefinitions/other' }] } };
  a.regions.assignments = [
    assignment('Allowed locations', BUILT_IN, allowed(['uksouth', 'UK West', 'swedencentral'])),
    assignment('Guardrails', set, { regions: { value: ['uksouth'] } }),
    assignment('SQL places', custom),
    assignment('Audit only', BUILT_IN, allowed(['eastus2']), { enforcementMode: 'DoNotEnforce' }),
    assignment('Not here', BUILT_IN, allowed(['eastus2']), { notScopes: ['/subscriptions/SUB-1'] }),
    assignment('Hidden', '/providers/Microsoft.Management/managementGroups/mg/providers/Microsoft.Authorization/policySetDefinitions/hidden'),
  ];
  const got = await allowedLocationRules(a.api, 'sub-1', SUB);
  assert.deepEqual(got?.rules.sort((x, y) => x.assignment.localeCompare(y.assignment)), [
    { assignment: 'Allowed locations', locations: ['uksouth', 'ukwest', 'swedencentral'], resourceGroups: false },
    { assignment: 'Guardrails', locations: ['uksouth'], resourceGroups: true },
    { assignment: 'SQL places', locations: ['ukwest', 'uksouth'], resourceGroups: false, types: ['Microsoft.Sql/servers'] },
  ]);
  assert.deepEqual(got?.unread, ['Hidden']);
  assert.ok(a.calls.includes(`listPolicyAssignments ${SUB}`));

  const denied = arm();
  denied.failures.listPolicyAssignments = [httpError(403, 'AuthorizationFailed')];
  assert.equal(await allowedLocationRules(denied.api, 'sub-1', SUB), null);
});

test('checkRegions: drops regions policy, provider types, Storage or Azure SQL rule out, and says why', async () => {
  const a = arm();
  a.regions.assignments = [assignment('Allowed locations', BUILT_IN, allowed(['uksouth', 'ukwest', 'westeurope', 'swedencentral']))];
  a.regions.providers['Microsoft.App'] = { resourceTypes: [{ resourceType: 'jobs', locations: ['UK South', 'West Europe', 'Sweden Central', 'East US 2'] }] };
  a.regions.storageSkus = [{ name: 'Standard_LRS', kind: 'StorageV2', restrictions: [{ type: 'Location', values: ['westeurope'], reasonCode: 'NotAvailableForSubscription' }] }];
  a.restrictedSqlRegions.add('uksouth');
  const c = await check(a);
  assert.deepEqual(c.regions.map((r) => r.name), ['uksouth', 'ukwest', 'westeurope', 'swedencentral', 'eastus2'], 'logical regions are left out');
  const ok = c.regions.filter((r) => !regionProblems(c, r.name, { sql: true }).length).map((r) => r.name);
  assert.deepEqual(ok, ['swedencentral']);
  assert.deepEqual(regionProblems(c, 'ukwest', { sql: true }), ['Container Apps jobs not offered']);
  assert.deepEqual(regionProblems(c, 'westeurope', { sql: true }), ['Standard_LRS storage for this subscription not offered']);
  assert.match(regionProblems(c, 'uksouth', { sql: true })[0], /Azure SQL restricted: Subscriptions are restricted/);
  assert.deepEqual(regionProblems(c, 'uksouth', { sql: false }), [], 'SQL can go elsewhere in advanced mode');
  assert.deepEqual(regionProblems(c, 'eastus2', { sql: true }), ['Azure Policy (Allowed locations)']);
  assert.equal(sqlProblem(c, 'eastus2'), 'Azure Policy (Allowed locations)');
  assert.ok(!a.calls.some((x) => x.includes('eastus2') && x.startsWith('sqlCapability')), "doesn't ask SQL about regions policy rules out");
  const notes = regionNotes(c, ok, { sql: true });
  assert.ok(notes.includes('Azure Policy "Allowed locations" allows uksouth, ukwest, westeurope, swedencentral.'));
  assert.ok(notes.includes('Not offered: ukwest (Container Apps jobs not offered).'));
  assert.ok(notes.some((n) => /^Not offered: uksouth \(Azure SQL restricted/.test(n)));
  assert.ok(!notes.some((n) => n.includes('eastus2')), 'the policy line already covers regions policy rules out');
});

test('checkRegions: resource group rules count only for a new resource group; unreadable policy filters nothing', async () => {
  const a = arm();
  a.regions.assignments = [assignment('RG places', BUILT_IN_RG, allowed(['ukwest']))];
  assert.deepEqual(regionProblems(await check(a, true), 'uksouth', { sql: true }), ['Azure Policy (RG places)']);
  assert.deepEqual(regionProblems(await check(a, false), 'uksouth', { sql: true }), []);
  assert.deepEqual(regionNotes(await check(a, false), ['uksouth'], { sql: true }), []);

  const denied = arm();
  denied.failures.listPolicyAssignments = [httpError(403, 'AuthorizationFailed')];
  const c = await check(denied);
  assert.equal(c.policyUnreadable, true);
  assert.equal(c.regions.filter((r) => !regionProblems(c, r.name, { sql: true }).length).length, 5);
  assert.match(regionNotes(c, [], { sql: true })[0], /Couldn't read Azure Policy here/);
});

test('allowedFor: the intersection of the rules that cover a type, or null', async () => {
  const a = arm();
  a.regions.assignments = [assignment('A', BUILT_IN, allowed(['uksouth', 'swedencentral', 'eastus2'])), assignment('B', BUILT_IN, allowed(['swedencentral', 'eastus2', 'ukwest'])), assignment('RG', BUILT_IN_RG, allowed(['uksouth']))];
  assert.deepEqual(allowedFor(await check(a), ASK_TYPE), ['swedencentral', 'eastus2']);
  assert.equal(allowedFor(await check(arm()), ASK_TYPE), null);
  assert.equal(allowedFor(undefined, ASK_TYPE), null);
});

/** @param {{ advanced?: boolean }} [o] */
function planCtx(o = {}) {
  const a = arm();
  const u = fakeUi({ yesTo: o.advanced ? ['Change the advanced settings?'] : [] });
  /** @type {Record<string, { choices: any[], def: any }>} */
  const selects = {};
  const select = u.ui.select;
  u.ui.select = async (message, choices, def) => {
    selects[message] = { choices, def };
    return select(message, choices, def);
  };
  const t = fakeCtx({ ui: u.ui, arm: a.api, fabric: fakeFabric().api, powerBi: fakePowerBi().api });
  delete t.config.fabric.workspaceId;
  return { ...t, a, u, selects, az: () => /** @type {import('../src/config.js').AzureConfig} */ (t.config.azure) };
}

test('planAzure: offers only the regions that pass, says why, and defaults to one of them', async () => {
  const t = planCtx();
  t.a.regions.assignments = [assignment('Allowed locations', BUILT_IN, allowed(['ukwest', 'swedencentral', 'eastus2']))];
  t.a.restrictedSqlRegions.add('ukwest');
  await planAzure(t.ctx, PRE);
  assert.deepEqual(t.selects['Azure region'].choices.map((c) => c.value), ['swedencentral', 'eastus2']);
  assert.equal(t.selects['Azure region'].def, 'swedencentral', 'uksouth is not allowed, so the default moves');
  assert.equal(t.az().location, 'swedencentral');
  assert.match(t.u.text(), /Azure Policy "Allowed locations" allows ukwest, swedencentral, eastus2\./);
  assert.match(t.u.text(), /Not offered: ukwest \(Azure SQL restricted/);
  assert.ok(t.ctx.azureRegions, 'kept for placing the Ask model');
});

test('planAzure: stops with a clear message, before deploying, when no region passes', async () => {
  const t = planCtx();
  t.a.regions.assignments = [assignment('Allowed locations', BUILT_IN, allowed(['ukwest']))];
  t.a.restrictedSqlRegions.add('ukwest');
  await assert.rejects(planAzure(t.ctx, PRE), (/** @type {Error} */ e) => {
    assert.match(e.message, /^No Azure region in this subscription passes Azure Policy/);
    assert.match(e.message, /Azure Policy "Allowed locations" allows ukwest\./);
    assert.match(e.message, /Not offered: ukwest \(Azure SQL restricted/);
    return true;
  });
  assert.ok(!t.a.calls.some((c) => /deploy/i.test(c)));
});

test('planAzure (advanced): a region Azure SQL can\'t use stays on offer, and the SQL list leaves it out', async () => {
  const t = planCtx({ advanced: true });
  t.a.restrictedSqlRegions.add('uksouth');
  t.a.regions.assignments = [assignment('Allowed locations', BUILT_IN, allowed(['uksouth', 'ukwest', 'swedencentral']))];
  await planAzure(t.ctx, PRE);
  const main = t.selects['Azure region'].choices;
  assert.deepEqual(main.map((c) => c.value), ['uksouth', 'ukwest', 'swedencentral']);
  assert.match(main[0].description, /Azure SQL restricted.*pick another Azure SQL region next/);
  const sql = t.selects['Azure SQL region'];
  assert.deepEqual(sql.choices.map((c) => c.value), ['ukwest', 'swedencentral'], 'no "Same as above" for a region SQL can\'t use');
  assert.equal(t.az().sqlLocation, 'ukwest');
});

test('planAzure: a re-run of an existing install keeps the old region list', async () => {
  const t = planCtx();
  t.config.azure = /** @type {any} */ ({ subscriptionId: 'sub-1', resourceGroup: 'rg-analytics-hub', location: 'uksouth', outputs: { sqlServerFqdn: 'sql.database.windows.net' } });
  t.a.regions.assignments = [assignment('Allowed locations', BUILT_IN, allowed(['ukwest']))];
  await planAzure(t.ctx, PRE);
  assert.ok(!t.a.calls.some((c) => c.startsWith('listPolicyAssignments')));
  assert.equal(t.selects['Azure region'].choices.length, REGIONS.length);
  assert.equal(t.ctx.azureRegions, undefined);
});

test('planAzureAsk: the Ask model goes only where Azure Policy allows it', async () => {
  const t = planCtx();
  t.a.regions.assignments = [assignment('Allowed locations', BUILT_IN, allowed(['uksouth', 'francecentral']))];
  t.ctx.azureRegions = await check(t.a);
  t.config.target = 'azure';
  t.config.azure = /** @type {any} */ ({ subscriptionId: 'sub-1', resourceGroup: 'rg', location: 'uksouth', namePrefix: 'vlens', tags: {}, deployments: [], outputs: {}, graphRoles: { assigned: [], pending: [] } });
  t.a.ai.models = { uksouth: [], '*': [t.a.ai.offered()] };
  await planAzureAsk(t.ctx);
  assert.equal(t.az().ask?.location, 'francecentral', 'skips the usual fallbacks policy denies');
});
