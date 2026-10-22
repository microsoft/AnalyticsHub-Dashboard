// @ts-check
/** The audit ingestion checks: the app's own token, the live audit search, and what they say. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCli } from '../src/cli.js';
import { HttpError } from '../src/http.js';
import {
  appSecretFor,
  AUDIT_ROLE,
  checkAppToken,
  checkAuditAccess,
  checkAuditCommand,
  emptyAuditHelp,
  PROBE_POLL_MS,
  PROBE_WAIT_MS,
  probeAuditLog,
  ROLE_RETRY_MS,
  saveAuditCheck,
  SECRET_RETRY_MS,
  TOKEN_ATTEMPTS,
} from '../src/steps/audit-check.js';
import { fakeCtx, fakeUi } from './fakes.js';

/** @param {Record<string, unknown>} claims */
const jwt = (claims) => `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
const GOOD = jwt({ tid: 'tenant-1', roles: [AUDIT_ROLE, 'Reports.Read.All'] });

/**
 * A fake audit API. Each query's status list is read in turn by getQuery; records says how many the query has.
 * @param {{ statuses?: string[][], records?: number[], fail?: Error }} [o]
 */
function fakeAudit(o = {}) {
  /** @type {any[]} */
  const started = [];
  const statuses = (o.statuses ?? []).map((s) => [...s]);
  const records = [...(o.records ?? [])];
  /** @type {Record<string, { statuses: string[], records: number }>} */
  const queries = {};
  const audit = {
    /** @param {any} q */
    startQuery: async (q) => {
      if (o.fail) throw o.fail;
      const id = `q-${started.length + 1}`;
      started.push(q);
      queries[id] = { statuses: statuses.shift() ?? ['succeeded'], records: records.shift() ?? 0 };
      return { id, status: queries[id].statuses.shift() };
    },
    /** @param {string} id */
    getQuery: async (id) => ({ id, status: queries[id].statuses.length > 1 ? queries[id].statuses.shift() : queries[id].statuses[0] }),
    /** @param {string} id */
    firstRecords: async (id) => Array.from({ length: Math.min(1, queries[id].records) }, (_, i) => ({ id: `r-${i}` })),
  };
  return { audit, started };
}

/**
 * @param {{ tokens?: (string | Error)[], audit?: any, answers?: any[], yes?: boolean, config?: any }} [o]
 */
function setup(o = {}) {
  const ui = fakeUi({ answers: o.answers, yes: o.yes });
  const made = fakeCtx({ ui: ui.ui, config: o.config });
  const tokens = [...(o.tokens ?? [GOOD])];
  /** @type {string[]} */
  const used = [];
  made.ctx.api.appGraph = (appId, secret) => ({
    token: async () => {
      used.push(`${appId}:${secret}`);
      const t = tokens.length > 1 ? tokens.shift() : tokens[0];
      if (t instanceof Error) throw t;
      return /** @type {string} */ (t);
    },
    audit: o.audit ?? fakeAudit().audit,
  });
  return { ...made, ui, used };
}

test('checkAppToken: a token for this tenant with AuditLogsQuery.Read.All is ok', async () => {
  const t = setup();
  const r = await checkAppToken(t.ctx, 'app-1', 's3cret');
  assert.equal(r.result, 'ok');
  assert.deepEqual(t.used, ['app-1:s3cret']);
  assert.deepEqual(t.sleeps, []);
});

test('checkAppToken: a token for another tenant is the wrong tenant, whatever its roles', async () => {
  const t = setup({ tokens: [jwt({ tid: 'tenant-2', roles: [AUDIT_ROLE] })] });
  const r = await checkAppToken(t.ctx, 'app-1', 's');
  assert.equal(r.result, 'wrong-tenant');
  assert.match(r.detail ?? '', /tenant-2, not tenant-1/);

  const missing = setup({ tokens: [new Error('AADSTS700016: Application with identifier app-1 was not found in the directory')] });
  assert.equal((await checkAppToken(missing.ctx, 'app-1', 's')).result, 'wrong-tenant');
});

test('checkAppToken: no role is no-role; right after consent it waits for the role to arrive', async () => {
  const none = setup({ tokens: [jwt({ tid: 'tenant-1', roles: ['Reports.Read.All'] })] });
  const r = await checkAppToken(none.ctx, 'app-1', 's');
  assert.equal(r.result, 'no-role');
  assert.deepEqual(r.roles, ['Reports.Read.All']);
  assert.deepEqual(none.sleeps, [], 'no wait when consent isn\'t known to be in place');

  const late = setup({ tokens: [jwt({ tid: 'tenant-1' }), jwt({ tid: 'tenant-1' }), GOOD] });
  assert.equal((await checkAppToken(late.ctx, 'app-1', 's', { waitForRole: true })).result, 'ok');
  assert.deepEqual(late.sleeps, [ROLE_RETRY_MS, ROLE_RETRY_MS]);

  const never = setup({ tokens: [jwt({ tid: 'tenant-1' })] });
  assert.equal((await checkAppToken(never.ctx, 'app-1', 's', { waitForRole: true })).result, 'no-role');
  assert.equal(never.sleeps.length, TOKEN_ATTEMPTS - 1, 'gives up after a few tries');
});

test('checkAppToken: a new secret is retried; one still rejected is a bad secret; an expired one says so', async () => {
  const fresh = setup({ tokens: [new Error('AADSTS7000215: Invalid client secret provided.'), GOOD] });
  assert.equal((await checkAppToken(fresh.ctx, 'app-1', 's')).result, 'ok');
  assert.deepEqual(fresh.sleeps, [SECRET_RETRY_MS]);

  const bad = setup({ tokens: [new Error('AADSTS7000215: Invalid client secret provided.')] });
  const r = await checkAppToken(bad.ctx, 'app-1', 's');
  assert.equal(r.result, 'bad-secret');
  assert.match(r.detail ?? '', /rejected the client secret/);

  const expired = setup({ tokens: [new Error('AADSTS7000222: The provided client secret keys are expired.')] });
  assert.match((await checkAppToken(expired.ctx, 'app-1', 's')).detail ?? '', /expired/);

  const disabled = setup({ tokens: [new Error('AADSTS7000112: Application is disabled.')] });
  assert.equal((await checkAppToken(disabled.ctx, 'app-1', 's')).result, 'refused');

  const other = setup({ tokens: [new Error('getaddrinfo ENOTFOUND login.microsoftonline.com')] });
  assert.equal((await checkAppToken(other.ctx, 'app-1', 's')).result, 'error');
});

test('probeAuditLog: Copilot records found', async () => {
  const { audit, started } = fakeAudit({ statuses: [['notStarted', 'running', 'succeeded']], records: [3] });
  const t = setup({ audit });
  assert.deepEqual(await probeAuditLog(t.ctx, 'app-1', 's'), { result: 'records' });
  assert.equal(started.length, 1);
  assert.deepEqual(started[0].recordTypes, ['copilotInteraction']);
  assert.equal(started[0].end.toISOString(), '2026-06-01T12:00:00.000Z');
  assert.equal(started[0].start.toISOString(), '2026-05-30T12:00:00.000Z');
  assert.deepEqual(t.sleeps, [PROBE_POLL_MS, PROBE_POLL_MS]);
});

test('probeAuditLog: no Copilot records, but other records, is no-copilot; none at all is empty-log', async () => {
  const other = fakeAudit({ records: [0, 5] });
  const a = setup({ audit: other.audit });
  assert.equal((await probeAuditLog(a.ctx, 'app-1', 's')).result, 'no-copilot');
  assert.equal(other.started.length, 2);
  assert.equal(other.started[1].recordTypes, undefined, 'the second search is for any record');

  const empty = setup({ audit: fakeAudit({ records: [0, 0] }).audit });
  assert.equal((await probeAuditLog(empty.ctx, 'app-1', 's')).result, 'empty-log');
});

test('probeAuditLog: a slow search times out, a failed one is an error, a refusal is refused', async () => {
  const slow = setup({ audit: fakeAudit({ statuses: [['running']] }).audit });
  assert.equal((await probeAuditLog(slow.ctx, 'app-1', 's', { maxWaitMs: 3 * PROBE_POLL_MS })).result, 'timeout');
  assert.equal(slow.sleeps.length, 3);
  assert.ok(PROBE_WAIT_MS >= 5 * 60_000, 'waits minutes by default');

  const failed = setup({ audit: fakeAudit({ statuses: [['failed']] }).audit });
  const f = await probeAuditLog(failed.ctx, 'app-1', 's');
  assert.equal(f.result, 'error');
  assert.match(f.detail ?? '', /ended as failed/);

  const err = new HttpError('403 Forbidden', { method: 'POST', url: 'https://graph.microsoft.com/beta/security/auditLog/queries', status: 403 });
  const refused = setup({ audit: fakeAudit({ fail: err }).audit });
  assert.equal((await probeAuditLog(refused.ctx, 'app-1', 's')).result, 'refused');
});

test('appSecretFor: this run\'s secret, else Key Vault, else pasted when asked; never asked with --yes', async () => {
  const t = setup();
  t.ctx.appSecret = 'from-run';
  assert.equal(await appSecretFor(t.ctx), 'from-run');

  const kv = setup();
  kv.config.keyVault.secretName = 'app-secret';
  kv.ctx.api.keyVault = /** @type {any} */ ({ secretValue: async () => 'from-vault' });
  assert.equal(await appSecretFor(kv.ctx), 'from-vault');
  assert.equal(kv.ctx.appSecret, 'from-vault');

  const blocked = setup({ answers: ['  pasted  '] });
  blocked.config.keyVault.secretName = 'app-secret';
  blocked.ctx.api.keyVault = /** @type {any} */ ({ secretValue: async () => { throw new HttpError('403 Forbidden', { method: 'GET', url: 'https://kv', status: 403 }); } });
  assert.equal(await appSecretFor(blocked.ctx), undefined, 'not asked unless the caller asks');
  assert.equal(await appSecretFor(blocked.ctx, { ask: true }), 'pasted');

  const yes = setup({ yes: true });
  yes.ctx.api.keyVault = /** @type {any} */ ({});
  assert.equal(await appSecretFor(yes.ctx, { ask: true }), undefined);
  assert.deepEqual(yes.ui.asked, []);
});

test('checkAuditAccess: during install it checks the token once, says who fixes it, and keeps the finding', async () => {
  const t = setup({ tokens: [jwt({ tid: 'tenant-1' })] });
  t.ctx.appSecret = 's';
  assert.equal(await checkAuditAccess(t.ctx), 'no-role');
  const text = t.ui.text();
  assert.match(text, /The app app-1 can't read the audit log: its token has no AuditLogsQuery\.Read\.All/);
  assert.match(text, /Global Administrator or Privileged Role Administrator selects "Grant admin consent"/);
  assert.match(text, /adminconsent/i);
  assert.equal(t.config.auditCheck?.result, 'no-role');
  assert.equal(t.config.auditCheck?.at, '2026-06-01T12:00:00.000Z');
  assert.equal(t.saves(), 1);
  assert.equal(await checkAuditAccess(t.ctx), undefined, 'once per run');

  const noSecret = setup();
  noSecret.ctx.api.keyVault = /** @type {any} */ ({});
  assert.equal(await checkAuditAccess(noSecret.ctx), undefined, 'no secret to hand: skipped, not asked');
  assert.deepEqual(noSecret.ui.asked, []);

  const azure = setup();
  azure.config.target = 'azure';
  azure.ctx.appSecret = 's';
  assert.equal(await checkAuditAccess(azure.ctx), undefined);
});

test('saveAuditCheck: a passing token check doesn\'t replace an earlier live search\'s finding', () => {
  const t = setup();
  saveAuditCheck(t.ctx, { result: 'empty-log' });
  saveAuditCheck(t.ctx, { result: 'ok' });
  assert.equal(t.config.auditCheck?.result, 'empty-log');
  saveAuditCheck(t.ctx, { result: 'records' });
  assert.equal(t.config.auditCheck?.result, 'records');
  saveAuditCheck(t.ctx, { result: 'no-role', detail: 'x' });
  assert.deepEqual(t.config.auditCheck, { at: '2026-06-01T12:00:00.000Z', result: 'no-role', detail: 'x' });
});

test('checkAuditCommand: token, then the live search; an empty log says how to turn audit logging on', async () => {
  const t = setup({ audit: fakeAudit({ records: [0, 0] }).audit });
  t.ctx.appSecret = 's';
  assert.equal(await checkAuditCommand(t.ctx), 'empty-log');
  const text = t.ui.text();
  assert.match(text, /Audit ingestion check/);
  assert.match(text, /✓ The app app-1 has AuditLogsQuery\.Read\.All in this tenant/);
  assert.match(text, /no records at all in the last day: audit logging is probably off/);
  assert.match(text, /Compliance Administrator[^\n]*Purview > Audit/);
  assert.match(text, /Start recording user and admin activity/);
  assert.equal(t.config.auditCheck?.result, 'empty-log');

  const noRole = setup({ tokens: [jwt({ tid: 'tenant-1' })] });
  noRole.ctx.appSecret = 's';
  assert.equal(await checkAuditCommand(noRole.ctx), 'no-role');
  assert.doesNotMatch(noRole.ui.text(), /test audit search/, 'no search without the role');
});

test('checkAuditCommand: with no secret to hand and --yes, it says how to run it', async () => {
  const t = setup({ yes: true });
  t.ctx.api.keyVault = /** @type {any} */ ({});
  await assert.rejects(checkAuditCommand(t.ctx), /isn't readable from Key Vault here[\s\S]*paste a client secret of app-1/);

  const none = setup();
  none.config.app.appId = undefined;
  await assert.rejects(checkAuditCommand(none.ctx), /no app registration yet/);
});

test('checkAuditCommand: on Azure it reads the managed identity\'s roles from the record', async () => {
  const t = setup();
  t.config.target = 'azure';
  t.config.azure = /** @type {any} */ ({ graphRoles: { assigned: [], pending: [AUDIT_ROLE] } });
  assert.equal(await checkAuditCommand(t.ctx), 'no-role');
  assert.match(t.ui.text(), /managed identity doesn't have AuditLogsQuery\.Read\.All yet/);

  const ok = setup();
  ok.config.target = 'azure';
  ok.config.azure = /** @type {any} */ ({ graphRoles: { assigned: [AUDIT_ROLE], pending: [] } });
  assert.equal(await checkAuditCommand(ok.ctx), 'ok');
  assert.match(ok.ui.text(), /check that audit logging is on/);
});

test('emptyAuditHelp: most likely causes first, narrowed by the last audit check', () => {
  const t = setup();
  const none = emptyAuditHelp(t.config);
  assert.match(none.lead, /found no Copilot interactions/);
  assert.equal(none.causes.length, 5);
  assert.match(none.causes[0], /Admin consent for AuditLogsQuery\.Read\.All/);
  assert.match(none.causes[1], /Audit logging is off/);
  assert.match(none.causes.at(-1) ?? '', /check-audit/);

  t.config.auditCheck = { at: 'x', result: 'no-copilot' };
  assert.doesNotMatch(emptyAuditHelp(t.config).causes.join(' '), /Admin consent|Audit logging is off/);
  t.config.auditCheck = { at: 'x', result: 'bad-secret' };
  assert.match(emptyAuditHelp(t.config).causes[0], /rotate-secret/);
});

test('cli: --check-audit goes with install or update on Fabric; check-audit is a command', () => {
  assert.equal(parseCli(['install', '--check-audit']).checkAudit, true);
  assert.equal(parseCli(['update', '--check-audit']).checkAudit, true);
  assert.equal(parseCli(['install']).checkAudit, false);
  assert.equal(parseCli(['check-audit']).command, 'check-audit');
  assert.throws(() => parseCli(['run', '--check-audit']), /--check-audit goes with install or update/);
  assert.throws(() => parseCli(['install', '--target', 'azure', '--check-audit']), /Fabric target only/);
});
