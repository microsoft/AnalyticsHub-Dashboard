// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCli } from '../src/cli.js';
import { HttpError } from '../src/http.js';
import { finishUpdate, restoreReplaced } from '../src/install.js';
import { deployModel, MODEL_UPDATE_NOTE, needsDataReset, replacedModels } from '../src/steps/model.js';
import { planReview } from '../src/steps/plan.js';
import { fakeCtx, fakeFabric, fakeGraph, fakePowerBi, fakeUi, httpError } from './fakes.js';

/** Fabric turning down an update it can only make by clearing the model's data, as a call error and as a failed operation. */
const RESETS = {
  http: () => new HttpError('The request requires options', { status: 400, method: 'POST', url: 'https://x', code: 'RequiredOptionsMissing' }),
  operation: () => new Error('Fabric operation failed (RequiredOptionsMissing): Dataset schema change requires allowPurgeData'),
};

/** A deployed, bound model whose definition is about to change. @param {{ answers?: any[], yes?: boolean }} [o] */
function deployed(o = {}) {
  const fabric = fakeFabric();
  const powerBi = fakePowerBi();
  const ui = fakeUi({ answers: o.answers, yes: o.yes });
  const t = fakeCtx({ fabric: fabric.api, graph: fakeGraph().api, powerBi: powerBi.api, ui: ui.ui });
  const sm = t.config.semanticModel;
  sm.enabled = true;
  const item = fabric.add('SemanticModel', 'Analytics Hub Model', 'v1');
  Object.assign(sm, { id: item.id, name: item.displayName, signature: 'old', bound: true });
  const deploy = () => deployModel(t.ctx, sm, { signature: 'new', definition: () => 'v2' });
  return { ...t, fabric, powerBi, ui, sm, item, deploy };
}

test('a model update keeps its data by default: no purge option unless Fabric asks for one', async () => {
  const t = deployed({ yes: true });
  await t.deploy();
  assert.deepEqual(t.fabric.calls.filter((c) => c.startsWith('updateSemanticModel')), ['updateSemanticModel Analytics Hub Model']);
  assert.equal(t.item.content, 'v2');
  assert.deepEqual([...replacedModels(t.ctx).values()], [{ name: 'Analytics Hub Model', cleared: false }]);
  assert.deepEqual(t.ui.asked, []);
});

