// @ts-check
/**
 * How long loading the audit history is likely to take: one table, by target, tenant size and days. The plan
 * shows it beside the history question, and the installer says it again when the first load or a reload starts.
 *
 * Two things set the figures. Both are estimates until timed installer runs replace them.
 *
 * The audit searches. A load starts one audit search for each window it fetches (WINDOW_HOURS). A tenant can start
 * at least 200 in a rolling 24 hours, shared with other admins and tools, and a tenant with more eligible licences
 * can get more. How many more isn't published:
 * https://learn.microsoft.com/graph/throttling-limits#security-audit-log-query-service-limits
 * A load that needs more than 200 stops when they're used up, and a run a day later carries on. So S searches take
 * k to k+1 days, where k = floor((S - 1) / 200), over k + 1 to k + 2 runs. The extra run is for the searches others
 * start and the windows searched again, such as a window split at the audit service's record limit.
 *
 * The time, for a load within the allowance: 45 minutes and 0.6 a search, to 60 minutes and 1.2 a search, each end
 * rounded to the nearest hour and at least 1. A large tenant's searches take half as long again: it has about three
 * times the records to fetch and process, but most of a search is the audit service's queue. The fixed part covers
 * the other loads, processing and publishing. The figures per search come from two measurements:
 * - On Azure, 30 days of history took 58 minutes by hand: 90 queries of 8 hours, 5 at a time, so about 3 minutes
 *   for each round of 5, most of it waiting in the audit service's queue. That's 0.6 minutes a search; the high end
 *   doubles it.
 * - In an offline test at 20,000 seats, with the audit service simulated (installer/README.md, "How long the first
 *   load takes"), collecting took about 3 minutes for 30 days and 18 for 180, and processing about 3 and 25 to 35.
 *
 * On Fabric, the audit load stops at its time budget (90 minutes, or 300 for a large tenant) and the pipeline's two
 * retries carry on, so one run fetches for up to three budgets. The schedule loads only the newest days, so it
 * doesn't carry a first load or a reload on: each run after the first is started by hand. On Azure, a run has
 * 4 hours and keeps at least the last hour to process and publish, so it fetches for up to about 3 hours (less
 * what the other collectors take first), then publishes what it has loaded; no retry is counted on. So a load
 * whose high end reaches 4 hours can take a second run. A run stopped at its time limit starts the next one
 * straight away when the run job can start itself; otherwise, and after a stop at the search limit, the next
 * scheduled run carries the load on. The audit service's queue on a busy day isn't counted: it can add hours.
 */
import { commandLine } from './launch.js';

/** The rows of the table: the history the installer offers. A load of other days uses the next row up. */
export const ESTIMATE_DAYS = /** @type {const} */ ([30, 90, 180]);

/** @typedef {'fabric' | 'azure'} EstimateTarget */
/** @typedef {'standard' | 'large' | 'unsized'} EstimateBand */
/** @typedef {{ time: string, runs: [number, number] }} Estimate  runs: the fewest and most runs it takes. */

/** The audit searches a tenant can start in a rolling 24 hours, at least. Microsoft can allow a tenant more. */
export const SEARCH_ALLOWANCE = 200;

/** A load that needs more searches than this, and no more than the allowance, can still wait for another run if others searched in the day before. */
export const NEAR_ALLOWANCE = 150;

/**
 * Each load's audit window, in hours: one search each. Fabric's are the pipeline's CHUNK_HOURS for each tenant
 * size, and the notebook's own for an install with no size set. Azure's is the job's, whatever the size.
 * @type {Record<EstimateTarget, Partial<Record<EstimateBand, number>>>}
 */
export const WINDOW_HOURS = {
  fabric: { standard: 24, large: 2, unsized: 8 },
  azure: { standard: 8, large: 8 },
};

/**
 * The audit searches a load of `days` starts: one a window.
 * @param {EstimateTarget} target
 * @param {EstimateBand} band
 * @param {number} days
 */
export function searchesFor(target, band, days) {
  return Math.ceil((days * 24) / (WINDOW_HOURS[target][band] ?? 8));
}

/**
 * The figures, by the rules above. The comments give each band's searches for 30, 90 and 180 days.
 * @type {Record<EstimateTarget, Partial<Record<EstimateBand, Record<number, Estimate>>>>}
 */
