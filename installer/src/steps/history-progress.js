// @ts-check
/**
 * How much audit history has loaded, for `status`, and a load of history the installer couldn't start, so that
 * `status` and the next steps still give its command.
 *
 * Progress is read only with the access the install already has: the audit notebook's manifest in the Lakehouse
 * on Fabric, and the run job's state in its storage on Azure. Nothing here adds a role, a scope or a network rule
 * to read it. When it can't be read (a private install, no access to the files, a network error), `status` says
 * so and falls back to what was asked for and the runs since. It never fails because of it.
 *
 * Fetched isn't published. On Fabric, the manifest records the windows the audit load has fetched, and a first
 * load or a reload writes them to the table once every window is fetched. On Azure, the state's high-water mark
 * moves once a run has merged every window, so the history up to it is in the reports. Fetched windows reach the
 * reports when a run merges them, near its end. A run of a job image from 0.6.9 fetches the newest windows first
 * and merges what it fetched even when it stops at its time limit, and the state then says how far back the
 * reports go and how many windows are left. An older image's run publishes only when it fetches everything left.
 */
import { adminConsentUrl, apiPermissionsUrl } from '../clients/graph.js';
import { HttpError } from '../http.js';
import { commandLine } from '../launch.js';
import { scaleProfile } from '../transform/pipeline.js';

/** @typedef {import('../install.js').Ctx} Ctx */
/** @typedef {import('./next-steps.js').NextStep} NextStep */

/**
 * The audit notebook's manifest of the windows it has queried, in the Lakehouse (STAGING_DIR in
 * fabric/notebooks/Copilot_Audit_Log_Direct_Ingester.ipynb). #169's audit-check.js names the same file:
 * whichever lands second uses one constant.
 */
export const AUDIT_MANIFEST = 'Files/_audit_staging/_manifest.json';

/** The run job's audit state, in its storage (STATE in azure/jobs/valuelens_jobs/collect/audit.py). */
export const AUDIT_STATE = Object.freeze({ container: 'raw', path: '_state/audit.json' });

/** The Azure job's audit window, in hours (CHUNK_HOURS in its collector). */
export const AZURE_CHUNK_HOURS = 8;

/** The notebook's audit window on an install with no tenant size: the template's. */
const TEMPLATE_CHUNK_HOURS = 8;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A run that started longer ago than this is stuck, not running, as when starting one. */
const STUCK_MS = DAY;

/** @param {unknown} v @returns {v is Record<string, any>} */
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** A time's UTC date, yyyy-mm-dd. @param {number} ms */
export const day = (ms) => new Date(ms).toISOString().slice(0, 10);

/** @param {number} v */
const n = (v) => v.toLocaleString('en-GB');

/**
 * Milliseconds for a time in the progress files, written by Python's isoformat ("+00:00", microseconds). A time
 * with no zone is UTC. undefined for anything else.
 * @param {unknown} v
 * @returns {number | undefined}
 */
export function utcTime(v) {
  if (typeof v !== 'string' || !v.trim()) return undefined;
  const s = v.trim();
  const t = Date.parse(/T[\d:.]+$/.test(s) ? `${s}Z` : s);
  return Number.isFinite(t) ? t : undefined;
}

const WINDOW_KEY = /^(?:v\d+_)?(\d{12})_(\d{12})$/;

/** @param {string} s  yyyymmddHHMM, UTC. */
const keyTime = (s) => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12));

/**
 * A window's range from its key, such as "v2_202605010800_202605011600", or "202605010800_202605011600" from a
 * notebook before keys had a version. undefined for any other key.
 * @param {string} key
 * @returns {{ start: number, end: number } | undefined}
 */
export function keyRange(key) {
  const m = WINDOW_KEY.exec(key);
  if (!m) return undefined;
  const start = keyTime(m[1]);
  const end = keyTime(m[2]);
  return end > start ? { start, end } : undefined;
}

/**
 * A window entry's range: its own times, or its key's.
 * @param {string} key
 * @param {Record<string, any>} entry
 */
function windowRange(key, entry) {
  const start = utcTime(entry.window_start);
  const end = utcTime(entry.window_end);
  if (start !== undefined && end !== undefined && end > start) return { start, end };
  return keyRange(key);
}

