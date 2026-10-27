// @ts-check
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  BAND_LABELS, bandOf, ESTIMATE_DAYS, estimateFor, estimateShort, FIRST_LOAD_ESTIMATES, firstLoadEstimate, NEAR_ALLOWANCE,
  runsPhrase, SEARCH_ALLOWANCE, searchesFor, WINDOW_HOURS,
} from '../src/estimate.js';
import { AZURE_CHUNK_HOURS } from '../src/steps/history-progress.js';
import { scaleProfile } from '../src/transform/pipeline.js';

/** @typedef {import('../src/estimate.js').EstimateTarget} EstimateTarget */
/** @typedef {import('../src/estimate.js').EstimateBand} EstimateBand */

const BANDS = /** @type {Record<EstimateTarget, EstimateBand[]>} */ ({ fabric: ['standard', 'large', 'unsized'], azure: ['standard', 'large'] });

/** Every row of the table, with its target, band and days. */
const rows = () => Object.entries(BANDS).flatMap(([target, bands]) => bands.flatMap((band) => ESTIMATE_DAYS.map((days) => ({
  target: /** @type {EstimateTarget} */ (target),
  band,
  days,
  est: /** @type {import('../src/estimate.js').Estimate} */ (FIRST_LOAD_ESTIMATES[/** @type {EstimateTarget} */ (target)][band]?.[days]),
}))));

/**
 * The figures by estimate.js's rules. Over the allowance: k = floor((S - 1) / 200), k to k + 1 days over k + 1 to
 * k + 2 runs. Within it: 45 minutes and 0.6 a search to 60 and 1.2, half as long again a search for a large tenant,
 * rounded to the hour. An Azure load whose high end reaches its 4 hours can take a second run.
 * @param {EstimateTarget} target @param {EstimateBand} band @param {number} days
 */
function ruleFor(target, band, days) {
  const s = searchesFor(target, band, days);
  if (s > SEARCH_ALLOWANCE) {
    const k = Math.floor((s - 1) / SEARCH_ALLOWANCE);
    return { time: `${k} to ${k + 1} days`, runs: [k + 1, k + 2] };
  }
  const per = band === 'large' ? 1.5 : 1;
  /** @param {number} minutes */
  const hours = (minutes) => Math.max(1, Math.round(minutes / 60));
  const low = hours(45 + 0.6 * per * s);
  const high = hours(60 + 1.2 * per * s);
  return { time: `${low} to ${high} hours`, runs: target === 'azure' && high >= 4 ? [1, 2] : [1, 1] };
}

/** The audit window that a source file sets, from the first line that starts with CHUNK_HOURS. @param {string} text */
const chunkHours = (text) => Number(/^CHUNK_HOURS\s*=\s*(\d+)/m.exec(text)?.[1]);

test('estimate table: every target and size has a row for each history choice', () => {
  assert.deepEqual([...ESTIMATE_DAYS], [30, 90, 180]);
  for (const [target, names] of Object.entries(BANDS)) {
    const table = /** @type {Record<string, any>} */ (FIRST_LOAD_ESTIMATES[/** @type {EstimateTarget} */ (target)]);
    assert.deepEqual(Object.keys(table).sort(), [...names].sort(), target);
  }
  for (const { target, band, days, est } of rows()) {
    assert.ok(est?.time, `${target} ${band} ${days}`);
    const [min, max] = est.runs;
    assert.ok(min >= 1 && max >= min, `${target} ${band} ${days}: runs ${est.runs}`);
  }
  // Each run's figures grow with the days asked for.
  for (const band of /** @type {const} */ (['standard', 'large'])) {
    const runs = ESTIMATE_DAYS.map((d) => FIRST_LOAD_ESTIMATES.azure[band]?.[d].runs[1] ?? 0);
    assert.deepEqual(runs, [...runs].sort((a, b) => a - b), band);
  }
});

test('estimate table: every row is the rule\'s, from the audit searches it needs', () => {
  for (const { target, band, days, est } of rows()) assert.deepEqual(est, ruleFor(target, band, days), `${target} ${band} ${days}`);
  assert.equal(searchesFor('fabric', 'standard', 30), 30);
  assert.equal(searchesFor('fabric', 'large', 180), 2160);
  assert.equal(searchesFor('fabric', 'unsized', 90), 270);
  assert.equal(searchesFor('azure', 'large', 30), 90);
  assert.equal(SEARCH_ALLOWANCE, 200);
  assert.ok(NEAR_ALLOWANCE < SEARCH_ALLOWANCE);
  // Within the allowance, a Fabric load fits in one run: its retries give it three time budgets.
  for (const { target, band, days } of rows()) {
    const s = searchesFor(target, band, days);
    if (target !== 'fabric' || s > SEARCH_ALLOWANCE) continue;
    const budget = scaleProfile(band === 'unsized' ? undefined : band).audit.TIME_BUDGET_MIN;
    assert.ok(1.2 * (band === 'large' ? 1.5 : 1) * s <= 3 * budget, `${band} ${days}`);
  }
});

