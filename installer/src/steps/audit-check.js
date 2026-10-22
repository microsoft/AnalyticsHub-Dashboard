// @ts-check
/**
 * Checks that the app registration can read the Copilot interactions in the audit log, the way the
 * audit notebook does: an app-only token with AuditLogsQuery.Read.All for this tenant, and, when
 * asked, a small live audit search. A load that reads nothing doesn't fail, so without this an
 * install with no consent, the wrong tenant or audit logging off looks the same as one with no
 * Copilot use.
 */
import { decodeJwt } from '../auth.js';
import { adminConsentUrl, apiPermissionsUrl } from '../clients/graph.js';
import { secretMode } from '../config.js';
import { HttpError } from '../http.js';
import { commandLine } from '../launch.js';

/** @typedef {import('../install.js').Ctx} Ctx */
/** @typedef {import('../config.js').AuditCheck} AuditCheck */
/** @typedef {AuditCheck['result']} AuditResult */

export const AUDIT_ROLE = 'AuditLogsQuery.Read.All';
export const AUDIT_RECORD_TYPE = 'copilotInteraction';
export const PURVIEW_AUDIT_URL = 'https://purview.microsoft.com/audit/auditsearch';

/** How far back the live search looks for Copilot interactions, and for anything at all. */
export const PROBE_DAYS = 2;
export const ANY_RECORD_DAYS = 1;
/** How long the installer waits for each live search, and how often it asks. */
export const PROBE_WAIT_MS = 10 * 60_000;
export const PROBE_POLL_MS = 15_000;
/** A new secret or a new consent can take a little while to be honoured. */
export const TOKEN_ATTEMPTS = 4;
export const SECRET_RETRY_MS = 15_000;
export const ROLE_RETRY_MS = 30_000;

/** Results that came from a live search, which a token check alone doesn't replace. */
const LIVE = new Set(['records', 'no-copilot', 'empty-log', 'timeout']);

/** Results that mean the audit load can't find anything until someone fixes it. */
/** @type {AuditResult[]} */
export const AUDIT_CHECK_FAILS = ['no-role', 'refused', 'bad-secret', 'wrong-tenant', 'empty-log'];

/** What each result means, in a few words, for the prerequisites list. */
/** @type {Record<AuditResult, string>} */
export const AUDIT_CHECK_LABELS = {
  ok: 'the app\'s token has the permission',
  records: 'Copilot interactions found',
  'no-copilot': 'audit records found, but no Copilot interactions',
  'empty-log': 'the audit log is empty; audit logging may be off',
  'no-role': `the app's token lacks ${AUDIT_ROLE}`,
  'bad-secret': 'the app\'s client secret doesn\'t work',
  'wrong-tenant': 'the app registration is in another tenant',
  refused: 'the audit search was refused',
  timeout: 'the audit search didn\'t finish in time',
  error: 'the check couldn\'t finish',
};

/**
 * The app registration's client secret for this run: the one the run just made or was given, else
 * the one in Key Vault when the vault is reachable, else (when `ask`) pasted by the user.
 * @param {Ctx} ctx
 * @param {{ ask?: boolean }} [o]
 * @returns {Promise<string | undefined>}
 */
export async function appSecretFor(ctx, o = {}) {
  const { config, api, ui } = ctx;
  if (ctx.appSecret) return ctx.appSecret;
  const kv = config.keyVault;
  if (secretMode(config) !== 'notebook' && kv?.uri && kv.secretName && !kv.private) {
    try {
      const value = await api.keyVault.secretValue(kv.uri, kv.secretName);
      if (value) return (ctx.appSecret = value);
    } catch {
      // Not allowed to read it (keyvault-admin, or no Secrets User role): fall through.
    }
  }
  if (!o.ask || ui.yes) return undefined;
  const pasted = (await ui.secret(`Paste a client secret of the app registration ${config.app.appId} (it's only used for this check)`)).trim();
  return pasted ? (ctx.appSecret = pasted) : undefined;
}

/**
 * Gets a fresh app-only Graph token and checks it: for this tenant, with AuditLogsQuery.Read.All.
 * Tries again for a while when the secret or the consent is new, as Entra takes a moment to honour them.
 * @param {Ctx} ctx
 * @param {string} appId
 * @param {string} secret
 * @param {{ waitForRole?: boolean }} [o]  waitForRole: consent was just found or granted, so a missing role may be on its way.
 * @returns {Promise<{ result: AuditResult, detail?: string, roles?: string[] }>}
 */