/**
 * The window entries, whatever their key's version. A first load from an older notebook is in the table, so its
 * windows count, even though a reload fetches them again under the newer keys.
 * @param {Record<string, any>} entries
 * @returns {[string, Record<string, any>][]}
 */
const windowEntries = (entries) => Object.entries(entries).filter(([, e]) => isObject(e));

/**
 * @typedef {object} FetchedWindow
 * @property {number} start
 * @property {number} end
 * @property {number} [rows]  The records it returned, when the entry says.
 */

/**
 * The windows a load has fetched, oldest first: the succeeded entries. A split window's halves have entries of
 * their own. Anything that isn't a window entry counts as nothing fetched.
 * @param {unknown} entries
 * @returns {FetchedWindow[]}
 */
export function fetchedWindows(entries) {
  if (!isObject(entries)) return [];
  /** @type {FetchedWindow[]} */
  const out = [];
  for (const [key, entry] of windowEntries(entries)) {
    if (entry.status !== 'succeeded') continue;
    const range = windowRange(key, entry);
    if (!range) continue;
    out.push(typeof entry.rows === 'number' && entry.rows >= 0 ? { ...range, rows: entry.rows } : range);
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end);
}

/**
 * The end of the newest window a run has started on, fetched or not. A run plans its windows up to its own
 * start, so the history it's loading ends about then.
 * @param {unknown} entries
 * @returns {number | undefined}
 */
export function newestEnd(entries) {
  if (!isObject(entries)) return undefined;
  /** @type {number | undefined} */
  let newest;
  for (const [key, entry] of windowEntries(entries)) {
    if (typeof entry.status !== 'string') continue;
    const end = windowRange(key, entry)?.end;
    if (end !== undefined && (newest === undefined || end > newest)) newest = end;
  }
  return newest;
}

/**
 * @typedef {object} Coverage
 * @property {number} fetchedHours  How much of the range the fetched windows cover.
 * @property {number} windowsLeft  About how many windows are still to fetch.
 * @property {boolean} complete  The windows cover the range, give or take a window at each end.
 * @property {number} [through]  Where the history fetched from the start of the range runs to.
 * @property {boolean} tailOnly  Only the newest part of the range is still to fetch.
 * @property {boolean} allEmpty  Complete, and every window came back with no records.
 */

/**
 * How much of the history from `from` to `until` the fetched windows cover. A run's windows start on the hour at
 * or before its range and end at its start, so a window's worth at each end doesn't count as missing.
 * @param {FetchedWindow[]} windows  Oldest first.
 * @param {{ from: number, until: number, chunkHours?: number }} range
 * @returns {Coverage}
 */
