// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildSupportFiles, collectSupport, createRedactor, loadRecord, readRunLog, recordRun, runLogFile, summariseLog,
  supportFileName, supportZip, writeSupportFile, RUN_LOG_RUNS,
} from '../src/support.js';
import { emptyConfig } from '../src/config.js';
import { listZip, readZipEntry, crc32 } from '../src/transform/zip.js';
import { parseCli } from '../src/cli.js';
import { createUi } from '../src/ui.js';

const SALT = Buffer.alloc(16);
const JWT = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLWJ5dGVz';
const CLIENT_SECRET = 'abc8Q~ZyXwVuTsRqPoNmLkJiHgFeDcBa0123456789';
const ACCOUNT_KEY = 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFla0123456789abcdefABCDEF==';
const WS = '11111111-2222-3333-4444-555555555555';

const tmp = () => mkdtempSync(join(tmpdir(), 'support-'));

/** Every file's text, joined, to search for anything that shouldn't be there. */
const allText = (/** @type {{ text: string }[]} */ files) => files.map((f) => f.text).join('\n');

test('redaction removes tokens, secrets, keys and SAS signatures from free text', () => {
  const r = createRedactor({ salt: SALT });
  const out = r.text([
    `Authorization: Bearer ${JWT}`,
    `token ${JWT}`,
    `client secret ${CLIENT_SECRET} is wrong`,
    'https://acct.blob.core.windows.net/c/f.csv?sv=2024-01-01&sig=AbCdEf123%2Bxyz%3D&se=2026-10-27',
    `DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=${ACCOUNT_KEY};EndpointSuffix=core.windows.net`,
    'client_secret=hunter2&grant_type=client_credentials',
    'password: "P@ssw0rd!"',
    `blob ${ACCOUNT_KEY}`,
  ].join('\n'));
  for (const secret of [JWT, CLIENT_SECRET, 'AbCdEf123', ACCOUNT_KEY, 'hunter2', 'P@ssw0rd!']) assert.ok(!out.includes(secret), `${secret} leaked:\n${out}`);
  assert.match(out, /Bearer \[removed\]/);
  assert.match(out, /sig=\[removed\]/);
  assert.match(out, /AccountKey=\[removed\]/);
  assert.match(out, /grant_type=client_credentials/);
  assert.ok(r.counts.secrets >= 7);
});

test('redaction keeps resource paths, GUIDs and ordinary words', () => {
  const r = createRedactor({ salt: SALT });
  const path = `/subscriptions/${WS}/resourceGroups/rg-analytics/providers/Microsoft.App/jobs/valuelens-run-job/executions/valuelens-run-job-abcdefg1234567`;
  const text = `Workspace ${WS} failed at ${path}. HTTP 429 Too Many Requests.`;
  assert.equal(r.text(text), text);
  assert.equal(r.counts.secrets, 0);
});

test('redaction hashes emails, UPNs and names the same way everywhere', () => {
  const r = createRedactor({ salt: SALT });
  const value = {
    user: { upn: 'Ada.Lovelace@Contoso.com', displayName: 'Ada Lovelace' },
    owner: 'grace@contoso.com',
    app: { displayName: 'Analytics Hub' },
    note: 'Ada Lovelace (ada.lovelace@contoso.com) and guest_user_example.com#EXT#@contoso.onmicrosoft.com',
  };
  r.learn(value);
  const out = /** @type {any} */ (r.value(value));
  const ada = r.hash('ada.lovelace@contoso.com');
  assert.match(ada, /^user-[0-9a-f]{10}$/);
  assert.equal(out.user.upn, ada, 'case and spaces don\'t change the token');
  assert.equal(out.user.displayName, r.hash('Ada Lovelace'));
  assert.equal(out.owner, r.hash('grace@contoso.com'));
  assert.equal(out.app.displayName, 'Analytics Hub', 'an app name is not a person');
  assert.ok(out.note.includes(ada));
  assert.ok(out.note.includes(r.hash('Ada Lovelace')));
  const s = JSON.stringify(out);
  for (const leak of ['Ada', 'Lovelace', 'grace', 'contoso.com', '#EXT#']) assert.ok(!s.includes(leak), `${leak} leaked: ${s}`);
});

test('the hash is SHA-256 of the salt and the lower-cased value, cut to 10 hex digits', () => {
  // The notebook's Python copy is checked against the same value in tests/test_support_file_notebook.py.
  assert.equal(createRedactor({ salt: SALT }).hash('  Ada.Lovelace@Contoso.com '),   'user-1a37274c6a');
    assert.notEqual(createRedactor().hash('ada.lovelace@contoso.com'), 'user-1a37274c6a', 'without a salt given, each file has its own');
});

