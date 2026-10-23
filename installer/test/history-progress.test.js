// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apiPermissionsUrl } from '../src/clients/graph.js';
import { emptyConfig } from '../src/config.js';
import {
  AUDIT_MANIFEST,
  AUDIT_STATE,
  azureHistory,
  clearPendingHistory,
  coverage,
  fabricHistory,
  fetchedWindows,
  historyStep,
  keyRange,
  newestEnd,
  pendingHistory,
  readAzureProgress,
  readFabricProgress,
  recordPendingHistory,
  showHistoryStep,
  utcTime,
} from '../src/steps/history-progress.js';
import { fakeCtx, fakeUi, httpError } from './fakes.js';

const H = 3_600_000;
const D = 24 * H;
/** @param {string} s  A UTC time with no zone. */
const t = (s) => Date.parse(`${s}Z`);
/** @param {number} ms  As Python's isoformat writes it. */
const iso = (ms) => new Date(ms).toISOString().replace('.000Z', '+00:00');
/** @param {number} ms */
const stamp = (ms) => new Date(ms).toISOString().slice(0, 16).replace(/[-T:]/g, '');

/**
 * The windows a load plans, as the notebook and the job do: on a grid anchored at the hour, the last one cut at `end`.
 * @param {number} start @param {number} end @param {number} hours
 * @returns {[number, number][]}
 */
function plan(start, end, hours) {
  const d = new Date(start);
  let cur = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours() - (d.getUTCHours() % hours));
  /** @type {[number, number][]} */
  const out = [];
  for (; cur < end; cur += hours * H) out.push([cur, Math.min(cur + hours * H, end)]);
  return out;
}

/**
 * A manifest's or state's window entries. `status(i)` is each window's; a window with none is left out.
 * @param {[number, number][]} windows
 * @param {(i: number) => string | undefined} status
 * @param {number} [rows]
 */
function entries(windows, status, rows = 12) {
  /** @type {Record<string, any>} */
  const out = {};
  windows.forEach(([s, e], i) => {
    const st = status(i);
    if (!st) return;
    out[`v2_${stamp(s)}_${stamp(e)}`] =
      st === 'succeeded'
        ? { status: st, window_start: iso(s), window_end: iso(e), rows, pages: 1, files: [`win_${stamp(s)}_0.jsonl`], completed_at: iso(e + H) }
        : { status: st, window_start: iso(s), window_end: iso(e) };
  });
  return out;
}

/** @param {number} start @param {number} count @param {number} [hours] @param {number} [rows] */
const list = (start, count, hours = 24, rows = 12) => Array.from({ length: count }, (_, i) => ({ start: start + i * hours * H, end: start + (i + 1) * hours * H, rows }));

/** @param {string} text */
const lines = (text) => text.split('\n').map((s) => s.trim()).filter(Boolean);

test('utcTime: Python isoformat, with or without a zone, is UTC', () => {
  assert.equal(utcTime('2026-05-01T08:00:00+00:00'), t('2026-05-01T08:00:00'));
  assert.equal(utcTime('2026-05-01T08:00:00.123456+00:00'), t('2026-05-01T08:00:00.123'));
  assert.equal(utcTime('2026-05-01T08:00:00.123456'), t('2026-05-01T08:00:00.123'));
  assert.equal(utcTime('2026-05-01T08:00:00'), t('2026-05-01T08:00:00'));
  assert.equal(utcTime(' 2026-05-01T08:00:00Z '), t('2026-05-01T08:00:00'));
  for (const v of [undefined, null, '', '  ', 'soon', 5, {}]) assert.equal(utcTime(v), undefined, String(v));
});

test('keyRange: versioned keys and those from before keys had a version; anything else is no window', () => {
  assert.deepEqual(keyRange('v2_202605010800_202605011600'), { start: t('2026-05-01T08:00:00'), end: t('2026-05-01T16:00:00') });
  assert.deepEqual(keyRange('202605010000_202605020000'), { start: t('2026-05-01T00:00:00'), end: t('2026-05-02T00:00:00') });
  for (const key of ['v2_202605011600_202605010800', 'v2_2026050108_2026050116', 'win_x', 'high_water_mark']) assert.equal(keyRange(key), undefined, key);
});

/** Entries of every kind a manifest or state can hold. */
const MIXED = {
  'v2_202605020000_202605030000': { status: 'succeeded', window_start: '2026-05-02T00:00:00+00:00', window_end: '2026-05-03T00:00:00+00:00', rows: 0 },
  // A notebook from before keys had a version kept only the status and rows.
  '202605010000_202605020000': { status: 'succeeded', rows: 7 },
  'v2_202605030000_202605040000': { status: 'failed', error: 'throttled' },
  'v2_202605040000_202605050000': { status: 'split', parts: ['a', 'b'] },
  'v2_202605050000_202605060000': { status: 'querying' },
  'v2_202605060000_202605070000': { status: 'succeeded', rows: -1 },
  'v2_202605070000_202605080000': { status: 'succeeded', rows: '3' },
  'odd-key': { status: 'succeeded', rows: 1 },
  'v2_202605080000_202605090000': 'succeeded',
  'v2_202605090000_202605100000': { rows: 4 },
};

test('fetchedWindows: the succeeded windows of any key version, oldest first', () => {
  assert.deepEqual(fetchedWindows(MIXED), [
    { start: t('2026-05-01T00:00:00'), end: t('2026-05-02T00:00:00'), rows: 7 },
    { start: t('2026-05-02T00:00:00'), end: t('2026-05-03T00:00:00'), rows: 0 },
    { start: t('2026-05-06T00:00:00'), end: t('2026-05-07T00:00:00') },
    { start: t('2026-05-07T00:00:00'), end: t('2026-05-08T00:00:00') },
  ]);
  for (const v of [null, undefined, [], 'x', 3]) assert.deepEqual(fetchedWindows(v), []);
});

test('newestEnd: the end of the newest window a run started on, fetched or not', () => {
  assert.equal(newestEnd(MIXED), t('2026-05-08T00:00:00'));
  assert.equal(newestEnd({ 'v2_202605090000_202605100000': { rows: 4 } }), undefined, 'an entry with no status');
  for (const v of [null, {}, []]) assert.equal(newestEnd(v), undefined);
});

test('coverage: how much of the range the fetched windows cover, and what is left', () => {
  const from = t('2026-05-02T12:00:00');
  const until = t('2026-06-01T12:00:00');
  const range = { from, until, chunkHours: 24 };
  assert.deepEqual(coverage(list(from, 30), range), { fetchedHours: 720, windowsLeft: 0, complete: true, through: until, tailOnly: false, allEmpty: false });
  assert.deepEqual(coverage(list(from, 10), range), { fetchedHours: 240, windowsLeft: 20, complete: false, through: from + 10 * D, tailOnly: true, allEmpty: false });
  assert.deepEqual(coverage([...list(from, 10), ...list(from + 15 * D, 15)], range), {
    fetchedHours: 600,
    windowsLeft: 5,
    complete: false,
    through: from + 10 * D,
    tailOnly: false,
    allEmpty: false,
  });
  assert.deepEqual(coverage(list(from + 5 * D, 25), range), { fetchedHours: 600, windowsLeft: 5, complete: false, tailOnly: false, allEmpty: false }, 'no history from the start of the range');
  assert.deepEqual(
    coverage(list(from + H, 359, 2), { from, until, chunkHours: 2 }),
    { fetchedHours: 718, windowsLeft: 0, complete: true, through: until - H, tailOnly: false, allEmpty: false },
    'a window at each end is no gap',
  );
  // Windows overlap the range at each end, and a version's windows can overlap another's.
  const empty = list(from - 12 * H, 31, 24, 0);
  assert.deepEqual(coverage([...empty, ...list(from, 2, 24, 0)].sort((a, b) => a.start - b.start), range), {
    fetchedHours: 720,
    windowsLeft: 0,
    complete: true,
    through: until,
    tailOnly: false,
    allEmpty: true,
  });
  const unknownRows = empty.map((w, i) => (i === 3 ? { start: w.start, end: w.end } : w));
  assert.equal(coverage(unknownRows, range).allEmpty, false, 'rows not recorded');
  assert.equal(coverage([...empty, { start: until + H, end: until + 2 * H, rows: 5 }], range).allEmpty, true, 'records outside the range');
  assert.deepEqual(coverage([], range), { fetchedHours: 0, windowsLeft: 30, complete: false, tailOnly: false, allEmpty: false });
  assert.equal(coverage([], { from, until }).windowsLeft, 90, 'the template window of 8 hours');
});

