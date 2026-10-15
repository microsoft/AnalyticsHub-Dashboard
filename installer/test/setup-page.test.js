// @ts-check
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';

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
  /** @returns {string} */
  get text() { return this.textContent + this.children.map((child) => child.text).join(''); }
}

function page() {
  const context = createContext({
    Node: Element, matchMedia: () => ({ matches: false }), submitted: [],
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