test('values under secret keys are removed, but GUIDs, dates, numbers and booleans stay', () => {
  const r = createRedactor({ salt: SALT });
  const out = /** @type {any} */ (r.value({
    app: { appId: WS, secret: 'xyz', secretExpires: '2027-04-01T00:00:00Z', secretName: 'valuelens-client-secret' },
    keyVault: { name: 'kv-analytics', mode: 'keyvault' },
    sqlReader: { password: 'p', passwordRotated: true, secretExpiry: '2027-01-01' },
    connectionString: 'Server=tcp:x;Password=y',
    tokens: [{ accessToken: 'a' }, 3],
    sasUrl: 'https://x/?sig=1',
  }));
  assert.equal(out.app.appId, WS);
  assert.equal(out.app.secret, '[removed]');
  assert.equal(out.app.secretExpires, '2027-04-01T00:00:00Z');
  assert.equal(out.app.secretName, '[removed]');
  assert.deepEqual(out.keyVault, { name: 'kv-analytics', mode: 'keyvault' });
  assert.equal(out.sqlReader.password, '[removed]');
  assert.equal(out.sqlReader.passwordRotated, true);
  assert.equal(out.sqlReader.secretExpiry, '2027-01-01');
  assert.equal(out.connectionString, '[removed]');
  assert.deepEqual(out.tokens, [{ accessToken: '[removed]' }, 3]);
  assert.equal(out.sasUrl, '[removed]');
});

test('the log summary counts throttling, sign-in errors, time-outs and windows', () => {
  const s = summariseLog([
    'window 1 of 12 ok',
    'window 2 of 12: HTTP 429 Too Many Requests, retrying',
    'window 3/12 throttled',
    'ERROR 401 Unauthorized: AADSTS7000215 invalid client secret',
    'Request timed out after 300s',
    'HTTP 403 Forbidden',
  ].join('\n'));
  assert.equal(s.http429, 3);
  assert.equal(s.http401, 3);
  assert.equal(s.http403, 2);
  assert.equal(s.timeouts, 1);
  assert.equal(s.windows, 3);
  assert.equal(s.lines, 6);
  assert.match(String(s.firstError), /^ERROR 401/);
});