export const FIRST_LOAD_ESTIMATES = {
  fabric: {
    // 30, 90 and 180.
    standard: {
      30: { time: '1 to 2 hours', runs: [1, 1] },
      90: { time: '2 to 3 hours', runs: [1, 1] },
      180: { time: '3 to 5 hours', runs: [1, 1] },
    },
    // 360, 1,080 and 2,160: each over the allowance.
    large: {
      30: { time: '1 to 2 days', runs: [2, 3] },
      90: { time: '5 to 6 days', runs: [6, 7] },
      180: { time: '10 to 11 days', runs: [11, 12] },
    },
    // 90, 270 and 540.
    unsized: {
      30: { time: '2 to 3 hours', runs: [1, 1] },
      90: { time: '1 to 2 days', runs: [2, 3] },
      180: { time: '2 to 3 days', runs: [3, 4] },
    },
  },
  // 90, 270 and 540, for either size.
  azure: {
    standard: {
      30: { time: '2 to 3 hours', runs: [1, 1] },
      90: { time: '1 to 2 days', runs: [2, 3] },
      180: { time: '2 to 3 days', runs: [3, 4] },
    },
    large: {
      30: { time: '2 to 4 hours', runs: [1, 2] },
      90: { time: '1 to 2 days', runs: [2, 3] },
      180: { time: '2 to 3 days', runs: [3, 4] },
    },
  },
};

/** Who each band's figures are for, as the estimate says it. @type {Record<EstimateBand, string>} */
export const BAND_LABELS = {
  standard: 'for up to 10,000 people',
  large: 'for more than 10,000 people',
  unsized: 'for an install with no tenant size set',
};

/**
 * The table's band for an install. A Fabric install with no tenant size keeps the template's 8-hour windows; Azure
 * has one window size, so its figures go by the size alone.
 * @param {EstimateTarget} target
 * @param {string | undefined} scale
 * @returns {EstimateBand}
 */
export function bandOf(target, scale) {
  if (scale === 'large') return 'large';
  return target === 'fabric' && scale !== 'standard' ? 'unsized' : 'standard';
}

/**
 * The estimate for loading `days` of history, from the row at or above it. undefined for no days.
 * @param {EstimateTarget} target
 * @param {number} days
 * @param {string | undefined} scale
 * @returns {(Estimate & { days: number, band: EstimateBand }) | undefined}  days: the row used.
 */
export function estimateFor(target, days, scale) {
  if (!Number.isFinite(days) || days < 1) return undefined;
  const band = bandOf(target, scale);
  const row = ESTIMATE_DAYS.find((d) => d >= days) ?? ESTIMATE_DAYS[ESTIMATE_DAYS.length - 1];
  const est = FIRST_LOAD_ESTIMATES[target][band]?.[row];
  return est && { ...est, days: row, band };
}

const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
/** @param {number} n */
const word = (n) => WORDS[n] ?? String(n);

/**
 * "in one run", "over two runs", "in one or two runs", "over two or three runs", "over 11 or 12 runs".
 * @param {[number, number]} runs
 */
export function runsPhrase([min, max]) {
  if (min === max) return min === 1 ? 'in one run' : `over ${word(min)} runs`;
  return `${min === 1 ? 'in' : 'over'} ${word(min)} or ${word(max)} runs`;
}

/**
 * The history an estimate is for: "90 days", or "up to 90 days" for fewer than the row.
 * @param {number} days
 * @param {number} row
 */
function daysPhrase(days, row) {
  if (days > row) return `${row} days or more`;
  return days === row ? `${days} days` : `up to ${row} days`;
}

/**
 * The searches the row needs, as the estimate says them: "about 360", "up to about 360" for fewer days than the
 * row, or "more than 2,160" for more.
 * @param {number} days
 * @param {number} row
 * @param {number} searches
 */
function searchesPhrase(days, row, searches) {
  const count = searches.toLocaleString('en-GB');
  if (days > row) return `more than ${count}`;
  return days === row ? `about ${count}` : `up to about ${count}`;
}

/**
 * One line, for a question's choice or a plan row: "Estimate: 1 to 2 hours." With `band`, it says who the figures
 * are for: "Estimate for up to 10,000 people: 1 to 2 hours." On Fabric, a load of more than one run says the runs
 * after the first are started by hand: the schedule doesn't carry it on. Each such load is over the search
 * allowance, so they're a day apart.
 * @param {number} days
 * @param {string | undefined} scale
 * @param {EstimateTarget} [target]
 * @param {{ band?: boolean }} [opts]
 */
export function estimateShort(days, scale, target = 'fabric', opts = {}) {
  const est = estimateFor(target, days, scale);
  if (!est) return '';
  const runs = est.runs[1] > 1;
  const byHand = runs && target === 'fabric' ? ' You start each run after the first by hand, a day apart.' : '';
  return `Estimate${opts.band ? ` ${BAND_LABELS[est.band]}` : ''}: ${est.time}${runs ? `, ${runsPhrase(est.runs)}` : ''}.${byHand}`;
}

