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
 * doesn't carry a first load or a reload on: each run after the first is started by hand. On Azure, a run stops at
 * 4 hours and no retry is counted on, so a load whose high end reaches 4 hours can take a second run, and the
 * scheduled runs carry a load on. The audit service's queue on a busy day isn't counted: it can add hours.
 *
 * The figures are for Microsoft Graph audit search, which Azure and a Fabric install with the Graph source read. A
 * Fabric install that reads the Office 365 Management Activity API (feed, or auto after Microsoft Sentinel) loads
 * the last FEED_DAYS days in one run, and leaves the older days out. Only a load that reads those from Graph
 * (Graph history) takes the figures.
 */
import { readsFeed } from './catalog.js';
import { commandLine } from './launch.js';

/** The days the Office 365 Management Activity API keeps: FEED_RETENTION in the audit notebook. */
export const FEED_DAYS = 7;

/**
 * Where a Fabric load reads its history, for the estimate. With no source, it reads Graph.
 * @typedef {object} SourceOpts
 * @property {import('./catalog.js').AuditSource} [source]  The install's audit source.
 * @property {boolean} [graphHistory]  Whether the load reads the older days from Graph. undefined: not asked
 *   yet, so the short form says both.
 */

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
 * The source a Fabric load reads its history from when it isn't Graph: feed or auto. undefined: Graph.
 * @param {EstimateTarget} target
 * @param {SourceOpts} opts
 * @returns {'feed' | 'auto' | undefined}
 */
function heldSource(target, opts) {
  if (target !== 'fabric' || opts.graphHistory === true || !opts.source || !readsFeed(opts.source)) return undefined;
  return /** @type {'feed' | 'auto'} */ (opts.source);
}

/**
 * The days a feed or auto load holds: "the last 7 days", "the last day", or "what Sentinel holds, or the last 7 days".
 * @param {'feed' | 'auto'} source
 * @param {number} days
 */
function heldPhrase(source, days) {
  const held = Math.min(days, FEED_DAYS);
  const last = held === 1 ? 'the last day' : `the last ${held} days`;
  return source === 'auto' && days > FEED_DAYS ? `what Sentinel holds, or ${last}` : last;
}

/**
 * One line, for a question's choice or a plan row: "Estimate: 1 to 2 hours." With `band`, it says who the figures
 * are for: "Estimate for up to 10,000 people: 1 to 2 hours." On Fabric, a load of more than one run says the runs
 * after the first are started by hand: the schedule doesn't carry it on. Each such load is over the search
 * allowance, so they're a day apart.
 *
 * A feed or auto load says the days it holds, in one run: "Estimate: the last 7 days, in one run." With
 * graphHistory false, it adds that the older days are left out. Before the Graph history question (undefined), it
 * adds the figures for reading them from Graph.
 * @param {number} days
 * @param {string | undefined} scale
 * @param {EstimateTarget} [target]
 * @param {{ band?: boolean } & SourceOpts} [opts]
 */
export function estimateShort(days, scale, target = 'fabric', opts = {}) {
  const est = estimateFor(target, days, scale);
  if (!est) return '';
  const runs = est.runs[1] > 1;
  const byHand = runs && target === 'fabric' ? ' You start each run after the first by hand, a day apart.' : '';
  const graph = `${est.time}${runs ? `, ${runsPhrase(est.runs)}` : ''}.${byHand}`;
  const held = heldSource(target, opts);
  if (!held) return `Estimate${opts.band ? ` ${BAND_LABELS[est.band]}` : ''}: ${graph}`;
  const head = `Estimate: ${heldPhrase(held, days)}, in one run.`;
  if (days <= FEED_DAYS) return head;
  if (opts.graphHistory === false) return `${head} ${held === 'auto' ? "Older days Sentinel doesn't hold are left out." : 'Older days are left out.'}`;
  return `${head} With the older days from Microsoft Graph audit search${opts.band ? `, ${BAND_LABELS[est.band]}` : ''}: ${graph}`;
}

/**
 * firstLoadEstimate for a feed or auto load: the days it holds, the older days left out, and on a first load, a
 * new subscription's wait. Ends with a space.
 * @param {'feed' | 'auto'} source
 * @param {number} days
 * @param {{ reload?: boolean }} opts
 */
function heldEstimate(source, days, opts) {
  const auto = source === 'auto';
  const older = days > FEED_DAYS;
  let text = `Estimate: ${heldPhrase(source, days)}, in one run. `;
  if (older) {
    text += `The Office 365 Management Activity API keeps ${FEED_DAYS} days, so the older days of the ${days} asked for${auto ? " that Sentinel doesn't hold" : ''} are left out. `;
  }
  if (!opts.reload) {
    text += 'A new Management Activity API subscription can take up to 12 hours to show content, and has nothing from before it started, ' +
      `so the first load may find ${auto ? 'only what Sentinel holds' : 'nothing'}: the scheduled runs pick up from then on. `;
  }
  if (older) text += `Once this run has finished, you can load the older days from Microsoft Graph audit search with "${commandLine(`run --backfill-days ${days} --graph-history`)}". `;
  return text;
}

/**
 * What to expect when the first load, or a reload of more history, starts: the estimate, what can make it longer,
 * and what each target does when a run can't fetch it all. Ends with a space, for the note that follows. A feed or
 * auto load that doesn't read Graph (graphHistory not true) says the days it holds instead, and how to load the
 * older days from Graph.
 * @param {number} days
 * @param {string | undefined} scale
 * @param {EstimateTarget} [target]
 * @param {{ reload?: boolean } & SourceOpts} [opts]  reload: a reload of more history, which on Fabric takes its own command to carry on.
 */
export function firstLoadEstimate(days, scale, target = 'fabric', opts = {}) {
  const est = estimateFor(target, days, scale);
  if (!est) return '';
  const held = heldSource(target, opts);
  if (held) return heldEstimate(held, days, opts);
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
    if (over) {
      return `${head}Each run gets up to 4 hours, and one cut off then publishes nothing. A run stopped at the search limit publishes what it has fetched. ` +
        `The next scheduled run carries on where it stopped. The estimate counts a run a day: on a weekly schedule, start the runs in between with "${commandLine('run')}". `;
    }
    return `${head}Each run gets up to 4 hours. A run cut off then publishes nothing, so the reports show the new history once one run fetches everything left. ` +
      `The next scheduled run carries on where it stopped, or start one sooner with "${commandLine('run')}". `;
  }
  // A reload that read the older days from Graph carries on reading them from Graph.
  const viaGraph = opts.graphHistory === true && !!opts.source && readsFeed(opts.source) ? ' --graph-history' : '';
  const again = commandLine(opts.reload ? `run --backfill-days ${days}${viaGraph}` : 'run');
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