test('WINDOW_HOURS: the windows each load searches by', () => {
  assert.equal(WINDOW_HOURS.fabric.standard, scaleProfile('standard').audit.CHUNK_HOURS);
  assert.equal(WINDOW_HOURS.fabric.large, scaleProfile('large').audit.CHUNK_HOURS);
  // With no tenant size, the pipeline sets no window, so the notebook's own applies.
  assert.equal(scaleProfile(undefined).audit.CHUNK_HOURS, undefined);
  const notebook = JSON.parse(readFileSync(new URL('../../fabric/notebooks/Copilot_Audit_Log_Direct_Ingester.ipynb', import.meta.url), 'utf8'));
  const source = notebook.cells.map((/** @type {any} */ c) => [].concat(c.source).join('')).join('\n');
  assert.equal(WINDOW_HOURS.fabric.unsized, chunkHours(source));
  const job = readFileSync(new URL('../../azure/jobs/valuelens_jobs/collect/audit.py', import.meta.url), 'utf8');
  assert.equal(WINDOW_HOURS.azure.standard, chunkHours(job));
  assert.equal(WINDOW_HOURS.azure.large, chunkHours(job));
  assert.equal(AZURE_CHUNK_HOURS, chunkHours(job));
});

test('bandOf: Fabric without a size keeps its own figures; Azure goes by size alone', () => {
  assert.equal(bandOf('fabric', 'large'), 'large');
  assert.equal(bandOf('fabric', 'standard'), 'standard');
  assert.equal(bandOf('fabric', undefined), 'unsized');
  assert.equal(bandOf('azure', 'large'), 'large');
  assert.equal(bandOf('azure', undefined), 'standard');
});

test('estimateFor: other days use the row at or above them', () => {
  assert.equal(estimateFor('fabric', 30, 'standard')?.time, '1 to 2 hours');
  assert.equal(estimateFor('fabric', 7, 'standard')?.days, 30);
  assert.equal(estimateFor('fabric', 45, 'large')?.days, 90);
  assert.equal(estimateFor('azure', 365, 'large')?.days, 180);
  assert.equal(estimateFor('azure', 0, 'large'), undefined);
  assert.equal(estimateFor('fabric', Number.NaN, undefined), undefined);
});

test('runsPhrase: no "daily", as a schedule can be weekly', () => {
  assert.equal(runsPhrase([1, 1]), 'in one run');
  assert.equal(runsPhrase([2, 2]), 'over two runs');
  assert.equal(runsPhrase([1, 2]), 'in one or two runs');
  assert.equal(runsPhrase([2, 3]), 'over two or three runs');
  assert.equal(runsPhrase([6, 7]), 'over six or seven runs');
  assert.equal(runsPhrase([11, 12]), 'over 11 or 12 runs');
});

test('estimateShort: labelled an estimate, with who it is for when asked', () => {
  assert.equal(estimateShort(30, 'standard'), 'Estimate: 1 to 2 hours.');
  assert.equal(estimateShort(30, 'standard', 'fabric', { band: true }), `Estimate ${BAND_LABELS.standard}: 1 to 2 hours.`);
  assert.equal(estimateShort(180, 'large'), 'Estimate: 10 to 11 days, over 11 or 12 runs. You start each run after the first by hand, a day apart.');
  assert.equal(estimateShort(90, 'large', 'azure', { band: true }), 'Estimate for more than 10,000 people: 1 to 2 days, over two or three runs.');
  assert.equal(estimateShort(0, 'large'), '');
});

test('estimateShort: on Fabric, a load of more than one run says the runs after the first are started by hand', () => {
  for (const { target, band, days, est } of rows()) {
    const many = est.runs[1] > 1;
    const short = estimateShort(days, band === 'unsized' ? undefined : band, target);
    assert.equal(short.includes('You start each run after the first by hand, a day apart.'), many && target === 'fabric', `${target} ${band} ${days}`);
    // A day apart, because each such load is over the search allowance.
    if (many && target === 'fabric') assert.ok(searchesFor(target, band, days) > SEARCH_ALLOWANCE, `${band} ${days}`);
  }
});

