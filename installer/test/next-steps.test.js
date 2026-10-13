// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { appItemUrl, publicAccess, shareApp, shareAppPending, VIEWER_GROUP_NAME } from '../src/steps/access.js';
import { fabricConfigFile } from '../src/steps/app.js';
import { flowsWanted } from '../src/steps/flows.js';
import { GLOBAL_READER_ROLE_ID, nextSteps, stepsLeftTitle } from '../src/steps/next-steps.js';
import { summary } from '../src/install.js';
import { COWORK_DATAFLOW_ACTIVITY } from '../src/transform/pipeline.js';
import { FEEDBACK_SUBJECT } from '../src/transform/flows.js';
import { fakeCtx, fakeFabric, fakeUi } from './fakes.js';

const USER = { tenantId: 'tenant-1', upn: 'admin@contoso.com' };

/** A Fabric install with a viewer group and a deployed app. */
function installed(answers = /** @type {any[]} */ ([])) {
  const fake = fakeUi({ answers });
  const t = fakeCtx({ ui: fake.ui, fabric: fakeFabric().api });
  t.config.access = { groupId: 'g-1', groupName: VIEWER_GROUP_NAME, contact: 'admin@contoso.com', createdGroup: true };
  Object.assign(t.config.fabricApp, { enabled: true, itemId: 'app-item', name: 'Analytics Hub' });
  t.config.fabric.workspaceName = 'Analytics Hub';
  return { ...t, ...fake };
}

const ids = (/** @type {{ id: string }[]} */ steps) => steps.map((s) => s.id);

test('share: asked once after the app is deployed; "I\'ve shared it" is saved and not asked again', async () => {
  const t = installed([true]);
  assert.equal(shareAppPending(t.config), true);
  await shareApp(t.ctx);
  assert.deepEqual(t.asked, ['Have you shared the app?']);
  assert.equal(t.config.access?.appShared, true);
  assert.equal(t.saves(), 1);
  assert.match(t.text(), /appbackends\/app-item\?ctid=tenant-1/, 'it links straight to the app item');
  assert.match(t.text(), /Choose Share\./);
  assert.match(t.text(), /Enter "Analytics Hub Viewers" and choose Grant/);
  assert.equal(shareAppPending(t.config), false);

  await shareApp(t.ctx);
  assert.equal(t.asked.length, 1, 'not asked again once it is shared');
});

test('share: Later leaves it to the summary, and Repair asks again', async () => {
  const t = installed([false]);
  await shareApp(t.ctx);
  assert.equal(t.config.access?.appShared, undefined);
  assert.equal(t.saves(), 0);
  assert.match(t.text(), /no access/);
  assert.equal(shareAppPending(t.config), true);
  assert.deepEqual(ids(nextSteps(t.config, USER)), ['share-app']);
});

test('share: nothing to share without a viewer group or an app, and never on Azure', async () => {
  const t = installed();
  t.config.access = undefined;
  assert.equal(shareAppPending(t.config), false);
  await shareApp(t.ctx);
  assert.deepEqual(t.asked, []);

  const u = installed();
  u.config.fabricApp.itemId = undefined;
  assert.equal(shareAppPending(u.config), false);
  u.config.fabricApp.itemId = 'app-item';
  u.config.target = 'azure';
  assert.equal(shareAppPending(u.config), false);
});

test('share: the app is told it is shared only once it is', () => {
  const t = installed();
  assert.equal(publicAccess(t.config)?.appShared, undefined);
  assert.equal(fabricConfigFile(t.config, 'ws-1', ['vl']).access?.appShared, undefined);
  /** @type {any} */ (t.config.access).appShared = true;
  assert.equal(publicAccess(t.config)?.appShared, true);
  assert.equal(fabricConfigFile(t.config, 'ws-1', ['vl']).access?.appShared, true);
  assert.equal(appItemUrl(t.config), 'https://app.fabric.microsoft.com/groups/ws-1/appbackends/app-item');
  t.config.target = 'azure';
  assert.equal(publicAccess(t.config)?.appShared, undefined, 'Azure has no app item to share');
});

test('install: the share step comes straight after the app is deployed, before the first load waits', async () => {
  const src = await readFile(new URL('../src/install.js', import.meta.url), 'utf8');
  const at = (/** @type {string} */ s) => {
    const i = src.indexOf(s);
    assert.ok(i >= 0, `${s} is in install.js`);
    return i;
  };
  assert.ok(at("step('Analytics Hub app')") < at("step('Share the app')"));
  assert.ok(at("step('Share the app')") < at("step('First load')"));
  assert.match(src, /withShare = .*appShared !== true/, 'not asked again once shared');
});

test('next steps: none left for an install with nothing to do', () => {
  const t = installed();
  /** @type {any} */ (t.config.access).appShared = true;
  assert.deepEqual(nextSteps(t.config, USER), []);
  assert.equal(stepsLeftTitle([]), '0 optional steps');
});