export function coverage(windows, { from, until, chunkHours }) {
  const chunk = Math.max(Number(chunkHours) || TEMPLATE_CHUNK_HOURS, 1) * HOUR;
  const slack = Math.max(chunk, 2 * HOUR);
  const span = Math.max(until - from, 0);
  /** @type {[number, number][]} */
  const merged = [];
  for (const w of windows) {
    const s = Math.max(w.start, from);
    const e = Math.min(w.end, until);
    if (e <= s) continue;
    const last = merged[merged.length - 1];
    if (last && s <= last[1] + MINUTE) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  const fetched = merged.reduce((sum, [s, e]) => sum + (e - s), 0);
  const startsAtFrom = merged.length > 0 && merged[0][0] - from <= slack;
  const endsAtUntil = merged.length > 0 && until - merged[merged.length - 1][1] <= slack;
  const complete = startsAtFrom && endsAtUntil && merged.length === 1;
  const inRange = windows.filter((w) => w.end > from && w.start < until);
  return {
    fetchedHours: fetched / HOUR,
    windowsLeft: complete ? 0 : Math.max(Math.round((span - fetched) / chunk), 1),
    complete,
    ...(startsAtFrom ? { through: merged[0][1] } : {}),
    tailOnly: !complete && startsAtFrom && merged.length === 1,
    allEmpty: complete && inRange.length > 0 && inRange.every((w) => w.rows === 0),
  };
}

/** "1 window", "30 windows". @param {number} count */
const windowCount = (count) => `${n(count)} ${count === 1 ? 'window' : 'windows'}`;

/**
 * "about 47 of 180 days, 2025-12-03 to 2026-01-19; about 133 windows left". With `left`, the job's own count of
 * the windows left, that count instead of an estimate.
 * @param {Coverage} cov
 * @param {number} days
 * @param {number} from
 * @param {number} [left]
 */
function fetchedText(cov, days, from, left) {
  const remaining = left === undefined ? `about ${windowCount(cov.windowsLeft)}` : windowCount(left);
  if (cov.fetchedHours <= 0) return left === undefined ? 'none yet' : `none yet; ${remaining} left`;
  const range = cov.through !== undefined ? `, ${day(from)} to ${day(cov.through)}` : '';
  if (cov.complete) return `all ${n(days)} days${range}`;
  const whole = Math.min(Math.round(cov.fetchedHours / 24), days - 1);
  const got = whole < 1 ? `less than a day of ${n(days)}` : `about ${n(whole)} of ${n(days)} days${range}`;
  return `${got}; ${remaining} left`;
}

/**
 * @typedef {object} Progress  What a load has recorded.
 * @property {true} read
 * @property {Record<string, any>} entries  The windows it has started on, by key.
 * @property {FetchedWindow[]} windows  Those fetched.
 * @property {boolean} [missing]  No file yet: no load has started on a window.
 * @property {number} [highWaterMark]  Azure: the newest activity a run has merged, so it's in the reports.
 * @property {number} [backfillFrom]  Azure: where a reload that no run has merged yet starts.
 * @property {number} [windowsLeft]  Azure, from 0.6.9's job image: the windows the last run left for the next, when
 *   it stopped at its time limit or a window failed. Not there while no run has stopped with windows left.
 * @property {number} [loadedBackTo]  Azure, from 0.6.9: how far back the windows merged so far go, newest first.
 * @property {number} [pausedAt]  Azure, from 0.6.9: when the last run stopped at its time limit with windows left.
 */
/** @typedef {'private' | 'forbidden' | 'unavailable' | 'unreadable' | 'error'} Unread */
/** @typedef {{ read: false, reason: Unread }} NoProgress */

/**
 * @param {Record<string, any>} entries
 * @param {Partial<Omit<Progress, 'read' | 'entries' | 'windows'>>} [extra]
 * @returns {Progress}
 */
function progressOf(entries, extra = {}) {
  /** @type {Progress} */
  const p = { read: true, entries, windows: fetchedWindows(entries) };
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) Object.assign(p, { [k]: v });
  return p;
}

/** @param {unknown} err @returns {Unread} */
const unreadReason = (err) =>
  err instanceof HttpError && (err.status === 401 || err.status === 403) ? 'forbidden' : err instanceof SyntaxError ? 'unreadable' : 'error';

/**
 * The audit notebook's manifest. Never throws: what stops it being read is the reason.
 * @param {Ctx} ctx
 * @returns {Promise<Progress | NoProgress>}
 */
export async function readFabricProgress(ctx) {
  const f = ctx.config.fabric;
  const lake = ctx.api?.oneLake;
  if (!f?.workspaceId || !f.lakehouseId || typeof lake?.readJson !== 'function') return { read: false, reason: 'unavailable' };
  try {
    const doc = await lake.readJson(f.workspaceId, f.lakehouseId, AUDIT_MANIFEST);
    if (doc === null || doc === undefined) return progressOf({}, { missing: true });
    if (!isObject(doc)) return { read: false, reason: 'unreadable' };
    return progressOf(isObject(doc.windows) ? doc.windows : doc);
  } catch (err) {
    return { read: false, reason: unreadReason(err) };
  }
}

/**
 * The run job's audit state. Never throws. A private install's storage can't be reached from outside its
 * network, so it isn't tried. Fields it doesn't know are ignored, and those missing count as unknown.
 * @param {Ctx} ctx
 * @returns {Promise<Progress | NoProgress>}
 */
