// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCli } from '../src/cli.js';
import { fabricApi } from '../src/clients/fabric.js';
import { loadConfig, saveConfig } from '../src/config.js';
import { createClient, HttpError } from '../src/http.js';
import { finishUpdate, loadState } from '../src/install.js';
import { confirmReloaded, deployModel, MODEL_UPDATE_NOTE, needsDataReset, refreshModel, settleReloads } from '../src/steps/model.js';
import { planReview } from '../src/steps/plan.js';
import { createWebUi } from '../src/web-ui.js';
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
  assert.deepEqual(t.sm.reload, { since: '2026-06-01T12:00:00.000Z', seen: [] }, 'owed a reload, data kept; no refresh listed yet');
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
    assert.equal(t.sm.reload, undefined, 'Fabric changed nothing, so nothing is owed');
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
    assert.deepEqual(asked.sm.reload, { since: '2026-06-01T12:00:00.000Z', cleared: true, seen: [] });

    const flag = deployed({ yes: true });
    flag.ctx.allowModelReset = true;
    flag.fabric.failures.updateSemanticModel = [reset()];
    await flag.deploy();
    assert.deepEqual(flag.ui.asked, []);
    assert.ok(flag.fabric.calls.includes('updateSemanticModel Analytics Hub Model allowPurgeData'));
    assert.match(flag.ui.text(), /--allow-model-reset allows/);
    assert.equal(flag.sm.reload?.cleared, true);
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
  assert.equal(ok.config.semanticModel.reload?.cleared, true);
  assert.equal(yes.config.semanticModel.reload, undefined);
});

test('an unchanged model is not updated, and a new one is created, not updated', async () => {
  const t = deployed();
  t.sm.signature = undefined;
  await t.deploy();
  t.fabric.calls.length = 0;
  delete t.sm.reload;
  await t.deploy();
  assert.deepEqual(t.fabric.calls.filter((c) => /SemanticModel /.test(c)), []);
  assert.equal(t.sm.reload, undefined);

  const fabric = fakeFabric();
  const n = fakeCtx({ fabric: fabric.api, graph: fakeGraph().api, ui: fakeUi().ui });
  n.config.semanticModel.enabled = true;
  await deployModel(n.ctx, n.config.semanticModel, { signature: 's', definition: () => 'v1' });
  assert.deepEqual(fabric.calls.filter((c) => /SemanticModel /.test(c)), ['createSemanticModel Analytics Hub Model']);
  assert.equal(n.config.semanticModel.reload, undefined, 'a new model has nothing to reload');
});