test('the run log records steps, the failed step and the error, without secrets, and keeps the last runs', () => {
  const dir = tmp();
  try {
    const configFile = join(dir, 'valuelens-install.json');
    /** @type {string[]} */
    const out = [];
    const ui = createUi({ write: (s) => out.push(s) });
    const original = ui.fail;
    for (let i = 0; i < RUN_LOG_RUNS + 2; i++) {
      const rec = recordRun(ui, { command: `run${i}`, configFile, version: '9.9.9', now: () => new Date('2026-10-26T10:00:00Z') });
      rec.setUser({ upn: 'ada@contoso.com', displayName: 'Ada Lovelace' });
      ui.step(1, 2, 'Sign in');
      ui.ok('Signed in');
      ui.step(2, 2, 'Load the audit log');
      ui.fail(`Couldn't read the audit log: Bearer ${JWT}`);
      rec.finish(false, new Error(`Graph said 401 with client_secret=${CLIENT_SECRET}`));
      rec.finish(true);
    }
    assert.equal(ui.fail, original, 'finish puts the ui back');
    assert.match(out.join(''), /Load the audit log/, 'the ui still prints');
    const runs = readRunLog(configFile);
    assert.equal(runLogFile(configFile), join(dir, 'valuelens-install.log.json'));
    assert.equal(runs.length, RUN_LOG_RUNS);
    assert.equal(runs[0].command, 'run2');
    const last = runs[RUN_LOG_RUNS - 1];
    assert.equal(last.ok, false, 'a second finish changes nothing');
    assert.equal(last.failedStep, 'Load the audit log');
    assert.deepEqual(last.steps.map((s) => s.title), ['Sign in', 'Load the audit log']);
    const text = readFileSync(runLogFile(configFile), 'utf8');
    assert.ok(!text.includes(JWT) && !text.includes(CLIENT_SECRET));
    assert.match(String(last.error), /client_secret=\[removed\]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A Fabric install record with a pipeline, a notebook, a model and a Lakehouse. */
function fabricRecord() {
  const config = emptyConfig();
  config.tenantId = '99999999-8888-7777-6666-555555555555';
  config.fabric.workspaceId = WS;
  config.fabric.workspaceName = 'Analytics Hub';
  config.fabric.lakehouseId = '22222222-3333-4444-5555-666666666666';
  config.fabric.pipelineId = '33333333-4444-5555-6666-777777777777';
  config.fabric.notebooks = { ...config.fabric.notebooks, auditIngester: '44444444-5555-6666-7777-888888888888' };
  config.semanticModel.id = '55555555-6666-7777-8888-999999999999';
  config.semanticModel.name = 'Analytics Hub Model';
  config.app.appId = '66666666-7777-8888-9999-000000000000';
  /** @type {any} */ (config.app).secret = CLIENT_SECRET;
  return config;
}

function fakeApi() {
  /** @type {string[]} */
  const queries = [];
  const failure = { errorCode: 'NotebookFailed', message: `Audit window 3 of 12: HTTP 429 Too Many Requests for ada@contoso.com; Bearer ${JWT}` };
  return {
    queries,
    api: {
      fabric: {
        listJobs: async (/** @type {string} */ ws, /** @type {string} */ id) => id === fabricRecord().fabric.pipelineId
          ? [
            { id: 'j1', status: 'Completed', startTimeUtc: '2026-10-24T01:00:00', endTimeUtc: '2026-10-24T02:00:00' },
            { id: 'j2', status: 'Failed', startTimeUtc: '2026-10-25T01:00:00', endTimeUtc: '2026-10-25T02:00:00', failureReason: failure },
          ]
          : [{ id: 'n1', status: 'Failed', startTimeUtc: '2026-10-25T01:05:00', failureReason: failure }],
        queryActivityRuns: async () => [
          { activityName: 'Run_Audit_Log_Ingester', status: 'Failed', activityRunStart: '2026-10-25T01:05:00Z', error: { errorCode: '2011', message: 'Timeout: the operation timed out' } },
          { activityName: 'Run_Audit_Log_Ingester', status: 'Failed', activityRunStart: '2026-10-25T01:35:00Z', error: { errorCode: '2011', message: 'Timeout: the operation timed out' } },
        ],
      },
      powerBi: {
        refreshes: async () => [{ status: 'Failed', refreshType: 'ViaApi', startTime: '2026-10-25T02:00:00Z', serviceExceptionJson: '{"errorCode":"ModelRefreshFailed"}' }],
        executeQueries: async (/** @type {string} */ ws, /** @type {string} */ ds, /** @type {string} */ q) => {
          queries.push(q);
          return { results: [{ tables: [{ rows: [
            { '[table]': 'Copilot Interactions', '[id]': 'Copilot Interactions (12)', '[rows]': 0 },
            { '[table]': 'Copilot Interactions', '[id]': 'H$Copilot Interactions (12)$UserId (40)', '[rows]': 999 },
            { '[table]': 'Licensed Users', '[id]': 'Licensed Users (20)', '[rows]': 4200 },
          ] }] }] };
        },
      },
      oneLake: {
        readJson: async () => ({
          checkedAt: '2026-10-25T03:00:00Z',
          tables: { copilot_interactions_curated: { rows: 0 }, copilot_licensed_users: { rows: 4200, sample: [{ upn: 'ada@contoso.com' }] } },
          identity: { licensed: 4200, audit: 0, matched: 0, masked: false },
        }),
      },
    },
  };
}

test('the support file collects a 0-records case and shows it at once, with no data rows or secrets', async () => {
  const dir = tmp();
  try {
    const configFile = join(dir, 'valuelens-install.json');
    const config = fabricRecord();
    writeFileSync(configFile, JSON.stringify(config));
    const { api, queries } = fakeApi();
    const data = await collectSupport({
      config, configFile, recordExists: true, version: '0.6.8', now: new Date('2026-10-26T12:34:56Z'),
      api, user: { upn: 'ada@contoso.com', displayName: 'Ada Lovelace', tenantId: config.tenantId },
      checkPrereqs: async () => [{ id: 'fabric-admin', status: 'missing', detail: 'ada@contoso.com isn\'t a Fabric administrator' }],
    });
    assert.equal(data.signedIn, true);
    assert.equal(data.rowCounts.dataCheck.tables.copilot_interactions_curated.rows, 0);
    assert.equal(data.rowCounts.dataCheck.tables.copilot_licensed_users.sample, undefined, 'only counts, never rows');
    assert.deepEqual(data.rowCounts.models['Analytics Hub Model'], { 'Copilot Interactions': 0, 'Licensed Users': 4200 });
    assert.match(queries[0], /INFO\.STORAGETABLES/);
    assert.equal(data.runs.pipeline.runs[0].id, 'j2', 'newest first');
    assert.deepEqual(data.runs.pipeline.latestActivities[0], { activity: 'Run_Audit_Log_Ingester', status: 'Failed', attempts: 2, start: '2026-10-25T01:35:00Z', end: undefined, error: { code: '2011', message: 'Timeout: the operation timed out' } });
    assert.ok(data.logsSummary.runErrors.http429 >= 2);
    assert.ok(data.logsSummary.runErrors.timeouts >= 1);

    const files = buildSupportFiles(data, { salt: SALT });
    assert.deepEqual(files.map((f) => f.name), ['README.txt', 'manifest.json', 'settings.json', 'last-run.json', 'prereqs.json', 'runs.json', 'row-counts.json', 'logs-summary.json']);
    const text = allText(files);
    for (const leak of [JWT, CLIENT_SECRET, 'ada@contoso.com', 'Ada Lovelace']) assert.ok(!text.includes(leak), `${leak} leaked`);
    assert.ok(text.includes(createRedactor({ salt: SALT }).hash('ada@contoso.com')));
    assert.ok(text.includes(WS), 'IDs stay');
    const manifest = JSON.parse(files[1].text);
    assert.deepEqual(Object.keys(manifest), ['product', 'installerVersion', 'madeBy', 'createdAt', 'route', 'signedIn', 'files', 'redaction']);
    assert.equal(manifest.product, 'Analytics Hub');
    assert.equal(manifest.route, 'fabric');
    assert.equal(manifest.files.length, 7);
    assert.ok(manifest.redaction.counts.secrets > 0 && manifest.redaction.counts.emails > 0);
    assert.equal(JSON.parse(files[2].text).app.secret, '[removed]');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('without a sign-in, each live part says why it is missing', async () => {
  const config = fabricRecord();
  const data = await collectSupport({ config, configFile: join(tmpdir(), 'none', 'valuelens-install.json'), recordExists: true, version: '0.6.8', offline: 'Made with --offline.' });
  assert.equal(data.signedIn, false);
  assert.match(data.runs.notCollected, /--offline/);
  assert.match(data.rowCounts.notCollected, /--offline/);
  assert.match(/** @type {any} */ (data.lastRun).notCollected, /No installer run/);
  assert.match(data.prereqs.notCollected, /--offline/);
});

test('a part that fails is reported, and the rest is still collected', async () => {
  const config = fabricRecord();
  const { api } = fakeApi();
  api.fabric.listJobs = async () => {
    throw new Error('HTTP 403 Forbidden: the caller is not a workspace member');
  };
  const data = await collectSupport({ config, configFile: join(tmpdir(), 'none', 'x.json'), recordExists: true, version: '0.6.8', api });
  assert.match(data.runs.pipeline.notCollected, /403/);
  assert.equal(data.rowCounts.dataCheck.tables.copilot_interactions_curated.rows, 0);
});

test('an unreadable install record is reported in settings', () => {
  const dir = tmp();
  try {
    const file = join(dir, 'valuelens-install.json');
    writeFileSync(file, '{ not json');
    const r = loadRecord(file);
    assert.equal(r.existed, true);
    assert.match(String(r.error), /not valid JSON/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the zip holds exactly the files shown, under the agreed name', () => {
  const dir = tmp();
  try {
    const now = new Date('2026-10-26T09:05:07Z');
    assert.equal(supportFileName(now), 'analyticshub-support-20261026-090507.zip');
    const files = [{ name: 'README.txt', text: 'hello\n' }, { name: 'runs.json', text: '{"ok":true}\n'.repeat(200) }];
    const path = writeSupportFile(files, join(dir, 'out'), now);
    assert.ok(existsSync(path) && path.endsWith('analyticshub-support-20261026-090507.zip'));
    const zip = readFileSync(path);
    assert.deepEqual(zip, supportZip(files, now));
    assert.deepEqual([...listZip(zip).keys()], ['README.txt', 'runs.json']);
    for (const f of files) assert.equal(readZipEntry(zip, f.name).toString('utf8'), f.text);
    assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--support-bundle parses on its own, with --out, --log and --offline', () => {
  const a = parseCli(['--support-bundle', '--offline', '--log', 'a.log', '--log', 'b.log']);
  assert.equal(a.supportBundle, true);
  assert.equal(a.offline, true);
  assert.deepEqual(a.logFiles, ['a.log', 'b.log']);
  assert.equal(a.outDir, '.');
  assert.equal(parseCli(['--support-bundle', '--out', 'x']).outDir, 'x');
  assert.equal(parseCli(['preview']).outDir, 'valuelens-preview');
  assert.throws(() => parseCli(['install', '--support-bundle']), /Leave out the command/);
  assert.throws(() => parseCli(['--ui', '--support-bundle']), /--ui and --support-bundle/);
  assert.throws(() => parseCli(['status', '--offline']), /--offline goes with --support-bundle/);
  assert.throws(() => parseCli(['status', '--log', 'a.log']), /--log goes with --support-bundle/);
});
