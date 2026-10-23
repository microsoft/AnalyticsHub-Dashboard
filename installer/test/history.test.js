// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BACKFILL_ENV, jobTemplateWith } from '../src/steps/azure/index.js';
import { askMoreHistory, HISTORY_CHOICES, historyChoices, reloadDetail, reloadLine } from '../src/steps/plan.js';
import { fakeArm, fakeCtx, fakeUi } from './fakes.js';

/** A ui that records each select's choices and answers with `answer`, or the default. @param {any} [answer] */
function selectUi(answer) {
  const fake = fakeUi();
  /** @type {{ message: string, choices: any[] }[]} */
  const selects = [];
  fake.ui.select = async (/** @type {string} */ message, /** @type {any[]} */ choices, /** @type {any} */ def) => {
    selects.push({ message, choices });
    return answer === undefined ? def : answer;
  };
  return { ...fake, selects };
}

test('askMoreHistory: offers only more than is loaded, and leaves the record alone until the reload starts', async () => {
  const s = selectUi(90);
  const { ctx, config } = fakeCtx({ ui: s.ui });
  config.history.days = 30;
  await askMoreHistory(ctx);
  assert.equal(s.selects.length, 1);
  assert.match(s.selects[0].message, /Load more audit history\? 30 days are loaded now/);
  assert.deepEqual(s.selects[0].choices.map((c) => c.value), [0, 90, 180]);
  // No tenant size set: the template's figures, labelled an estimate. A reload can take more than one run, so not "once".
  assert.equal(s.selects[0].choices[2].description, 'Runs the pipeline with 180 days of history. Estimate: about 6 hours, over two runs. The scheduled runs carry on as usual after it.');
  assert.equal(ctx.reloadHistoryDays, 90);
  assert.equal(config.history.days, 30, 'saved only once the reload has started');

  const large = selectUi();
  const l = fakeCtx({ ui: large.ui });
  l.config.history.days = 30;
  l.config.scale = 'large';
  await askMoreHistory(l.ctx);
  assert.equal(large.selects[0].choices[1].description, 'Runs the pipeline with 90 days of history. Estimate: about 12 hours. The scheduled runs carry on as usual after it.');

  const keep = selectUi();
  const k = fakeCtx({ ui: keep.ui });
  k.config.history.days = 90;
  k.ctx.reloadHistoryDays = 180;
  await askMoreHistory(k.ctx);
  assert.deepEqual(keep.selects[0].choices.map((c) => c.value), [0, 180]);
  assert.equal(k.ctx.reloadHistoryDays, undefined, 'Keep is the default, and clears an earlier answer');

  const most = selectUi();
  const m = fakeCtx({ ui: most.ui });
  m.config.history.days = 180;
  await askMoreHistory(m.ctx);
  assert.equal(most.selects.length, 0, 'nothing more to offer at 180 days');
  assert.match(most.text(), /180 days loaded, the most the installer loads/);
});

test('reloadLine and reloadDetail describe the reload for the plan summary', () => {
  assert.deepEqual(HISTORY_CHOICES.map((c) => c.value), [30, 90, 180]);
  assert.match(reloadLine(90), /90 days/);
  assert.equal(reloadDetail(180, 'standard'), 'Estimate: 2 to 3 hours. The scheduled runs carry on as usual after it.');
  assert.equal(reloadDetail(180), 'Estimate: about 6 hours, over two runs. The scheduled runs carry on as usual after it.');
});

test('historyChoices: each choice has its estimate for the target and tenant size, beside the question', () => {
  for (const ch of HISTORY_CHOICES) assert.doesNotMatch(ch.name, /minute|hour/, 'the time is in the estimate, not the name');
  assert.deepEqual(historyChoices('fabric', 'standard').map((c) => c.description), [
    'Estimate for up to 10,000 people: about 25 minutes.',
    'Estimate for up to 10,000 people: about an hour.',
    'Estimate for up to 10,000 people: 2 to 3 hours.',
  ]);
  assert.deepEqual(historyChoices('fabric', undefined).map((c) => c.description), [
    'Estimate for an install with no tenant size set: about an hour.',
    'Estimate for an install with no tenant size set: about 3 hours.',
    'Estimate for an install with no tenant size set: about 6 hours, over two runs.',
  ]);
  assert.deepEqual(historyChoices('azure', 'large').map((c) => c.description), [
    'Estimate for more than 10,000 people: 1 to 2 hours.',
    'Estimate for more than 10,000 people: about 4 hours, in one or two runs.',
    'Estimate for more than 10,000 people: about 8 hours, over two or three runs.',
  ]);
  assert.deepEqual(historyChoices('azure', undefined).map((c) => [c.value, c.name]), HISTORY_CHOICES.map((c) => [c.value, c.name]));
});

test('jobTemplateWith: one execution with the backfill setting, replacing any old one and keeping the rest', async () => {
  const arm = fakeArm();
  const job = await arm.api.getContainerAppJob('sub-1', 'rg', 'vlens-run');
  const template = jobTemplateWith(job, [{ name: BACKFILL_ENV, value: '90' }]);
  assert.ok(template);
  const [ct] = template.containers;
  assert.equal(ct.image, 'img:1');
  assert.deepEqual(ct.command, ['python']);
  assert.deepEqual(ct.env, [{ name: 'VALUELENS_AUDIT_HISTORY_DAYS', value: '30' }, { name: BACKFILL_ENV, value: '90' }]);
  assert.equal(jobTemplateWith({ properties: { template: { containers: [] } } }, []), undefined);
  assert.equal(BACKFILL_ENV, 'VALUELENS_AUDIT_BACKFILL_DAYS');
});