export async function readAzureProgress(ctx) {
  const az = ctx.config.azure;
  if (az?.publicNetworkAccess === false) return { read: false, reason: 'private' };
  const account = az?.outputs?.storageAccountName;
  if (!account || typeof ctx.api?.dataLake !== 'function') return { read: false, reason: 'unavailable' };
  try {
    const text = await ctx.api.dataLake(String(account)).readText(AUDIT_STATE.container, AUDIT_STATE.path);
    if (text === null || text === undefined) return progressOf({}, { missing: true });
    const doc = typeof text === 'string' ? JSON.parse(text) : text;
    if (!isObject(doc)) return { read: false, reason: 'unreadable' };
    return progressOf(isObject(doc.windows) ? doc.windows : {}, {
      highWaterMark: utcTime(doc.high_water_mark),
      backfillFrom: utcTime(doc.backfill_from),
      windowsLeft: Number.isInteger(doc.windows_left) && doc.windows_left >= 0 ? doc.windows_left : undefined,
      loadedBackTo: utcTime(doc.loaded_back_to),
      pausedAt: utcTime(doc.paused_at),
    });
  } catch (err) {
    return { read: false, reason: unreadReason(err) };
  }
}

/** Why the progress can't be read from this PC. The installer doesn't add access to read it. @type {Record<'fabric' | 'azure', Record<Unread, string>>} */
const UNREAD = {
  fabric: {
    private: "the Lakehouse can't be reached from this PC",
    forbidden: "your account can't read the Lakehouse's files",
    unavailable: "the install record doesn't name the Lakehouse",
    unreadable: 'its progress file is in a form this installer doesn\'t know',
    error: "the Lakehouse couldn't be reached just now",
  },
  azure: {
    private: "it's a private install, so its storage can't be reached from outside its network",
    forbidden: "your account can't read the job's storage",
    unavailable: "the install record doesn't name the job's storage",
    unreadable: 'the job\'s progress file is in a form this installer doesn\'t know',
    error: "the job's storage couldn't be reached just now",
  },
};

/**
 * The newest of some times, or `fallback` when there are none.
 * @param {(number | undefined)[]} times
 * @param {number} fallback
 */
function latest(times, fallback) {
  const known = /** @type {number[]} */ (times.filter((t) => t !== undefined && Number.isFinite(t)));
  return known.length ? Math.max(...known) : fallback;
}

/**
 * "Asked for: 180 days", and a load that's waiting to start.
 * @param {number} days
 * @param {PendingHistory | undefined} pending
 */
function askedLine(days, pending) {
  if (!pending) return `Asked for: ${n(days)} days`;
  if (pending.first || pending.days <= days) return `Asked for: ${n(Math.max(days, pending.days))} days, waiting to start (see the step below)`;
  return `Asked for: ${n(days)} days, and a reload of ${n(pending.days)} days waiting to start (see the step below)`;
}

/**
 * Whether a Fabric job is going: not finished, and started less than a day ago.
 * @param {any} job @param {number} now
 */
export const fabricJobGoing = (job, now) => {
  if (job?.status !== 'InProgress' && job?.status !== 'NotStarted') return false;
  const started = utcTime(job.startTimeUtc);
  return !(started !== undefined && now - started > STUCK_MS);
};

/**
 * The audit history in `status` on Fabric: what was asked for, how much the audit load has fetched, and what the
 * reports have. The audit load writes a first load or a reload to the table only once every window is fetched.
 * @param {Ctx} ctx
 * @param {{ jobs?: any[], summary?: any, loaded?: boolean }} [opts]  jobs: the pipeline's runs. summary: the last
 *   data check's. loaded: whether the history has loaded, as `run` decides it; without it, from the install record
 *   and these runs.
 */
