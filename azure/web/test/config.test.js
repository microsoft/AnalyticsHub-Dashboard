import test from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedSemanticModel, loadConfig, parseModules, parseReporting, parseSemanticModels } from '../src/config.js';

test('legacy valueLensModel key is served as the vl alias the app queries', () => {
  const ref = { workspaceId: 'ws', itemId: 'ds' };
  assert.deepEqual(parseSemanticModels(JSON.stringify({ valueLensModel: ref })), { vl: ref });
  assert.deepEqual(parseSemanticModels(JSON.stringify({ vl: ref, cc: ref })), { vl: ref, cc: ref });
  assert.deepEqual(parseSemanticModels(''), {});
});

test('the Consumption Central model (cc) is queryable alongside vl, and nothing else is', () => {
  const models = parseSemanticModels(JSON.stringify({ vl: { workspaceId: 'ws', itemId: 'vl-1' }, cc: { workspaceId: 'ws', itemId: 'cc-1' } }));
  assert.equal(isAllowedSemanticModel(models, 'ws', 'vl-1'), true);
  assert.equal(isAllowedSemanticModel(models, 'ws', 'cc-1'), true);
  assert.equal(isAllowedSemanticModel(models, 'ws', 'other'), false);
  assert.equal(isAllowedSemanticModel(models, 'other-ws', 'cc-1'), false);
});

test('the installer\'s reporting currency is read with its rate, and a rate for US dollars is dropped', () => {
  assert.deepEqual(parseReporting('eur', '0.92'), { currency: 'EUR', exchangeRate: 0.92 });
  assert.deepEqual(parseReporting('GBP', ''), { currency: 'GBP' });
  assert.deepEqual(parseReporting('GBP', '-1'), { currency: 'GBP' });
  assert.deepEqual(parseReporting('USD', '0.8'), { currency: 'USD' });
  assert.equal(parseReporting('', '0.8'), undefined);
  assert.equal(parseReporting('pounds', undefined), undefined);
  assert.deepEqual(loadConfig({ VALUELENS_CURRENCY: 'JPY', VALUELENS_EXCHANGE_RATE: '150' }).reporting, { currency: 'JPY', exchangeRate: 150 });
  assert.equal(loadConfig({}).reporting, undefined);
});

// The seven flags the app reads, all off; each case turns on what its list names.
const ALL_OFF = { m365Activity: false, agent365: false, productFeedback: false, consumption: false, agentEvaluator: false, defender: false, resourceGraph: false };

test('without VALUELENS_MODULES (an older deployment, or local dev) there are no module flags, so the app checks every source', () => {
  for (const value of [undefined, '', '   ', ' , ,']) assert.equal(parseModules(value), undefined, JSON.stringify(value));
  assert.equal(loadConfig({}).modules, undefined);
  assert.equal(loadConfig({ VALUELENS_MODULES: '' }).modules, undefined);
});

test('VALUELENS_MODULES turns on the flag for each module in the list, including Agent Evaluator', () => {
  assert.deepEqual(parseModules('core,orgData,m365Activity,agent365,productFeedback,consumption,agentEvaluator,defender,resourceGraph'), {
    m365Activity: true, agent365: true, productFeedback: true, consumption: true, agentEvaluator: true, defender: true, resourceGraph: true,
  });
  // Everything the installer can collect on Azure today; Agent Evaluator isn't one of them yet.
  assert.deepEqual(loadConfig({ VALUELENS_MODULES: 'core,orgData,m365Activity,agent365,productFeedback,consumption,defender,resourceGraph' }).modules, { ...ALL_OFF, m365Activity: true, agent365: true, productFeedback: true, consumption: true, defender: true, resourceGraph: true });
});

test('modules missing from VALUELENS_MODULES are off', () => {
  assert.deepEqual(parseModules('core,orgData,m365Activity'), { ...ALL_OFF, m365Activity: true });
  assert.deepEqual(parseModules(' core , agent365,, defender '), { ...ALL_OFF, agent365: true, defender: true });
});

test('in sample-data mode Consumption and Resource Graph are off, as the installer leaves them out', () => {
  assert.deepEqual(parseModules('core,orgData,m365Activity,agent365,productFeedback,defender'), { ...ALL_OFF, m365Activity: true, agent365: true, productFeedback: true, defender: true });
});

test('IDs in VALUELENS_MODULES that aren\'t app modules are ignored', () => {
  assert.deepEqual(parseModules('core,orgData'), ALL_OFF);
  assert.deepEqual(parseModules('core,orgData,workday,notAModule,m365Activity'), { ...ALL_OFF, m365Activity: true });
});
