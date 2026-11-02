// @ts-check
/**
 * The support file: one zip a customer can open, check and email to us when an install or a load
 * goes wrong. It holds the installer's version and route, the last runs' step logs, the
 * prerequisites check, recent pipeline, notebook, refresh and Azure job runs with their errors,
 * row counts per table, a summary of the logs (throttling, sign-in failures, time-outs) and the
 * install record. Redaction is built in: secrets, tokens and keys are removed, people are hashed,
 * and no data rows are ever read. Whatever can't be collected says why, rather than being left out.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { writeZip } from './transform/zip.js';
import { emptyConfig, loadConfig } from './config.js';

export const SUPPORT_PRODUCT = 'Analytics Hub';
const PREFIX = 'analyticshub-support';
/** Runs kept in the run log beside the install record. */
export const RUN_LOG_RUNS = 5;
const MAX_LINES = 3000;
const MAX_TEXT = 2000;
/** The most of a --log file read. */
const MAX_LOG_BYTES = 20 * 1024 * 1024;

/* ---------- Redaction ---------- */

/** Keys whose values are secrets. keyVault itself is only where the secret lives. */
export const SECRET_KEY = /secret|passw(or)?d|^pwd$|token|key(?!vault)|signature|connectionstring|^sas|sas(url|uri)?$|credential|authori[sz]ation|cookie/i;
/** Keys whose values are people, and keys under which everything is about a person, such as user.displayName. */
export const PERSON_KEY = /^(givenName|surname|fullName|userName|contact|owner|owners|createdBy|lastModifiedBy|requestedBy|upn|userPrincipalName|mail|email|adminEmail|user|signedInAs)$/i;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;
const EMAIL = /[A-Za-z0-9._%+'#-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
/** Patterns of secrets in free text, each with what it becomes. */
const SECRET_TEXT = /** @type {[RegExp, string][]} */ ([
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '[removed]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [removed]'],
  [/\b(sig|AccountKey|SharedAccessKey|SharedAccessSignature|client_secret|client_assertion|code_verifier|refresh_token|access_token|id_token|password|pwd)(\s*[=:]\s*)("?)[^;&\s"',}]+/gi, '$1$2$3[removed]'],
  // An Entra client secret, such as abc8Q~... .
  [/\b[A-Za-z0-9_.-]{2,5}~[A-Za-z0-9_.~-]{30,}/g, '[removed]'],
]);
const LONG_BASE64 = /[A-Za-z0-9+/_=-]{80,}/g;
/** Long runs that are Azure resource paths or URLs, not keys. */
const RESOURCE_PATH = /\/(subscriptions|resourceGroups|providers|groups|workspaces|items)\//i;

/**
 * Removes secrets and, unless `people` is false, hashes email addresses, UPNs and names. Tokens are
 * SHA-256 of a salt and the lower-cased value, shown as `user-` and 10 hex digits, so one person has
 * one token in a support file. The salt is random for each file and kept nowhere.
 * @param {{ salt?: Buffer, people?: boolean }} [o]
 */
export function createRedactor(o = {}) {
  const salt = o.salt ?? randomBytes(16);
  const people = o.people !== false;
  const counts = { secrets: 0, emails: 0, names: 0 };
  /** Names seen under person keys, longest first when used. @type {Set<string>} */
  const names = new Set();

  /** @param {string} value */
  const hash = (value) => `user-${createHash('sha256').update(salt).update(value.trim().toLowerCase(), 'utf8').digest('hex').slice(0, 10)}`;

  /** @param {string} s */
  function text(s) {
    let out = s.replace(/\x1b\[[0-9;]*m/g, '');
    for (const [re, to] of SECRET_TEXT) {
      out = out.replace(re, (...m) => {
        counts.secrets++;
        return to.replace(/\$(\d)/g, (_, i) => m[Number(i)] ?? '');
      });
    }
    out = out.replace(LONG_BASE64, (m) => {
      if (RESOURCE_PATH.test(m) || !(/\d/.test(m) && /[A-Z]/.test(m) && /[a-z]/.test(m))) return m;
      counts.secrets++;
      return '[removed]';
    });
    if (!people) return out;
    out = out.replace(EMAIL, (m) => {
      counts.emails++;
      return hash(m);
    });
    for (const name of [...names].sort((a, b) => b.length - a.length)) {
      out = out.replace(new RegExp(`(?<![\\w-])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'gi'), () => {
        counts.names++;
        return hash(name);
      });
    }
    return out;
  }

  /**
   * @param {unknown} v
   * @param {boolean} secret  Under a secret key: only GUIDs, dates, numbers and booleans stay.
   * @param {boolean} person  Under a person key.
   * @returns {unknown}
   */
  function walk(v, secret, person) {
    if (v === null || v === undefined || typeof v === 'number' || typeof v === 'boolean') return v;
    if (typeof v === 'string') {
      if (secret) {
        if (GUID.test(v) || ISO_DATE.test(v)) return v;
        counts.secrets++;
        return '[removed]';
      }
      if (person && people && v.trim() && !GUID.test(v)) {
        if (v.includes('@')) counts.emails++;
        else counts.names++;
        return hash(v);
      }
      return text(v);
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, secret, person));
    if (typeof v === 'object') {
      /** @type {Record<string, unknown>} */
      const out = {};
      for (const [k, x] of Object.entries(v)) out[k] = walk(x, secret || SECRET_KEY.test(k), person || PERSON_KEY.test(k));
      return out;
    }
    return '[removed]';
  }

  return {
    counts,
    hash,
    text,
    /**
     * Notes the names under person keys, so the same names in free text are hashed too.
     * @param {unknown} v
     */
    learn(v) {
      /** @param {unknown} x @param {boolean} person */
      const visit = (x, person) => {
        if (typeof x === 'string') {
          if (person && x.trim().length >= 3 && !x.includes('@') && !GUID.test(x)) names.add(x.trim());
        } else if (Array.isArray(x)) x.forEach((y) => visit(y, person));
        else if (x && typeof x === 'object') for (const [k, y] of Object.entries(x)) visit(y, person || PERSON_KEY.test(k));
      };
      visit(v, false);
    },
    /**
     * A redacted copy of any JSON value.
     * @template T
     * @param {T} v
     * @returns {T}
     */
    value: (v) => /** @type {any} */ (walk(v, false, false)),
  };
}

/** What the README and manifest say was done. */
export const REDACTION_RULES = Object.freeze([
  'Values under keys that name a secret, token, key, password, signature, SAS, credential or connection string are removed. GUIDs, dates, numbers and true/false under them stay, such as when a secret expires.',
  'Tokens (JWTs), Bearer headers, SAS signatures, account and shared access keys, client secrets and long base64 strings are removed from any text.',
  'Email addresses, UPNs and people\'s names are replaced by user- and 10 hex digits: a SHA-256 hash with a random salt that is used for this file only and kept nowhere. The same person has the same token throughout the file.',
  'Tenant, workspace and item IDs (GUIDs) are kept, so we can find the right run.',
  'No data rows are read: tables appear as row counts only.',
]);

/* ---------- The run log beside the install record ---------- */

/** @param {string} configFile */
export const runLogFile = (configFile) => `${configFile.replace(/\.json$/i, '')}.log.json`;

/**
 * @typedef {{ level: string, text: string }} RunLine
 * @typedef {{ n?: number, total?: number, title: string, lines: RunLine[] }} RunStep
 * @typedef {{ command: string, version: string, route: string, startedAt: string, finishedAt?: string, ok?: boolean, failedStep?: string | null, error?: string | null, user?: { upn?: string, displayName?: string }, steps: RunStep[], prereqs?: any[] }} RunRecord
 */

/** @param {string} configFile @returns {RunRecord[]} */
export function readRunLog(configFile) {
  try {
    const runs = JSON.parse(readFileSync(runLogFile(configFile), 'utf8'));
    return Array.isArray(runs) ? runs : [];
  } catch {
    return [];
  }
}

const UI_LEVELS = /** @type {const} */ (['ok', 'warn', 'fail', 'info', 'note', 'line']);

/**
 * Records what a command prints, step by step, and saves it to the run log when it ends. The ui
 * keeps working as before; `finish` puts its methods back. Secrets are removed before saving.
 * @param {any} ui  The terminal or web ui.
 * @param {{ command: string, configFile: string, version: string, route?: string, now?: () => Date }} o
 */
export function recordRun(ui, o) {
  const now = o.now ?? (() => new Date());
  /** @type {RunRecord} */
  const run = { command: o.command, version: o.version, route: o.route ?? 'fabric', startedAt: now().toISOString(), steps: [{ title: 'Start', lines: [] }] };
  let count = 0;
  /** @type {Record<string, any>} */
  const originals = {};
  const current = () => run.steps[run.steps.length - 1];
  /** @param {string} level @param {unknown} s */
  const add = (level, s) => {
    if (count++ >= MAX_LINES) return;
    current().lines.push({ level, text: String(s ?? '').replace(/\x1b\[[0-9;]*m/g, '').slice(0, MAX_TEXT) });
  };
  /** @param {string} name @param {(...a: any[]) => void} note */
  const wrap = (name, note) => {
    const fn = ui[name];
    if (typeof fn !== 'function') return;
    originals[name] = fn;
    ui[name] = (/** @type {any[]} */ ...a) => {
      try {
        note(...a);
      } catch {
        // Recording never stops the command.
      }
      return fn.apply(ui, a);
    };
  };
  wrap('step', (n, total, title) => run.steps.push({ n, total, title: String(title).replace(/\x1b\[[0-9;]*m/g, ''), lines: [] }));
  wrap('heading', (title) => run.steps.push({ title: String(title).replace(/\x1b\[[0-9;]*m/g, ''), lines: [] }));
  for (const level of UI_LEVELS) wrap(level, (s) => add(level, s));
  wrap('prereqs', (items) => {
    run.prereqs = structuredClone(items);
  });
  wrap('loads', (cards) => {
    for (const card of cards ?? []) add(card.state === 'ok' ? 'ok' : card.state === 'failed' ? 'fail' : 'warn', `${card.name}: ${card.state}${card.attempts ? ` (${card.attempts} attempts)` : ''}${card.reason ? `. ${card.reason}` : ''}`);
  });
  wrap('todo', (step) => add('warn', `To do: ${step?.title ?? ''}`));
  wrap('nextSteps', (title, steps) => add('warn', `${title}: ${(steps ?? []).map((/** @type {any} */ s) => s.title).join('; ')}`));

  return {
    run,
    /** @param {{ upn?: string, displayName?: string }} user */
    setUser(user) {
      run.user = { upn: user.upn, displayName: user.displayName };
    },
    /** @param {'fabric' | 'azure'} route */
    setRoute(route) {
      run.route = route;
    },
    /**
     * Puts the ui back and saves the run. Never throws.
     * @param {boolean} ok
     * @param {unknown} [error]
     */
    finish(ok, error) {
      if (run.finishedAt) return;
      for (const [name, fn] of Object.entries(originals)) ui[name] = fn;
      run.finishedAt = now().toISOString();
      run.ok = ok;
      run.error = error === undefined || error === null ? null : String(/** @type {any} */ (error)?.message ?? error).slice(0, MAX_TEXT);
      const failed = [...run.steps].reverse().find((s) => s.lines.some((l) => l.level === 'fail'));
      run.failedStep = ok ? null : (failed ?? run.steps[run.steps.length - 1]).title;
      run.steps = run.steps.filter((s, i) => i > 0 || s.lines.length);
      try {
        const scrub = createRedactor({ people: false });
        const runs = [...readRunLog(o.configFile), scrub.value(run)].slice(-RUN_LOG_RUNS);
        writeFileSync(runLogFile(o.configFile), `${JSON.stringify(runs, null, 2)}\n`);
      } catch {
        // A run log that can't be written leaves the support file without it.
      }
    },
  };
}

/* ---------- Collecting ---------- */

/** @param {unknown} err */
const reason = (err) => String(/** @type {any} */ (err)?.message ?? err).slice(0, 500);
/** @param {string} why */
export const notCollected = (why) => ({ notCollected: why });

/**
 * @param {() => Promise<any>} fn
 * @returns {Promise<any>}
 */
async function attempt(fn) {
  try {
    return await fn();
  } catch (err) {
    return notCollected(reason(err));
  }
}

/** @param {any} job */
const jobSummary = (job) => ({
  id: job.id,
  status: job.status,
  invokeType: job.invokeType,
  startTimeUtc: job.startTimeUtc,
  endTimeUtc: job.endTimeUtc,
  error: job.failureReason ? { code: job.failureReason.errorCode, message: String(job.failureReason.message ?? '').slice(0, MAX_TEXT) } : undefined,
});

/** @param {any[]} jobs @param {number} n */
const newest = (jobs, n) => [...jobs].sort((a, b) => String(b.startTimeUtc ?? '').localeCompare(String(a.startTimeUtc ?? ''))).slice(0, n);

/**
 * Row counts per table from a model's storage, never the rows themselves.
 * @param {any} powerBi @param {string} workspaceId @param {string} datasetId
 */
export async function modelRowCounts(powerBi, workspaceId, datasetId) {
  const res = await powerBi.executeQueries(workspaceId, datasetId, 'EVALUATE SELECTCOLUMNS(INFO.STORAGETABLES(), "table", [DIMENSION_NAME], "id", [TABLE_ID], "rows", [ROWS_COUNT])');
  const rows = res?.results?.[0]?.tables?.[0]?.rows ?? [];
  /** @type {Record<string, number>} */
  const out = {};
  for (const r of rows) {
    const table = String(r['[table]'] ?? '');
    if (!table || /^(H|R|U)\$/.test(String(r['[id]'] ?? ''))) continue;
    out[table] = Math.max(out[table] ?? 0, Number(r['[rows]'] ?? 0));
  }
  return out;
}

/**
 * Recent runs on Fabric: the pipeline and its activities, each notebook and each model's refreshes.
 * @param {{ api: any, config: import('./config.js').InstallConfig, now: () => Date }} c
 */
async function fabricRuns(c) {
  const { activityRuns } = await import('./steps/run.js');
  const f = c.config.fabric;
  if (!f.workspaceId) return notCollected('Nothing is installed yet: the install record has no workspace.');
  const ws = f.workspaceId;
  /** @type {Record<string, any>} */
  const out = {};
  out.pipeline = f.pipelineId
    ? await attempt(async () => {
      const jobs = newest(await c.api.fabric.listJobs(ws, f.pipelineId), 5);
      const latest = jobs[0];
      /** @type {any} */
      let activities = notCollected('The pipeline has no finished run yet.');
      if (latest && latest.status !== 'InProgress' && latest.status !== 'NotStarted') {
        const runs = await activityRuns(/** @type {any} */ ({ ...c, ui: undefined }), latest.id, latest);
        activities = runs
          ? [...runs.values()].map((r) => ({ activity: r.activityName, status: r.status, attempts: r.attempts, start: r.activityRunStart, end: r.activityRunEnd, error: r.error?.message ? { code: r.error.errorCode, message: String(r.error.message).slice(0, MAX_TEXT) } : undefined }))
          : notCollected('Fabric didn\'t return the activity runs.');
      }
      return { runs: jobs.map(jobSummary), latestActivities: activities };
    })
    : notCollected('The install record has no pipeline.');
  /** @type {Record<string, any>} */
  const notebooks = {};
  for (const [key, id] of Object.entries(f.notebooks ?? {})) {
    if (!id) continue;
    notebooks[key] = await attempt(async () => newest(await c.api.fabric.listJobs(ws, id), 3).map(jobSummary));
  }
  out.notebooks = notebooks;
  /** @type {Record<string, any>} */
  const refreshes = {};
  for (const m of [c.config.semanticModel, c.config.consumption?.model, c.config.agentEvaluator?.model]) {
    if (!m?.id) continue;
    refreshes[m.name ?? m.id] = await attempt(async () =>
      (await c.api.powerBi.refreshes(ws, m.id, 3)).map((/** @type {any} */ r) => ({
        status: r.extendedStatus ?? r.status,
        refreshType: r.refreshType,
        startTime: r.startTime,
        endTime: r.endTime,
        error: r.serviceExceptionJson ? String(r.serviceExceptionJson).slice(0, MAX_TEXT) : undefined,
      })));
  }
  out.modelRefreshes = refreshes;
  return out;
}

/**
 * Recent Azure Container Apps job executions. Azure returns no error text for them.
 * @param {{ api: any, config: import('./config.js').InstallConfig }} c
 */
async function azureRuns(c) {
  const az = c.config.azure;
  if (!az?.subscriptionId || !az.resourceGroup) return notCollected('Nothing is installed yet: the install record has no resource group.');
  /** @type {Record<string, any>} */
  const out = { lastRun: az.status?.lastRun, lastMigrate: /** @type {any} */ (az.status)?.lastMigrate };
  for (const [label, name] of [['runJob', az.outputs?.runJobName], ['migrateJob', az.outputs?.migrateJobName]]) {
    if (!name) continue;
    out[/** @type {string} */ (label)] = await attempt(async () =>
      (await c.api.arm.listContainerAppJobExecutions(az.subscriptionId, az.resourceGroup, String(name))).slice(0, 5).map((/** @type {any} */ r) => ({
        name: r.name ?? String(r.id ?? '').split('/').pop(),
        status: r.properties?.status ?? r.status,
        startTime: r.properties?.startTime,
        endTime: r.properties?.endTime,
      })));
  }
  /** @type {Record<string, any>} */
  const refreshes = {};
  const pbi = az.powerBi;
  for (const [label, id] of [['main', pbi?.datasetId], ['consumption', pbi?.consumptionDatasetId], ['agentEvaluator', pbi?.agentEvaluatorDatasetId]]) {
    if (!id || !pbi?.workspaceId) continue;
    refreshes[/** @type {string} */ (label)] = await attempt(async () =>
      (await c.api.powerBi.refreshes(pbi.workspaceId, id, 3)).map((/** @type {any} */ r) => ({
        status: r.extendedStatus ?? r.status, startTime: r.startTime, endTime: r.endTime,
        error: r.serviceExceptionJson ? String(r.serviceExceptionJson).slice(0, MAX_TEXT) : undefined,
      })));
  }
  out.modelRefreshes = refreshes;
  return out;
}

/**
 * Row counts: the last data check's per-table counts (Fabric) and each model's tables.
 * @param {{ api: any, config: import('./config.js').InstallConfig }} c
 */
async function rowCounts(c) {
  const { DATA_CHECK_FILE } = await import('./transform/notebook.js');
  const { config, api } = c;
  /** @type {Record<string, any>} */
  const out = {};
  const azure = config.target === 'azure';
  if (!azure) {
    const f = config.fabric;
    out.dataCheck = f.workspaceId && f.lakehouseId
      ? await attempt(async () => {
        const s = await api.oneLake.readJson(f.workspaceId, f.lakehouseId, DATA_CHECK_FILE);
        if (!s) return notCollected('The data check hasn\'t run yet.');
        /** @type {Record<string, any>} */
        const tables = {};
        for (const [k, t] of Object.entries(s.tables ?? {})) {
          const v = /** @type {any} */ (t);
          tables[k] = { rows: Number(v?.rows ?? 0), from: v?.from, to: v?.to, withDepartment: v?.withDepartment };
        }
        const id = s.identity ?? {};
        return {
          checkedAt: s.checkedAt,
          tables,
          identity: { licensed: id.licensed, audit: id.audit, matched: id.matched, masked: id.masked },
          auditExcluded: s.auditExcluded ? { parsed: s.auditExcluded.parsed, reasons: s.auditExcluded.reasons } : undefined,
        };
      })
      : notCollected('The install record has no Lakehouse.');
  }
  /** @type {Record<string, any>} */
  const models = {};
  const ws = azure ? config.azure?.powerBi?.workspaceId : config.fabric.workspaceId;
  const ids = azure
    ? [['main', config.azure?.powerBi?.datasetId], ['consumption', config.azure?.powerBi?.consumptionDatasetId], ['agentEvaluator', config.azure?.powerBi?.agentEvaluatorDatasetId]]
    : [[config.semanticModel?.name ?? 'main', config.semanticModel?.id], [config.consumption?.model?.name ?? 'consumption', config.consumption?.model?.id], [config.agentEvaluator?.model?.name ?? 'agentEvaluator', config.agentEvaluator?.model?.id]];
  for (const [label, id] of ids) {
    if (id && ws) models[/** @type {string} */ (label)] = await attempt(() => modelRowCounts(api.powerBi, ws, id));
  }
  out.models = Object.keys(models).length ? models : notCollected('No semantic model is recorded yet.');
  return out;
}

/** What the log summary counts. */
const LOG_PATTERNS = /** @type {const} */ ({
  http429: /\b429\b|too many requests|throttl/gi,
  http401: /\b401\b|unauthori[sz]ed|invalid_client|AADSTS7000215|AADSTS7000222|expired (client )?secret/gi,
  http403: /\b403\b|forbidden|insufficient privileges|AADSTS65001|not authori[sz]ed/gi,
  timeouts: /timed? ?out|timeout|deadline exceeded|ETIMEDOUT|ESOCKETTIMEDOUT/gi,
  windows: /\bwindows?\s+\d+(\s*(of|\/)\s*\d+)?/gi,
});
const ERROR_LINE = /error|failed|exception|denied|refused/i;

/**
 * Counts throttling, sign-in failures, time-outs and windows in some text, and keeps its first error.
 * @param {string} text
 */
export function summariseLog(text) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const [k, re] of Object.entries(LOG_PATTERNS)) out[k] = (text.match(re) ?? []).length;
  out.lines = text ? text.split(/\r?\n/).length : 0;
  out.firstError = text.split(/\r?\n/).find((l) => ERROR_LINE.test(l))?.trim().slice(0, 600) ?? null;
  return out;
}

/** @param {any} v @param {string[]} into */
function errorTexts(v, into) {
  if (!v || typeof v !== 'object') return;
  if (Array.isArray(v)) return v.forEach((x) => errorTexts(x, into));
  for (const [k, x] of Object.entries(v)) {
    if (k === 'error' && x) into.push(typeof x === 'string' ? x : String(x.message ?? JSON.stringify(x)));
    else errorTexts(x, into);
  }
}

/**
 * The install record for a support file. A record that can't be read is itself worth reporting,
 * so this never throws.
 * @param {string} file
 * @returns {{ config: import('./config.js').InstallConfig, existed: boolean, error?: string }}
 */
export function loadRecord(file) {
  try {
    return loadConfig(file);
  } catch (err) {
    return { config: emptyConfig(), existed: existsSync(file), error: reason(err) };
  }
}

/**
 * @typedef {object} SupportInput
 * @property {import('./config.js').InstallConfig} config
 * @property {string} configFile
 * @property {boolean} recordExists
 * @property {string} [recordError]  Why the install record couldn't be read.
 * @property {string} version
 * @property {Date} [now]
 * @property {any} [api]  Signed-in clients; without them the live parts say why they are missing.
 * @property {{ upn?: string, displayName?: string, tenantId?: string }} [user]
 * @property {string} [offline]  Why there's no sign-in.
 * @property {any[]} [prereqs]  A prerequisites check already made, such as the web page's.
 * @property {string[]} [logFiles]  Collector or script logs to summarise, never include.
 * @property {(c: { api: any, user: any, config: import('./config.js').InstallConfig }) => Promise<any[]>} [checkPrereqs]
 */

/**
 * Gathers what goes into the support file. Every part is collected on its own; a part that fails
 * says why.
 * @param {SupportInput} o
 */
export async function collectSupport(o) {
  const now = o.now ?? new Date();
  const { config } = o;
  const route = config.target === 'azure' ? 'azure' : 'fabric';
  const runs = readRunLog(o.configFile);
  const live = o.api ? null : (o.offline ?? 'Not signed in.');
  const c = { api: o.api, config, now: () => now };

  /** @type {any} */
  let prereqs;
  if (o.prereqs) prereqs = { checkedAt: now.toISOString(), items: o.prereqs };
  else if (!live && o.checkPrereqs) prereqs = await attempt(async () => ({ checkedAt: now.toISOString(), items: await /** @type {any} */ (o.checkPrereqs)({ api: o.api, user: o.user, config }) }));
  else {
    const last = [...runs].reverse().find((r) => r.prereqs);
    prereqs = last ? { checkedAt: last.finishedAt ?? last.startedAt, fromRun: last.command, items: last.prereqs } : notCollected(live ?? 'No prerequisites check has run.');
  }

  const runStatus = live ? notCollected(`${live} Run statuses need a sign-in.`) : await attempt(() => (route === 'azure' ? azureRuns(c) : fabricRuns(c)));
  const counts = live ? notCollected(`${live} Row counts need a sign-in.`) : await attempt(() => rowCounts(c));

  /** @type {Record<string, any>} */
  const logs = {};
  const runText = runs.flatMap((r) => [r.error ?? '', ...r.steps.flatMap((s) => s.lines.map((l) => l.text))]).join('\n');
  logs.installerRuns = runs.length ? summariseLog(runText) : notCollected('No installer run is recorded yet.');
  /** @type {string[]} */
  const errs = [];
  errorTexts(runStatus, errs);
  logs.runErrors = runStatus?.notCollected ? notCollected(runStatus.notCollected) : summariseLog(errs.join('\n'));
  for (const file of o.logFiles ?? []) {
    const key = `file:${basename(file)}`;
    try {
      const size = statSync(file).size;
      const buf = readFileSync(file);
      logs[key] = { ...summariseLog(buf.subarray(Math.max(0, buf.length - MAX_LOG_BYTES)).toString('utf8')), bytes: size, ...(size > MAX_LOG_BYTES ? { readLastBytes: MAX_LOG_BYTES } : {}) };
    } catch (err) {
      logs[key] = notCollected(reason(err));
    }
  }

  return {
    product: SUPPORT_PRODUCT,
    installerVersion: o.version,
    createdAt: now.toISOString(),
    route,
    signedIn: !live,
    user: o.user ? { upn: o.user.upn, displayName: o.user.displayName, tenantId: o.user.tenantId } : undefined,
    settings: o.recordError ? notCollected(o.recordError) : o.recordExists ? config : notCollected(`No install record at ${basename(o.configFile)}.`),
    lastRun: runs.length ? { ...runs[runs.length - 1], earlierRuns: runs.slice(0, -1).reverse().map((r) => ({ command: r.command, startedAt: r.startedAt, ok: r.ok, failedStep: r.failedStep, error: r.error })) } : notCollected('No installer run is recorded yet.'),
    prereqs,
    runs: runStatus,
    rowCounts: counts,
    logsSummary: logs,
  };
}

/* ---------- The files ---------- */

/** @typedef {{ name: string, text: string }} SupportFile */

/**
 * The redacted files of a support file, in order, with README.txt and manifest.json first.
 * @param {Awaited<ReturnType<typeof collectSupport>>} s
 * @param {{ salt?: Buffer }} [o]
 * @returns {SupportFile[]}
 */
export function buildSupportFiles(s, o = {}) {
  const r = createRedactor({ salt: o.salt });
  r.learn(s);
  const json = (/** @type {unknown} */ v) => `${JSON.stringify(r.value(v), null, 2)}\n`;
  const body = [
    { name: 'settings.json', text: json(s.settings) },
    { name: 'last-run.json', text: json(s.lastRun) },
    { name: 'prereqs.json', text: json(s.prereqs) },
    { name: 'runs.json', text: json(s.runs) },
    { name: 'row-counts.json', text: json(s.rowCounts) },
    { name: 'logs-summary.json', text: json(s.logsSummary) },
  ];
  const readme = [
    `${SUPPORT_PRODUCT} support file`,
    '',
    `Made by installer ${s.installerVersion} on ${s.createdAt.slice(0, 19).replace('T', ' ')} UTC, for the ${s.route === 'azure' ? 'Azure' : 'Fabric'} route.`,
    s.signedIn ? `Signed in as ${r.value({ upn: s.user?.upn }).upn ?? 'unknown'}, so it includes live run statuses and row counts.` : 'Made without signing in, so run statuses and row counts say "notCollected".',
    '',
    'Files:',
    '  manifest.json       What is in this file and what redaction removed.',
    '  settings.json       The install record: IDs and choices.',
    '  last-run.json       The last installer run, step by step, with the step that failed and its error.',
    '  prereqs.json        Roles, licences, capacities and permissions: which are met and which are missing.',
    '  runs.json           Recent pipeline, notebook, refresh and Azure job runs, with their errors.',
    '  row-counts.json     Rows per table. Counts only, never the rows.',
    '  logs-summary.json   Counts of throttling (429), sign-in (401) and permission (403) errors, time-outs and windows.',
    '',
    'What was removed or hidden:',
    ...REDACTION_RULES.map((rule) => `  - ${rule}`),
    '',
    'Every file is plain text. Open them to check before you send this file.',
    '',
  ].join('\n');
  const files = [{ name: 'README.txt', text: readme }, ...body];
  const manifest = {
    product: s.product,
    installerVersion: s.installerVersion,
    madeBy: `installer ${s.installerVersion}`,
    createdAt: s.createdAt,
    route: s.route,
    signedIn: s.signedIn,
    files: files.map((f) => ({ name: f.name, bytes: Buffer.byteLength(f.text, 'utf8') })),
    redaction: { rules: REDACTION_RULES, counts: { ...r.counts } },
  };
  return [files[0], { name: 'manifest.json', text: `${JSON.stringify(manifest, null, 2)}\n` }, ...body];
}

/** @param {Date} d */
export const supportFileName = (d) => `${PREFIX}-${d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)}.zip`;

/**
 * Writes the support file and returns its path.
 * @param {SupportFile[]} files
 * @param {string} outDir
 * @param {Date} [now]
 */
export function writeSupportFile(files, outDir, now = new Date()) {
  const dir = resolve(outDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = join(dir, supportFileName(now));
  writeFileSync(path, writeZip(files.map((f) => ({ name: f.name, data: f.text })), now));
  return path;
}

/**
 * The zip's bytes, for the web page to download.
 * @param {SupportFile[]} files
 * @param {Date} [now]
 */
export const supportZip = (files, now = new Date()) => writeZip(files.map((f) => ({ name: f.name, data: f.text })), now);