test('firstLoadEstimate: the estimate, the queue, and what each target does with a run cut short', () => {
  const fabric = firstLoadEstimate(180, 'large');
  assert.match(fabric, /^Estimate for 180 days of history, for more than 10,000 people: 10 to 11 days, over 11 or 12 runs\. /);
  assert.match(fabric, /The audit service's queue can add hours, and so can Microsoft throttling audit searches\./);
  assert.match(fabric, /A trial or small capacity takes longer, and an F64 or larger capacity helps\./, "the sizing's advice for a large tenant");
  assert.doesNotMatch(firstLoadEstimate(30, 'standard'), /F64/);
  assert.match(firstLoadEstimate(30, 'standard'), /A trial or small capacity takes longer\./);
  assert.match(fabric, /stops without writing anything, and the pipeline's retries carry on from where it stopped/);
  assert.match(fabric, /the reports show the new history once every window is fetched/);
  assert.match(fabric, / $/, 'ends with a space for the note that follows');
  assert.match(firstLoadEstimate(30, 'standard'), /start another with "valuelens-install run": it carries on from the windows already fetched/);
  assert.match(firstLoadEstimate(90, 'standard', 'fabric', { reload: true }), /start another with "valuelens-install run --backfill-days 90": it carries on/);
  assert.match(firstLoadEstimate(20, undefined), /^Estimate for up to 30 days of history, for an install with no tenant size set: 2 to 3 hours, in one run\./);

  const azure = firstLoadEstimate(30, 'standard', 'azure');
  assert.match(azure, /^Estimate for 30 days of history, for up to 10,000 people: 2 to 3 hours, in one run\./);
  assert.match(azure, /Each run gets up to 4 hours\. A run cut off then publishes nothing/);
  assert.match(azure, /The next scheduled run carries on where it stopped, or start one sooner with "valuelens-install run"/);
  assert.doesNotMatch(azure, /time budget|retries|capacity/, 'Azure has no pipeline retries to count on, and no Fabric capacity');
  assert.doesNotMatch(azure, /It needs/, 'within the allowance, the searches go unsaid');
  assert.equal(firstLoadEstimate(0, 'standard'), '');
});

test('firstLoadEstimate: a load over the search allowance says what it needs and what the limit does', () => {
  const fabric = firstLoadEstimate(180, 'large');
  assert.match(fabric, /It needs about 2,160 audit searches\. A tenant can start at least 200 in a rolling 24 hours, shared with other admins and tools, so a run stops when they're used up\. A tenant with a higher limit loads sooner\. /);
  assert.match(fabric, /The scheduled runs don't carry it on, so if a run ends first, start another with "valuelens-install run", a day later if it stopped at the search limit: it carries on from the windows already fetched\. $/);
  assert.match(firstLoadEstimate(90, undefined, 'fabric', { reload: true }), /start another with "valuelens-install run --backfill-days 90", a day later if it stopped at the search limit/);
  assert.match(firstLoadEstimate(60, 'large'), /^Estimate for up to 90 days of history.*It needs up to about 1,080 audit searches\. /);
  assert.match(firstLoadEstimate(365, 'large'), /^Estimate for 180 days or more of history.*It needs more than 2,160 audit searches\. /);

  const azure = firstLoadEstimate(90, 'standard', 'azure');
  assert.match(azure, /^Estimate for 90 days of history, for up to 10,000 people: 1 to 2 days, over two or three runs\. /);
  assert.match(azure, /It needs about 270 audit searches\. A tenant can start at least 200/);
  assert.match(azure, /Each run gets up to 4 hours, and one cut off then publishes nothing\. A run stopped at the search limit publishes what it has fetched\. /);
  assert.match(azure, /The next scheduled run carries on where it stopped\. The estimate counts a run a day: on a weekly schedule, start the runs in between with "valuelens-install run"\. $/);
  assert.doesNotMatch(azure, /start one sooner|time budget|retries|capacity/);
  for (const { target, band, days } of rows()) {
    const text = firstLoadEstimate(days, band === 'unsized' ? undefined : band, target);
    assert.doesNotMatch(text, /daily|usually takes under an hour/, `${target} ${band} ${days}`);
    assert.equal(/It needs .* audit searches/.test(text), searchesFor(target, band, days) > NEAR_ALLOWANCE, `${target} ${band} ${days}`);
  }
});

test('firstLoadEstimate: a load near the allowance can still wait for another run', () => {
  const near = firstLoadEstimate(180, 'standard');
  assert.equal(searchesFor('fabric', 'standard', 180), 180);
  assert.match(near, /^Estimate for 180 days of history, for up to 10,000 people: 3 to 5 hours, in one run\. /);
  assert.match(near, /It needs about 180 audit searches, and a tenant can start at least 200 in a rolling 24 hours, shared with other admins and tools: if others ran audit searches in the 24 hours before, some of it can wait for another run\. /);
  assert.match(near, /The scheduled runs don't carry it on, so if a run ends first, start another with "valuelens-install run", a day later if it stopped at the search limit/);
  assert.doesNotMatch(firstLoadEstimate(90, 'standard'), /It needs|a day later/);
});
