// @ts-check
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { AZURE_RUN_HOURS, BAND_LABELS, bandOf, ESTIMATE_DAYS, estimateFor, estimateShort, FIRST_LOAD_ESTIMATES, firstLoadEstimate, runsPhrase } from '../src/estimate.js';

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
  assert.equal(estimateShort(90, 'large', 'azure', { band: true }), 'Estimate for more than 10,000 people: about 4 hours, over two runs.');
  assert.equal(estimateShort(90, 'standard', 'azure'), 'Estimate: about 3 hours, in one or two runs.', 'about 3 hours of fetching a run');
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
  assert.match(azure, /Each run fetches for up to about 3 hours, newest weeks first, then publishes what it has loaded, so the reports fill in after each run\./);
  assert.doesNotMatch(azure, /publishes nothing|4 hours/, 'a run out of time publishes what it has loaded');
  assert.match(firstLoadEstimate(180, 'large', 'azure'), /^Estimate for 180 days of history, for more than 10,000 people: about 8 hours, over three runs\./);
  // Before the deploy, or on an install from before 0.6.9, it isn't known whether the run job can start itself.
  assert.match(azure, /If the run job can start itself, the next run starts straight away and carries on where it stopped; if not, the next scheduled run does, or start one sooner with "valuelens-install run"\. $/);
  const chained = firstLoadEstimate(180, 'large', 'azure', { selfStart: true });
  assert.match(chained, /so the reports fill in after each run\. The next run then starts by itself and carries on where it stopped, until the history is loaded\. /);
  assert.match(chained, /If a run ends with an error or fetches nothing, the next scheduled run carries on instead\. $/);
  assert.doesNotMatch(chained, /start one sooner|admin/, 'nothing to do');
  // While an admin hasn't given the role: one run at each scheduled run, as before.
  const pending = firstLoadEstimate(180, 'large', 'azure', { selfStart: false });
  assert.match(pending, /The next scheduled run carries on where it stopped, or start one sooner with "valuelens-install run"\. /);
  assert.match(pending, /An admin can let the next run start straight away: see the pending admin action in "valuelens-install status"\. $/);
  assert.doesNotMatch(pending, /starts by itself/);
  assert.match(firstLoadEstimate(90, 'standard', 'azure', { reload: true, selfStart: true }), /The next run then starts by itself/, 'a reload carries itself on too');
  assert.doesNotMatch(azure, /time budget|retries|capacity/, 'Azure has no pipeline retries to count on, and no Fabric capacity');
  assert.doesNotMatch(`${fabric}${azure}${chained}${pending}`, /daily|usually takes under an hour/);
  assert.equal(firstLoadEstimate(0, 'standard'), '');
});

test('firstLoadEstimate: on Azure with the role, how long the runs take in all, publishing included', () => {
  // The runs follow one another, and each can take the run job's whole time limit: the most runs × 4 hours.
  const template = readFileSync(new URL('../src/azure/main.arm.json', import.meta.url), 'utf8');
  assert.equal(Number(template.match(/"runJobTimeoutSec": (\d+)/)?.[1]), AZURE_RUN_HOURS * 3600, "the run job's time limit");
  const two = firstLoadEstimate(90, 'large', 'azure', { selfStart: true });
  assert.match(two, /^Estimate for 90 days of history, for more than 10,000 people: about 4 hours, over two runs\. /, "the table's fetch time stays");
  assert.match(two, /until the history is loaded\. Each run can add up to an hour to publish, so the runs take up to about 8 hours in all\. If a run ends with an error/);
  assert.match(firstLoadEstimate(90, 'standard', 'azure', { selfStart: true }), /: about 3 hours, in one or two runs\. .* so the runs take up to about 8 hours in all\. /, 'counted for the most runs');
  const three = firstLoadEstimate(180, 'large', 'azure', { selfStart: true });
  assert.match(three, /: about 8 hours, over three runs\. .* so the runs take up to about 12 hours in all\. If a run ends/);
  assert.match(firstLoadEstimate(180, 'standard', 'azure', { selfStart: true }), /over two or three runs\. .* so the runs take up to about 12 hours in all\. /);
  assert.match(firstLoadEstimate(120, 'standard', 'azure', { reload: true, selfStart: true }), /^Estimate for up to 180 days of history.* up to about 12 hours in all\. /, 'fewer days than the row');
  // Beyond the table, more history can take more runs: no upper bound it could pass.
  for (const scale of ['standard', 'large']) {
    const beyond = firstLoadEstimate(365, scale, 'azure', { reload: true, selfStart: true });
    assert.match(beyond, /^Estimate for 180 days or more of history/, scale);
    assert.match(beyond, / so the runs take up to about 12 hours in all, or longer for more history\. If a run ends/, scale);
  }
  // One run, the role still pending, or not known: as before.
  assert.match(firstLoadEstimate(30, 'large', 'azure', { selfStart: true }), /until the history is loaded\. If a run ends with an error/, 'one run');
  for (const note of [
    firstLoadEstimate(30, 'standard', 'azure', { selfStart: true }),
    firstLoadEstimate(180, 'large', 'azure', { selfStart: false }),
    firstLoadEstimate(365, 'standard', 'azure', { reload: true, selfStart: false }),
    firstLoadEstimate(180, 'large', 'azure'),
    firstLoadEstimate(365, 'large', 'azure', { reload: true }),
  ]) assert.doesNotMatch(note, /in all|up to an hour to publish|or longer/);
  // Fabric's note and the plan's one line don't change.
  assert.doesNotMatch(firstLoadEstimate(180, 'large', 'fabric', { selfStart: true }), /in all|up to an hour to publish/);
  assert.equal(estimateShort(180, 'large', 'azure'), 'Estimate: about 8 hours, over three runs.');
});