export async function checkAppToken(ctx, appId, secret, o = {}) {
  const tenant = String(ctx.user.tenantId ?? '').toLowerCase();
  for (let attempt = 1; ; attempt++) {
    const last = attempt >= TOKEN_ATTEMPTS;
    /** @type {string} */
    let token;
    try {
      token = await /** @type {NonNullable<import('../install.js').Apis['appGraph']>} */ (ctx.api.appGraph)(appId, secret).token();
    } catch (err) {
      const msg = String(/** @type {any} */ (err)?.message ?? err);
      if (/AADSTS7000215|AADSTS7000222/.test(msg)) {
        if (!last) {
          await ctx.sleep(SECRET_RETRY_MS);
          continue;
        }
        return { result: 'bad-secret', detail: /AADSTS7000222/.test(msg) ? 'The client secret has expired.' : 'Microsoft Entra rejected the client secret.' };
      }
      // Also what Entra says for a minute or so after it creates an app, so it's tried again first.
      if (/AADSTS700016/.test(msg)) {
        if (!last) {
          await ctx.sleep(SECRET_RETRY_MS);
          continue;
        }
        return { result: 'wrong-tenant', detail: `The app registration ${appId} isn't in tenant ${ctx.user.tenantId}.` };
      }
      if (/AADSTS7000112/.test(msg)) return { result: 'refused', detail: `The app registration ${appId} is disabled in this tenant.` };
      return { result: 'error', detail: firstLine(msg) };
    }
    const claims = decodeJwt(token);
    if (claims.tid && tenant && String(claims.tid).toLowerCase() !== tenant) {
      return { result: 'wrong-tenant', detail: `The app's token is for tenant ${claims.tid}, not ${ctx.user.tenantId}.` };
    }
    const roles = Array.isArray(claims.roles) ? claims.roles.map(String) : [];
    if (roles.includes(AUDIT_ROLE)) return { result: 'ok', roles };
    if (o.waitForRole && !last) {
      await ctx.sleep(ROLE_RETRY_MS);
      continue;
    }
    return { result: 'no-role', roles };
  }
}

/**
 * The install's check, after admin consent: whether the app's own token can read the audit log.
 * Fabric only (Azure's jobs use a managed identity, with no secret to test). Never stops the
 * install: it says what's wrong and who fixes it. Once it has an answer that isn't provisional, it
 * isn't run again this run.
 * @param {Ctx} ctx
 * @param {{ consented?: boolean, provisional?: boolean }} [o]
 *   consented: consent is in place, so a missing role is waited for.
 *   provisional: straight after the app, its secret or consent may be new, and Entra can take
 *   minutes to honour them. A problem is only noted, not kept, and the later check decides.
 * @returns {Promise<AuditResult | undefined>}  undefined when it couldn't run.
 */
export async function checkAuditAccess(ctx, o = {}) {
  const { config, ui } = ctx;
  if (ctx.auditChecked || config.target === 'azure' || !ctx.api.appGraph) return undefined;
  const appId = config.app.appId;
  if (!appId) return undefined;
  const secret = await appSecretFor(ctx);
  if (!secret) return undefined;
  const r = await checkAppToken(ctx, appId, secret, { waitForRole: !!o.consented });
  if (r.result !== 'ok' && o.provisional) {
    ui.note(
      `The app's audit log access isn't confirmed yet (${AUDIT_CHECK_LABELS[r.result]}). Entra can take a few minutes to apply a new app, secret or consent, so it's checked again once the pipeline is deployed.`,
    );
    return r.result;
  }
  ctx.auditChecked = true;
  reportAudit(ctx, r);
  saveAuditCheck(ctx, r);
  return r.result;
}

/**
 * Runs a small audit search as the app, the way the audit notebook does. When it finds no Copilot
 * interactions, a second search for any record tells "no Copilot use" from "audit logging is off".
 * @param {Ctx} ctx
 * @param {string} appId
 * @param {string} secret
 * @param {{ maxWaitMs?: number }} [o]
 * @returns {Promise<{ result: AuditResult, detail?: string }>}
 */
