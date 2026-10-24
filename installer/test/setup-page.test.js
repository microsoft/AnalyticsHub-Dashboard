// @ts-check
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';
import { emptyConfig } from '../src/config.js';
import { dataPolicyPrereq } from '../src/prereqs.js';
import { setupCategories } from '../src/setup.js';
import { adminRequests, doneRequests } from '../src/steps/handoff.js';

/** A small DOM double exercises the real page renderers and their event payloads. */
class Element {
  /** @param {string} tag */
  constructor(tag) {
    this.tag = tag;
    /** @type {Element[]} */
    this.children = [];
    /** @type {Record<string, string>} */
    this.attributes = {};
    /** @type {Record<string, Function>} */
    this.events = {};
    this.value = '';
    this.selected = false;
    this.textContent = '';
    /** @type {Record<string, string>} */
    this.dataset = {};
  }
  /** @param {string} name @param {string} value */
  setAttribute(name, value) {
    this.attributes[name] = value;
    if (name === 'value') this.value = value;
    if (name === 'selected') this.selected = true;
  }
  /** @param {string} name @param {Function} handler */
  addEventListener(name, handler) { this.events[name] = handler; }
  /** @param {Element[]} kids */
  append(...kids) {
    this.children.push(...kids);
    if (this.tag === 'select') {
      this.value = this.children.find((child) => child.selected)?.value ?? this.children[0]?.value ?? '';
    }
  }
  /** @param {(Element | string)[]} kids */
  replaceChildren(...kids) {
    this.children = [];
    this.append(...kids.map((kid) => (typeof kid === 'string' ? Object.assign(new Element('#text'), { textContent: kid }) : kid)));
  }
  replaceWith() {}
  remove() {}
  /** @returns {string} */
  get text() { return this.textContent + this.children.map((child) => child.text).join(''); }
}

function page() {
  const context = createContext({
    Node: Element, matchMedia: () => ({ matches: false }), requestAnimationFrame: () => 0, submitted: [],
    document: {
      createElement: (/** @type {string} */ tag) => new Element(tag),
      createElementNS: (/** @type {string} */ ns, /** @type {string} */ tag) => new Element(tag),
      createTextNode: (/** @type {string} */ text) => Object.assign(new Element('#text'), { textContent: text }),
    },
  });
  const source = readFileSync(new URL('../src/web/app.js', import.meta.url), 'utf8').replace(/\ninit\(\);\s*$/, '\n');
  runInContext(source, context);
  runInContext('answer = (item, value) => submitted.push(value); start = (command, extra = {}) => submitted.push({ command, ...extra });', context);
  return context;
}

/** @param {Element} root @returns {Element[]} */
function all(root) { return [root, ...root.children.flatMap(all)]; }

test('settings page renders every category as a direct action and shows edits and earlier attempts', () => {
  const context = page();
  runInContext("app.attempts = [{ at: 0, state: 'failed', error: 'SQL region locked' }];", context);
  const root = runInContext(`renderPrompt({
    id: 1, kind: 'settings', message: 'Review and fix setup', error: '',
    categories: [{ id: 'placement', title: 'Azure placement', summary: 'SQL: UK South', complete: true },
      { id: 'schedule', title: 'Schedule', summary: 'Daily at 02:00', complete: false }],
    notice: 'SQL capacity is locked', changes: ['SQL: UK South -> Sweden Central']
  })`, context);
  assert.match(root.text, /Azure placement.*Schedule/);
  assert.match(root.text, /SQL: UK South -> Sweden Central/);
  assert.match(root.text, /Previous attempts in this session.*SQL region locked/);
  const edit = all(root).find((el) => el.tag === 'button' && el.text.startsWith('Azure placement'));
  edit?.events.click();
  assert.equal(context.submitted[0], 'placement');
});