test('readFabricProgress: reads the notebook manifest with the OneLake client', async () => {
  assert.equal(AUDIT_MANIFEST, 'Files/_audit_staging/_manifest.json');
  const doc = { 'v2_202605010000_202605020000': { status: 'succeeded', rows: 3 }, 'v2_202605020000_202605030000': { status: 'querying' } };
  /** @type {any[]} */
  const calls = [];
  const { ctx } = fakeCtx({ oneLake: { readJson: async (/** @type {any[]} */ ...args) => (calls.push(args), doc) } });
  assert.deepEqual(await readFabricProgress(ctx), { read: true, entries: doc, windows: [{ start: t('2026-05-01T00:00:00'), end: t('2026-05-02T00:00:00'), rows: 3 }] });
  assert.deepEqual(calls, [['ws-1', 'lh-1', AUDIT_MANIFEST]]);

  /** @param {() => Promise<any>} readJson */
  const read = (readJson) => readFabricProgress(fakeCtx({ oneLake: { readJson } }).ctx);
  assert.deepEqual(await read(async () => null), { read: true, entries: {}, windows: [], missing: true }, 'no manifest yet');
  assert.deepEqual((await read(async () => ({ windows: doc, version: 3 })))?.read && 'read', 'read', 'windows under a key of their own');
  assert.deepEqual(await read(async () => []), { read: false, reason: 'unreadable' });
  assert.deepEqual(await read(async () => 'text'), { read: false, reason: 'unreadable' });
  assert.deepEqual(await read(() => Promise.reject(httpError(403, 'Forbidden'))), { read: false, reason: 'forbidden' });
  assert.deepEqual(await read(() => Promise.reject(httpError(401, 'Unauthorized'))), { read: false, reason: 'forbidden' });
  assert.deepEqual(await read(() => Promise.reject(httpError(500, 'Server error'))), { read: false, reason: 'error' });
  assert.deepEqual(await read(() => Promise.reject(new Error('getaddrinfo ENOTFOUND onelake.dfs.fabric.microsoft.com'))), { read: false, reason: 'error' });
  assert.deepEqual(await read(() => Promise.reject(new SyntaxError('Unexpected token'))), { read: false, reason: 'unreadable' });

  assert.deepEqual(await readFabricProgress(fakeCtx().ctx), { read: false, reason: 'unavailable' }, 'no OneLake client');
  const noLakehouse = fakeCtx({ oneLake: { readJson: async () => assert.fail('not read') } });
  delete noLakehouse.config.fabric.lakehouseId;
  assert.deepEqual(await readFabricProgress(noLakehouse.ctx), { read: false, reason: 'unavailable' });
});

/**
 * An Azure install whose job state `readText` returns.
 * @param {(container: string, path: string) => Promise<any>} readText
 * @param {{ calls?: any[], days?: number }} [o]
 */
function azureCtx(readText, o = {}) {
  const ui = fakeUi();
  const config = emptyConfig();
  config.target = 'azure';
  config.history.days = o.days ?? 30;
  const az = /** @type {any} */ (config.azure);
  az.subscriptionId = 'sub-1';
  az.resourceGroup = 'rg-vlens';
  az.outputs = { runJobName: 'vlens-run', storageAccountName: 'vlensst' };
  const { ctx } = fakeCtx({
    ui: ui.ui,
    config,
    dataLake: (account) => {
      o.calls?.push(account);
      return { readText: (/** @type {string} */ container, /** @type {string} */ path) => (o.calls?.push(container, path), readText(container, path)) };
    },
  });
  return { ctx, config, az, ui };
}