export async function probeAuditLog(ctx, appId, secret, o = {}) {
  const audit = /** @type {NonNullable<import('../install.js').Apis['appGraph']>} */ (ctx.api.appGraph)(appId, secret).audit;
  const end = ctx.now();
  const search = async (/** @type {number} */ days, /** @type {string[] | undefined} */ recordTypes) => {
    const start = new Date(end.getTime() - days * 86_400_000);
    const q = await audit.startQuery({ displayName: `Analytics Hub installer check ${end.toISOString()}`, start, end, recordTypes });
    const status = await waitForQuery(ctx, audit, q, o.maxWaitMs ?? PROBE_WAIT_MS);
    if (status !== 'succeeded') return status;
    return (await audit.firstRecords(q.id, 1)).length ? 'found' : 'none';
  };
  try {
    ctx.ui.info(`Running a test audit search for Copilot interactions in the last ${PROBE_DAYS} days. It can take a few minutes.`);
    const copilot = await search(PROBE_DAYS, [AUDIT_RECORD_TYPE]);
    if (copilot === 'found') return { result: 'records' };
    if (copilot === 'timeout') return { result: 'timeout' };
    if (copilot !== 'none') return { result: 'error', detail: `The audit search ended as ${copilot}.` };
    ctx.ui.info(`None found. Checking whether the audit log has any records from the last ${ANY_RECORD_DAYS === 1 ? 'day' : `${ANY_RECORD_DAYS} days`}.`);
    const any = await search(ANY_RECORD_DAYS, undefined);
    if (any === 'found') return { result: 'no-copilot' };
    if (any === 'none') return { result: 'empty-log' };
    if (any === 'timeout') return { result: 'timeout' };
    return { result: 'error', detail: `The audit search ended as ${any}.` };
  } catch (err) {
    if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
      return { result: 'refused', detail: `Microsoft Graph refused the audit search (${err.status}${err.code ? ` ${err.code}` : ''}).` };
    }
    return { result: 'error', detail: firstLine(String(/** @type {any} */ (err)?.message ?? err)) };
  }
}

/**
 * @param {Ctx} ctx
 * @param {import('../clients/graph.js').AuditApi} audit
 * @param {{ id: string, status?: string }} q
 * @param {number} maxWaitMs
 * @returns {Promise<string>}  succeeded, failed, cancelled or timeout.
 */
async function waitForQuery(ctx, audit, q, maxWaitMs) {
  let status = q.status;
  for (let waited = 0; ; waited += PROBE_POLL_MS) {
    if (status === 'succeeded' || status === 'failed' || status === 'cancelled') return status;
    if (waited >= maxWaitMs) return 'timeout';
    await ctx.sleep(PROBE_POLL_MS);
    status = (await audit.getQuery(q.id))?.status;
  }
}

/**
 * The `check-audit` command, and --check-audit on install or update: the token check, then the live search.
 * @param {Ctx} ctx
 * @returns {Promise<AuditResult>}
 */
export async function checkAuditCommand(ctx) {
  const { config, ui } = ctx;
  ui.heading('Audit ingestion check');
  if (config.target === 'azure') return checkAzureAudit(ctx);
  const appId = config.app.appId;
  if (!appId) throw new Error('This install record has no app registration yet. Run the install first.');
  if (!ctx.api.appGraph) throw new Error('This sign-in can\'t check the app registration.');
  const secret = await appSecretFor(ctx, { ask: true });
  if (!secret) {
    throw new Error(
      `The app's client secret isn't readable from Key Vault here. Run ${commandLine('check-audit')} without --yes to paste a client secret of ${appId}, or run it where you can read the vault.`,
    );
  }
  const token = await checkAppToken(ctx, appId, secret);
  if (token.result !== 'ok') {
    reportAudit(ctx, token);
    saveAuditCheck(ctx, token);
    return token.result;
  }
  ui.ok(`The app ${appId} has ${AUDIT_ROLE} in this tenant`);
  const live = await probeAuditLog(ctx, appId, secret);
  reportAudit(ctx, live);
  saveAuditCheck(ctx, live);
  return live.result;
}

/**
 * Azure: the jobs read the audit log as the managed identity, whose Graph roles the installer
 * assigned or left for an admin. There's no secret to test a token with.
 * @param {Ctx} ctx
 * @returns {AuditResult}
 */