export async function fabricHistory(ctx, opts = {}) {
  const { ui, config } = ctx;
  const jobs = opts.jobs ?? [];
  const days = config.history.days;
  const now = ctx.now().getTime();
  const pending = pendingHistory(config);
  const running = jobs.some((j) => fabricJobGoing(j, now));
  const loaded = opts.loaded ?? (config.firstRun ? config.firstRun.status === 'Completed' : jobs.some((j) => j.status === 'Completed'));
  ui.heading('Audit history');
  ui.info(askedLine(days, pending));
  const progress = await readFabricProgress(ctx);
  /** @type {Coverage | undefined} */
  let cov;
  if (progress.read && !(progress.missing && loaded)) {
    const until = latest([utcTime(config.firstRun?.startedAt), newestEnd(progress.entries)], now);
    const from = until - days * DAY;
    cov = coverage(progress.windows, { from, until, chunkHours: scaleProfile(config.scale).audit.CHUNK_HOURS });
    ui.info(`Fetched from the audit log: ${fetchedText(cov, days, from)}`);
  } else if (!progress.read) {
    ui.info(`How much has been fetched can't be read from this PC: ${UNREAD.fabric[progress.reason]}.`);
  }
  const audit = opts.summary?.tables?.audit;
  if (audit?.from && audit?.to) ui.info(`In the reports: ${String(audit.from).slice(0, 10)} to ${String(audit.to).slice(0, 10)}, at the last data check`);
  else if (audit && !Number(audit.rows)) ui.info('In the reports: no Copilot activity, at the last data check');
  else if (!loaded) ui.info('In the reports: not the full history yet. The first load writes it once every window is fetched.');
  else ui.info(`In the reports: run "${commandLine('check')}" to see the dates.`);
  // A load waiting to start has its own step, with its command.
  if (pending) return;
  const incomplete = !loaded || (cov ? !cov.complete : false);
  if (!incomplete) return;
  if (running) {
    ui.note("The pipeline is running. If its audit load reaches its time budget, the pipeline's retries carry on from where it stopped.");
  } else if (!jobs.length && !config.firstRun) {
    ui.note(`Start the first load with "${commandLine('run')}".`);
  } else if (loaded && cov?.tailOnly) {
    ui.note(`The newest days load with the next scheduled run. Start one sooner with "${commandLine('run')}".`);
  } else {
    const again = commandLine(loaded ? `run --backfill-days ${days}` : 'run');
    if (cov && cov.fetchedHours <= 0) ui.note(`To load it, run "${again}".`);
    else ui.note(`To carry on, run "${again}". It reuses ${cov ? 'the' : 'any'} windows already fetched.`);
  }
}

/** @param {any} r  A run job execution. */
const startOf = (r) => utcTime(r?.properties?.startTime ?? r?.startTime);

/**
 * A run of only some of the job's steps, which doesn't load audit history. Its arguments aren't always listed.
 * @param {any} r
 */
const stepsOnly = (r) => (r?.properties?.template?.containers ?? []).some((/** @type {any} */ c) => Array.isArray(c?.args) && c.args.includes('--steps'));

/**
 * Whether an execution is going: Running or Processing, and started less than a day ago. One with no start
 * time counts as going, as when starting a run.
 * @param {any} r @param {number} now
 */
const executionGoing = (r, now) => {
  if (!/^(Running|Processing)$/i.test(r?.properties?.status ?? r?.status ?? '')) return false;
  const started = startOf(r);
  return !(started !== undefined && now - started > STUCK_MS);
};

/**
 * The audit history in `status` on Azure: what was asked for, what the reports have, and what's left to fetch.
 * A run publishes what it has merged, near its end. From 0.6.9, the job fetches the newest windows first and
 * merges what it fetched also when it stops at its time limit, and its state then says how far back that goes and
 * how many windows are left. Without those fields (an older job image, or no run has stopped with windows left),
 * the wording holds for either image: an older image's run publishes only when it fetches everything left.
 * @param {Ctx} ctx
 * @param {{ executions?: any[] }} [opts]  The run job's executions.
 */