/**
 * Within the search allowance: what carries an Azure load on once a run stops at its time limit. Ends with a space.
 * @param {boolean | undefined} selfStart  true when the run job can start its next run itself, false while that waits
 *   for an admin, undefined when it isn't known: on an install from before 0.6.9 until an update or a repair, or in
 *   demo mode, which gives no role.
 */
function azureNextRun(selfStart) {
  const sooner = `start one sooner with "${commandLine('run')}"`;
  if (selfStart) {
    return 'The next run then starts by itself and carries on where it stopped, until the history is loaded. ' +
      'If a run ends with an error or fetches nothing, the next scheduled run carries on instead. ';
  }
  if (selfStart === false) {
    return `The next scheduled run carries on where it stopped, or ${sooner}. ` +
      `An admin can let the next run start straight away: see the pending admin action in "${commandLine('status')}". `;
  }
  return `If the run job can start itself, the next run starts straight away and carries on where it stopped; if not, the next scheduled run does, or ${sooner}. `;
}

/**
 * What to expect when the first load, or a reload of more history, starts: the estimate, what can make it longer,
 * and what each target does when a run can't fetch it all. Ends with a space, for the note that follows.
 * @param {number} days
 * @param {string | undefined} scale
 * @param {EstimateTarget} [target]
 * @param {{ reload?: boolean, selfStart?: boolean }} [opts]  reload: a reload of more history, which on Fabric takes its
 *   own command to carry on. selfStart: on Azure, whether the run job can start its next run itself, as `azureNextRun`.
 */
export function firstLoadEstimate(days, scale, target = 'fabric', opts = {}) {
  const est = estimateFor(target, days, scale);
  if (!est) return '';
  const searches = searchesFor(target, est.band, est.days);
  const over = searches > SEARCH_ALLOWANCE;
  const needs = `It needs ${searchesPhrase(days, est.days, searches)} audit searches`;
  const allowance = `${SEARCH_ALLOWANCE} in a rolling 24 hours, shared with other admins and tools`;
  let limit = '';
  if (over) limit = `${needs}. A tenant can start at least ${allowance}, so a run stops when they're used up. A tenant with a higher limit loads sooner. `;
  else if (searches > NEAR_ALLOWANCE) limit = `${needs}, and a tenant can start at least ${allowance}: if others ran audit searches in the 24 hours before, some of it can wait for another run. `;
  const head = `Estimate for ${daysPhrase(days, est.days)} of history, ${BAND_LABELS[est.band]}: ${est.time}, ${runsPhrase(est.runs)}. ` +
    `The audit service's queue can add hours, and so can Microsoft throttling audit searches. ${limit}`;
  if (target === 'azure') {
    const each = 'Each run fetches for up to about 3 hours, newest weeks first, then publishes what it has loaded, so the reports fill in after each run. ';
    if (over) {
      const next = opts.selfStart
        ? 'A run stopped at its time limit then starts the next one by itself; after a stop at the search limit, the next scheduled run carries on where it stopped. '
        : `The next scheduled run carries on where it stopped. ${opts.selfStart === false ? `An admin can let a run stopped at its time limit start the next one straight away: see the pending admin action in "${commandLine('status')}". ` : ''}`;
      return `${head}${each}A run stopped at the search limit does the same. ${next}` +
        `The estimate counts a run a day: on a weekly schedule, start the runs in between with "${commandLine('run')}". `;
    }
    return `${head}${each}${azureNextRun(opts.selfStart)}`;
  }
  const again = commandLine(opts.reload ? `run --backfill-days ${days}` : 'run');
  // A large tenant's advice from the sizing: a bigger capacity helps.
  const capacity = est.band === 'large' ? 'A trial or small capacity takes longer, and an F64 or larger capacity helps. ' : 'A trial or small capacity takes longer. ';
  const budget = 'If the audit load reaches its time budget, it stops without writing anything, and the pipeline\'s retries carry on from where it stopped; ' +
    'the reports show the new history once every window is fetched. ';
  // The schedule loads only the newest days, so a load the search limit can stop is carried on by `run`, not by it.
  const carry = searches > NEAR_ALLOWANCE
    ? `The scheduled runs don't carry it on, so if a run ends first, start another with "${again}", a day later if it stopped at the search limit: it carries on from the windows already fetched. `
    : `If the run ends first, start another with "${again}": it carries on from the windows already fetched. `;
  return `${head}${capacity}${budget}${carry}`;
}