function checkAzureAudit(ctx) {
  const { config, ui } = ctx;
  const roles = config.azure?.graphRoles;
  if (roles?.pending?.includes(AUDIT_ROLE)) {
    ui.warn(`The jobs' managed identity doesn't have ${AUDIT_ROLE} yet, so the audit job finds nothing.`);
    ui.info('A Global Administrator or Privileged Role Administrator grants it: run the installer\'s update as them, or assign the Microsoft Graph app role to the managed identity.');
    saveAuditCheck(ctx, { result: 'no-role' });
    return 'no-role';
  }
  if (roles?.assigned?.includes(AUDIT_ROLE)) ui.ok(`The jobs' managed identity has ${AUDIT_ROLE}`);
  else ui.note(`Couldn't tell from the install record whether the jobs' managed identity has ${AUDIT_ROLE}.`);
  ui.note('A live audit search isn\'t run on Azure. If the audit job still finds nothing, check that audit logging is on:');
  for (const line of AUDIT_LOGGING_STEPS) ui.note(line);
  return 'ok';
}

/** How audit logging is turned on, and how long records take to appear. */
export const AUDIT_LOGGING_STEPS = [
  `A Compliance Administrator (or anyone with the Audit Logs role in Purview) opens Microsoft Purview > Audit: ${PURVIEW_AUDIT_URL}`,
  'If it offers "Start recording user and admin activity", audit logging is off: they select it.',
  'New records then take from 60 minutes to 24 hours to appear.',
];

/** Where the audit notebook keeps track of the windows it has read, in the Lakehouse. */
export const AUDIT_MANIFEST = 'Files/_audit_staging/_manifest.json';
/** The notebook reuses a recent window it read this many hours ago, and never rereads one older than this many days. */
export const AUDIT_REUSE_HOURS = 6;
export const AUDIT_LOOKBACK_DAYS = 7;

/**
 * After consent or audit logging is fixed: the audit notebook keeps the windows it already read
 * as empty, so they are reloaded by hand. Fabric only.
 * @param {import('../config.js').InstallConfig} config
 * @returns {string[]}
 */
export function auditReloadSteps(config) {
  if (config.target === 'azure') return [];
  return [
    `Once it's fixed, reload what the audit load already read as empty. Otherwise those windows are reused: recent ones for ${AUDIT_REUSE_HOURS} hours, and ones older than ${AUDIT_LOOKBACK_DAYS} days are never read again.`,
    `In the Lakehouse, rename ${AUDIT_MANIFEST} (for example to _manifest.old.json), then run ${commandLine('run --backfill-days <n>')}, with <n> covering the days to reload.`,
  ];
}

/**
 * Says what a check found and who fixes it. Once a load has run, a problem that left it empty
 * also says how to reload.
 * @param {Ctx} ctx
 * @param {{ result: AuditResult, detail?: string }} r
 */
export function reportAudit(ctx, r) {
  reportAuditResult(ctx, r);
  if (AUDIT_CHECK_FAILS.includes(r.result) && ctx.config.firstRun?.jobId) {
    for (const line of auditReloadSteps(ctx.config)) ctx.ui.info(line);
  }
}

/**
 * @param {Ctx} ctx
 * @param {{ result: AuditResult, detail?: string }} r
 */
function reportAuditResult(ctx, r) {
  const { ui, config, user } = ctx;
  const appId = config.app.appId ?? 'the app registration';
  const detail = r.detail ? ` ${r.detail}` : '';
  switch (r.result) {
    case 'ok':
      ui.ok(`The app can read the audit log: its token for this tenant has ${AUDIT_ROLE}`);
      ui.note(`To also check the audit log has Copilot records, run ${commandLine('check-audit')}.`);
      return;
    case 'records':
      ui.ok(`A test audit search found Copilot interactions from the last ${PROBE_DAYS} days`);
      return;
    case 'no-role':
      ui.warn(`The app ${appId} can't read the audit log: its token has no ${AUDIT_ROLE}, so the audit load will find nothing.`);
      ui.info('A Global Administrator or Privileged Role Administrator selects "Grant admin consent" on its API permissions page:');
      ui.info(apiPermissionsUrl(appId));
      ui.note(`Or the direct consent link: ${adminConsentUrl(user.tenantId, appId)}`);
      ui.note(`Consent can take a few minutes to apply. Then run ${commandLine('check-audit')}.`);
      return;
    case 'bad-secret':
      ui.warn(`The app's client secret doesn't work.${detail} The loads can't sign in until it's replaced.`);
      ui.info(`Run ${commandLine('rotate-secret')} to make a new one.`);
      return;
    case 'wrong-tenant':
      ui.warn(`The app registration doesn't belong to this tenant.${detail} The loads would read the wrong tenant's audit log, or none.`);
      ui.info('Run the installer signed in to the tenant whose Copilot use you want to see, with an app registration from that tenant.');
      return;
    case 'refused':
      ui.warn(`The app can't read the audit log.${detail}`);
      ui.info(`Check that ${AUDIT_ROLE} is an Application permission (not Delegated) with admin consent: ${apiPermissionsUrl(appId)}`);
      return;
    case 'no-copilot':
      ui.warn(`The audit log has records, but no Copilot interactions in the last ${PROBE_DAYS} days.`);
      ui.info('If people use Copilot, check they have Microsoft 365 Copilot or Copilot Chat. New records can take up to 24 hours to appear; the scheduled loads pick them up.');
      return;
    case 'empty-log':
      ui.warn(`A test audit search found no records at all in the last ${ANY_RECORD_DAYS === 1 ? 'day' : `${ANY_RECORD_DAYS} days`}: audit logging is probably off.`);
      for (const line of AUDIT_LOGGING_STEPS) ui.info(line);
      return;
    case 'timeout':
      ui.warn(`The test audit search was still running after ${Math.round(PROBE_WAIT_MS / 60_000)} minutes.`);
      ui.info(`Audit searches can be slow in a large tenant. Run ${commandLine('check-audit')} later to see the result.`);
      return;
    default:
      ui.warn(`Couldn't check the app's access to the audit log.${detail}`);
      ui.note(`Run ${commandLine('check-audit')} to try again.`);
  }
}