export async function azureHistory(ctx, opts = {}) {
  const { ui, config } = ctx;
  const az = config.azure;
  if (!az?.outputs?.runJobName || az.sampleData) return;
  const days = config.history.days;
  const now = ctx.now().getTime();
  const pending = pendingHistory(config);
  const executions = (opts.executions ?? []).filter((r) => !stepsOnly(r));
  const running = executions.some((r) => executionGoing(r, now));
  const again = commandLine('run');
  ui.heading('Audit history');
  ui.info(askedLine(days, pending));
  const progress = await readAzureProgress(ctx);
  if (!progress.read) {
    ui.info(`How much has loaded can't be read from this PC: ${UNREAD.azure[progress.reason]}.`);
    if (!pending) ui.note("The reports fill in as the run job's runs publish, and have the history asked for once those runs have loaded all of it. The runs are listed above.");
    return;
  }
  const { highWaterMark: hwm, backfillFrom, windowsLeft, loadedBackTo, pausedAt } = progress;
  // The job's own count of the windows the last run left for the next.
  const left = windowsLeft !== undefined && windowsLeft > 0 ? windowsLeft : undefined;
  const pausedOn = left !== undefined && pausedAt !== undefined ? day(pausedAt) : undefined;
  if (hwm !== undefined && backfillFrom === undefined) {
    ui.ok(`In the reports: activity up to ${day(hwm)}`);
    // A scheduled run that reached its time limit before it had fetched every window.
    if (left !== undefined && pausedOn !== undefined && !pending) {
      ui.note(running
        ? `A run is going now, and carries on with the ${windowCount(left)} the last run left.`
        : `The last run reached its time limit on ${pausedOn} with ${windowCount(left)} left. The next scheduled run carries on with them, or start one now with "${again}".`);
    }
    return;
  }
  const until = latest([...executions.map(startOf), utcTime(az.status?.lastRun?.startedAt), newestEnd(progress.entries)], now);
  const from = Math.min(until - days * DAY, backfillFrom ?? Infinity);
  const cov = coverage(progress.windows, { from, until, chunkHours: AZURE_CHUNK_HOURS });
  const empty = hwm === undefined && cov.complete && cov.allEmpty;
  if (hwm !== undefined) {
    const reached = loadedBackTo !== undefined ? ` It has loaded back to ${day(loadedBackTo)} so far, newest first.` : '';
    ui.info(`In the reports: activity up to ${day(hwm)}. The reload from ${day(/** @type {number} */ (backfillFrom))} isn't all in them yet.${reached}`);
  }
  if (empty) {
    ui.info(`Fetched from the audit log: all ${n(days)} days, with no Copilot activity in them`);
    ui.info('In the reports: no Copilot activity, because the audit log returned none for those days');
    return;
  }
  // The job counts the windows left when a run stops. While the next run is going, its entries move on: the estimate.
  ui.info(`Fetched from the audit log: ${fetchedText(cov, days, from, running ? undefined : left)}`);
  if (hwm === undefined) {
    if (loadedBackTo !== undefined) ui.info(`In the reports: activity back to ${day(loadedBackTo)} so far, newest first`);
    else ui.info(`In the reports: ${cov.fetchedHours > 0 ? 'not all of it yet' : 'none of it yet'}`);
  }
  if (pending) return;
  if (running) {
    ui.note(left !== undefined
      ? 'A run is going now. It publishes what it has loaded when it finishes or reaches its time limit, and the next run carries on with any windows left.'
      : 'A run is going now. What it fetches reaches the reports when it publishes, near the end of the run.');
  } else if (pausedOn !== undefined) {
    ui.note(cov.fetchedHours > 0 || loadedBackTo !== undefined
      ? `The last run reached its time limit on ${pausedOn} and published what it had loaded. The next scheduled run carries on with the rest, or start one now with "${again}".`
      : `The last run reached its time limit on ${pausedOn} before any of it had loaded. The next scheduled run carries on, or start one now with "${again}".`);
  } else if (cov.complete) ui.note(`The next run publishes it. Start one sooner with "${again}".`);
  else if (cov.fetchedHours > 0) ui.note(`The next scheduled run carries on where it stopped, or start one now with "${again}".`);
  else ui.note(`The next scheduled run starts loading it, or start one now with "${again}".`);
}

/**
 * A load of audit history the installer couldn't start, kept in the install record so its command isn't lost
 * when the window closes. Installers that don't know it ignore it. It clears once a run with that load starts.
 * @typedef {object} PendingHistory
 * @property {number} days
 * @property {'consent' | 'keyVault' | 'running' | 'failed'} reason  What stopped it: admin consent, the Key Vault's
 *   private endpoint, a run that was going, or an error starting it.
 * @property {string} at  When.
 * @property {boolean} [first]  The first load, rather than a reload of more history.
 */

/**
 * The load waiting to start, if any. One a later run has started, by this installer or an older one, doesn't count.
 * @param {import('../config.js').InstallConfig} config
 * @returns {PendingHistory | undefined}
 */