test('declining a reset keeps an obligation an earlier run left', async () => {
  const t = deployed({ answers: [false] });
  t.sm.reload = { since: '2026-05-31T09:00:00.000Z', cleared: true };
  t.fabric.failures.updateSemanticModel = [RESETS.http()];
  await assert.rejects(t.deploy(), /wasn't changed/);
  assert.deepEqual(t.sm.reload, { since: '2026-05-31T09:00:00.000Z', cleared: true });
});

/** A model this run replaced (and so cleared), connected again as the update's later steps do. */
async function replacedAndBound() {
  const t = deployed({ answers: [true] });
  t.fabric.failures.updateSemanticModel = [RESETS.http()];
  await t.deploy();
  t.sm.bound = true;
  return t;
}

test('update: "Up to date" only once the replaced model is reloaded, which takes the obligation back', async () => {
  const t = await replacedAndBound();
  assert.equal(await finishUpdate(t.ctx), true);
  assert.ok(t.powerBi.calls.some((c) => c.startsWith(`refresh ${t.sm.id}`)));
  assert.ok(t.powerBi.calls.some((c) => c.startsWith('getRefresh ')), 'followed to the end');
  assert.match(t.ui.text(), /Up to date/);
  assert.equal(t.sm.reload, undefined);
});

test('update: a failed refresh is reported, not "Up to date", and the model stays owed a reload', async () => {
  const t = await replacedAndBound();
  t.powerBi.states.push({ status: 'Failed', extendedStatus: 'Failed' });
  assert.equal(await finishUpdate(t.ctx), false);
  const text = t.ui.text();
  assert.doesNotMatch(text, /Up to date/);
  assert.match(text, /Analytics Hub Model has no data until a refresh finishes/);
  assert.match(text, /The update isn't finished: the models weren't reloaded/);
  assert.equal(t.sm.reload?.cleared, true);
});

test('update: a replaced model that can\'t be refreshed is reported, not "Up to date"', async () => {
  const t = await replacedAndBound();
  t.sm.bound = false;
  assert.equal(await finishUpdate(t.ctx), false);
  assert.ok(!t.powerBi.calls.some((c) => c.startsWith('refresh ')));
  assert.doesNotMatch(t.ui.text(), /Up to date/);
  assert.match(t.ui.text(), /Analytics Hub Model needs reloading after its update, but isn't connected to its data/);
  assert.equal(t.sm.reload?.cleared, true);
});

test('update without waiting: the refresh started is success, but said as still reloading, not "Up to date"', async () => {
  const t = await replacedAndBound();
  assert.equal(await finishUpdate(t.ctx, { wait: false }), true);
  assert.equal(t.powerBi.calls.filter((c) => c.startsWith('refresh ')).length, 1);
  assert.equal(t.powerBi.calls.filter((c) => c.startsWith('getRefresh ')).length, 0);
  const text = t.ui.text();
  assert.doesNotMatch(text, /Up to date/);
  assert.match(text, /Updated\. Analytics Hub Model is still reloading: reports on it can show no data or miss new columns until that finishes/);
  assert.equal(t.sm.reload?.cleared, true, 'kept until a refresh is seen to finish');
});

test('update on the page says the same: still reloading, or not finished, never "Up to date" early', async () => {
  for (const [wait, outcome] of /** @type {const} */ ([[false, 'reloading'], [true, 'failed']])) {
    const t = await replacedAndBound();
    const web = createWebUi({ now: () => 1000 });
    t.ctx.ui = web;
    if (outcome === 'failed') t.powerBi.states.push({ status: 'Failed', extendedStatus: 'Failed' });
    assert.equal(await finishUpdate(t.ctx, { wait }), outcome !== 'failed');
    const lines = web.history().filter((/** @type {any} */ e) => e.type === 'line').map((/** @type {any} */ e) => `${e.kind}: ${e.text}`);
    assert.ok(!lines.some((l) => /Up to date/.test(l)), lines.join('\n'));
    if (outcome === 'reloading') assert.ok(lines.some((l) => /^ok: Updated\. Analytics Hub Model is still reloading/.test(l)), lines.join('\n'));
    else assert.ok(lines.some((l) => /^fail: The update isn't finished: the models weren't reloaded/.test(l)), lines.join('\n'));
  }
});

test('update with nothing replaced still refreshes, and is up to date', async () => {
  const t = deployed();
  assert.equal(await finishUpdate(t.ctx), true);
  assert.ok(t.powerBi.calls.some((c) => c.startsWith(`refresh ${t.sm.id}`)));
});

test('refresh: only a finished refresh that started after the change takes the obligation back', async () => {
  const failed = await replacedAndBound();
  failed.powerBi.states.push({ status: 'Unknown' }, { status: 'Failed', extendedStatus: 'Failed' });
  assert.equal((await refreshModel(failed.ctx, { wait: true })).ok, false);
  assert.equal(failed.sm.reload?.cleared, true);

  const done = await replacedAndBound();
  done.powerBi.states.push({ status: 'Unknown' }, { status: 'Completed', extendedStatus: 'Completed' });
  assert.equal((await refreshModel(done.ctx, { wait: true })).ok, true);
  assert.equal(done.sm.reload, undefined);

  // Following a refresh that was already running when the definition changed: it may have loaded the old one.
  const older = await replacedAndBound();
  older.powerBi.failures.refresh = [httpError(409, 'A refresh is in progress')];
  older.powerBi.history.push({ requestId: 'earlier', status: 'Unknown', startTime: '2026-06-01T11:59:00Z' });
  assert.equal((await refreshModel(older.ctx, { wait: true })).ok, true);
  assert.equal(older.sm.reload?.cleared, true);
});

test('settleReloads: a load still running leaves the models pending; waiting, that is not finished', async () => {
  const t = await replacedAndBound();
  const reachable = () => true;
  assert.deepEqual(await settleReloads(t.ctx, { wait: false, load: 'running', reachable }), { ok: true, pending: ['Analytics Hub Model'] });
  assert.deepEqual(await settleReloads(t.ctx, { wait: true, load: 'running', reachable }), { ok: false, pending: ['Analytics Hub Model'] });
  assert.equal(t.powerBi.calls.filter((c) => c.startsWith('refresh ')).length, 0, 'no refresh competes with the load');
  assert.match(t.ui.text(), /still reloading, so this couldn't confirm it finished/);
});

test('settleReloads after a finished load: its refresh counts only if it started after the change and completed', async () => {
  const reachable = () => true;
  const loaded = await replacedAndBound();
  loaded.powerBi.history.push({ requestId: 'pipeline', status: 'Completed', startTime: '2026-06-01T12:30:00Z' });
  assert.deepEqual(await settleReloads(loaded.ctx, { wait: true, load: 'done', reachable }), { ok: true, pending: [] });
  assert.equal(loaded.powerBi.calls.filter((c) => c.startsWith('refresh ')).length, 0);
  assert.equal(loaded.sm.reload, undefined);

  // An earlier refresh's success says nothing about this change: refreshed now.
  const earlier = await replacedAndBound();
  earlier.powerBi.history.push({ requestId: 'yesterday', status: 'Completed', startTime: '2026-05-31T02:00:00Z' });
  assert.deepEqual(await settleReloads(earlier.ctx, { wait: true, load: 'done', reachable }), { ok: true, pending: [] });
  assert.equal(earlier.powerBi.calls.filter((c) => c.startsWith('refresh ')).length, 1);
  assert.equal(earlier.sm.reload, undefined);

  const failed = await replacedAndBound();
  failed.powerBi.history.push({ requestId: 'pipeline', status: 'Failed', startTime: '2026-06-01T12:30:00Z' });
  failed.powerBi.states.push({ status: 'Failed', extendedStatus: 'Failed' });
  assert.equal((await settleReloads(failed.ctx, { wait: true, load: 'done', reachable })).ok, false);
  assert.equal(failed.sm.reload?.cleared, true);
});

test('loadState: how far a pipeline run got with reloading the models', () => {
  assert.equal(loadState({ jobId: 'j', status: 'Completed', started: true }), 'done');
  assert.equal(loadState({ jobId: 'j', status: 'Failed', started: true }), 'none');
  assert.equal(loadState({ jobId: 'j', status: 'Cancelled', started: true }), 'none');
  assert.equal(loadState({ jobId: 'j', status: 'NotStarted', started: true }), 'running');
  assert.equal(loadState({ jobId: 'j', status: 'InProgress', started: false }), 'running');
});

/** Writes the record on every save, as the installer does, so a new context can read it back. */
function persisted(/** @type {{ ctx: any, config: any }} */ t) {
  const dir = mkdtempSync(join(tmpdir(), 'ah-reload-'));
  const file = join(dir, 'valuelens-install.json');
  t.ctx.save = () => saveConfig(file, t.config);
  t.ctx.save();
  return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('a reload owed after a failed refresh survives the record being saved and read back, and the next run reloads it', async () => {
  const t = deployed({ answers: [true] });
  const record = persisted(t);
  try {
    t.fabric.failures.updateSemanticModel = [RESETS.http()];
    await t.deploy();
    t.sm.bound = true;
    t.ctx.save();
    t.powerBi.states.push({ status: 'Failed', extendedStatus: 'Failed' });
    assert.equal(await finishUpdate(t.ctx), false);

    const { config } = loadConfig(record.file);
    assert.deepEqual(config.semanticModel.reload, { since: '2026-06-01T12:00:00.000Z', cleared: true, seen: [], ours: 'request-1', failed: ['request-1'] });
    const powerBi = t.powerBi;
    powerBi.calls.length = 0;
    // Its own record of the failed request is the only history: that never counts as the reload.
    powerBi.history.push({ requestId: 'request-1', status: 'Completed', startTime: '2026-06-01T12:00:01Z' });
    const ui = fakeUi();
    const next = fakeCtx({ config, fabric: t.fabric.api, graph: fakeGraph().api, powerBi: powerBi.api, ui: ui.ui, now: new Date('2026-06-01T13:00:00Z') });
    next.ctx.save = () => saveConfig(record.file, config);
    // Unchanged definition: no update request, but the saved obligation is still met.
    t.fabric.calls.length = 0;
    await deployModel(next.ctx, config.semanticModel, { signature: 'new', definition: () => 'v2' });
    assert.deepEqual(t.fabric.calls.filter((c) => c.startsWith('updateSemanticModel')), []);
    assert.deepEqual(await settleReloads(next.ctx, { wait: true, load: 'none', reachable: () => true }), { ok: true, pending: [] });
    assert.equal(powerBi.calls.filter((c) => c.startsWith('refresh ')).length, 1);
    assert.match(ui.text(), /Analytics Hub Model has no data until it reloads after its update, so refreshing it now/);
    assert.equal(loadConfig(record.file).config.semanticModel.reload, undefined, 'taken back on disk too');
  } finally {
    record.cleanup();
  }
});

test('the reload is recorded before each request that can change the model, so an unknown outcome is still owed one', async () => {
  const definition = { parts: [{ path: 'model.bim', payload: Buffer.from('{}').toString('base64'), payloadType: 'InlineBase64' }] };
  const t = deployed({ answers: [true] });
  const record = persisted(t);
  try {
    /** @type {{ method: string, purge: boolean, owed: any }[]} */
    const seen = [];
    const http = createClient({
      baseUrl: 'https://fabric.invalid/v1',
      getToken: async () => 'offline',
      sleep: async () => {},
      fetchImpl: /** @type {any} */ (async (/** @type {string} */ _url, /** @type {any} */ options) => {
        const body = options.body ? JSON.parse(options.body) : undefined;
        seen.push({ method: options.method, purge: !!body?.options?.allowPurgeData, owed: loadConfig(record.file).config.semanticModel.reload ?? null });
        if (options.method === 'GET') return new Response(JSON.stringify({ errorCode: 'Forbidden', message: 'Polling denied' }), { status: 403 });
        if (!body.options?.allowPurgeData) return new Response(JSON.stringify({ errorCode: 'RequiredOptionsMissing', message: 'Needs reset' }), { status: 400 });
        return new Response(null, { status: 202, headers: { Location: 'https://fabric.invalid/v1/operations/purge' } });
      }),
    });
    t.fabric.api.updateSemanticModel = fabricApi(http).updateSemanticModel;
    await assert.rejects(deployModel(t.ctx, t.sm, { signature: 'new', definition: () => definition }), /Polling denied/);
    assert.deepEqual(seen.map((s) => [s.method, s.purge, s.owed]), [
      ['POST', false, { since: '2026-06-01T12:00:00.000Z', unsettled: true }],
      ['POST', true, { since: '2026-06-01T12:00:00.000Z', unsettled: true, cleared: true }],
      ['GET', false, { since: '2026-06-01T12:00:00.000Z', unsettled: true, cleared: true }],
    ]);
    assert.equal(t.sm.signature, 'old', 'the outcome is unknown, so the next run sends it again');
    assert.match(t.ui.text(), /Analytics Hub Model's data may have been cleared\. Run the installer again once the problem below is fixed: it applies the update again and then reloads the data/);
    assert.deepEqual(loadConfig(record.file).config.semanticModel.reload, { since: '2026-06-01T12:00:00.000Z', unsettled: true, cleared: true });
  } finally {
    record.cleanup();
  }
});

test('a refresh that ran before the change settled never counts as its reload, even when its start looks later', async () => {
  const definition = { parts: [{ path: 'model.bim', payload: Buffer.from('{}').toString('base64'), payloadType: 'InlineBase64' }] };
  const t = deployed({ answers: [true] });
  const record = persisted(t);
  try {
    let posts = 0;
    const http = createClient({
      baseUrl: 'https://fabric.invalid/v1',
      getToken: async () => {
        // While the purge request is being sent: another refresh reads the old definition and finishes.
        if (posts === 1) t.powerBi.history.unshift({ requestId: 'old-definition', status: 'Completed', startTime: '2026-06-01T12:00:01Z', endTime: '2026-06-01T12:00:02Z' });
        return 'offline';
      },
      sleep: async () => {},
      fetchImpl: /** @type {any} */ (async (/** @type {string} */ _url, /** @type {any} */ options) => {
        const body = JSON.parse(options.body);
        posts++;
        if (!body.options?.allowPurgeData) return new Response(JSON.stringify({ errorCode: 'RequiredOptionsMissing', message: 'Needs reset' }), { status: 400 });
        return new Response(null, { status: 200 });
      }),
    });
    t.fabric.api.updateSemanticModel = fabricApi(http).updateSemanticModel;
    await deployModel(t.ctx, t.sm, { signature: 'new', definition: () => definition });
    t.sm.bound = true;
    t.ctx.save();
    // The clock didn't move, so by start time alone the old refresh would count.
    assert.deepEqual(loadConfig(record.file).config.semanticModel.reload, { since: '2026-06-01T12:00:00.000Z', cleared: true, seen: ['old-definition'] });
    assert.equal(await confirmReloaded(t.ctx, t.sm), false);
    assert.ok(loadConfig(record.file).config.semanticModel.reload);
    t.powerBi.calls.length = 0;
    assert.deepEqual(await settleReloads(t.ctx, { wait: true, load: 'none', reachable: () => true }), { ok: true, pending: [] });
    assert.deepEqual(t.powerBi.calls.filter((c) => c.startsWith('refresh ')), [`refresh ${t.sm.id} full`], 'reloaded after the change');
    assert.equal(loadConfig(record.file).config.semanticModel.reload, undefined);
  } finally {
    record.cleanup();
  }
});

test('when the refreshes can\'t be listed as the change settles, only a refresh the installer starts counts', async () => {
  const t = deployed({ answers: [true] });
  const list = t.powerBi.api.refreshes;
  t.powerBi.api.refreshes = async () => { throw httpError(500, 'Unavailable'); };
  t.fabric.failures.updateSemanticModel = [RESETS.http()];
  await t.deploy();
  t.sm.bound = true;
  t.powerBi.api.refreshes = list;
  assert.deepEqual(t.sm.reload, { since: '2026-06-01T12:00:00.000Z', cleared: true });
  t.powerBi.history.push({ requestId: 'pipeline', status: 'Completed', startTime: '2026-06-01T12:30:00Z' });
  assert.equal(await confirmReloaded(t.ctx, t.sm), false);
  assert.deepEqual(await settleReloads(t.ctx, { wait: true, load: 'done', reachable: () => true }), { ok: true, pending: [] });
  assert.equal(t.powerBi.calls.filter((c) => c.startsWith('refresh ')).length, 1);
  assert.equal(t.sm.reload, undefined);
});

/** A refresh that ends Completed, but with a calculated table that wasn't calculated. */
const WARNED = { status: 'Completed', extendedStatus: 'Completed', messages: [{ type: 'Warning', message: 'A calculated table could not be calculated.' }] };

test('a refresh whose details report problems never counts as the reload, even when the history says Completed', async () => {
  const t = await replacedAndBound();
  const record = persisted(t);
  try {
    // The history shows each refresh only as Completed.
    const refresh = t.powerBi.api.refresh;
    t.powerBi.api.refresh = async (/** @type {any[]} */ ...a) => {
      const id = await /** @type {any} */ (refresh)(...a);
      t.powerBi.history.unshift({ requestId: id, status: 'Completed', startTime: '2026-06-01T12:00:01Z' });
      return id;
    };
    t.powerBi.states.push(WARNED);
    assert.equal(await finishUpdate(t.ctx), false);
    assert.match(t.ui.text(), /parts of it weren't calculated/);
    assert.doesNotMatch(t.ui.text(), /Up to date/);
    const saved = loadConfig(record.file).config.semanticModel.reload;
    assert.equal(saved?.cleared, true);
    assert.deepEqual(saved?.failed, ['request-1']);

    // A new run: that refresh still doesn't count, so it refreshes again and checks the details.
    const { config } = loadConfig(record.file);
    const next = fakeCtx({ config, fabric: t.fabric.api, graph: fakeGraph().api, powerBi: t.powerBi.api, ui: fakeUi().ui });
    next.ctx.save = () => saveConfig(record.file, config);
    t.powerBi.calls.length = 0;
    t.powerBi.states.push(WARNED);
    assert.deepEqual(await settleReloads(next.ctx, { wait: true, load: 'none', reachable: () => true }), { ok: false, pending: [] });
    assert.equal(t.powerBi.calls.filter((c) => c.startsWith('refresh ')).length, 1);
    assert.equal(loadConfig(record.file).config.semanticModel.reload?.cleared, true);

    t.powerBi.calls.length = 0;
    assert.deepEqual(await settleReloads(next.ctx, { wait: true, load: 'none', reachable: () => true }), { ok: true, pending: [] });
    assert.equal(t.powerBi.calls.filter((c) => c.startsWith('refresh ')).length, 1);
    assert.equal(loadConfig(record.file).config.semanticModel.reload, undefined, 'taken back only after a clean one');
  } finally {
    record.cleanup();
  }
});

test('a finished load counts only when every refresh since the change is clean by its own details', async () => {
  const row = { requestId: 'pipeline', status: 'Completed', startTime: '2026-06-01T12:30:00Z' };
  const warned = await replacedAndBound();
  warned.powerBi.history.push(row);
  warned.powerBi.states.push(WARNED);
  assert.equal(await confirmReloaded(warned.ctx, warned.sm), false);
  assert.deepEqual(warned.sm.reload?.failed, ['pipeline']);

  const missing = await replacedAndBound();
  missing.powerBi.history.push(row);
  missing.powerBi.api.getRefresh = async () => { throw httpError(404, 'Not found'); };
  assert.equal(await confirmReloaded(missing.ctx, missing.sm), false, 'no details, no proof');
  assert.equal(missing.sm.reload?.failed, undefined);
  assert.equal(missing.sm.reload?.cleared, true);

  // The pipeline reloads the whole model and then one table: both have to be clean.
  const table = { requestId: 'table', status: 'Failed', startTime: '2026-06-01T12:40:00Z' };
  const partly = await replacedAndBound();
  partly.powerBi.history.push(table, row);
  assert.equal(await confirmReloaded(partly.ctx, partly.sm), false);

  const clean = await replacedAndBound();
  clean.powerBi.history.push({ ...table, status: 'Completed' }, row);
  assert.equal(await confirmReloaded(clean.ctx, clean.sm), true);
  assert.deepEqual(clean.powerBi.calls.filter((c) => c.startsWith('getRefresh ')), ['getRefresh table', 'getRefresh pipeline']);
  assert.equal(clean.sm.reload, undefined);

  // The whole-model refresh failed and only the table one after it was clean: not reloaded.
  const fullFailed = await replacedAndBound();
  fullFailed.powerBi.history.push({ ...table, status: 'Completed' }, { ...row, status: 'Failed' });
  assert.equal(await confirmReloaded(fullFailed.ctx, fullFailed.sm), false);
  assert.deepEqual(fullFailed.sm.reload?.failed, ['pipeline']);
  assert.equal(await confirmReloaded(fullFailed.ctx, fullFailed.sm), false, 'still not, once it is remembered as failed');
});

test('a change that may not have finished is applied again before anything counts as its reload', async () => {
  const t = deployed({ answers: [true] });
  await t.deploy();
  t.sm.bound = true;
  t.sm.reload = { since: '2026-06-01T12:00:00.000Z', unsettled: true, cleared: true };
  t.powerBi.history.push({ requestId: 'later', status: 'Completed', startTime: '2026-06-01T12:30:00Z' });
  assert.equal(await confirmReloaded(t.ctx, t.sm), false);
  t.powerBi.calls.length = 0;
  assert.deepEqual(await settleReloads(t.ctx, { wait: true, load: 'none', reachable: () => true }), { ok: false, pending: [] });
  assert.equal(t.powerBi.calls.filter((c) => c.startsWith('refresh ')).length, 0);
  assert.match(t.ui.text(), /Analytics Hub Model's last update may not have finished, so it can't be reloaded yet/);
  // A refresh on its own (the refresh command) doesn't settle it either.
  assert.equal((await refreshModel(t.ctx, { wait: true })).ok, true);
  assert.equal(t.sm.reload?.unsettled, true);

  // The same version, unchanged: applied again all the same, then reloaded.
  t.fabric.calls.length = 0;
  await t.deploy();
  assert.deepEqual(t.fabric.calls.filter((c) => c.startsWith('updateSemanticModel')), ['updateSemanticModel Analytics Hub Model']);
  assert.match(t.ui.text(), /last update may not have finished, so applying it again/);
  assert.deepEqual(t.sm.reload, { since: '2026-06-01T12:00:00.000Z', cleared: true, seen: ['later'] });
  t.sm.bound = true;
  assert.deepEqual(await settleReloads(t.ctx, { wait: true, load: 'none', reachable: () => true }), { ok: true, pending: [] });
  assert.equal(t.sm.reload, undefined);
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