test('readAzureProgress: reads the job state with the Data Lake client, and ignores fields it does not know', async () => {
  assert.deepEqual(AUDIT_STATE, { container: 'raw', path: '_state/audit.json' });
  const windows = { 'v2_202605010000_202605010800': { status: 'succeeded', rows: 3, window_start: '2026-05-01T00:00:00+00:00', window_end: '2026-05-01T08:00:00+00:00' } };
  const state = {
    windows,
    high_water_mark: '2026-05-31T23:59:00.250000+00:00',
    backfill_from: '2026-03-03T00:00:00+00:00',
    publish: { from: '2026-03-03', windows: 4 },
    version: 3,
  };
  /** @type {any[]} */
  const calls = [];
  const { ctx } = azureCtx(async () => JSON.stringify(state), { calls });
  assert.deepEqual(await readAzureProgress(ctx), {
    read: true,
    entries: windows,
    windows: [{ start: t('2026-05-01T00:00:00'), end: t('2026-05-01T08:00:00'), rows: 3 }],
    highWaterMark: t('2026-05-31T23:59:00.250'),
    backfillFrom: t('2026-03-03T00:00:00'),
  });
  assert.deepEqual(calls, ['vlensst', 'raw', '_state/audit.json']);

  /** @param {() => Promise<any>} readText */
  const read = (readText) => readAzureProgress(azureCtx(readText).ctx);
  assert.deepEqual(await read(async () => '{}'), { read: true, entries: {}, windows: [] }, 'missing fields are unknown');
  assert.deepEqual(await read(async () => '{"windows":[],"high_water_mark":"soon"}'), { read: true, entries: {}, windows: [] });
  assert.deepEqual(await read(async () => null), { read: true, entries: {}, windows: [], missing: true }, 'no state yet');
  assert.deepEqual(await read(async () => '[]'), { read: false, reason: 'unreadable' });
  assert.deepEqual(await read(async () => 'not json'), { read: false, reason: 'unreadable' });
  assert.deepEqual(await read(async () => ''), { read: false, reason: 'unreadable' });
  assert.deepEqual(await read(() => Promise.reject(httpError(403, 'AuthorizationPermissionMismatch'))), { read: false, reason: 'forbidden' });
  assert.deepEqual(await read(() => Promise.reject(Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' }))), { read: false, reason: 'error' });

  const priv = azureCtx(async () => assert.fail('a private install is not read'), { calls: [] });
  priv.az.publicNetworkAccess = false;
  assert.deepEqual(await readAzureProgress(priv.ctx), { read: false, reason: 'private' });
  const noStorage = azureCtx(async () => assert.fail('not read'));
  delete noStorage.az.outputs.storageAccountName;
  assert.deepEqual(await readAzureProgress(noStorage.ctx), { read: false, reason: 'unavailable' });
  const noClient = azureCtx(async () => '{}');
  /** @type {any} */ (noClient.ctx.api).dataLake = undefined;
  assert.deepEqual(await readAzureProgress(noClient.ctx), { read: false, reason: 'unavailable' });
});

test("readAzureProgress: from 0.6.9's job image, how far back the reports go, the windows left and when the last run stopped", async () => {
  const windows = {
    'v2_202605311600_202606010000': { status: 'succeeded', rows: 3, window_start: '2026-05-31T16:00:00+00:00', window_end: '2026-06-01T00:00:00+00:00', merged_at: '2026-06-01T05:20:00+00:00' },
    'v2_202605310800_202605311600': {
      status: 'paused',
      window_start: '2026-05-31T08:00:00+00:00',
      window_end: '2026-05-31T16:00:00+00:00',
      query_id: 'q-1',
      query_created_at: '2026-06-01T04:40:00+00:00',
      paused_at: '2026-06-01T05:00:00+00:00',
      files: [],
      pages: 0,
      rows: 0,
    },
  };
  const state = {
    windows,
    windows_left: 61,
    loaded_back_to: '2026-05-31T16:00:00+00:00',
    paused_at: '2026-06-01T05:00:00.123456+00:00',
    pending_high_water_mark: '2026-05-31T23:58:00+00:00',
    last_merge_to_publish_s: 1260.5,
    merge_open: { started_at: '2026-06-01T05:10:00+00:00', clock: 11400.2, cutoff_s: 3000 },
  };
  const read = (/** @type {any} */ doc) => readAzureProgress(azureCtx(async () => JSON.stringify(doc)).ctx);
  assert.deepEqual(await read(state), {
    read: true,
    entries: windows,
    windows: [{ start: t('2026-05-31T16:00:00'), end: t('2026-06-01T00:00:00'), rows: 3 }],
    windowsLeft: 61,
    loadedBackTo: t('2026-05-31T16:00:00'),
    pausedAt: t('2026-06-01T05:00:00.123'),
    pendingHighWaterMark: t('2026-05-31T23:58:00'),
  }, 'a paused window is not fetched, and a merged one is');
  assert.equal(newestEnd({ ...windows, 'v2_202606010000_202606010200': { status: 'paused', query_id: 'q-2' } }), t('2026-06-01T02:00:00'), 'a paused window is one a run started on');
  // Nothing merged yet: the job writes null.
  assert.deepEqual(await read({ windows: {}, windows_left: 91, loaded_back_to: null, paused_at: '2026-06-01T05:00:00+00:00' }), {
    read: true,
    entries: {},
    windows: [],
    windowsLeft: 91,
    pausedAt: t('2026-06-01T05:00:00'),
  });
  assert.equal(/** @type {any} */ (await read({ windows_left: 0 })).windowsLeft, 0);
  for (const bad of [-1, '3', 1.5, null, true, {}]) assert.equal('windowsLeft' in (await read({ windows_left: bad })), false, JSON.stringify(bad));
  for (const bad of ['soon', 5, '']) {
    const p = await read({ loaded_back_to: bad, paused_at: bad });
    assert.equal('loadedBackTo' in p || 'pausedAt' in p, false, JSON.stringify(bad));
  }
});

test("readAzureProgress: from 0.6.9's job image, where the load had got to for the last publish", async () => {
  const read = (/** @type {any} */ doc) => readAzureProgress(azureCtx(async () => JSON.stringify(doc)).ctx);
  const p = /** @type {any} */ (
    await read({
      high_water_mark: '2026-05-31T23:58:00+00:00',
      published: {
        high_water_mark: '2026-05-30T23:58:00+00:00',
        pending_high_water_mark: '2026-05-31T23:00:00+00:00',
        loaded_back_to: '2026-05-31T08:00:00+00:00',
        backfill_from: '2026-03-03T00:00:00+00:00',
        process_started_at: '2026-06-01T05:25:00.123456+00:00',
        published_at: '2026-06-01T05:40:00+00:00',
      },
    })
  );
  assert.deepEqual(p.published, {
    highWaterMark: t('2026-05-30T23:58:00'),
    pendingHighWaterMark: t('2026-05-31T23:00:00'),
    loadedBackTo: t('2026-05-31T08:00:00'),
    backfillFrom: t('2026-03-03T00:00:00'),
  });
  assert.deepEqual(/** @type {any} */ (await read({ published: {} })).published, {}, 'none published yet');
  assert.deepEqual(/** @type {any} */ (await read({ published: { high_water_mark: 'soon', loaded_back_to: 5, backfill_from: null } })).published, {});
  for (const bad of [null, [], 'x', 5, true]) assert.equal('published' in (await read({ published: bad })), false, JSON.stringify(bad));
  assert.equal('published' in (await read({ high_water_mark: '2026-05-31T23:58:00+00:00' })), false, 'an older image keeps no record');
});

/**
 * A Fabric install whose manifest `readJson` returns.
 * @param {() => Promise<any>} readJson
 * @param {{ days?: number, scale?: 'standard' | 'large' }} [o]
 */
function fabricCtx(readJson, o = {}) {
  const ui = fakeUi();
  const config = emptyConfig();
  config.history.days = o.days ?? 30;
  if (o.scale) config.scale = o.scale;
  const { ctx } = fakeCtx({ ui: ui.ui, config, oneLake: { readJson } });
  return { ctx, config, ui };
}

test('fabricHistory: a large first load part-way through, while the pipeline runs', async () => {
  const from = t('2025-12-03T08:00:00');
  const until = t('2026-06-01T08:00:00');
  const manifest = entries(plan(from, until, 2), (i) => (i < 564 ? 'succeeded' : i === 564 ? 'querying' : undefined));
  const { ctx, config, ui } = fabricCtx(async () => manifest, { days: 180, scale: 'large' });
  config.firstRun = { jobId: 'job-1', status: 'InProgress', startedAt: '2026-06-01T08:00:00.000Z' };
  await fabricHistory(ctx, { jobs: [{ id: 'job-1', status: 'InProgress', startTimeUtc: '2026-06-01T08:00:00' }] });
  assert.deepEqual(lines(ui.text()), [
    'Audit history',
    'Asked for: 180 days',
    'Fetched from the audit log: about 47 of 180 days, 2025-12-03 to 2026-01-19; about 1,596 windows left',
    'In the reports: not the full history yet. The first load writes it once every window is fetched.',
    "The pipeline is running. If its audit load reaches its time budget, the pipeline's retries carry on from where it stopped.",
  ]);
});

test('fabricHistory: a reload with a gap, after a run that failed', async () => {
  const windows = plan(t('2025-12-03T00:00:00'), t('2026-06-01T06:00:00'), 24);
  assert.equal(windows.length, 181);
  const manifest = entries(windows, (i) => (i < 100 || i >= 150 ? 'succeeded' : i === 100 ? 'failed' : undefined));
  const { ctx, config, ui } = fabricCtx(async () => manifest, { days: 180, scale: 'standard' });
  config.firstRun = { jobId: 'job-1', status: 'Completed', startedAt: '2026-05-01T08:00:00.000Z' };
  const summary = { tables: { audit: { rows: 5000, from: '2026-05-01', to: '2026-05-31T23:00:00' } } };
  await fabricHistory(ctx, { jobs: [{ id: 'job-2', status: 'Failed', startTimeUtc: '2026-06-01T06:00:00' }], summary });
  assert.deepEqual(lines(ui.text()), [
    'Audit history',
    'Asked for: 180 days',
    'Fetched from the audit log: about 130 of 180 days, 2025-12-03 to 2026-03-13; about 50 windows left',
    'In the reports: 2026-05-01 to 2026-05-31, at the last data check',
    'To carry on, run "valuelens-install run --backfill-days 180". It reuses the windows already fetched.',
  ]);
});

test('fabricHistory: a load that is complete, and one with only its newest days to fetch', async () => {
  const windows = plan(t('2026-05-02T02:05:00'), t('2026-06-01T02:05:00'), 24);
  assert.equal(windows.length, 31);
  const done = fabricCtx(async () => entries(windows, () => 'succeeded'), { scale: 'standard' });
  done.config.firstRun = { jobId: 'job-1', status: 'Completed', startedAt: '2026-06-01T02:05:00.000Z' };
  await fabricHistory(done.ctx, { jobs: [{ id: 'job-1', status: 'Completed', startTimeUtc: '2026-06-01T02:05:00' }] });
  assert.deepEqual(lines(done.ui.text()), [
    'Audit history',
    'Asked for: 30 days',
    'Fetched from the audit log: all 30 days, 2026-05-02 to 2026-06-01',
    'In the reports: run "valuelens-install check" to see the dates.',
  ]);

  const tail = fabricCtx(async () => entries(windows, (i) => (i < 26 ? 'succeeded' : 'failed')), { scale: 'standard' });
  tail.config.firstRun = { jobId: 'job-1', status: 'Completed', startedAt: '2026-05-01T08:00:00.000Z' };
  await fabricHistory(tail.ctx, { jobs: [{ id: 'job-2', status: 'Failed', startTimeUtc: '2026-06-01T02:05:00' }] });
  assert.deepEqual(lines(tail.ui.text()).slice(2), [
    'Fetched from the audit log: about 26 of 30 days, 2026-05-02 to 2026-05-28; about 4 windows left',
    'In the reports: run "valuelens-install check" to see the dates.',
    'The newest days load with the next scheduled run. Start one sooner with "valuelens-install run".',
  ]);
});

test('fabricHistory: when the manifest cannot be read, or is not there', async () => {
  const denied = fabricCtx(() => Promise.reject(httpError(403, 'Forbidden')));
  denied.config.firstRun = { jobId: 'job-1', status: 'Failed', startedAt: '2026-06-01T08:00:00.000Z' };
  await fabricHistory(denied.ctx, { jobs: [{ id: 'job-1', status: 'Failed', startTimeUtc: '2026-06-01T08:00:00' }] });
  assert.deepEqual(lines(denied.ui.text()).slice(1), [
    'Asked for: 30 days',
    "How much has been fetched can't be read from this PC: your account can't read the Lakehouse's files.",
    'In the reports: not the full history yet. The first load writes it once every window is fetched.',
    'To carry on, run "valuelens-install run". It reuses any windows already fetched.',
  ]);

  // A loaded install whose staging area has gone: nothing to say about what was fetched.
  const gone = fabricCtx(async () => null);
  gone.config.firstRun = { jobId: 'job-1', status: 'Completed', startedAt: '2026-05-01T08:00:00.000Z' };
  await fabricHistory(gone.ctx, { jobs: [] });
  assert.deepEqual(lines(gone.ui.text()).slice(1), ['Asked for: 30 days', 'In the reports: run "valuelens-install check" to see the dates.']);

  const fresh = fabricCtx(async () => null);
  await fabricHistory(fresh.ctx, { jobs: [] });
  assert.deepEqual(lines(fresh.ui.text()).slice(1), [
    'Asked for: 30 days',
    'Fetched from the audit log: none yet',
    'In the reports: not the full history yet. The first load writes it once every window is fetched.',
    'Start the first load with "valuelens-install run".',
  ]);

  // A first load that failed before it fetched anything: nothing to carry on from.
  const none = fabricCtx(async () => null);
  none.config.firstRun = { jobId: 'job-1', status: 'Failed', startedAt: '2026-06-01T08:00:00.000Z' };
  await fabricHistory(none.ctx, { jobs: [{ id: 'job-1', status: 'Failed', startTimeUtc: '2026-06-01T08:00:00' }] });
  assert.deepEqual(lines(none.ui.text()).slice(2), [
    'Fetched from the audit log: none yet',
    'In the reports: not the full history yet. The first load writes it once every window is fetched.',
    'To load it, run "valuelens-install run".',
  ]);

  const empty = fabricCtx(async () => null);
  empty.config.firstRun = { jobId: 'job-1', status: 'Completed', startedAt: '2026-05-01T08:00:00.000Z' };
  await fabricHistory(empty.ctx, { jobs: [], summary: { tables: { audit: { rows: 0 } } } });
  assert.match(empty.ui.text(), /In the reports: no Copilot activity, at the last data check/);
});

test('fabricHistory: a first load waiting for consent points to its step', async () => {
  const { ctx, config, ui } = fabricCtx(async () => null);
  config.history.pending = { days: 30, reason: 'consent', at: '2026-06-01T11:00:00.000Z', first: true };
  await fabricHistory(ctx, { jobs: [] });
  const out = lines(ui.text());
  assert.equal(out[1], 'Asked for: 30 days, waiting to start (see the step below)');
  assert.doesNotMatch(ui.text(), /Start the first load|To carry on/, 'the step has the command');
});

/**
 * A run job execution.
 * @param {string} status @param {string} startTime @param {string[]} [args]
 */
const exec = (status, startTime, args = ['run']) => ({ name: `vlens-run-${startTime.slice(11, 13)}`, properties: { status, startTime, template: { containers: [{ name: 'run', args }] } } });

const AZ_WINDOWS = plan(t('2026-05-02T00:00:00'), t('2026-06-01T02:00:00'), 8);

test('azureHistory: published history is in the reports up to the high-water mark', async () => {
  const state = { high_water_mark: '2026-06-01T01:58:00+00:00', windows: entries(AZ_WINDOWS.slice(-3), () => 'succeeded') };
  const { ctx, ui } = azureCtx(async () => JSON.stringify(state));
  await azureHistory(ctx, { executions: [exec('Succeeded', '2026-06-01T02:00:00+00:00')] });
  assert.deepEqual(lines(ui.text()), ['Audit history', 'Asked for: 30 days', '✓ In the reports: activity up to 2026-06-01']);
});

test('azureHistory: a reload part-way through is not in the reports yet', async () => {
  const windows = plan(t('2026-03-03T00:00:00'), t('2026-06-01T02:00:00'), 8);
  assert.equal(windows.length, 271);
  const state = {
    high_water_mark: '2026-05-31T23:59:00+00:00',
    backfill_from: '2026-03-03T00:00:00+00:00',
    windows: entries(windows, (i) => (i < 135 ? 'succeeded' : i === 135 ? 'querying' : undefined)),
  };
  const { ctx, az, ui } = azureCtx(async () => JSON.stringify(state), { days: 90 });
  az.status = { lastRun: { name: 'vlens-run-02', status: 'Failed', finishedAt: '2026-06-01T06:00:00.000Z' } };
  await azureHistory(ctx, { executions: [exec('Failed', '2026-06-01T02:00:00+00:00')] });
  assert.deepEqual(lines(ui.text()), [
    'Audit history',
    'Asked for: 90 days',
    "In the reports: activity up to 2026-05-31. The reload from 2026-03-03 isn't all in them yet.",
    'Fetched from the audit log: about 45 of 90 days, 2026-03-03 to 2026-04-17; about 135 windows left',
    'The next scheduled run carries on where it stopped, or start one now with "valuelens-install run".',
  ]);
});

test('azureHistory: a first load with nothing published says what is fetched, not that it is loaded', async () => {
  const partial = { windows: entries(AZ_WINDOWS, (i) => (i < 60 ? 'succeeded' : i === 60 ? 'querying' : undefined)) };
  const cut = azureCtx(async () => JSON.stringify(partial));
  await azureHistory(cut.ctx, { executions: [exec('Failed', '2026-06-01T02:00:00+00:00')] });
  assert.deepEqual(lines(cut.ui.text()).slice(2), [
    'Fetched from the audit log: about 20 of 30 days, 2026-05-02 to 2026-05-22; about 30 windows left',
    'In the reports: not all of it yet',
    'The next scheduled run carries on where it stopped, or start one now with "valuelens-install run".',
  ]);

  // A run of only some steps loads no history: it is neither going nor where the history ends.
  const steps = azureCtx(async () => JSON.stringify(partial));
  await azureHistory(steps.ctx, { executions: [exec('Running', '2026-06-01T11:30:00+00:00', ['run', '--steps', 'access']), exec('Failed', '2026-06-01T02:00:00+00:00')] });
  assert.equal(steps.ui.text(), cut.ui.text());

  const fetched = azureCtx(async () => JSON.stringify({ windows: entries(AZ_WINDOWS, () => 'succeeded') }));
  await azureHistory(fetched.ctx, { executions: [exec('Failed', '2026-06-01T02:00:00+00:00')] });
  assert.deepEqual(lines(fetched.ui.text()).slice(2), [
    'Fetched from the audit log: all 30 days, 2026-05-02 to 2026-06-01',
    'In the reports: not all of it yet',
    'The next run publishes it. Start one sooner with "valuelens-install run".',
  ]);

  const going = azureCtx(async () => null);
  /** @type {any} */ (going.az).status = { lastRun: { name: 'vlens-run-11', status: 'Running', startedAt: '2026-06-01T11:00:00.000Z' } };
  await azureHistory(going.ctx, { executions: [exec('Running', '2026-06-01T11:00:00+00:00')] });
  assert.deepEqual(lines(going.ui.text()).slice(2), [
    'Fetched from the audit log: none yet',
    'In the reports: none of it yet',
    'A run is going now. What it fetches reaches the reports when it publishes, near the end of the run.',
  ]);

  // A run that started over a day ago is stuck, not going.
  const stuck = azureCtx(async () => JSON.stringify({ windows: {} }));
  await azureHistory(stuck.ctx, { executions: [exec('Running', '2026-05-30T11:00:00+00:00')] });
  assert.match(stuck.ui.text(), /The next scheduled run starts loading it, or start one now with "valuelens-install run"\./);
  assert.doesNotMatch(`${cut.ui.text()}${fetched.ui.text()}${going.ui.text()}`, /loaded now|activity up to/);
});

test('azureHistory: windows that all came back empty mean no activity, not a load still to come', async () => {
  const { ctx, ui } = azureCtx(async () => JSON.stringify({ windows: entries(AZ_WINDOWS, () => 'succeeded', 0) }));
  await azureHistory(ctx, { executions: [exec('Succeeded', '2026-06-01T02:00:00+00:00')] });
  assert.deepEqual(lines(ui.text()).slice(2), [
    'Fetched from the audit log: all 30 days, with no Copilot activity in them',
    'In the reports: no Copilot activity, because the audit log returned none for those days',
  ]);
});

/**
 * Window entries as 0.6.9's job image writes them: a merged window has `merged_at`, and a paused one its query
 * and when it paused.
 * @param {Record<string, any>} e
 */
const asJob = (e) =>
  Object.fromEntries(
    Object.entries(e).map(([key, v]) => [
      key,
      v.status === 'succeeded'
        ? { ...v, merged_at: '2026-06-01T05:20:00+00:00' }
        : v.status === 'paused'
          ? { ...v, query_id: `q-${key}`, query_created_at: '2026-06-01T04:40:00+00:00', paused_at: '2026-06-01T05:00:00+00:00', files: [], pages: 0, rows: 0 }
          : v,
    ]),
  );
const PAUSED_NOTE =
  'The last run reached its time limit on 2026-06-01 and published what it had loaded. The next scheduled run carries on with the rest, or start one now with "valuelens-install run".';

/**
 * What 0.6.9's run job records once a publish has carried a process step that saw `state`'s position (SEEN in
 * its collector).
 * @param {Record<string, any>} state
 */
const record = (state) => ({
  ...Object.fromEntries(['high_water_mark', 'pending_high_water_mark', 'loaded_back_to', 'backfill_from'].filter((k) => state[k] != null).map((k) => [k, state[k]])),
  process_started_at: '2026-06-01T05:25:00+00:00',
  published_at: '2026-06-01T05:40:00+00:00',
});
/**
 * A 0.6.9 state whose last publish carried everything it has merged.
 * @template {Record<string, any>} T
 * @param {T} state
 */
const allPublished = (state) => ({ ...state, published: record(state) });
const UNPUBLISHED_NOTE = 'The run that loaded it stopped before publishing. The next scheduled run publishes it, or start one now with "valuelens-install run".';
const GOING_NOTE = 'A run is going now. What has loaded reaches the reports when that run publishes, near its end.';

test('azureHistory: a first load that stopped at its time limit has its newest weeks in the reports, and the next run carries on', async () => {
  // Newest first: the newest 30 windows merged, the next one paused at the time budget, and the rest not started.
  assert.equal(AZ_WINDOWS.length, 91);
  const state = allPublished({
    windows: asJob(entries(AZ_WINDOWS, (i) => (i > 60 ? 'succeeded' : i === 60 ? 'paused' : undefined))),
    pending_high_water_mark: '2026-06-01T01:58:00+00:00',
    loaded_back_to: '2026-05-22T08:00:00+00:00',
    windows_left: 61,
    paused_at: '2026-06-01T05:00:00+00:00',
  });
  const paused = azureCtx(async () => JSON.stringify(state));
  await azureHistory(paused.ctx, { executions: [exec('Succeeded', '2026-06-01T02:00:00+00:00')] });
  assert.deepEqual(lines(paused.ui.text()).slice(1), [
    'Asked for: 30 days',
    'Fetched from the audit log: about 10 of 30 days; 61 windows left',
    'In the reports: activity back to 2026-05-22 so far, newest first',
    PAUSED_NOTE,
  ]);

  // The next run is going: its entries move on, so what's left is the estimate, and it publishes at its end.
  const going = azureCtx(async () => JSON.stringify(state));
  await azureHistory(going.ctx, { executions: [exec('Running', '2026-06-01T11:00:00+00:00'), exec('Succeeded', '2026-06-01T02:00:00+00:00')] });
  assert.deepEqual(lines(going.ui.text()).slice(2), [
    'Fetched from the audit log: about 10 of 30 days; about 61 windows left',
    'In the reports: activity back to 2026-05-22 so far, newest first',
    'A run is going now. It publishes what it has loaded when it finishes or reaches its time limit, and the next run carries on with any windows left.',
  ]);

  // The time limit came before any window had merged: the newest window's query was still waiting.
  const none = azureCtx(async () =>
    JSON.stringify(allPublished({ windows: asJob(entries(AZ_WINDOWS, (i) => (i === 90 ? 'paused' : undefined))), loaded_back_to: null, windows_left: 91, paused_at: '2026-06-01T05:00:00+00:00' })),
  );
  await azureHistory(none.ctx, { executions: [exec('Succeeded', '2026-06-01T02:00:00+00:00')] });
  assert.deepEqual(lines(none.ui.text()).slice(2), [
    'Fetched from the audit log: none yet; 91 windows left',
    'In the reports: none of it yet',
    'The last run reached its time limit on 2026-06-01 before any of it had loaded. The next scheduled run carries on, or start one now with "valuelens-install run".',
  ]);
  assert.doesNotMatch(`${paused.ui.text()}${going.ui.text()}${none.ui.text()}`, /activity up to|loaded now|4 hours|publishes nothing/);
});

test('azureHistory: a reload that stopped at its time limit says how far back the reports have it', async () => {
  const windows = plan(t('2026-03-03T00:00:00'), t('2026-06-01T02:00:00'), 8);
  const state = allPublished({
    high_water_mark: '2026-05-31T23:59:00+00:00',
    backfill_from: '2026-03-03T00:00:00+00:00',
    windows: asJob(entries(windows, (i) => (i > 135 ? 'succeeded' : i === 135 ? 'paused' : undefined))),
    loaded_back_to: '2026-04-17T08:00:00+00:00',
    windows_left: 136,
    paused_at: '2026-06-01T05:00:00+00:00',
  });
  const { ctx, ui } = azureCtx(async () => JSON.stringify(state), { days: 90 });
  await azureHistory(ctx, { executions: [exec('Succeeded', '2026-06-01T02:00:00+00:00')] });
  assert.deepEqual(lines(ui.text()), [
    'Audit history',
    'Asked for: 90 days',
    "In the reports: activity up to 2026-05-31. The reload from 2026-03-03 isn't all in them yet. They have it back to 2026-04-17 so far, newest first.",
    'Fetched from the audit log: about 45 of 90 days; 136 windows left',
    PAUSED_NOTE,
  ]);

  // The last run loaded further back, and stopped before it published that.
  const behind = azureCtx(async () => JSON.stringify({ ...state, published: record({ ...state, loaded_back_to: '2026-05-02T08:00:00+00:00' }) }), { days: 90 });
  await azureHistory(behind.ctx, { executions: [exec('Failed', '2026-06-01T02:00:00+00:00')] });
  assert.deepEqual(lines(behind.ui.text()).slice(2), [
    "In the reports: activity up to 2026-05-31. The reload from 2026-03-03 isn't all in them yet. They have it back to 2026-05-02 so far, newest first.",
    'Loaded: the reload back to 2026-04-17 so far, newest first',
    'Fetched from the audit log: about 45 of 90 days; 136 windows left',
    'The last run reached its time limit on 2026-06-01 and stopped before publishing what it had loaded. The next scheduled run publishes it and carries on with the rest, or start one now with "valuelens-install run".',
  ]);

  // The last publish came before the reload was asked for: the reports have the history up to the high-water mark.
  const before = azureCtx(async () => JSON.stringify({ ...state, published: record({ high_water_mark: state.high_water_mark }) }), { days: 90 });
  await azureHistory(before.ctx, { executions: [exec('Failed', '2026-06-01T02:00:00+00:00')] });
  assert.deepEqual(lines(before.ui.text()).slice(2, 4), [
    "In the reports: activity up to 2026-05-31. The reload from 2026-03-03 isn't all in them yet.",
    'Loaded: the reload back to 2026-04-17 so far, newest first',
  ]);
});

test('azureHistory: a scheduled run that stopped at its time limit leaves its windows for the next', async () => {
  // The high-water mark holds until every window has merged, so the reports have at least that.
  const state = allPublished({
    high_water_mark: '2026-05-30T23:58:00+00:00',
    windows: asJob(entries(AZ_WINDOWS, (i) => (i > 87 ? 'succeeded' : i === 87 ? 'paused' : undefined))),
    pending_high_water_mark: '2026-06-01T01:58:00+00:00',
    loaded_back_to: '2026-05-31T08:00:00+00:00',
    windows_left: 4,
    paused_at: '2026-06-01T05:00:00+00:00',
  });
  const stopped = azureCtx(async () => JSON.stringify(state));
  await azureHistory(stopped.ctx, { executions: [exec('Succeeded', '2026-06-01T02:00:00+00:00')] });
  assert.deepEqual(lines(stopped.ui.text()).slice(2), [
    '✓ In the reports: activity up to 2026-05-30',
    'The last run reached its time limit on 2026-06-01 with 4 windows left. The next scheduled run carries on with them, or start one now with "valuelens-install run".',
  ]);
  const going = azureCtx(async () => JSON.stringify(state));
  await azureHistory(going.ctx, { executions: [exec('Running', '2026-06-01T11:00:00+00:00')] });
  assert.deepEqual(lines(going.ui.text()).slice(2), ['✓ In the reports: activity up to 2026-05-30', 'A run is going now, and carries on with the 4 windows the last run left.']);

  // A failed window, with none paused, isn't a time limit: the run is listed as failed, and the next one retries it.
  const { paused_at: _, ...failed } = state;
  const retry = azureCtx(async () => JSON.stringify({ ...failed, windows_left: 1 }));
  await azureHistory(retry.ctx, { executions: [exec('Failed', '2026-06-01T02:00:00+00:00')] });
  assert.deepEqual(lines(retry.ui.text()).slice(2), ['✓ In the reports: activity up to 2026-05-30']);

  // A reload waiting to start has its own step.
  const waiting = azureCtx(async () => JSON.stringify(state));
  waiting.config.history.pending = { days: 90, reason: 'running', at: '2026-06-01T11:00:00.000Z' };
  await azureHistory(waiting.ctx, { executions: [] });
  assert.deepEqual(lines(waiting.ui.text()).slice(2), ['✓ In the reports: activity up to 2026-05-30']);

  // The run stopped before it published what it had loaded, and then the next run is going.
  const unpublished = { ...state, published: record({ high_water_mark: state.high_water_mark }) };
  const stuck = azureCtx(async () => JSON.stringify(unpublished));
  await azureHistory(stuck.ctx, { executions: [exec('Failed', '2026-06-01T02:00:00+00:00')] });
  assert.deepEqual(lines(stuck.ui.text()).slice(2), [
    '✓ In the reports: activity up to 2026-05-30',
    'Loaded: activity up to 2026-06-01',
    'The last run reached its time limit on 2026-06-01 with 4 windows left, and stopped before publishing what it had loaded. The next scheduled run publishes it and carries on with them, or start one now with "valuelens-install run".',
  ]);
  const next = azureCtx(async () => JSON.stringify(unpublished));
  await azureHistory(next.ctx, { executions: [exec('Running', '2026-06-01T11:00:00+00:00')] });
  assert.deepEqual(lines(next.ui.text()).slice(2), [
    '✓ In the reports: activity up to 2026-05-30',
    'Loaded: activity up to 2026-06-01',
    'A run is going now. What has loaded reaches the reports when that run publishes, near its end, and the next run carries on with any windows left.',
  ]);
});

test('azureHistory: a first load that has merged every window is in the reports once a run has published it', async () => {
  // The run that merged the last windows is processing and publishing them. The run before stopped at its time
  // limit, and published the newest windows, back to 2026-05-12.
  const state = {
    high_water_mark: '2026-06-01T01:58:00+00:00',
    windows: asJob(entries(AZ_WINDOWS, () => 'succeeded')),
    last_merge_to_publish_s: 1260.5,
    published: record({ pending_high_water_mark: '2026-05-31T01:58:00+00:00', loaded_back_to: '2026-05-12T00:00:00+00:00' }),
  };
  const going = azureCtx(async () => JSON.stringify(state));
  await azureHistory(going.ctx, { executions: [exec('Running', '2026-06-01T02:00:00+00:00'), exec('Succeeded', '2026-05-31T02:00:00+00:00')] });
  assert.deepEqual(lines(going.ui.text()).slice(1), [
    'Asked for: 30 days',
    'In the reports: activity back to 2026-05-12 so far, newest first',
    'Loaded: all the history asked for, up to 2026-06-01',
    GOING_NOTE,
  ]);

  // It stopped before it published: at its hard deadline, or its process or publish step failed.
  const stopped = azureCtx(async () => JSON.stringify(state));
  await azureHistory(stopped.ctx, { executions: [exec('Failed', '2026-06-01T02:00:00+00:00'), exec('Succeeded', '2026-05-31T02:00:00+00:00')] });
  assert.deepEqual(lines(stopped.ui.text()).slice(2), [
    'In the reports: activity back to 2026-05-12 so far, newest first',
    'Loaded: all the history asked for, up to 2026-06-01',
    UNPUBLISHED_NOTE,
  ]);

  // A first load that fitted in one run: none of it is in the reports until that run publishes.
  const first = azureCtx(async () => JSON.stringify({ ...state, published: {} }));
  await azureHistory(first.ctx, { executions: [exec('Running', '2026-06-01T02:00:00+00:00')] });
  assert.deepEqual(lines(first.ui.text()).slice(2), ['In the reports: none of it yet', 'Loaded: all the history asked for, up to 2026-06-01', GOING_NOTE]);
  assert.doesNotMatch(`${going.ui.text()}${stopped.ui.text()}${first.ui.text()}`, /✓/);

  const done = azureCtx(async () => JSON.stringify(allPublished(state)));
  await azureHistory(done.ctx, { executions: [exec('Succeeded', '2026-06-01T02:00:00+00:00')] });
  assert.deepEqual(lines(done.ui.text()).slice(2), ['✓ In the reports: activity up to 2026-06-01']);
});

test('azureHistory: the newest activity a run has merged is in the reports once a run publishes it', async () => {
  const yesterday = { high_water_mark: '2026-05-31T01:57:00+00:00' };
  const state = {
    high_water_mark: '2026-06-01T01:58:00+00:00',
    windows: asJob(entries(AZ_WINDOWS.slice(-6), () => 'succeeded')),
    published: record(yesterday),
  };
  // Between the run's merge and the end of its publish.
  const going = azureCtx(async () => JSON.stringify(state));
  await azureHistory(going.ctx, { executions: [exec('Running', '2026-06-01T02:00:00+00:00'), exec('Succeeded', '2026-05-31T02:00:00+00:00')] });
  const goingLines = ['✓ In the reports: activity up to 2026-05-31', 'Loaded: activity up to 2026-06-01', GOING_NOTE];
  assert.deepEqual(lines(going.ui.text()).slice(2), goingLines);

  // A run with a collector error fails after it has published, so what it merged is in the reports.
  const failed = azureCtx(async () => JSON.stringify(allPublished(state)));
  await azureHistory(failed.ctx, { executions: [exec('Failed', '2026-06-01T02:00:00+00:00')] });
  assert.deepEqual(lines(failed.ui.text()).slice(2), ['✓ In the reports: activity up to 2026-06-01']);

  // One stopped at its hard deadline before it published, or whose process or publish step failed, didn't publish.
  const stopped = azureCtx(async () => JSON.stringify(state));
  await azureHistory(stopped.ctx, { executions: [exec('Failed', '2026-06-01T02:00:00+00:00')] });
  assert.deepEqual(lines(stopped.ui.text()).slice(2), ['✓ In the reports: activity up to 2026-05-31', 'Loaded: activity up to 2026-06-01', UNPUBLISHED_NOTE]);

  // Overlapping runs: one whose process step started before the other merged has published since. Its publish
  // carried only what had merged by then, and the other run, still going, publishes the rest.
  const overlap = azureCtx(async () =>
    JSON.stringify({ ...state, published: { high_water_mark: '2026-05-31T23:58:00+00:00', process_started_at: '2026-06-01T01:00:00+00:00', published_at: '2026-06-01T05:40:00+00:00' } }),
  );
  await azureHistory(overlap.ctx, { executions: [exec('Running', '2026-06-01T02:00:00+00:00'), exec('Succeeded', '2026-06-01T00:30:00+00:00')] });
  assert.deepEqual(lines(overlap.ui.text()).slice(2), goingLines);
});

test("azureHistory: an older job image's state reads as before 0.6.9, and a 0.6.9 load merged but never published doesn't", async () => {
  // An older image kept no record of what its runs published, and its runs published only once they had merged it all.
  const older = { high_water_mark: '2026-06-01T01:58:00+00:00', windows: entries(AZ_WINDOWS.slice(-3), () => 'succeeded') };
  const before = azureCtx(async () => JSON.stringify(older));
  await azureHistory(before.ctx, { executions: [exec('Running', '2026-06-01T11:00:00+00:00')] });
  assert.deepEqual(lines(before.ui.text()).slice(2), ['✓ In the reports: activity up to 2026-06-01']);

  // The first 0.6.9 run counts what the older image had merged as published, before it fetches anything.
  const seeded = azureCtx(async () => JSON.stringify({ ...older, published: { high_water_mark: older.high_water_mark } }));
  await azureHistory(seeded.ctx, { executions: [exec('Running', '2026-06-01T11:00:00+00:00')] });
  assert.equal(seeded.ui.text(), before.ui.text());

  // 0.6.9 merged the same windows, and no run has published them yet: with the job's empty record, or none.
  const merged = { ...older, windows: asJob(older.windows) };
  for (const state of [{ ...merged, published: {} }, merged]) {
    const { ctx, ui } = azureCtx(async () => JSON.stringify(state));
    await azureHistory(ctx, { executions: [exec('Running', '2026-06-01T11:00:00+00:00')] });
    assert.deepEqual(lines(ui.text()).slice(2), ['In the reports: none of it yet', 'Loaded: all the history asked for, up to 2026-06-01', GOING_NOTE], JSON.stringify(Object.keys(state)));
  }

  // A first load part-way through, merged by 0.6.9 and never published.
  const paused = {
    windows: asJob(entries(AZ_WINDOWS, (i) => (i > 60 ? 'succeeded' : i === 60 ? 'paused' : undefined))),
    pending_high_water_mark: '2026-06-01T01:58:00+00:00',
    loaded_back_to: '2026-05-22T08:00:00+00:00',
    windows_left: 61,
    paused_at: '2026-06-01T05:00:00+00:00',
  };
  for (const state of [{ ...paused, published: {} }, paused]) {
    const { ctx, ui } = azureCtx(async () => JSON.stringify(state));
    await azureHistory(ctx, { executions: [exec('Failed', '2026-06-01T02:00:00+00:00')] });
    assert.deepEqual(lines(ui.text()).slice(2), [
      'Fetched from the audit log: about 10 of 30 days; 61 windows left',
      'In the reports: none of it yet',
      'Loaded: activity back to 2026-05-22 so far, newest first',
      'The last run reached its time limit on 2026-06-01 and stopped before publishing what it had loaded. The next scheduled run publishes it and carries on with the rest, or start one now with "valuelens-install run".',
    ], JSON.stringify(Object.keys(state)));
  }
});

test('azureHistory: when the state cannot be read, it falls back to the runs, and never fails', async () => {
  const priv = azureCtx(async () => assert.fail('a private install is not read'));
  priv.az.publicNetworkAccess = false;
  await azureHistory(priv.ctx, { executions: [] });
  assert.deepEqual(lines(priv.ui.text()).slice(1), [
    'Asked for: 30 days',
    "How much has loaded can't be read from this PC: it's a private install, so its storage can't be reached from outside its network.",
    "The reports fill in as the run job's runs publish, and have the history asked for once those runs have loaded all of it. The runs are listed above.",
  ]);

  for (const [err, reason] of /** @type {[Error, RegExp][]} */ ([
    [httpError(403, 'AuthorizationPermissionMismatch'), /your account can't read the job's storage\./],
    [new Error('fetch failed'), /the job's storage couldn't be reached just now\./],
  ])) {
    const { ctx, ui } = azureCtx(() => Promise.reject(err));
    await azureHistory(ctx, { executions: [exec('Failed', '2026-06-01T02:00:00+00:00')] });
    assert.match(ui.text(), reason);
    assert.doesNotMatch(ui.text(), /loaded now|activity up to|Fetched from/);
  }

  const sample = azureCtx(async () => assert.fail('not read'));
  sample.az.sampleData = true;
  await azureHistory(sample.ctx, {});
  const notDeployed = azureCtx(async () => assert.fail('not read'));
  delete notDeployed.az.outputs.runJobName;
  await azureHistory(notDeployed.ctx, {});
  assert.equal(`${sample.ui.text()}${notDeployed.ui.text()}`, '', 'sample data and an install with no run job have no history to load');
});

test('azureHistory: a reload waiting to start points to its step', async () => {
  const { ctx, config, ui } = azureCtx(async () => JSON.stringify({ high_water_mark: '2026-06-01T01:58:00+00:00' }));
  config.history.pending = { days: 90, reason: 'running', at: '2026-06-01T11:00:00.000Z' };
  await azureHistory(ctx, { executions: [] });
  assert.deepEqual(lines(ui.text()).slice(1), ['Asked for: 30 days, and a reload of 90 days waiting to start (see the step below)', '✓ In the reports: activity up to 2026-06-01']);
});

test('pendingHistory: a load waiting to start, until a run with it starts', () => {
  const config = emptyConfig();
  assert.equal(pendingHistory(config), undefined);
  config.history.pending = { days: 90, reason: 'running', at: '2026-06-01T11:00:00.000Z' };
  assert.equal(pendingHistory(config)?.days, 90);
  config.history.days = 90;
  assert.equal(pendingHistory(config), undefined, 'a reload that started raised the days asked for');
  config.history.days = 180;
  assert.equal(pendingHistory(config), undefined);

  config.history = { days: 30, pending: { days: 30, reason: 'consent', at: '2026-06-01T11:00:00.000Z', first: true } };
  assert.equal(pendingHistory(config)?.reason, 'consent');
  config.firstRun = { jobId: 'job-0', status: 'Failed', startedAt: '2026-05-01T08:00:00.000Z' };
  assert.equal(pendingHistory(config)?.reason, 'consent', 'an earlier first load');
  config.firstRun = { jobId: 'job-1', status: 'InProgress', startedAt: '2026-06-01T11:30:00.000Z' };
  assert.equal(pendingHistory(config), undefined, 'a first load started since, by any installer');

  const azure = emptyConfig();
  azure.target = 'azure';
  azure.history.pending = { days: 30, reason: 'failed', at: '2026-06-01T11:00:00.000Z', first: true };
  assert.ok(pendingHistory(azure));
  /** @type {any} */ (azure.azure).status = { lastRun: { name: 'r', status: 'Succeeded', finishedAt: '2026-06-01T11:45:00.000Z' } };
  assert.equal(pendingHistory(azure), undefined, 'a waited run keeps only when it finished');

  for (const pending of [{ days: 0 }, { days: 'x' }, 'soon', null]) {
    config.history = { days: 30, pending: /** @type {any} */ (pending) };
    assert.equal(pendingHistory(config), undefined, JSON.stringify(pending));
  }
});

test('recordPendingHistory and clearPendingHistory: kept in the record until a run covers it', () => {
  const { ctx, config, saves } = fakeCtx();
  recordPendingHistory(ctx, { days: 0, reason: 'failed' });
  recordPendingHistory(ctx, { days: undefined, reason: 'failed' });
  assert.equal(config.history.pending, undefined);
  assert.equal(saves(), 0);

  recordPendingHistory(ctx, { days: 30, reason: 'consent', first: true });
  assert.deepEqual(config.history.pending, { days: 30, reason: 'consent', at: '2026-06-01T12:00:00.000Z', first: true });
  assert.equal(saves(), 1);
  recordPendingHistory(ctx, { days: 20, reason: 'keyVault' });
  assert.deepEqual(config.history.pending, { days: 30, reason: 'keyVault', at: '2026-06-01T12:00:00.000Z', first: true }, 'keeps the bigger load, and that it is the first');

  clearPendingHistory(ctx, { days: 7 });
  assert.ok(config.history.pending, 'a run with less history');
  assert.equal(saves(), 2);
  clearPendingHistory(ctx, { first: true });
  assert.equal(config.history.pending, undefined, 'the first load');
  assert.equal(saves(), 3);

  recordPendingHistory(ctx, { days: 90, reason: 'running' });
  clearPendingHistory(ctx, { first: true });
  assert.ok(config.history.pending, 'a first load is not a reload');
  clearPendingHistory(ctx, { days: 180 });
  assert.equal(config.history.pending, undefined);
  const before = saves();
  clearPendingHistory(ctx, { days: 180 });
  assert.equal(saves(), before, 'nothing to clear');
});

test('historyStep: what stopped the load, and the commands that already exist', () => {
  const { config } = fakeCtx();
  const user = { tenantId: 'tenant-1' };
  assert.equal(historyStep(config, user), null);

  config.history.pending = { days: 30, reason: 'consent', at: '2026-06-01T11:00:00.000Z', first: true };
  assert.deepEqual(historyStep(config, user), {
    id: 'load-history',
    title: 'Load 30 days of audit history',
    why: "The first load didn't start, because the data collector app's permissions haven't been approved yet. Until it runs, the reports don't have the history.",
    who: 'You',
    link: apiPermissionsUrl('app-1'),
    linkText: "The app's API permissions in Entra",
    steps: [
      'Ask a Global Administrator or Privileged Role Administrator to open the link and select "Grant admin consent", or to use https://login.microsoftonline.com/tenant-1/adminconsent?client_id=app-1.',
      'Run "valuelens-install run --backfill-days 30".',
      'See how far it has got with "valuelens-install status".',
    ],
  });

  config.keyVault.name = 'kv-test';
  config.keyVault.id = '/subscriptions/sub-1/resourceGroups/rg-vlens/providers/Microsoft.KeyVault/vaults/kv-test';
  config.history.pending = { days: 90, reason: 'keyVault', at: '2026-06-01T11:00:00.000Z' };
  const vault = historyStep(config, user);
  assert.equal(vault?.title, 'Load 90 days of audit history');
  assert.equal(vault?.why, "The reload of 90 days didn't start, because the private endpoint to kv-test hasn't been approved yet. Until it runs, the reports keep the history they have.");
  assert.equal(vault?.link, `https://portal.azure.com/#@tenant-1/resource${config.keyVault.id}/networking`);
  assert.deepEqual(vault?.steps, [
    'Ask someone who manages kv-test to approve the private endpoint, under Networking, Private endpoint connections.',
    'Run "valuelens-install run --backfill-days 90".',
    'See how far it has got with "valuelens-install status".',
  ]);

  config.history.pending = { days: 90, reason: 'running', at: '2026-06-01T11:00:00.000Z' };
  assert.equal(historyStep(config, user)?.steps?.[0], 'Wait for the run that\'s going to finish. "valuelens-install status" shows it.');
  config.history.pending = { days: 90, reason: 'failed', at: '2026-06-01T11:00:00.000Z' };
  const failed = historyStep(config, user);
  assert.equal(failed?.why, "The reload of 90 days didn't start. Until it runs, the reports keep the history they have.");
  assert.equal(failed?.steps?.length, 2);

  delete config.app.appId;
  config.history.pending = { days: 30, reason: 'consent', at: '2026-06-01T11:00:00.000Z', first: true };
  const noApp = historyStep(config, {});
  assert.equal(noApp?.link, undefined);
  assert.equal(noApp?.steps?.[0], 'Ask a Global Administrator or Privileged Role Administrator to grant admin consent to the data collector app.');
});

test('showHistoryStep: the step, in the next steps, only while the load is waiting', () => {
  const ui = fakeUi();
  const { ctx, config } = fakeCtx({ ui: ui.ui });
  showHistoryStep(ctx);
  assert.equal(ui.text(), '');
  config.history.pending = { days: 30, reason: 'consent', at: '2026-06-01T11:00:00.000Z', first: true };
  showHistoryStep(ctx);
  assert.match(ui.text(), /1 step left\n {2}1\. Load 30 days of audit history {2}You\n/);
  assert.match(ui.text(), /c\. See how far it has got with "valuelens-install status"\./);
});