export function pendingHistory(config) {
  const p = config.history?.pending;
  if (!isObject(p) || !(Number(p.days) > 0)) return undefined;
  if (p.first) {
    const last = config.azure?.status?.lastRun;
    const started = utcTime(config.target === 'azure' ? last?.startedAt ?? last?.finishedAt : config.firstRun?.startedAt);
    const at = utcTime(p.at);
    if (started !== undefined && at !== undefined && started > at) return undefined;
  } else if ((config.history.days ?? 0) >= p.days) return undefined;
  return /** @type {PendingHistory} */ (p);
}

/**
 * Records a load of history that didn't start. A bigger one waiting already keeps its days.
 * @param {Ctx} ctx
 * @param {{ days: number | undefined, reason: PendingHistory['reason'], first?: boolean }} load
 */
export function recordPendingHistory(ctx, { days, reason, first }) {
  if (!days || !(days > 0)) return;
  const prev = pendingHistory(ctx.config);
  ctx.config.history.pending = {
    days: Math.max(days, prev?.days ?? 0),
    reason,
    at: ctx.now().toISOString(),
    ...(first || prev?.first ? { first: true } : {}),
  };
  ctx.save();
}

/**
 * Clears the load waiting to start once a run that covers it has started.
 * @param {Ctx} ctx
 * @param {{ days?: number, first?: boolean }} load  The run's days of history, and whether it's the first load.
 */
export function clearPendingHistory(ctx, { days = 0, first = false }) {
  const p = ctx.config.history?.pending;
  if (!p) return;
  if (days >= (Number(p.days) || 0) || (first && p.first)) {
    delete ctx.config.history.pending;
    ctx.save();
  }
}

/**
 * The card for a load of history waiting to start: clear what stopped it, then run it. Its command already
 * exists; this only keeps it in sight.
 * @param {import('../config.js').InstallConfig} config
 * @param {{ tenantId?: string }} [user]
 * @returns {NextStep | null}
 */
export function historyStep(config, user = {}) {
  const p = pendingHistory(config);
  if (!p) return null;
  const what = p.first ? 'The first load' : `The reload of ${n(p.days)} days`;
  const vault = config.keyVault?.name ?? 'the Key Vault';
  const why = {
    consent: `${what} didn't start, because the data collector app's permissions haven't been approved yet.`,
    keyVault: `${what} didn't start, because the private endpoint to ${vault} hasn't been approved yet.`,
    running: `${what} didn't start, because a run was already going.`,
    failed: `${what} didn't start.`,
  }[p.reason] ?? `${what} didn't start.`;
  const until = p.first ? "Until it runs, the reports don't have the history." : 'Until it runs, the reports keep the history they have.';
  /** @type {string[]} */
  const steps = [];
  /** @type {{ link?: string, linkText?: string }} */
  let link = {};
  const appId = config.app?.appId;
  if (p.reason === 'consent') {
    if (appId) link = { link: apiPermissionsUrl(appId), linkText: "The app's API permissions in Entra" };
    steps.push(
      appId
        ? `Ask a Global Administrator or Privileged Role Administrator to open the link and select "Grant admin consent"${user.tenantId ? `, or to use ${adminConsentUrl(user.tenantId, appId)}` : ''}.`
        : 'Ask a Global Administrator or Privileged Role Administrator to grant admin consent to the data collector app.',
    );
  } else if (p.reason === 'keyVault') {
    const id = config.keyVault?.id;
    if (id && user.tenantId) link = { link: `https://portal.azure.com/#@${user.tenantId}/resource${id}/networking`, linkText: "The vault's networking in the Azure portal" };
    steps.push(`Ask someone who manages ${vault} to approve the private endpoint, under Networking, Private endpoint connections.`);
  } else if (p.reason === 'running') {
    steps.push(`Wait for the run that's going to finish. "${commandLine('status')}" shows it.`);
  }
  steps.push(`Run "${commandLine(`run --backfill-days ${p.days}`)}".`, `See how far it has got with "${commandLine('status')}".`);
  return {
    id: 'load-history',
    title: `Load ${n(p.days)} days of audit history`,
    why: `${why} ${until}`,
    who: 'You',
    ...link,
    steps,
  };
}

/**
 * Shows the card for a load of history waiting to start, if there is one.
 * @param {Ctx} ctx
 */
export function showHistoryStep(ctx) {
  const card = historyStep(ctx.config, ctx.user ?? {});
  if (card) ctx.ui.nextSteps('1 step left', [card]);
}