test('settings page: Azure\'s App registrations is a category of its own, after Viewer access, with who makes the two apps', () => {
  const config = emptyConfig();
  config.target = 'azure';
  config.azure = /** @type {any} */ ({ adminScript: '/home/me/analytics-hub-azure-admin.md' });
  const context = page();
  const root = runInContext(`renderPrompt(${JSON.stringify({ id: 3, kind: 'settings', message: 'Review and fix setup', error: '', categories: setupCategories(config), notice: '', changes: [] })})`, context);
  assert.match(root.text, /Viewer access.*App registrations.*Waiting for an admin's script: \/home\/me\/analytics-hub-azure-admin\.md/s);
  const edit = all(root).find((el) => el.tag === 'button' && el.text.startsWith('App registrations'));
  edit?.events.click();
  assert.equal(context.submitted[0], 'identity');
});

test('grouped form submits all related fields together and explains locked fields', () => {
  const context = page();
  const root = runInContext(`renderPrompt({
    id: 2, kind: 'form', message: 'Azure placement', error: '',
    fields: [{ id: 'region', label: 'Region', default: 'uk', readOnly: 'Already deployed',
      choices: [{ name: 'UK South', value: 'uk' }] },
      { id: 'sql', label: 'SQL region', default: 'sweden', choices: [{ name: 'Sweden Central', value: 'sweden' }] }],
    settingsBack: true
  })`, context);
  assert.match(root.text, /Already deployed/);
  assert.match(root.text, /Back to settings/);
  assert.equal(all(root).filter((el) => el.tag === 'select').length, 2);
  root.events.submit({ preventDefault() {} });
  assert.deepEqual(JSON.parse(JSON.stringify(context.submitted[0])), { region: 'uk', sql: 'sweden' });
});

test('failure page offers direct category edit, all settings and saved-config retry without Home', () => {
  const context = page();
  const root = runInContext(`renderOutcome({
    command: 'install', state: 'failed', phase: 'build', startedAt: 0, endedAt: 1000,
    error: 'SQL capacity locked\\nDeploymentFailed: nested SQL failure',
    recovery: { section: 'placement', label: 'Change SQL region' }
  })`, context);
  for (const label of ['Change SQL region', 'Edit all settings', 'Retry saved configuration']) {
    const button = all(root).find((el) => el.tag === 'button' && el.text === label);
    assert.ok(button, label);
    button.events.click();
  }
  assert.deepEqual(JSON.parse(JSON.stringify(context.submitted)), [
    { command: 'install', section: 'placement' },
    { command: 'install' },
    { command: 'install', retry: true },
  ]);
  assert.match(root.text, /Technical details.*DeploymentFailed/s);
});

test('run page: an install step with a ✗ line shows as failed, even when the install carries on past it', () => {
  const context = page();
  const install = runInContext(`
    app.replay = true;
    app.run = createRun({ type: 'command', command: 'install', state: 'running', at: 0, seq: 1 });
    [
      { type: 'step', n: 1, total: 3, title: 'Analytics Hub app', at: 1 },
      { type: 'line', kind: 'fail', text: "The app wasn't deployed: the deploy tool failed", at: 2 },
      { type: 'step', n: 2, total: 3, title: 'Share the app', at: 3 },
      { type: 'line', kind: 'warn', text: "There's no app yet, so there's nothing to share.", at: 4 },
      { type: 'step', n: 3, total: 3, title: 'Model refresh', at: 5 },
      { type: 'line', kind: 'fail', text: 'The model refreshed, but a test query failed', at: 6 },
    ].forEach(apply);
    onCommand({ type: 'command', command: 'install', state: 'done', at: 7, seq: 2 });
    app.run.stages.find((s) => s.title === 'Setting up').kids.map((k) => [k.title, k.status, k.el.dataset.status]);
  `, context);
  assert.deepEqual(JSON.parse(JSON.stringify(install)), [
    ['Analytics Hub app', 'failed', 'failed'],
    ['Share the app', 'done', 'done'],
    ['Model refresh', 'failed', 'failed'],
  ]);

  // Other commands' sections aren't steps: status shows an earlier run that failed with ✗, and checking it didn't fail.
  const status = runInContext(`
    app.run = createRun({ type: 'command', command: 'status', state: 'running', at: 0, seq: 3 });
    [
      { type: 'heading', title: 'Recent runs', at: 1 },
      { type: 'line', kind: 'fail', text: '2026-06-01 02:00 UTC  Failed, 3 h 45 min  Scheduled', at: 2 },
    ].forEach(apply);
    onCommand({ type: 'command', command: 'status', state: 'done', at: 3, seq: 4 });
    app.run.stages[1].kids.map((k) => [k.title, k.status]);
  `, context);
  assert.deepEqual(JSON.parse(JSON.stringify(status)), [['Recent runs', 'done']]);
});

test('run page: a load failure the install counts shows as failed with Rerun failed, even when a next step is for that load', () => {
  const context = page();
  const cowork = { activity: 'Refresh_Cowork_Credits', name: 'Cowork credits (Viva Insights)', state: 'failed', fix: [] };
  const studio = { activity: 'Run_Consumption_Studio', name: 'Copilot Studio credits', state: 'ok', fix: [] };
  /** An install whose First load ends with these cards, then the Cowork sign-in as a next step. @param {any[]} cards */
  const firstLoad = (cards) => JSON.parse(JSON.stringify(runInContext(`
    app.replay = true;
    app.state = { record: { can: { 'rerun-failed': true } } };
    app.run = createRun({ type: 'command', command: 'install', state: 'running', at: 0, seq: 1 });
    [
      { type: 'step', n: 1, total: 1, title: 'First load', at: 1 },
      { type: 'line', kind: 'ok', text: 'Pipeline finished in 2 h', at: 2 },
      { type: 'loads', cards: ${JSON.stringify(cards)}, at: 3 },
      { type: 'next-steps', title: '1 step left', at: 4, steps: [{ id: 'cowork-dataflow', title: 'Sign in to the Dataflow',
        why: 'Cowork credits load once it has its sign-ins.', who: 'You', activity: 'Refresh_Cowork_Credits' }] },
    ].forEach(apply);
    onCommand({ type: 'command', command: 'install', state: 'done', at: 5, seq: 2 });
    ({
      step: app.run.stages.find((s) => s.title === 'Setting up').kids[0].status,
      waiting: [...runItems(app.run.stages)].find((it) => it.t === 'loads').cards.map((c) => c.expected ?? null),
      outcome: app.run.outcomeEl.text,
    });
  `, context)));

  // On a busy capacity the Dataflow failed, signed in or not: the install counts it, so it isn't waiting on the sign-in.
  const busy = firstLoad([{ ...cowork, kind: 'capacity', reason: "Fabric's capacity was too busy to start it.", counted: true }, studio]);
  assert.equal(busy.step, 'failed');
  assert.deepEqual(busy.waiting, [null, null]);
  assert.match(busy.outcome, /Some loads failed/);
  assert.match(busy.outcome, /Rerun failed/);

  // Failing until it's signed in is expected, as are cards saved before the page was told which failures count.
  const unsigned = firstLoad([{ ...cowork, kind: 'signIn' }, studio]);
  assert.equal(unsigned.step, 'done');
  assert.deepEqual(unsigned.waiting, ['Sign in to the Dataflow', null]);
  assert.doesNotMatch(unsigned.outcome, /Some loads failed|Rerun failed/);

  const other = firstLoad([{ ...cowork, kind: 'signIn' }, { ...studio, state: 'failed', counted: true }]);
  assert.equal(other.step, 'failed', 'another load failed beside it');
  assert.deepEqual(other.waiting, ['Sign in to the Dataflow', null]);
  assert.match(other.outcome, /Some loads failed/);
});

const PREREQ_ITEMS = JSON.stringify([
  {
    id: 'consent-role', label: 'Admin consent for the app', status: 'handoff', optional: true,
    detail: "You don't need this yourself.", neededFor: "The app's Microsoft Graph permissions",
    howTo: 'A Privileged Role Administrator or Global Administrator approves it: https://learn.microsoft.com/entra/identity/enterprise-apps/grant-admin-consent',
  },
  { id: 'fabric-capacity', label: 'A Fabric capacity', status: 'missing', detail: 'None you can use.', neededFor: 'The workspace', howTo: 'Ask its capacity admin.' },
  { id: 'fabric-licence', label: 'A Fabric licence', status: 'met', detail: 'You have one.', neededFor: 'Everything', howTo: 'Not shown.' },
]);

test('prerequisites: a hand-off reads "Hand-off" with its own glyph and says who does it; the others keep "How to get it"', () => {
  const context = page();
  const list = runInContext(`renderPrereqs(${PREREQ_ITEMS})`, context);
  const [handoff, missing, met] = list.children;
  assert.equal(/** @type {any} */ (handoff).className, 'prereq handoff');
  assert.match(handoff.text, /^Admin consent for the app Hand-off, optional/);
  assert.match(handoff.text, /Who does it: A Privileged Role Administrator or Global Administrator approves it/);
  assert.doesNotMatch(handoff.text, /How to get it/);
  const glyph = (/** @type {Element} */ li) => li.children[0].children[0].children[0].attributes.d;
  assert.equal(glyph(handoff), runInContext('ICONS.link', context));
  assert.notEqual(glyph(handoff), glyph(missing));
  assert.match(missing.text, /Missing.*How to get it: Ask its capacity admin\./s);
  assert.doesNotMatch(met.text, /How to get it|Who does it/, 'nothing to get for a row you have');
});

test('prerequisites: the home panel counts hand-offs as "to hand off", and the Markdown export marks them → with who does it', () => {
  const context = page();
  const panel = runInContext(`
    app.state = { user: { upn: 'someone@example.com' }, prereqs: { at: 0, upn: 'someone@example.com', items: ${PREREQ_ITEMS} } };
    prereqsPanel(false);
  `, context);
  assert.match(panel.text, /Checked as someone@example\.com at .+\. 1 you have it, 1 missing, 1 to hand off\. Only active roles count\./);

  const md = runInContext(`itemMarkdown({ t: 'prereqs', items: ${PREREQ_ITEMS} }, 2).join('\\n')`, context);
  assert.match(md, /^- → Admin consent for the app: Hand-off \(optional\)$/m);
  assert.match(md, /^ {2}- Who does it: A Privileged Role Administrator or Global Administrator approves it/m);
  assert.match(md, /^- ✗ A Fabric capacity: Missing$/m);
  assert.match(md, /^ {2}- How to get it: Ask its capacity admin\.$/m);
  assert.doesNotMatch(md, /Not shown/, 'a row you have has no how-to');
});

test('prerequisites: the data policy row isn\'t tagged optional in the list or the Markdown export; other optional rows keep their tag', () => {
  const config = emptyConfig();
  Object.assign(config.dataSources, { productFeedback: 'csv', studioCredits: 'api', resourceGraph: 'skip' });
  const policy = dataPolicyPrereq(config);
  assert.equal(policy.neededFor, 'Only the Power Automate flows: Analytics Hub - Copilot Studio credits.');
  const items = JSON.stringify([
    { id: 'power-automate-premium', label: 'Power Automate Premium licence', status: 'missing', optional: true, detail: 'None assigned to you.', neededFor: 'Only the Power Automate flows.', howTo: 'Ask your licence admin.' },
    policy,
  ]);
  const context = page();
  const [premium, row] = runInContext(`renderPrereqs(${items})`, context).children;
  assert.match(premium.text, /^Power Automate Premium licence Missing, optional/);
  assert.equal(/** @type {any} */ (row).className, 'prereq unknown');
  assert.match(row.text, /^Data policy Couldn't check/);
  assert.doesNotMatch(row.text, /optional/);
  assert.match(row.text, /How to get it: Ask a Power Platform administrator to confirm that HTTP with Microsoft Entra ID \(preauthorized\) is allowed in /);

  const md = runInContext(`itemMarkdown({ t: 'prereqs', items: ${items} }, 2).join('\\n')`, context);
  assert.match(md, /^- ✗ Power Automate Premium licence: Missing \(optional\)$/m);
  assert.match(md, /^- \? Data policy: Couldn't check$/m);
  assert.doesNotMatch(md.slice(md.indexOf('Data policy')), /optional/);
});

/** Real requests, as the server sends them with a prerequisites check: one for the data policy, one for a licence. */
function requestsFixture() {
  const config = emptyConfig();
  Object.assign(config.dataSources, { productFeedback: 'csv', studioCredits: 'api', resourceGraph: 'skip' });
  /** @type {import('../src/prereqs.js').Prereq[]} */
  const items = [
    { id: 'power-bi-pro', label: 'Power BI Pro licence', status: 'missing', detail: 'None assigned to you.', neededFor: 'Publishing the reports.', howTo: 'Ask your licence admin.' },
    dataPolicyPrereq(config),
  ];
  const requests = adminRequests(items, config, { from: 'someone@example.com' });
  assert.deepEqual(requests.map((r) => [r.who, r.rows]), [['A Power Platform administrator', ['Data policy']], ['Your licence admin', ['Power BI Pro licence']]]);
  return { items, requests };
}

const cls = (/** @type {Element} */ el) => /** @type {any} */ (el).className;

test('prerequisites: under the list, one request per admin, with what it\'s for, the message, and a Copy request button that copies it', async () => {
  const { items, requests } = requestsFixture();
  const context = page();
  /** @type {string[]} */
  const copied = [];
  context.navigator = { clipboard: { writeText: async (/** @type {string} */ text) => { copied.push(text); } } };
  const panel = runInContext(`
    app.state = ${JSON.stringify({ user: { upn: 'someone@example.com' }, prereqs: { at: 0, upn: 'someone@example.com', items, requests } })};
    prereqsPanel(false);
  `, context);
  const body = all(panel).find((el) => cls(el) === 'panel-body');
  assert.ok(body);
  assert.deepEqual(body.children.map(cls), ['hint', 'prereqs', 'admin-requests'], 'after the rows they cover');
  const section = body.children[2];
  assert.equal(section.children[0].text, 'Requests for your admins');
  assert.match(section.children[1].text, /^One message per admin\. Copy each one and send it/);
  const cards = all(section).filter((el) => cls(el) === 'next-card');
  assert.deepEqual(cards.map((card) => all(card).find((el) => cls(el) === 'next-name')?.text), ['A Power Platform administrator', 'Your licence admin']);
  const licence = cards[1];
  assert.equal(all(licence).find((el) => cls(el) === 'next-who')?.text, 'For: Power BI Pro licence');
  assert.equal(all(licence).find((el) => el.tag === 'pre')?.text, requests[1].message);
  assert.match(requests[1].message, /^Hi,\n\nI'm installing Analytics Hub, and I need your help with this:\n\n- Assign me a Power BI Pro licence.*\n\nThanks\nsomeone@example\.com$/s);
  const button = all(licence).find((el) => el.tag === 'button');
  assert.ok(button);
  assert.equal(button.text, 'Copy request');
  await button.events.click();
  assert.deepEqual(copied, [requests[1].message]);
  assert.equal(button.text, 'Copied');

  // Without a clipboard, the button says to select the text instead.
  context.navigator = {};
  const other = all(cards[0]).find((el) => el.tag === 'button');
  assert.ok(other);
  await other.events.click();
  assert.equal(other.text, 'Select the text to copy it');

  // Nothing to ask anyone, or a check saved before there were requests: no section.
  for (const prereqs of [{ at: 0, upn: 'someone@example.com', items, requests: [] }, { at: 0, upn: 'someone@example.com', items }]) {
    const none = runInContext(`app.state = ${JSON.stringify({ user: { upn: 'someone@example.com' }, prereqs })}; prereqsPanel(false);`, context);
    assert.equal(all(none).some((el) => cls(el) === 'admin-requests'), false);
  }
});

test('prerequisites: the run log shows the requests after the rows, and the Markdown export lists each admin\'s asks', () => {
  const { items, requests } = requestsFixture();
  const context = page();
  const logged = runInContext(`
    app.replay = true;
    app.run = createRun({ type: 'command', command: 'prereqs', state: 'running', at: 0, seq: 1 });
    [
      { type: 'prereqs', items: ${JSON.stringify(items)}, at: 1 },
      { type: 'admin-requests', requests: ${JSON.stringify(requests)}, at: 2 },
    ].forEach(apply);
    [...runItems(app.run.stages)].filter((it) => it.t === 'prereqs' || it.t === 'admin-requests').map((it) => [it.t, it.el]);
  `, context);
  assert.deepEqual([...logged].map(([t]) => t), ['prereqs', 'admin-requests']);
  const section = logged[1][1];
  assert.equal(cls(section), 'admin-requests');
  assert.equal(all(section).filter((el) => el.tag === 'button' && el.text === 'Copy request').length, 2);

  const md = runInContext(`itemMarkdown(${JSON.stringify({ t: 'admin-requests', requests })}, 2).join('\\n')`, context);
  assert.match(md, /^\*\*Requests for your admins\*\*$/m);
  assert.match(md, /^1\. \*\*A Power Platform administrator\*\* \(for: Data policy\)$/m);
  assert.match(md, /^2\. \*\*Your licence admin\*\* \(for: Power BI Pro licence\)$/m);
  assert.match(md, /^ {3}- Assign me a Power BI Pro licence \(Premium Per User works too\), to publish the Analytics Hub reports\.$/m);
  assert.doesNotMatch(md, /^Hi,|^Thanks/m, 'the asks, not the whole letter');
  assert.equal(runInContext(`itemMarkdown({ t: 'admin-requests', requests: [] }, 2).length`, context), 0);
});

const PACK = {
  index: '/records/analytics-hub-admin-pack.md',
  files: [
    { who: 'A Power Platform administrator', path: '/records/analytics-hub-admin-pack/power-platform.md' },
    { who: 'Your licence admin', path: '/records/analytics-hub-admin-pack/licence.md' },
  ],
};

/** @param {Element} section */
const packLines = (section) => (all(section).find((el) => cls(el) === 'admin-pack-files')?.children ?? []).map((li) => li.text);

test('prerequisites: under the requests, where the admin pack is: the index to start from, a file per admin, and Copy path', async () => {
  const { items, requests } = requestsFixture();
  const context = page();
  /** @type {string[]} */
  const copied = [];
  context.navigator = { clipboard: { writeText: async (/** @type {string} */ text) => { copied.push(text); } } };
  const panel = runInContext(`
    app.state = ${JSON.stringify({ user: { upn: 'someone@example.com' }, prereqs: { at: 0, upn: 'someone@example.com', items, requests, adminPack: PACK } })};
    prereqsPanel(false);
  `, context);
  const body = all(panel).find((el) => cls(el) === 'panel-body');
  assert.ok(body);
  assert.deepEqual(body.children.map(cls), ['hint', 'prereqs', 'admin-requests', 'admin-requests admin-pack'], 'after the requests it holds');
  const section = body.children[3];
  assert.equal(section.attributes['aria-label'], 'Admin pack');
  assert.equal(section.children[0].text, 'Admin pack');
  assert.equal(section.children[1].text, 'The same requests as files: one for each admin, to send as it is, and an index for you that says who gets which.');
  assert.deepEqual(packLines(section), [
    'Start here: /records/analytics-hub-admin-pack.md',
    'A Power Platform administrator: /records/analytics-hub-admin-pack/power-platform.md',
    'Your licence admin: /records/analytics-hub-admin-pack/licence.md',
  ]);
  const button = all(section).find((el) => el.tag === 'button');
  assert.ok(button);
  assert.equal(button.text, 'Copy path');
  await button.events.click();
  assert.deepEqual(copied, [PACK.index]);

  // An index with nothing left in it says so. No pack (no install record to put it next to, or a check saved before
  // there was one): no section.
  const empty = runInContext(`app.state.prereqs.adminPack = { index: ${JSON.stringify(PACK.index)}, files: [] }; prereqsPanel(false);`, context);
  const none = all(empty).find((el) => cls(el) === 'admin-requests admin-pack');
  assert.ok(none);
  assert.equal(none.children[1].text, 'Nothing is waiting on an admin.');
  assert.deepEqual(packLines(none), [`Start here: ${PACK.index}`]);
  for (const adminPack of ['null', 'undefined']) {
    const missing = runInContext(`app.state.prereqs.adminPack = ${adminPack}; prereqsPanel(false);`, context);
    assert.equal(all(missing).some((el) => cls(el) === 'admin-requests admin-pack'), false, adminPack);
  }
});

test('prerequisites: the run log shows where the admin pack is after the requests, and the Markdown export lists its files', () => {
  const { items, requests } = requestsFixture();
  const context = page();
  const logged = runInContext(`
    app.replay = true;
    app.run = createRun({ type: 'command', command: 'prereqs', state: 'running', at: 0, seq: 1 });
    [
      { type: 'prereqs', items: ${JSON.stringify(items)}, at: 1 },
      { type: 'admin-requests', requests: ${JSON.stringify(requests)}, at: 2 },
      { type: 'admin-pack', ...${JSON.stringify(PACK)}, at: 3 },
    ].forEach(apply);
    [...runItems(app.run.stages)].filter((it) => ['prereqs', 'admin-requests', 'admin-pack'].includes(it.t)).map((it) => [it.t, it.el]);
  `, context);
  assert.deepEqual([...logged].map(([t]) => t), ['prereqs', 'admin-requests', 'admin-pack']);
  const section = logged[2][1];
  assert.equal(cls(section), 'admin-requests admin-pack');
  assert.equal(packLines(section).length, 3);

  const md = runInContext(`itemMarkdown(${JSON.stringify({ t: 'admin-pack', ...PACK })}, 2).join('\\n')`, context);
  assert.equal(md, [
    '', '**Admin pack**', '',
    '- Start here: `/records/analytics-hub-admin-pack.md`',
    '- A Power Platform administrator: `/records/analytics-hub-admin-pack/power-platform.md`',
    '- Your licence admin: `/records/analytics-hub-admin-pack/licence.md`',
    '',
  ].join('\n'));
  const empty = runInContext(`itemMarkdown(${JSON.stringify({ t: 'admin-pack', index: PACK.index, files: [] })}, 2).join('\\n')`, context);
  assert.match(empty, /^Nothing is waiting on an admin\.$/m);
  assert.match(empty, /^- Start here: `\/records\/analytics-hub-admin-pack\.md`$/m);
});

/** What's left for admins at the end of a Fabric install that left Global Reader, consent, names, the export, Foundry and the Viva query. */
function doneFixture() {
  const config = emptyConfig();
  Object.assign(config.app, { appId: 'app-1', servicePrincipalId: 'sp-1' });
  Object.assign(config.dataSources, { resourceGraph: 'api', productFeedback: 'api', studioCredits: 'csv', coworkCredits: 'csv' });
  config.modules.consumption = true;
  config.modules.agentEvaluator = false;
  const requests = doneRequests(config, { from: 'someone@example.com', consented: false });
  assert.deepEqual(requests.map((r) => r.admin), ['role-admin', 'global-admin', 'm365-admin', 'azure-owner', 'viva']);
  return requests;
}

/**
 * An install that showed preflight's requests, ended with a card and the requests at the end, and finished.
 * @param {import('node:vm').Context} context @param {unknown[]} done
 * @param {{ index: string, files: { who: string, path: string }[], done?: boolean }[]} [packs]  Where the admin pack
 *   is: preflight's after its requests, and the end's after what's left.
 */
function finishedInstall(context, done, packs = []) {
  const { requests } = requestsFixture();
  const pack = (/** @type {boolean} */ end, /** @type {number} */ at) =>
    JSON.stringify(packs.filter((p) => !!p.done === end).map((p) => ({ type: 'admin-pack', ...p, at })));
  return runInContext(`
    app.replay = true;
    app.run = createRun({ type: 'command', command: 'install', state: 'running', at: 0, seq: 1 });
    [
      { type: 'admin-requests', requests: ${JSON.stringify(requests)}, at: 1 },
      ...${pack(false, 1)},
      { type: 'step', n: 1, total: 1, title: 'Share the app', at: 2 },
      { type: 'line', kind: 'ok', text: 'Shared it', at: 3 },
      { type: 'next-steps', title: '1 step left', at: 4, steps: [{ id: 'share-app', title: 'Share the app with your users',
        why: 'Only you can open it until it\\'s shared.', who: 'You' }] },
      ...${JSON.stringify(done.length ? [{ type: 'done-requests', requests: done, at: 5 }] : [])},
      ...${pack(true, 5)},
    ].forEach(apply);
    onCommand({ type: 'command', command: 'install', state: 'done', at: 6, seq: 2 });
    app.run;
  `, context);
}

test('Done page: what\'s left for admins at the end, one request per admin, with notes, the message, Copy request and what you do once it\'s done', async () => {
  const done = doneFixture();
  const context = page();
  /** @type {string[]} */
  const copied = [];
  context.navigator = { clipboard: { writeText: async (/** @type {string} */ text) => { copied.push(text); } } };
  const run = finishedInstall(context, done);

  // The outcome: the cards you do, then the requests for your admins. Preflight's requests stay in the run log.
  const outcome = run.outcomeEl;
  const sections = outcome.children.filter((/** @type {Element} */ el) => el.tag === 'section');
  assert.deepEqual(sections.map(cls), ['next', 'admin-requests']);
  const section = sections[1];
  assert.equal(section.children[0].text, 'Still to do by your admins');
  assert.match(section.children[1].text, /^One request per admin\. Copy each one and send it\./);
  const cards = all(section).filter((el) => cls(el)?.startsWith('next-card'));
  assert.deepEqual(cards.map((card) => all(card).find((el) => cls(el) === 'next-name')?.text), done.map((r) => r.who));
  assert.equal(all(outcome).some((el) => el.text === 'Your licence admin'), false, 'preflight\'s requests aren\'t on the Done page');

  done.forEach((r, i) => {
    const card = cards[i];
    assert.equal(all(card).find((el) => cls(el) === 'next-who')?.text, `For: ${r.rows.join('; ')}${r.optional ? ', optional' : ''}`);
    assert.equal(all(card).find((el) => el.tag === 'pre')?.text, r.message);
    const after = all(card).find((el) => cls(el) === 'next-after');
    assert.ok(after, `${r.admin}: what you do once it's done`);
    assert.deepEqual(after.children.map((li) => li.text), r.after);
    assert.ok(all(card).some((el) => el.tag === 'strong' && el.text === 'Once it\'s done'));
    for (const note of r.notes ?? []) assert.ok(card.children.some((el) => el.tag === 'p' && el.text === note), note);
  });
  const viva = cards[4];
  assert.equal(cls(viva), 'next-card optional');
  assert.match(all(viva).find((el) => cls(el) === 'next-who')?.text ?? '', /, optional$/);
  assert.ok(done[2].notes?.length && done[4].notes?.length, 'the export and the Viva query carry a note for you');
  // A link in a note or a follow-up opens.
  const linked = runInContext(`renderDoneRequests(${JSON.stringify([{ ...done[0], notes: ['See https://example.com/a.'], after: ['Open https://example.com/b, then wait.'] }])})`, context);
  assert.deepEqual(all(linked).filter((el) => el.tag === 'a').map((el) => el.attributes.href), ['https://example.com/a', 'https://example.com/b']);

  const button = all(cards[1]).find((el) => el.tag === 'button');
  assert.ok(button);
  assert.equal(button.text, 'Copy request');
  await button.events.click();
  assert.deepEqual(copied, [done[1].message]);
  assert.equal(button.text, 'Copied');

  // The run log doesn't show them: they're on the Done page, once.
  const items = [...runInContext('[...runItems(app.run.stages)]', context)];
  const end = items.filter((it) => it.t === 'done-requests');
  assert.equal(end.length, 1);
  assert.equal(end[0].el, null);
  assert.ok(items.find((it) => it.t === 'admin-requests')?.el, 'preflight\'s requests show in the run log');

  // Nothing left for admins: no section, and the outcome doesn't make one up.
  const none = finishedInstall(page(), []);
  assert.equal(none.outcomeEl.children.filter((/** @type {Element} */ el) => el.tag === 'section').map(cls).join(), 'next');
  assert.equal(runInContext('renderDoneRequests([])', context), null);
});

test('Done page: the saved record lists the requests at the end once, with each message as it\'s sent and what you do afterwards', () => {
  const done = doneFixture();
  const context = page();
  finishedInstall(context, done);
  runInContext('saved = []; download = (name, lines) => saved.push(lines.join("\\n"));', context);
  runInContext('saveRecord(app.run)', context);
  const [md] = runInContext('saved', context);
  assert.equal(md.split('**Still to do by your admins**').length, 2, 'once');
  assert.equal(md.split('**Requests for your admins**').length, 2, 'preflight\'s, once, where they were in the run');
  done.forEach((r, i) => {
    const head = `${i + 1}. **${r.who}**${r.optional ? ' (optional)' : ''} (for: ${r.rows.join('; ')})`;
    assert.equal(md.split(`\n${head}\n`).length, 2, head);
    const fenced = r.message.split('\n').map((l) => (l ? `   ${l}` : '')).join('\n');
    assert.ok(md.includes(`   \`\`\`text\n${fenced}\n   \`\`\``), `${r.admin}: the message, as it's sent`);
    for (const a of r.after ?? []) assert.ok(md.includes(`   - ${a}`), a);
  });
  assert.match(md, /^ {3}Once it's done:$/m);
  assert.ok(md.indexOf('**Requests for your admins**') < md.indexOf('**Still to do by your admins**'), 'in the order they came');
});

test('Done page: where the admin pack is, after what\'s left for admins; preflight\'s stays in the run log, and the saved record has both', () => {
  const done = doneFixture();
  const context = page();
  const end = { index: PACK.index, files: done.map((r) => ({ who: r.who, path: `/records/analytics-hub-admin-pack/${r.admin}.md` })), done: true };
  const run = finishedInstall(context, done, [PACK, end]);
  const sections = run.outcomeEl.children.filter((/** @type {Element} */ el) => el.tag === 'section');
  assert.deepEqual(sections.map(cls), ['next', 'admin-requests', 'admin-requests admin-pack']);
  assert.deepEqual(packLines(sections[2]), [`Start here: ${PACK.index}`, ...end.files.map((f) => `${f.who}: ${f.path}`)]);

  // The run log shows preflight's where it was written; the end's is on the Done page only.
  const items = [...runInContext('[...runItems(app.run.stages)]', context)].filter((it) => it.t === 'admin-pack');
  assert.equal(items.length, 2);
  assert.equal(cls(items[0].el), 'admin-requests admin-pack');
  assert.deepEqual(packLines(items[0].el), [`Start here: ${PACK.index}`, ...PACK.files.map((f) => `${f.who}: ${f.path}`)]);
  assert.equal(items[1].el, null);

  // The saved record: both, in the order they came.
  runInContext('saved = []; download = (name, lines) => saved.push(lines.join("\\n"));', context);
  runInContext('saveRecord(app.run)', context);
  const [md] = runInContext('saved', context);
  assert.equal(md.split('**Admin pack**').length, 3);
  assert.ok(md.indexOf('**Requests for your admins**') < md.indexOf('**Admin pack**'));
  assert.ok(md.indexOf('**Still to do by your admins**') < md.lastIndexOf('**Admin pack**'));
  for (const f of end.files) assert.ok(md.includes(`- ${f.who}: \`${f.path}\``), f.who);

  // Nothing left at the end of an install that wrote a pack before: the index says so, and so does the Done page.
  const none = finishedInstall(page(), [], [PACK, { index: PACK.index, files: [], done: true }]);
  const last = none.outcomeEl.children.filter((/** @type {Element} */ el) => el.tag === 'section');
  assert.deepEqual(last.map(cls), ['next', 'admin-requests admin-pack']);
  assert.equal(last[1].children[1].text, 'Nothing is waiting on an admin.');
  // Preflight's alone isn't on the Done page: it stays in the run log.
  assert.equal(finishedInstall(page(), [], [PACK]).outcomeEl.children.filter((/** @type {Element} */ el) => el.tag === 'section').map(cls).join(), 'next');
});
