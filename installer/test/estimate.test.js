// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BAND_LABELS, bandOf, ESTIMATE_DAYS, estimateFor, estimateShort, FIRST_LOAD_ESTIMATES, firstLoadEstimate, runsPhrase } from '../src/estimate.js';

test('estimate table: every target and size has a row for each history choice', () => {
  assert.deepEqual([...ESTIMATE_DAYS], [30, 90, 180]);
  const bands = { fabric: ['standard', 'large', 'unsized'], azure: ['standard', 'large'] };
  for (const [target, names] of Object.entries(bands)) {
    const table = /** @type {Record<string, any>} */ (FIRST_LOAD_ESTIMATES[/** @type {'fabric' | 'azure'} */ (target)]);
    assert.deepEqual(Object.keys(table).sort(), [...names].sort(), target);
    for (const band of names) {
      for (const days of ESTIMATE_DAYS) {
        const est = table[band][days];
        assert.ok(est?.time, `${target} ${band} ${days}`);
        const [min, max] = est.runs;
        assert.ok(min >= 1 && max >= min, `${target} ${band} ${days}: runs ${est.runs}`);
      }
    }
  }
  // Each run's figures grow with the days asked for.
  for (const band of ['standard', 'large']) {
    const runs = ESTIMATE_DAYS.map((d) => FIRST_LOAD_ESTIMATES.azure[/** @type {'standard' | 'large'} */ (band)]?.[d].runs[1] ?? 0);
    assert.deepEqual(runs, [...runs].sort((a, b) => a - b), band);
  }
});

test('bandOf: Fabric without a size keeps its own figures; Azure goes by size alone', () => {
  assert.equal(bandOf('fabric', 'large'), 'large');
  assert.equal(bandOf('fabric', 'standard'), 'standard');
  assert.equal(bandOf('fabric', undefined), 'unsized');
  assert.equal(bandOf('azure', 'large'), 'large');
  assert.equal(bandOf('azure', undefined), 'standard');
});

test('estimateFor: other days use the row at or above them', () => {
  assert.equal(estimateFor('fabric', 30, 'standard')?.time, 'about 25 minutes');
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
});

test('estimateShort: labelled an estimate, with who it is for when asked', () => {
  assert.equal(estimateShort(30, 'standard'), 'Estimate: about 25 minutes.');
  assert.equal(estimateShort(30, 'standard', 'fabric', { band: true }), `Estimate ${BAND_LABELS.standard}: about 25 minutes.`);
  assert.equal(estimateShort(180, 'large'), 'Estimate: a day or more, over two runs.');
  assert.equal(estimateShort(90, 'large', 'azure', { band: true }), 'Estimate for more than 10,000 people: about 4 hours, in one or two runs.');
  assert.equal(estimateShort(0, 'large'), '');
});

test('firstLoadEstimate: the estimate, the queue, and what each target does with a run cut short', () => {
  const fabric = firstLoadEstimate(180, 'large');
  assert.match(fabric, /^Estimate for 180 days of history, for more than 10,000 people: a day or more, over two runs\. /);
  assert.match(fabric, /The audit service's queue can add hours, and a large tenant's history can take more than one run\./);
  assert.match(fabric, /A trial or small capacity takes longer, and an F64 or larger capacity helps\./, "the sizing's advice for a large tenant");
  assert.doesNotMatch(firstLoadEstimate(30, 'standard'), /F64/);
  assert.match(firstLoadEstimate(30, 'standard'), /A trial or small capacity takes longer\./);
  assert.match(fabric, /stops without writing anything, and the pipeline's retries carry on from where it stopped/);
  assert.match(fabric, /the reports show the new history once every window is fetched/);
  assert.match(fabric, /start another with "valuelens-install run": it carries on from the windows already fetched/);
  assert.match(fabric, / $/, 'ends with a space for the note that follows');
  assert.match(firstLoadEstimate(90, 'standard', 'fabric', { reload: true }), /start another with "valuelens-install run --backfill-days 90"/);
  assert.match(firstLoadEstimate(20, undefined), /^Estimate for up to 30 days of history, for an install with no tenant size set: about an hour, in one run\./);

  const azure = firstLoadEstimate(30, 'standard', 'azure');
  assert.match(azure, /^Estimate for 30 days of history, for up to 10,000 people: about an hour, in one run\./);
  assert.match(azure, /Each run gets up to 4 hours\. A run cut off then publishes nothing/);
  assert.match(azure, /The next scheduled run carries on where it stopped, or start one sooner with "valuelens-install run"/);
  assert.doesNotMatch(azure, /time budget|retries|capacity/, 'Azure has no pipeline retries to count on, and no Fabric capacity');
  assert.doesNotMatch(`${fabric}${azure}`, /daily|usually takes under an hour/);
  assert.equal(firstLoadEstimate(0, 'standard'), '');
});