/**
 * Keeps what a check found, for the data check after a load. A token check that passed doesn't
 * replace an earlier live search's finding, which says more.
 * @param {Ctx} ctx
 * @param {{ result: AuditResult, detail?: string }} r
 */
export function saveAuditCheck(ctx, r) {
  const prev = ctx.config.auditCheck;
  if (r.result === 'ok' && prev && LIVE.has(prev.result)) return;
  ctx.config.auditCheck = { at: ctx.now().toISOString(), result: r.result, ...(r.detail ? { detail: r.detail } : {}) };
  ctx.save();
}

/**
 * Why the audit load found no Copilot interactions, most likely first, for the data check. Uses
 * the last check's finding when there is one. `after` is what to do once the cause is fixed.
 * @param {import('../config.js').InstallConfig} config
 * @returns {{ lead: string, causes: string[], after: string[] }}
 */
export function emptyAuditHelp(config) {
  const help = emptyAuditCauses(config);
  const after = help.causes.length && config.auditCheck?.result !== 'no-copilot' ? auditReloadSteps(config) : [];
  return { ...help, after };
}

/**
 * @param {import('../config.js').InstallConfig} config
 * @returns {{ lead: string, causes: string[] }}
 */
function emptyAuditCauses(config) {
  const check = config.auditCheck?.result;
  const consent = `Admin consent for ${AUDIT_ROLE} is missing or not yet in effect. A Global Administrator or Privileged Role Administrator grants it on the app's API permissions page.`;
  const logging = 'Audit logging is off in Microsoft Purview. A Compliance Administrator turns it on in Purview > Audit; records then take 60 minutes to 24 hours to appear.';
  const usage = 'Nobody used Copilot in the period loaded, or nobody has a Copilot licence yet.';
  const lag = 'The audit log can lag by up to 24 hours, so very recent use shows after the next scheduled load.';
  const tool = `Run ${commandLine('check-audit')} to test the app's access and search the audit log.`;
  if (check === 'no-role' || check === 'refused') return { lead: `The last audit check found the app can't read the audit log.`, causes: [consent, tool] };
  if (check === 'bad-secret') return { lead: `The last audit check found the app's client secret doesn't work.`, causes: [`Run ${commandLine('rotate-secret')} to make a new one.`] };
  if (check === 'wrong-tenant') return { lead: `The last audit check found the app registration isn't in this tenant.`, causes: ['Use an app registration from the tenant whose Copilot use you want to see.'] };
  if (check === 'empty-log') return { lead: 'The last audit check found the audit log empty.', causes: [logging, tool] };
  if (check === 'no-copilot') return { lead: 'The last audit check found audit records, but no Copilot interactions.', causes: [usage, lag] };
  return { lead: 'The audit load found no Copilot interactions. Most likely causes, in order:', causes: [consent, logging, usage, lag, tool] };
}

/** @param {string} s */
const firstLine = (s) => s.split('\n')[0].slice(0, 300);