test('next steps: in order, share, flows, Cowork Dataflow, then hand-offs; each says who and why', () => {
  const t = installed();
  const config = t.config;
  config.dataSources.productFeedback = 'api';
  config.dataSources.resourceGraph = 'api';
  config.uploads = { ...config.uploads, flowIds: { feedback: 'flow-1' }, flowEnvironment: { id: 'env-1', name: 'Contoso (default)', url: 'https://org.crm.dynamics.com' } };
  config.modules.consumption = true;
  config.dataSources.coworkCredits = 'api';
  config.consumption.dataflowId = 'df-1';
  assert.ok(flowsWanted(config).includes('feedback'));

  const steps = nextSteps(config, USER);
  assert.deepEqual(ids(steps), ['share-app', 'flows', 'cowork-dataflow', 'entra-role', 'm365-export']);
  for (const s of steps) {
    assert.ok(s.title && s.why && s.who, `${s.id} has a title, why and who`);
    assert.doesNotMatch(JSON.stringify(s), /Rayfin/i);
  }
  assert.equal(stepsLeftTitle(steps), '5 steps left');

  const [share, flows, cowork, role, m365] = steps;
  assert.equal(share.link, 'https://app.fabric.microsoft.com/groups/ws-1/appbackends/app-item?ctid=tenant-1');
  assert.equal(share.steps?.length, 3);
  assert.equal(flows.link, 'https://make.powerautomate.com/environments/env-1/flows');
  assert.match(String(flows.message), /^Hi,/);
  assert.match(String(flows.message), /Contoso \(default\)/);
  assert.equal(cowork.activity, COWORK_DATAFLOW_ACTIVITY, 'its failed refresh is expected until it is signed in');
  assert.equal(role.who, 'A Privileged Role Administrator');
  assert.match(String(role.message), /Application \(client\) ID: app-1/);
  assert.match(String(role.message), /Object ID \(enterprise application\): sp-1/);
  assert.match(String(role.message), new RegExp(`"principalId":"sp-1","roleDefinitionId":"${GLOBAL_READER_ROLE_ID}"`));
  assert.match(String(role.message), /admin@contoso\.com$/, 'signed by the person running the installer');
  assert.equal(m365.who, 'A Microsoft 365 admin');
  assert.ok(m365.message?.includes(FEEDBACK_SUBJECT));
  assert.match(String(m365.message), /emailed to admin@contoso\.com/);
});

test('next steps: the Global Reader hand-off shows until the role is recorded as assigned', () => {
  const t = installed();
  /** @type {any} */ (t.config.access).appShared = true;
  t.config.dataSources.resourceGraph = 'api';
  assert.deepEqual(ids(nextSteps(t.config, USER)), ['entra-role'], 'not recorded counts as not assigned');

  t.config.app.servicePrincipalId = undefined;
  assert.match(String(nextSteps(t.config, USER)[0].message), /\$\(az ad sp show --id app-1 --query id -o tsv\)/);

  /** @type {any} */ (t.config.resourceGraph) = { ...t.config.resourceGraph, roleAssigned: true };
  assert.deepEqual(nextSteps(t.config, USER), []);

  /** @type {any} */ (t.config.resourceGraph) = { ...t.config.resourceGraph, roleAssigned: undefined, agents: false };
  assert.deepEqual(nextSteps(t.config, USER), [], 'not needed when agents are not read');
});

test('next steps: the product feedback export only with its flow; the Viva query is optional', () => {
  const t = installed();
  /** @type {any} */ (t.config.access).appShared = true;
  t.config.dataSources.productFeedback = 'csv';
  assert.ok(!ids(nextSteps(t.config, USER)).includes('m365-export'));

  t.config.modules.consumption = true;
  t.config.dataSources.coworkCredits = 'csv';
  const steps = nextSteps(t.config, USER);
  assert.deepEqual(ids(steps), ['viva-query']);
  assert.equal(steps[0].optional, true);
  assert.equal(stepsLeftTitle(steps), '1 optional step');
  assert.equal(stepsLeftTitle([{ id: 'a', title: 'A', why: '', who: '' }, ...steps]), '1 step left, and 1 optional');
});

test('summary: what is left comes first, as cards, before the next steps', async () => {
  const t = installed();
  t.config.dataSources.resourceGraph = 'api';
  await summary(t.ctx);
  const text = t.text();
  const left = text.indexOf('2 steps left');
  assert.ok(left >= 0, text);
  assert.ok(left < text.indexOf('Share the app with Analytics Hub Viewers'));
  assert.ok(text.indexOf('Share the app with Analytics Hub Viewers') < text.indexOf('Ask for Global Reader'));
  const next = text.indexOf('Next steps');
  if (next >= 0) assert.ok(left < next, 'the cards lead');
  assert.match(text, /Copy and send:/);
});