for (const [kind, reset] of Object.entries(RESETS)) {
  test(`${kind}: --yes alone never clears a model's data; the model is left as it was and the run stops`, async () => {
    const t = deployed({ yes: true });
    t.fabric.failures.updateSemanticModel = [reset()];
    assert.ok(needsDataReset(reset()));
    await assert.rejects(t.deploy(), /Analytics Hub Model wasn't changed.*--allow-model-reset/s);
    assert.deepEqual(t.fabric.calls.filter((c) => c.startsWith('updateSemanticModel')), ['updateSemanticModel Analytics Hub Model'], 'never retried with purge');
    assert.equal(t.item.content, 'v1');
    assert.equal(t.sm.signature, 'old', 'the next run tries again');
    assert.equal(t.sm.bound, true);
    assert.equal(replacedModels(t.ctx).size, 0);
    assert.match(t.ui.text(), /can't apply this version of Analytics Hub Model and keep its data.*show no data/s);
    assert.deepEqual(t.ui.asked, []);
  });

  test(`${kind}: declining the reset leaves the model as it was`, async () => {
    const t = deployed({ answers: [false] });
    t.fabric.failures.updateSemanticModel = [reset()];
    await assert.rejects(t.deploy(), /wasn't changed/);
    assert.equal(t.ui.asked.length, 1);
    assert.match(t.ui.asked[0], /Clear Analytics Hub Model's data and reload it now\?/);
    assert.equal(t.fabric.calls.filter((c) => c.includes('allowPurgeData')).length, 0);
    assert.equal(t.item.content, 'v1');
    assert.equal(t.sm.signature, 'old');
  });

  test(`${kind}: agreeing to the reset, asked or by --allow-model-reset, clears and records the model for a reload`, async () => {
    const asked = deployed({ answers: [true] });
    asked.fabric.failures.updateSemanticModel = [reset()];
    await asked.deploy();
    assert.deepEqual(asked.fabric.calls.filter((c) => c.startsWith('updateSemanticModel')), ['updateSemanticModel Analytics Hub Model', 'updateSemanticModel Analytics Hub Model allowPurgeData']);
    assert.equal(asked.item.content, 'v2');
    assert.equal(asked.sm.bound, false);
    assert.deepEqual(replacedModels(asked.ctx).get(asked.sm.id ?? ''), { name: 'Analytics Hub Model', cleared: true });

    const flag = deployed({ yes: true });
    flag.ctx.allowModelReset = true;
    flag.fabric.failures.updateSemanticModel = [reset()];
    await flag.deploy();
    assert.deepEqual(flag.ui.asked, []);
    assert.ok(flag.fabric.calls.includes('updateSemanticModel Analytics Hub Model allowPurgeData'));
    assert.match(flag.ui.text(), /--allow-model-reset allows/);
    assert.equal(replacedModels(flag.ctx).get(flag.sm.id ?? '')?.cleared, true);
  });
}

test('any other update error is passed on without asking or purging', async () => {
  const t = deployed({ answers: [true] });
  t.fabric.failures.updateSemanticModel = [httpError(500, 'Internal')];
  await assert.rejects(t.deploy(), /Internal/);
  assert.deepEqual(t.ui.asked, []);
  assert.equal(t.fabric.calls.filter((c) => c.includes('allowPurgeData')).length, 0);
  assert.equal(t.sm.signature, 'old');
});

test('a model a stopped run created is updated with the same consent rule', async () => {
  const setup = (/** @type {{ answers?: any[], yes?: boolean }} */ o) => {
    const fabric = fakeFabric();
    const ui = fakeUi(o);
    const t = fakeCtx({ fabric: fabric.api, graph: fakeGraph().api, ui: ui.ui });
    t.config.semanticModel.enabled = true;
    const item = fabric.add('SemanticModel', 'Analytics Hub Model', 'half-made', 'ValueLens. (ref cc33)');
    t.config.fabric.pendingItems = { 'SemanticModel:main': { name: 'Analytics Hub Model', ref: 'cc33' } };
    fabric.failures.updateSemanticModel = [RESETS.operation()];
    return { ...t, fabric, ui, item, deploy: () => deployModel(t.ctx, t.config.semanticModel, { signature: 's', definition: () => 'v2' }) };
  };
  const yes = setup({ yes: true });
  await assert.rejects(yes.deploy(), /wasn't changed/);
  assert.equal(yes.item.content, 'half-made');
  assert.equal(yes.fabric.calls.filter((c) => c.includes('allowPurgeData')).length, 0);
  assert.equal(yes.fabric.calls.filter((c) => c.startsWith('createSemanticModel')).length, 0, 'not created again');

  const ok = setup({ answers: [true] });
  await ok.deploy();
  assert.ok(ok.fabric.calls.includes('updateSemanticModel Analytics Hub Model allowPurgeData'));
  assert.equal(ok.item.content, 'v2');
  assert.equal(replacedModels(ok.ctx).get(ok.item.id)?.cleared, true);
});

test('an unchanged model is not updated, and a new one is created, not updated', async () => {
  const t = deployed();
  t.sm.signature = undefined;
  await t.deploy();
  t.fabric.calls.length = 0;
  replacedModels(t.ctx).clear();
  await t.deploy();
  assert.deepEqual(t.fabric.calls.filter((c) => /SemanticModel /.test(c)), []);
  assert.equal(replacedModels(t.ctx).size, 0);

  const fabric = fakeFabric();
  const n = fakeCtx({ fabric: fabric.api, graph: fakeGraph().api, ui: fakeUi().ui });
  n.config.semanticModel.enabled = true;
  await deployModel(n.ctx, n.config.semanticModel, { signature: 's', definition: () => 'v1' });
  assert.deepEqual(fabric.calls.filter((c) => /SemanticModel /.test(c)), ['createSemanticModel Analytics Hub Model']);
  assert.equal(replacedModels(n.ctx).size, 0);
});

/** A model this run replaced (and so cleared), connected again as the update's later steps do. */
async function replacedAndBound() {
  const t = deployed({ answers: [true] });
  t.fabric.failures.updateSemanticModel = [RESETS.http()];
  await t.deploy();
  t.sm.bound = true;
  return t;
}

test('update: "Up to date" only once the replaced model is reloaded', async () => {
  const t = await replacedAndBound();
  assert.equal(await finishUpdate(t.ctx), true);
  assert.ok(t.powerBi.calls.some((c) => c.startsWith(`refresh ${t.sm.id}`)));
  assert.match(t.ui.text(), /Up to date/);
});

test('update: a failed refresh is reported, not "Up to date"', async () => {
  const t = await replacedAndBound();
  t.powerBi.states.push({ status: 'Failed', extendedStatus: 'Failed' });
  assert.equal(await finishUpdate(t.ctx), false);
  const text = t.ui.text();
  assert.doesNotMatch(text, /Up to date/);
  assert.match(text, /Analytics Hub Model has no data until a refresh finishes/);
  assert.match(text, /The update isn't finished: the models weren't reloaded/);
});

test('update: a replaced model that can\'t be refreshed is reported, not "Up to date"', async () => {
  const t = await replacedAndBound();
  t.sm.bound = false;
  assert.equal(await finishUpdate(t.ctx), false);
  assert.ok(!t.powerBi.calls.some((c) => c.startsWith('refresh ')));
  assert.doesNotMatch(t.ui.text(), /Up to date/);
  assert.match(t.ui.text(), /Analytics Hub Model isn't connected to the Lakehouse, so it couldn't be refreshed after the update/);
});

test('update with nothing replaced still refreshes, and is up to date', async () => {
  const t = deployed();
  assert.equal(await finishUpdate(t.ctx), true);
  assert.ok(t.powerBi.calls.some((c) => c.startsWith(`refresh ${t.sm.id}`)));
});

test('install: when the load is skipped, a replaced model is refreshed on its own, and a failure is reported', async () => {
  const t = await replacedAndBound();
  assert.equal(await restoreReplaced(t.ctx, { wait: false, loadSkipped: true }), true);
  assert.ok(t.powerBi.calls.some((c) => c.startsWith(`refresh ${t.sm.id}`)));
  assert.match(t.ui.text(), /This run replaced Analytics Hub Model, so refreshing it from the Lakehouse now/);

  const failed = await replacedAndBound();
  failed.powerBi.states.push({ status: 'Failed', extendedStatus: 'Failed' });
  assert.equal(await restoreReplaced(failed.ctx, { wait: true, loadSkipped: true }), false);
  assert.match(failed.ui.text(), /The install isn't finished/);

  // The pipeline ran and refreshed it: nothing more to do here.
  const loaded = await replacedAndBound();
  assert.equal(await restoreReplaced(loaded.ctx, { wait: true, loadSkipped: false }), true);
  assert.ok(!loaded.powerBi.calls.some((c) => c.startsWith('refresh ')));

  const stranded = await replacedAndBound();
  stranded.sm.bound = false;
  assert.equal(await restoreReplaced(stranded.ctx, { wait: true, loadSkipped: true }), false);
  assert.match(stranded.ui.text(), /isn't connected to the Lakehouse, so it can't be refreshed yet/);
});

test('--allow-model-reset: only with install, update or access, and not with --ui', () => {
  assert.equal(parseCli(['update', '--yes', '--allow-model-reset']).allowModelReset, true);
  assert.equal(parseCli(['install']).allowModelReset, false);
  assert.equal(parseCli(['update', '--yes']).allowModelReset, false);
  assert.throws(() => parseCli(['refresh', '--allow-model-reset']), /goes with install, update or access/);
  assert.throws(() => parseCli(['--ui', '--allow-model-reset']), /--ui/);
});

test('the plan says an existing model may need its data cleared, and a new one doesn\'t', () => {
  const t = deployed();
  const existing = planReview(t.ctx).creates.find((c) => c.kind === 'Semantic model');
  assert.equal(existing?.detail, MODEL_UPDATE_NOTE);
  assert.match(MODEL_UPDATE_NOTE, /asked before it's cleared/);
  delete t.sm.id;
  const fresh = planReview(t.ctx).creates.find((c) => c.kind === 'Semantic model');
  assert.equal(fresh?.isNew, true);
  assert.equal(fresh?.detail, undefined);
});
