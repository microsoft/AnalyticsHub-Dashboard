// @ts-check
/**
 * How long loading the audit history is likely to take: one table, by target, tenant size and days. The plan
 * shows it beside the history question, and the installer says it again when the first load or a reload starts.
 *
 * The figures are estimates, scaled from two measurements, until timed installer runs replace them:
 * - On Azure, 30 days of history took 58 minutes by hand: 90 queries of 8 hours, 5 at a time, so about 3 minutes
 *   for each round of 5, most of it waiting in the audit service's queue.
 * - In an offline test at 20,000 seats, with the audit service simulated (installer/README.md, "How long the first
 *   load takes"), collecting took about 3 minutes for 30 days and 18 for 180, and processing about 3 and 25 to 35.
 *
 * They're scaled by the windows each load queries, at about 3 minutes for each round of 5: day-long windows on
 * Fabric for up to 10,000 people, 2-hour windows for more, and 8-hour windows on Azure and on a Fabric install with
 * no tenant size set. A large tenant has about three times the records to fetch and process. On Fabric, the audit
 * load stops at its time budget (90 minutes, or 300 for a large tenant) and the pipeline's two retries carry on,
 * so one run fetches for up to three budgets. On Azure, a run stops at 4 hours, and no retry is counted on. The
 * audit service's queue on a busy day isn't counted: it can add hours.
 */
import { commandLine } from './launch.js';

/** The rows of the table: the history the installer offers. A load of other days uses the next row up. */
export const ESTIMATE_DAYS = /** @type {const} */ ([30, 90, 180]);

/** @typedef {'fabric' | 'azure'} EstimateTarget */
/** @typedef {'standard' | 'large' | 'unsized'} EstimateBand */
/** @typedef {{ time: string, runs: [number, number] }} Estimate  runs: the fewest and most runs it takes. */

/** @type {Record<EstimateTarget, Partial<Record<EstimateBand, Record<number, Estimate>>>>} */
export const FIRST_LOAD_ESTIMATES = {
  fabric: {
    standard: {
      30: { time: 'about 25 minutes', runs: [1, 1] },
      90: { time: 'about an hour', runs: [1, 1] },
      180: { time: '2 to 3 hours', runs: [1, 1] },
    },
    large: {
      30: { time: 'about 4 hours', runs: [1, 1] },
      90: { time: 'about 12 hours', runs: [1, 1] },
      180: { time: 'a day or more', runs: [2, 2] },
    },
    unsized: {
      30: { time: 'about an hour', runs: [1, 1] },
      90: { time: 'about 3 hours', runs: [1, 1] },
      180: { time: 'about 6 hours', runs: [2, 2] },
    },
  },
  azure: {
    standard: {
      30: { time: 'about an hour', runs: [1, 1] },
      90: { time: 'about 3 hours', runs: [1, 1] },
      180: { time: 'about 6 hours', runs: [2, 2] },
    },
    large: {
      30: { time: '1 to 2 hours', runs: [1, 1] },
      90: { time: 'about 4 hours', runs: [1, 2] },
      180: { time: 'about 8 hours', runs: [2, 3] },
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

const WORDS = ['no', 'one', 'two', 'three', 'four', 'five'];
/** @param {number} n */
const word = (n) => WORDS[n] ?? String(n);

/**
 * "in one run", "over two runs", "in one or two runs", "over two or three runs".
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
 * One line, for a question's choice or a plan row: "Estimate: about 25 minutes." With `band`, it says who the
 * figures are for: "Estimate for up to 10,000 people: about 25 minutes."
 * @param {number} days
 * @param {string | undefined} scale
 * @param {EstimateTarget} [target]
 * @param {{ band?: boolean }} [opts]
 */
export function estimateShort(days, scale, target = 'fabric', opts = {}) {
  const est = estimateFor(target, days, scale);
  if (!est) return '';
  return `Estimate${opts.band ? ` ${BAND_LABELS[est.band]}` : ''}: ${est.time}${est.runs[1] > 1 ? `, ${runsPhrase(est.runs)}` : ''}.`;
}

/**
 * What to expect when the first load, or a reload of more history, starts: the estimate, what can make it longer,
 * and what each target does when a run can't fetch it all. Ends with a space, for the note that follows.
 * @param {number} days
 * @param {string | undefined} scale
 * @param {EstimateTarget} [target]
 * @param {{ reload?: boolean }} [opts]  reload: a reload of more history, which on Fabric takes its own command to carry on.
 */
export function firstLoadEstimate(days, scale, target = 'fabric', opts = {}) {
  const est = estimateFor(target, days, scale);
  if (!est) return '';
  const head = `Estimate for ${daysPhrase(days, est.days)} of history, ${BAND_LABELS[est.band]}: ${est.time}, ${runsPhrase(est.runs)}. ` +
    'The audit service\'s queue can add hours, and a large tenant\'s history can take more than one run. ';
  if (target === 'azure') {
    return `${head}Each run gets up to 4 hours. A run cut off then publishes nothing, so the reports show the new history once one run fetches everything left. ` +
      `The next scheduled run carries on where it stopped, or start one sooner with "${commandLine('run')}". `;
  }
  const again = commandLine(opts.reload ? `run --backfill-days ${days}` : 'run');
  // A large tenant's advice from the sizing: a bigger capacity helps.
  const capacity = est.band === 'large' ? 'A trial or small capacity takes longer, and an F64 or larger capacity helps. ' : 'A trial or small capacity takes longer. ';
  return `${head}${capacity}If the audit load reaches its time budget, it stops without writing anything, and the pipeline's retries carry on from where it stopped; ` +
    `the reports show the new history once every window is fetched. If the run ends first, start another with "${again}": it carries on from the windows already fetched. `;
}
