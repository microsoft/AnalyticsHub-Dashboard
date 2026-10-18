// @ts-check
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CLI_PACKAGE, pinnedVersion } from '../src/managed-app/cli.js';
import { ADMIN_STEPS } from '../src/managed-app/errors.js';
import {
  DEFAULT_NAME, MIN_NODE, appPackagesReady, nodeOk, npmCommand, npmSwallowed, openInBrowser, parseArgs, parseShareList,
  report, runDeploy, runRemove, spawnNpm, terminalIo, yes,
} from '../src/managed-app/flow.js';
import { isGuid } from '../src/managed-app/links.js';
import { CONFIG_FILE, INSTALL_FOLDER, INSTALL_RECORD_FILE, VIEWER_GROUP } from '../src/managed-app/models.js';
import { readSaved } from '../src/managed-app/state.js';
import * as steps from '../src/managed-app/steps.js';

/** @typedef {import('../src/managed-app/cli.js').CliResult} CliResult */
/** @typedef {import('../src/managed-app/flow.js').FlowDeps} FlowDeps */
/** @typedef {import('../src/managed-app/flow.js').Io} Io */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const EXAMPLE = join(REPO, 'app', 'managed-app.config.example.json');
const WS = '00000000-0000-4000-8000-00000000000a';
const VL = '00000000-0000-4000-8000-00000000000b';
const CC = '00000000-0000-4000-8000-00000000000c';
const AE = '00000000-0000-4000-8000-00000000000d';
const GROUP = '00000000-0000-4000-8000-00000000000e';
const PAT = 'pat@contoso.com';
const SAM = 'sam@contoso.com';
const OTHER = 'other@contoso.com';
const NOW = '2026-06-01T12:00:00.000Z';
const LATER = '2026-06-02T09:00:00.000Z';
const PIN = pinnedVersion();
const PACKAGE_JSON = '{\r\n  "name": "analytics-hub-app"\r\n}\r\n';
const PACKAGE_LOCK = '{\n  "lockfileVersion": 3\n}\n';
const POWER_BI = { powerbi: { apis: { ExecuteDatasetQueriesJson: {}, GetDatasets: {} } } };
const APP_PACKAGES = ['@microsoft/managed-apps', '@microsoft/managed-apps-vite-plugin', 'vite'];
const RECORD_PATH = join('Documents', INSTALL_FOLDER, INSTALL_RECORD_FILE);
const PLAY = 'https://play.example/app-1';
const VL_MODEL = { workspaceId: WS, itemId: VL };
const CC_MODEL = { workspaceId: WS, itemId: CC };
const ACCESS = { groupId: GROUP, groupName: VIEWER_GROUP, grantedModels: [VL, CC] };
/** A Fabric install with the Consumption Central module. */
const RECORD = {
  target: 'fabric',
  fabric: { workspaceId: WS },
  semanticModel: { enabled: true, id: VL, bound: true },
  modules: { consumption: true, agentEvaluator: false },
  consumption: { model: { id: CC, bound: true } },
  agentEvaluator: { model: {} },
  access: ACCESS,
};
const AZURE_RECORD = { target: 'azure', azure: { powerBi: { workspaceId: WS, datasetId: VL, consumptionDatasetId: CC } }, access: ACCESS };
const FIRST_RUN = ['auth status', 'connector list-actions', 'app init', 'app add data-source', 'app deploy', 'app share', 'app share list'];
const CHECKLIST = 'Before others use it, check these. Setup can\'t:';
const ACCOUNT = `Signed in as ${PAT}. Use this account? (Y/n) `;
const SHARE_GROUP = `Share it with ${VIEWER_GROUP}? That group has access to the models. (Y/n) `;
const ANYONE = 'Anyone else? Emails or group object IDs, comma-separated (Enter for no one): ';
/** Enter for each question of a first run with an install record: the models, the account, the group, anyone else. */
const ENTER_4 = ['', '', '', ''];

/** @param {import('node:test').TestContext} t */
function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ahm-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * @param {string} error
 * @param {number} [exitCode]
 * @returns {Partial<CliResult>}
 */
const failure = (error, exitCode = 1) => ({ ok: false, exitCode, error });

/**
 * @param {string} dir
 * @param {string} version
 */
function writePackage(dir, version) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version }));
}

/** @param {string} appDir */
function addAppPackages(appDir) {
  for (const name of APP_PACKAGES) writePackage(join(appDir, 'node_modules', ...name.split('/')), '1.0.0');
}

/**
 * An app folder, as downloaded, with its packages installed.
 * @param {string} root
 * @param {string} name
 */
function appFolder(root, name) {
  const appDir = join(root, name);
  mkdirSync(appDir, { recursive: true });
  writeFileSync(join(appDir, 'package.json'), PACKAGE_JSON);
  writeFileSync(join(appDir, 'package-lock.json'), PACKAGE_LOCK);
  addAppPackages(appDir);
  return appDir;
}

/**
 * Questions answered from a list, in order. After the last, there's no answer, as at the end of piped input.
 * @param {(string | undefined)[]} [answers]
 */
function fakeIo(answers = []) {
  const queue = [...answers];
  /** @type {string[]} */
  const lines = [];
  /** @type {string[]} */
  const questions = [];
  /** @type {Io} */
  const io = {
    say: (line = '') => {
      lines.push(line);
    },
    ask: async (question) => {
      questions.push(question);
      lines.push(question);
      return queue.shift();
    },
  };
  return { io, lines, questions, text: () => lines.join('\n'), unanswered: () => queue.length };
}

/**
 * A fake managed apps CLI with a tenant behind it: who's signed in, the apps, and who each is shared with.
 * Each app command acts on the app in its folder's ms.config.json, as the real one does.
 * @param {object} [given]
 * @param {string} [given.account]  Who's signed in. No one by default.
 * @param {string[]} [given.accounts]  The accounts the CLI has.
 * @param {string} [given.loginAs]  Who a sign-in signs in as, whichever account it asked for.
 * @param {boolean} [given.blocked]  An admin blocks the Power BI connector's query actions.
 * @param {string[]} [given.unknown]  People the directory doesn't have.
 */
function fakeCli(given = {}) {
  const tenant = {
    account: given.account,
    accounts: given.accounts ?? (given.account ? [given.account] : []),
    loginAs: given.loginAs,
    blocked: given.blocked ?? false,
    unknown: given.unknown ?? [],
    /** @type {Map<string, { environmentId: string, displayName: string, deploys: number, shared: string[] }>} */
    apps: new Map(),
    made: 0,
  };
  /** @type {Record<string, (args: string[], options: any) => Partial<CliResult> | undefined>} */
  const override = {};
  /** @type {{ command: string, args: string[], options: any }[]} */
  const calls = [];
  const valueOf = (/** @type {string[]} */ args, /** @type {string} */ name) => {
    const at = args.indexOf(name);
    return at < 0 ? undefined : args[at + 1];
  };
  const appIn = (/** @type {string} */ cwd) => {
    const { appId } = JSON.parse(readFileSync(join(cwd, 'ms.config.json'), 'utf8'));
    const app = tenant.apps.get(appId);
    if (!app) throw new Error(`The tenant has no app ${appId}.`);
    return { appId, app };
  };
  /** @type {Record<string, (args: string[], options: any) => Partial<CliResult>>} */
  const handlers = {
    'auth status': () => (tenant.account
      ? { data: { signedIn: true, activeAccount: { username: tenant.account }, accounts: tenant.accounts.map((username) => ({ username })) } }
      : failure('Not signed in.', 3)),
    'auth switch': (args) => {
      const account = String(valueOf(args, '--account'));
      if (!tenant.accounts.includes(account)) return failure(`There's no account ${account}.`);
      tenant.account = account;
      return {};
    },
    'auth login': (args) => {
      const account = tenant.loginAs ?? String(valueOf(args, '--account'));
      tenant.account = account;
      if (!tenant.accounts.includes(account)) tenant.accounts.push(account);
      return { data: undefined };
    },
    'connector list-actions': () => ({
      data: { items: [{ id: 'ExecuteDatasetQueriesJson', behavior: tenant.blocked ? 'Block' : 'Allow' }, { id: 'GetDatasets', behavior: 'Allow' }] },
    }),
    'app init': (args, { cwd }) => {
      const appId = `app-${++tenant.made}`;
      const environmentId = valueOf(args, '--environment-id') ?? 'env-dev';
      const displayName = String(valueOf(args, '--display-name'));
      tenant.apps.set(appId, { environmentId, displayName, deploys: 0, shared: [] });
      writeFileSync(join(cwd, 'ms.config.json'), JSON.stringify({ appId, environmentId, appDisplayName: displayName }));
      writeFileSync(join(cwd, 'package.json'), '{ "devDependencies": { "@microsoft/managed-apps-cli": "^0.29.0" } }');
      writeFileSync(join(cwd, 'package-lock.json'), '{}');
      return { data: { success: true } };
    },
    'app add data-source': (_args, { cwd }) => {
      mkdirSync(join(cwd, 'generated'), { recursive: true });
      writeFileSync(join(cwd, 'generated', 'dataSources.ts'), `export default ${JSON.stringify(POWER_BI)};\n`);
      return {};
    },
    'app refresh data-source': () => ({}),
    'app deploy': (_args, { cwd }) => {
      const { appId, app } = appIn(cwd);
      app.deploys++;
      return { data: { appPlayUri: `https://play.example/${appId}` } };
    },
    'app share list': (_args, { cwd }) => ({
      data: { results: [{ value: appIn(cwd).app.shared.filter((p) => isGuid(p)).map((principalObjectId) => ({ principalObjectId })) }] },
    }),
    'app share': (args, { cwd }) => {
      const { app } = appIn(cwd);
      const asked = args[2].split(',');
      const rejected = asked.filter((p) => tenant.unknown.includes(p));
      app.shared.push(...asked.filter((p) => !rejected.includes(p)));
      return { data: { partialFailure: rejected.length > 0, warnings: rejected.map((input) => ({ input, reason: 'Not found in the directory.' })) } };
    },
    'app play': (_args, { cwd }) => ({ data: { url: `https://play.example/${appIn(cwd).appId}` } }),
    'app delete': (args) => {
      const appId = String(valueOf(args, '--app'));
      return tenant.apps.delete(appId) ? { data: { existed: true } } : failure(`App ${appId} wasn't found.`, 6);
    },
  };
  const commands = Object.keys(handlers).sort((a, b) => b.length - a.length);
  /** @type {import('../src/managed-app/cli.js').RunCli} */
  const run = async (args, options = {}) => {
    const command = commands.find((c) => c.split(' ').every((word, i) => args[i] === word));
    if (!command) throw new Error(`The fake CLI has no ${args.join(' ')}.`);
    calls.push({ command, args, options });
    const given = override[command]?.(args, options) ?? handlers[command](args, options);
    return { ok: true, exitCode: 0, data: {}, stdout: '', stderr: '', ...given };
  };
  return { run, tenant, override, calls, commands: () => calls.map((c) => c.command) };
}

/**
 * A machine to run it on: the app folder with its packages, the pinned CLI, a place for state, the CLI and
 * its tenant, npm and the browser. All faked.
 * @param {import('node:test').TestContext} t
 * @param {{ record?: any, cli?: Parameters<typeof fakeCli>[0] }} [given]  record null: no install record.
 */
function machine(t, { record = RECORD, cli = { account: PAT } } = {}) {
  const root = tempDir(t);
  const cliDir = join(root, 'cli');
  mkdirSync(cliDir);
  writeFileSync(join(cliDir, 'package.json'), JSON.stringify({ private: true, dependencies: { [CLI_PACKAGE]: PIN } }));
  writePackage(join(cliDir, 'node_modules', '@microsoft', 'managed-apps-cli'), PIN);
  return {
    root,
    appDir: appFolder(root, 'app'),
    cliDir,
    stateDir: join(root, 'state'),
    cli: fakeCli(cli),
    record,
    now: NOW,
    /** @type {string[]} */
    opened: [],
    /** @type {{ args: string[], cwd: string }[]} */
    npmRuns: [],
    npm: /** @type {(args: string[], cwd: string) => number | null} */ (() => 0),
  };
}

/**
 * @param {ReturnType<typeof machine>} m
 * @param {Io} io
 * @param {Partial<FlowDeps>} extra
 * @returns {FlowDeps}
 */
function depsFor(m, io, extra) {
  return {
    io,
    appDir: m.appDir,
    run: m.cli.run,
    cliDir: m.cliDir,
    stateDir: m.stateDir,
    runNpm: async (args, cwd) => {
      m.npmRuns.push({ args, cwd });
      return m.npm(args, cwd);
    },
    findRecord: () => (m.record ? { path: RECORD_PATH, record: m.record } : undefined),
    openUrl: (url) => {
      m.opened.push(url);
    },
    nodeVersion: `v${MIN_NODE}`,
    now: () => new Date(m.now),
    env: {},
    ...extra,
  };
}

/**
 * npm run deploy:managed, answering its questions.
 * @param {ReturnType<typeof machine>} m
 * @param {string[]} [argv]
 * @param {(string | undefined)[]} [answers]
 * @param {Partial<FlowDeps>} [extra]
 */
async function deploy(m, argv = [], answers = [], extra = {}) {
  const said = fakeIo(answers);
  const code = await runDeploy(argv, depsFor(m, said.io, extra));
  return { code, ...said };
}

/**
 * npm run remove:managed, answering its questions.
 * @param {ReturnType<typeof machine>} m
 * @param {string[]} [argv]
 * @param {(string | undefined)[]} [answers]
 * @param {Partial<FlowDeps>} [extra]
 */
async function remove(m, argv = [], answers = [], extra = {}) {
  const said = fakeIo(answers);
  const code = await runRemove(argv, depsFor(m, said.io, extra));
  return { code, ...said };
}

/**
 * Sets up the app on the machine as a first run does, and forgets the calls it made.
 * @param {ReturnType<typeof machine>} m
 */
async function deployed(m) {
  const first = await deploy(m, [], ENTER_4);
  assert.equal(first.code, 0, first.text());
  m.cli.calls.length = 0;
}

/**
 * @param {{ lines: string[] }} said
 * @param {string[]} expected
 */
function saidAll(said, expected) {
  for (const line of expected) assert.ok(said.lines.includes(line), `It didn't say: ${line}\n---\n${said.lines.join('\n')}`);
}

/**
 * @param {ReturnType<typeof machine>} m
 * @returns {unknown}
 */
const configOf = (m) => JSON.parse(readFileSync(join(m.appDir, CONFIG_FILE), 'utf8'));

// --- npm run deploy:managed ----------------------------------------------------------------------------

test('deploy:managed: a first run takes the models from the install record, makes the app, deploys it, and shares it with the viewer group', async (t) => {
  const m = machine(t);
  const first = await deploy(m, [], ENTER_4);
  assert.equal(first.code, 0, first.text());
  assert.deepEqual(first.questions, ['Use those models? (Y/n) ', ACCOUNT, SHARE_GROUP, ANYONE]);
  assert.deepEqual(m.cli.commands(), FIRST_RUN);
  const [, policy, made, added, uploaded, shared, listed] = m.cli.calls;
  assert.deepEqual(policy.args, ['connector', 'list-actions', '--connector', 'shared_powerbi']);
  assert.deepEqual(made.args, ['app', 'init', '--repo', 'none', '--display-name', DEFAULT_NAME, '--build-command', 'npm run build:managed']);
  assert.deepEqual(shared.args, ['app', 'share', GROUP, '--access', 'play']);
  for (const call of [made, added, uploaded, shared, listed]) assert.equal(call.options.cwd, m.appDir, call.command);

  assert.deepEqual(configOf(m), { semanticModels: { vl: VL_MODEL, cc: CC_MODEL } });
  assert.equal(readFileSync(join(m.appDir, 'package.json'), 'utf8'), PACKAGE_JSON, 'init\'s change is undone, so npm ci still works');
  assert.equal(readFileSync(join(m.appDir, 'package-lock.json'), 'utf8'), PACKAGE_LOCK);
  assert.deepEqual(m.cli.tenant.apps.get('app-1'), { environmentId: 'env-dev', displayName: DEFAULT_NAME, deploys: 1, shared: [GROUP] });
  assert.deepEqual(readSaved(m.stateDir), {
    appId: 'app-1', environmentId: 'env-dev', displayName: DEFAULT_NAME, deployedAt: NOW, playUrl: PLAY, sharedAt: NOW, savedAt: NOW,
  });
  assert.deepEqual(m.opened, [PLAY]);
  assert.deepEqual(m.npmRuns, [], 'the packages were there');
  saidAll(first, [
    `Found your install record: ${RECORD_PATH}`,
    'It has: Analytics Hub Model, Consumption Central model.',
    `Saved them in ${CONFIG_FILE}.`,
    `Making the app "${DEFAULT_NAME}" in your developer environment.`,
    'Deployed.',
    `Shared with ${VIEWER_GROUP}.`,
    `Open it: ${PLAY}`,
    `Signed in as ${PAT}.`,
    CHECKLIST,
    `  1. ${ADMIN_STEPS.executeQueries.who}: ${ADMIN_STEPS.executeQueries.what}`,
    `  3. ${ADMIN_STEPS.licences.who}: ${ADMIN_STEPS.licences.what}`,
    '  4. Open the app as a viewer, then Diagnostics > Check who the model sees. It shows who the model sees, and their row-level security.',
    'To update it, run this again. To remove it: npm run remove:managed',
  ]);
});

test('deploy:managed: running it again only deploys, without asking about models or sharing', async (t) => {
  const m = machine(t);
  await deployed(m);
  m.now = LATER;
  const again = await deploy(m, [], ['']);
  assert.equal(again.code, 0, again.text());
  assert.deepEqual(again.questions, [ACCOUNT]);
  assert.deepEqual(m.cli.commands(), ['auth status', 'app deploy']);
  saidAll(again, [`Models: Analytics Hub Model, Consumption Central model, from ${CONFIG_FILE}.`, `Open it: ${PLAY}`]);
  assert.equal(again.lines.includes(CHECKLIST), false, 'the checklist is for the first deploy');
  assert.deepEqual(m.opened, [PLAY], 'the browser opens the first time only');
  assert.equal(m.cli.tenant.apps.get('app-1')?.deploys, 2);
  assert.deepEqual(readSaved(m.stateDir), {
    appId: 'app-1', environmentId: 'env-dev', displayName: DEFAULT_NAME, deployedAt: LATER, playUrl: PLAY, sharedAt: NOW, savedAt: LATER,
  });
});

test('deploy:managed: in a fresh download, it updates the app set up before, or makes another', async (t) => {
  const m = machine(t);
  await deployed(m);
  m.appDir = appFolder(m.root, 'download');
  const update = await deploy(m, [], ['', '']);
  assert.equal(update.code, 0, update.text());
  assert.deepEqual(update.questions, [`Update the "${DEFAULT_NAME}" app you set up on 2026-06-01? (Y/n) `, ACCOUNT]);
  assert.deepEqual(m.cli.commands(), ['auth status', 'app deploy']);
  assert.equal(steps.readAppConfig(m.appDir)?.appId, 'app-1');
  saidAll(update, [`Models: Analytics Hub Model, Consumption Central model, from ${CONFIG_FILE}.`]);

  m.appDir = appFolder(m.root, 'another');
  m.cli.calls.length = 0;
  const another = await deploy(m, [], ['n', ...ENTER_4]);
  assert.equal(another.code, 0, another.text());
  saidAll(another, ['It makes a new app. The other one stays deployed.']);
  assert.deepEqual(m.cli.commands(), FIRST_RUN);
  assert.deepEqual([...m.cli.tenant.apps.keys()], ['app-1', 'app-2']);
  assert.equal(readSaved(m.stateDir)?.appId, 'app-2', 'it remembers the newest');
});

test('deploy:managed: --new makes another app, and leaves the first one deployed', async (t) => {
  const m = machine(t);
  await deployed(m);
  const fresh = await deploy(m, ['--new', '--display-name', 'Hub test'], ['', '', '']);
  assert.equal(fresh.code, 0, fresh.text());
  assert.deepEqual(fresh.questions, [ACCOUNT, SHARE_GROUP, ANYONE], 'the models are kept');
  saidAll(fresh, [`--new: it makes another app. "${DEFAULT_NAME}" (app-1) stays deployed.`]);
  assert.deepEqual(m.cli.commands(), FIRST_RUN);
  assert.equal(m.cli.calls[2].args[5], 'Hub test');
  assert.deepEqual([...m.cli.tenant.apps.keys()], ['app-1', 'app-2']);
  assert.equal(steps.readAppConfig(m.appDir)?.displayName, 'Hub test');
  assert.equal(readSaved(m.stateDir)?.appId, 'app-2');
});

test('deploy:managed: back in the folder of an app it no longer remembers, it asks about sharing again', async (t) => {
  const m = machine(t);
  await deployed(m);
  const first = m.appDir;
  m.appDir = appFolder(m.root, 'second');
  const second = await deploy(m, ['--new'], ENTER_4);
  assert.equal(second.code, 0, second.text());
  assert.equal(readSaved(m.stateDir)?.appId, 'app-2', 'it remembers the newest');

  m.appDir = first;
  m.now = LATER;
  m.cli.calls.length = 0;
  const back = await deploy(m, [], ['', '', '']);
  assert.equal(back.code, 0, back.text());
  assert.deepEqual(back.questions, [ACCOUNT, SHARE_GROUP, ANYONE]);
  assert.deepEqual(m.cli.commands(), ['auth status', 'app deploy', 'app share', 'app share list']);
  assert.equal(m.cli.tenant.apps.get('app-1')?.deploys, 2);
  assert.deepEqual(readSaved(m.stateDir), {
    appId: 'app-1', environmentId: 'env-dev', displayName: DEFAULT_NAME, deployedAt: LATER, playUrl: PLAY, sharedAt: LATER, savedAt: LATER,
  });
});

test('deploy:managed: another environment than the app\'s stops before anything runs', async (t) => {
  const m = machine(t);
  await deployed(m);
  const here = await deploy(m, ['--environment-id', 'env-test']);
  assert.equal(here.code, 2);
  saidAll(here, ['This app is in environment env-dev. To make one in env-test, add --new.']);

  m.appDir = appFolder(m.root, 'download');
  const download = await deploy(m, ['--environment-id', 'env-test']);
  assert.equal(download.code, 2);
  saidAll(download, ['The app you set up on 2026-06-01 is in environment env-dev. To make one in env-test, add --new.']);
  assert.deepEqual([...here.questions, ...download.questions], []);
  assert.deepEqual(m.cli.calls, []);

  const same = await deploy(m, ['--environment-id', 'ENV-DEV'], ['', '']);
  assert.equal(same.code, 0, same.text());
  assert.deepEqual(m.cli.commands(), ['auth status', 'app deploy']);
});

test('deploy:managed: a blocked query action stops it before the app is made, says who to ask, and it carries on once allowed', async (t) => {
  const m = machine(t, { cli: { account: PAT, blocked: true } });
  const blocked = await deploy(m, [], ['', '']);
  assert.equal(blocked.code, 1);
  assert.deepEqual(m.cli.commands(), ['auth status', 'connector list-actions']);
  const ask = blocked.lines.indexOf(`Ask your ${ADMIN_STEPS.queryAction.who}:`);
  assert.ok(ask > 0, blocked.text());
  assert.deepEqual(blocked.lines.slice(ask + 1), [
    `  ${ADMIN_STEPS.queryAction.what}`,
    `  ${ADMIN_STEPS.queryAction.link}`,
    'Then run npm run deploy:managed again. It picks up where it stopped.',
  ]);
  assert.equal(existsSync(join(m.appDir, 'ms.config.json')), false, 'nothing was made');
  assert.equal(readSaved(m.stateDir), undefined);

  m.cli.tenant.blocked = false;
  m.cli.calls.length = 0;
  const allowed = await deploy(m, [], ['', '', '']);
  assert.equal(allowed.code, 0, allowed.text());
  assert.deepEqual(allowed.questions, [ACCOUNT, SHARE_GROUP, ANYONE], 'the models were saved');
  assert.deepEqual(m.cli.commands(), FIRST_RUN);
});

test('deploy:managed: switches to the account you name when the CLI has it', async (t) => {
  const m = machine(t, { cli: { account: PAT, accounts: [PAT, SAM] } });
  const run = await deploy(m, [], ['', 'n', SAM, '', '']);
  assert.equal(run.code, 0, run.text());
  assert.deepEqual(run.questions.slice(1, 3), [ACCOUNT, 'Your work email: ']);
  assert.deepEqual(m.cli.commands().slice(0, 4), ['auth status', 'auth switch', 'auth status', 'connector list-actions']);
  assert.deepEqual(m.cli.calls[1].args, ['auth', 'switch', '--account', SAM]);
  saidAll(run, [`Signed in as ${SAM}.`]);
});

test('deploy:managed: signs in on screen when no one is signed in, with a code if you ask', async (t) => {
  const m = machine(t, { cli: {} });
  const run = await deploy(m, [], ['', 'pat', PAT, '', '']);
  assert.equal(run.code, 0, run.text());
  saidAll(run, ['That isn\'t an email.', `Signing in as ${PAT}.`, `Signed in as ${PAT}.`]);
  assert.deepEqual(m.cli.commands().slice(0, 3), ['auth status', 'auth login', 'auth status']);
  assert.deepEqual(m.cli.calls[1], { command: 'auth login', args: ['auth', 'login', '--account', PAT], options: { onScreen: true } });

  const n = machine(t, { cli: {} });
  const code = await deploy(n, ['--device-code'], ['', PAT, '', '']);
  assert.equal(code.code, 0, code.text());
  saidAll(code, [`Signing in as ${PAT}. It shows a code to enter in a browser.`]);
  assert.deepEqual(n.cli.calls[1].args, ['auth', 'login', '--account', PAT, '--device-code']);
});

test('deploy:managed: when the browser signs in as someone else, it carries on as them only if you say so', async (t) => {
  const m = machine(t, { cli: { loginAs: OTHER } });
  const declined = await deploy(m, [], ['', PAT, '']);
  assert.equal(declined.code, 1);
  assert.equal(declined.questions[2], `It signed in as ${OTHER}, not ${PAT}. Carry on as ${OTHER}? (y/N) `);
  saidAll(declined, [`Run it again, and sign in as ${PAT}. If another account signs in, add --device-code, and open the link in an InPrivate window.`]);
  assert.deepEqual(m.cli.commands(), ['auth status', 'auth login', 'auth status']);

  const n = machine(t, { cli: { loginAs: OTHER } });
  const accepted = await deploy(n, [], ['', PAT, 'y', '', '']);
  assert.equal(accepted.code, 0, accepted.text());
  saidAll(accepted, [`Signed in as ${OTHER}.`]);
});

test('deploy:managed: a step whose sign-in expired runs again after signing in again', async (t) => {
  const m = machine(t);
  let expired = true;
  m.cli.override['app deploy'] = () => {
    if (!expired) return undefined;
    expired = false;
    return failure('Your sign-in session has expired.', 3);
  };
  const run = await deploy(m, [], ENTER_4);
  assert.equal(run.code, 0, run.text());
  saidAll(run, ['Your sign-in has expired. Sign in again.']);
  assert.deepEqual(m.cli.commands(), [...FIRST_RUN.slice(0, 5), 'auth login', ...FIRST_RUN.slice(4)]);
  assert.deepEqual(m.cli.calls[5], { command: 'auth login', args: ['auth', 'login', '--account', PAT], options: { onScreen: true } });
});

test('deploy:managed: a failed build stops it with the build\'s output; the next run deploys the same app', async (t) => {
  const m = machine(t);
  m.cli.override['app deploy'] = () => ({ ...failure('Build command exited with code 2.'), errorData: { stderrTail: 'src/App.tsx(1,1): error TS2304' } });
  const failed = await deploy(m, [], ['', '']);
  assert.equal(failed.code, 1);
  saidAll(failed, ['It stopped: Build command exited with code 2.', '  src/App.tsx(1,1): error TS2304']);
  assert.deepEqual(readSaved(m.stateDir), { appId: 'app-1', environmentId: 'env-dev', displayName: DEFAULT_NAME, savedAt: NOW });
  assert.deepEqual(m.opened, []);

  delete m.cli.override['app deploy'];
  m.cli.calls.length = 0;
  const fixed = await deploy(m, [], ['', '', '']);
  assert.equal(fixed.code, 0, fixed.text());
  assert.deepEqual(m.cli.commands(), ['auth status', 'app deploy', 'app share', 'app share list']);
  assert.deepEqual(m.opened, [PLAY], 'still its first deploy');
  saidAll(fixed, [CHECKLIST]);
});

test('deploy:managed: when sharing fails, it says who to ask and how to share later, and asks again next time', async (t) => {
  const m = machine(t);
  m.cli.override['app share'] = () => failure('Sharing is blocked by an environment or tenant policy.');
  const failed = await deploy(m, [], ENTER_4);
  assert.equal(failed.code, 1);
  saidAll(failed, ['Sharing failed: Sharing is blocked by an environment or tenant policy.', 'Ask your Power Platform admin:', `Open it: ${PLAY}`]);
  assert.equal(failed.lines[failed.lines.length - 1], `It's deployed, but not shared with ${GROUP}. To share it: npm run deploy:managed -- --share ${GROUP}`);
  assert.equal(readSaved(m.stateDir)?.deployedAt, NOW);
  assert.equal(readSaved(m.stateDir)?.sharedAt, undefined);

  delete m.cli.override['app share'];
  m.cli.calls.length = 0;
  m.now = LATER;
  const again = await deploy(m, [], ['', '', '']);
  assert.equal(again.code, 0, again.text());
  assert.deepEqual(again.questions, [ACCOUNT, SHARE_GROUP, ANYONE], 'it wasn\'t shared, so it asks again');
  assert.deepEqual(m.cli.commands(), ['auth status', 'app deploy', 'app share', 'app share list']);
  saidAll(again, [`Shared with ${VIEWER_GROUP}.`]);
  assert.equal(readSaved(m.stateDir)?.sharedAt, LATER);

  m.cli.calls.length = 0;
  const more = await deploy(m, ['--share', SAM], ['']);
  assert.equal(more.code, 0, more.text());
  assert.deepEqual(more.questions, [ACCOUNT], 'with --share, it asks no one');
  assert.deepEqual(m.cli.commands(), ['auth status', 'app deploy', 'app share'], 'only object IDs can be checked');
  assert.deepEqual(m.cli.calls[2].args, ['app', 'share', SAM, '--access', 'play']);
  saidAll(more, [`Shared with ${SAM}.`]);
  assert.deepEqual(m.cli.tenant.apps.get('app-1')?.shared, [GROUP, SAM]);
});

test('deploy:managed: says who it couldn\'t share with, and when a share hasn\'t shown yet', async (t) => {
  const m = machine(t, { cli: { account: PAT, unknown: [SAM] } });
  m.cli.override['app share list'] = () => ({ data: { results: [] } });
  const run = await deploy(m, [], ['', '', '', `${SAM}, ${OTHER}`]);
  assert.equal(run.code, 1);
  assert.deepEqual(m.cli.calls.find((c) => c.command === 'app share')?.args, ['app', 'share', `${GROUP},${SAM},${OTHER}`, '--access', 'play']);
  saidAll(run, [
    `Not shared: ${SAM}: Not found in the directory.`,
    `Couldn't see it shared with ${VIEWER_GROUP} yet. It can take a few minutes.`,
    `Shared with ${VIEWER_GROUP}, ${OTHER}.`,
    `It's deployed, but not shared with ${SAM}. To share it: npm run deploy:managed -- --share ${SAM}`,
  ]);
  assert.equal(readSaved(m.stateDir)?.sharedAt, undefined);

  const n = machine(t);
  n.cli.override['app share'] = () => ({ data: { partialFailure: true, warnings: [] } });
  const unnamed = await deploy(n, [], ['', '', '', OTHER]);
  assert.equal(unnamed.code, 1);
  assert.equal(unnamed.lines.some((line) => line.startsWith('Shared with')), false, 'it can\'t tell who it was shared with');
  assert.equal(n.cli.commands().includes('app share list'), false);
  assert.equal(unnamed.lines[unnamed.lines.length - 1], `It's deployed, but not shared with ${GROUP}, ${OTHER}. To share it: npm run deploy:managed -- --share ${GROUP},${OTHER}`);
});

test('deploy:managed: warns when the viewer group has no Build on a model', async (t) => {
  const m = machine(t, { record: { ...RECORD, access: { ...ACCESS, grantedModels: [CC] } } });
  const run = await deploy(m, [], ENTER_4);
  assert.equal(run.code, 0, run.text());
  saidAll(run, [`${VIEWER_GROUP} has no Build on: Analytics Hub Model. Its members can open the app, but can't read those. Run the installer again, or give the group Build on each.`]);
});

test('deploy:managed: takes the models an Azure install published', async (t) => {
  const m = machine(t, { record: AZURE_RECORD });
  const run = await deploy(m, [], ENTER_4);
  assert.equal(run.code, 0, run.text());
  assert.deepEqual(configOf(m), { semanticModels: { vl: VL_MODEL, cc: CC_MODEL } });
  assert.deepEqual(m.cli.tenant.apps.get('app-1')?.shared, [GROUP]);
});

test('deploy:managed: without an install record, it asks for each model\'s link, and keeps the example\'s other settings', async (t) => {
  const m = machine(t, { record: null });
  writeFileSync(join(m.appDir, CONFIG_FILE), readFileSync(EXAMPLE));
  const run = await deploy(m, [], [
    `https://app.powerbi.com/groups/${WS}/reports/${VL}/ReportSection`,
    `https://app.powerbi.com/groups/${WS}/datasets/${VL}/details`,
    '',
    `https://app.powerbigov.us/groups/${WS}/semanticmodels/${AE}`,
    '',
    '',
  ]);
  assert.equal(run.code, 0, run.text());
  assert.deepEqual(run.questions, [
    'Analytics Hub Model link: ',
    'Analytics Hub Model link: ',
    'Consumption Central model link (Enter to skip): ',
    'Agent Evaluator model link (Enter to skip): ',
    ACCOUNT,
    ANYONE,
  ]);
  assert.ok(run.lines.some((line) => line.startsWith('That\'s a report link.')), run.text());
  const example = JSON.parse(readFileSync(EXAMPLE, 'utf8'));
  assert.deepEqual(configOf(m), { ...example, semanticModels: { vl: VL_MODEL, ae: { workspaceId: WS, itemId: AE } } });
  saidAll(run, ['It isn\'t shared with anyone else yet. To share it: npm run deploy:managed -- --share <emails or group object IDs>']);
  assert.equal(m.cli.commands().includes('app share'), false);
});

test('deploy:managed: gets the link from the CLI when deploy doesn\'t give one', async (t) => {
  const m = machine(t);
  m.cli.override['app deploy'] = () => ({ data: {} });
  const run = await deploy(m, [], ENTER_4);
  assert.equal(run.code, 0, run.text());
  assert.ok(m.cli.commands().includes('app play'));
  assert.deepEqual(m.opened, [PLAY]);
});

test('deploy:managed: stops when there\'s no answer, or managed-app.config.json isn\'t valid, before anything runs', async (t) => {
  const m = machine(t);
  const silent = await deploy(m);
  assert.equal(silent.code, 1);
  assert.deepEqual(silent.questions, ['Use those models? (Y/n) ']);
  saidAll(silent, ['No answer, so it stopped.']);

  writeFileSync(join(m.appDir, CONFIG_FILE), '{ "semanticModels": ');
  const invalid = await deploy(m);
  assert.equal(invalid.code, 1);
  assert.ok(invalid.lines.some((line) => line.startsWith('It stopped: ')), invalid.text());
  saidAll(invalid, [`${CONFIG_FILE}, in app, isn't valid. Fix it, or delete it and paste the links when it asks.`]);
  assert.deepEqual(m.cli.calls, []);
});

test('deploy:managed: --dry-run, --help, a wrong option, an option npm took, and an old Node.js run nothing', async (t) => {
  const m = machine(t);
  const dry = await deploy(m, ['--dry-run', '--environment-id', 'env-test', '--share', PAT]);
  assert.equal(dry.code, 0);
  saidAll(dry, [
    '  ms connector list-actions --connector shared_powerbi --environment-id env-test',
    `  ms app init --repo none --display-name "${DEFAULT_NAME}" --build-command "npm run build:managed" --environment-id env-test`,
    '  ms app add data-source --connector shared_powerbi --as action',
    '  ms app deploy',
    `  ms app share ${PAT} --access play`,
    `  - Install the CLI: npm install -g ${CLI_PACKAGE}@${PIN}`,
  ]);

  const help = await deploy(m, ['--help']);
  assert.equal(help.code, 0);
  assert.match(help.text(), /--environment-id <id> {3}Use this environment/);

  const wrong = await deploy(m, ['--environment', 'env-test']);
  assert.equal(wrong.code, 2);
  assert.deepEqual(wrong.lines, ['Unknown option: --environment', 'See the options: npm run deploy:managed -- --help']);

  const swallowed = await deploy(m, [], [], { env: { npm_lifecycle_event: 'deploy:managed', npm_config_dry_run: 'true' } });
  assert.equal(swallowed.code, 2);
  assert.deepEqual(swallowed.lines, ['npm took --dry-run for itself, so nothing ran. Put -- before the options:', '  npm run deploy:managed -- <options>']);

  const old = await deploy(m, [], [], { nodeVersion: 'v24.14.0' });
  assert.equal(old.code, 1);
  assert.deepEqual(old.lines, [`It needs Node.js ${MIN_NODE} or later, and this is v24.14.0. Get it from https://nodejs.org/, then run it again.`]);

  assert.deepEqual(m.cli.calls, []);
  assert.deepEqual(m.npmRuns, []);
  assert.equal(existsSync(m.stateDir), false);
  assert.equal(existsSync(join(m.appDir, CONFIG_FILE)), false);
});

test('deploy:managed: installs the app\'s build tools and the pinned CLI when they\'re missing', async (t) => {
  const m = machine(t);
  rmSync(join(m.appDir, 'node_modules'), { recursive: true });
  rmSync(join(m.cliDir, 'node_modules'), { recursive: true });
  assert.equal(appPackagesReady(m.appDir), false);
  m.npm = (_args, cwd) => {
    if (cwd === m.appDir) addAppPackages(cwd);
    else writePackage(join(cwd, 'node_modules', '@microsoft', 'managed-apps-cli'), PIN);
    return 0;
  };
  const run = await deploy(m, [], ENTER_4);
  assert.equal(run.code, 0, run.text());
  assert.deepEqual(m.npmRuns, [
    { args: ['ci', '--no-audit', '--no-fund'], cwd: m.appDir },
    { args: ['ci', '--no-audit', '--no-fund', '--ignore-scripts'], cwd: m.cliDir },
  ]);
  assert.equal(appPackagesReady(m.appDir), true);
  saidAll(run, [`Installing the managed apps CLI ${PIN}, just for this. It takes a minute.`]);
});

test('deploy:managed: stops when npm can\'t install what it needs', async (t) => {
  const app = machine(t);
  rmSync(join(app.appDir, 'node_modules', 'vite'), { recursive: true });
  app.npm = () => 1;
  const appFailed = await deploy(app);
  assert.equal(appFailed.code, 1);
  saidAll(appFailed, ['npm ci failed in app. Check the messages above, then run it again.']);

  const cli = machine(t);
  writePackage(join(cli.cliDir, 'node_modules', '@microsoft', 'managed-apps-cli'), '0.28.0');
  const cliFailed = await deploy(cli);
  assert.equal(cliFailed.code, 1);
  assert.deepEqual(cli.npmRuns, [{ args: ['ci', '--no-audit', '--no-fund', '--ignore-scripts'], cwd: cli.cliDir }], 'another version is replaced');
  saidAll(cliFailed, ['Couldn\'t install the managed apps CLI. Check the messages above, then run it again.']);

  const gone = machine(t);
  rmSync(join(gone.cliDir, 'package.json'));
  const goneFailed = await deploy(gone);
  assert.equal(goneFailed.code, 1);
  saidAll(goneFailed, [`The managed apps CLI's package is missing from ${gone.cliDir}. Download the code again.`]);

  for (const m of [app, cli, gone]) assert.deepEqual(m.cli.calls, []);
});

// --- npm run remove:managed ----------------------------------------------------------------------------

test('remove:managed: deletes the app once you say yes, and forgets it, keeping your models', async (t) => {
  const m = machine(t);
  await deployed(m);
  const run = await remove(m, [], ['y', '']);
  assert.equal(run.code, 0, run.text());
  assert.deepEqual(run.questions, ['Delete it? (y/N) ', ACCOUNT]);
  saidAll(run, [
    `This deletes "${DEFAULT_NAME}" (app-1), in environment env-dev. Everyone it's shared with loses it.`,
    'Deleted.',
    'The Power BI connection stays, for other apps. If you don\'t need it, delete it in Power Apps > Connections.',
  ]);
  assert.deepEqual(m.cli.calls.map((c) => c.args), [['auth', 'status'], ['app', 'delete', '--force', '--app', 'app-1', '--environment-id', 'env-dev']]);
  assert.equal(m.cli.calls[1].options.cwd, m.appDir);
  assert.equal(m.cli.tenant.apps.size, 0);
  assert.equal(existsSync(m.stateDir), false);
  for (const name of ['ms.config.json', 'generated']) assert.equal(existsSync(join(m.appDir, name)), false, name);
  assert.ok(existsSync(join(m.appDir, CONFIG_FILE)), 'the models stay, for next time');
  assert.equal(readFileSync(join(m.appDir, 'package.json'), 'utf8'), PACKAGE_JSON);
});

test('remove:managed: keeps the app when you say no, or don\'t answer', async (t) => {
  const m = machine(t);
  await deployed(m);
  /** @type {[(string | undefined)[], number][]} */
  const cases = [[['n'], 0], [[''], 0], [[], 1]];
  for (const [answers, code] of cases) {
    const run = await remove(m, [], answers);
    assert.equal(run.code, code, JSON.stringify(answers));
    saidAll(run, ['Nothing was deleted.']);
  }
  assert.deepEqual(m.cli.calls, []);
  assert.equal(m.cli.tenant.apps.size, 1);
  assert.equal(readSaved(m.stateDir)?.appId, 'app-1');
});

test('remove:managed: removes the app saved from an earlier run, says when there\'s none, and when it was already gone', async (t) => {
  const m = machine(t);
  const none = await remove(m);
  assert.equal(none.code, 0);
  assert.deepEqual(none.lines, ['There\'s no managed app to remove. This folder has none, and none was saved.']);

  await deployed(m);
  m.appDir = join(m.root, 'download');
  mkdirSync(m.appDir);
  const saved = await remove(m, [], ['y', '']);
  assert.equal(saved.code, 0, saved.text());
  saidAll(saved, ['Deleted.']);
  assert.deepEqual(m.npmRuns, [], 'removing needs only the CLI, not the app\'s packages');
  assert.equal(existsSync(m.stateDir), false);

  const n = machine(t);
  await deployed(n);
  n.cli.tenant.apps.clear();
  const gone = await remove(n, [], ['y', '']);
  assert.equal(gone.code, 0, gone.text());
  saidAll(gone, ['It was already gone.']);
  assert.equal(existsSync(join(n.appDir, 'ms.config.json')), false);
  assert.equal(existsSync(n.stateDir), false);
});

test('remove:managed: takes only --device-code, and says what npm took', async (t) => {
  const m = machine(t);
  const wrong = await remove(m, ['--new']);
  assert.equal(wrong.code, 2);
  assert.deepEqual(wrong.lines, ['Unknown option: --new', 'See the options: npm run remove:managed -- --help']);
  const help = await remove(m, ['--help']);
  assert.equal(help.code, 0);
  assert.match(help.text(), /--device-code/);
  const swallowed = await remove(m, [], [], { env: { npm_lifecycle_event: 'remove:managed', npm_config_device_code: 'true' } });
  assert.equal(swallowed.code, 2);
  assert.deepEqual(swallowed.lines, ['npm took --device-code for itself, so nothing ran. Put -- before the options:', '  npm run remove:managed -- <options>']);
  assert.deepEqual(m.cli.calls, []);
});

// --- The parts -----------------------------------------------------------------------------------------

test('parseArgs: reads each option, with its value after it or after =', () => {
  const all = parseArgs(['--', '--environment-id', 'Default-0f', '--display-name', ' My Hub ', '--share', `${PAT};${GROUP}`, '--device-code', '--new', '--dry-run'], 'deploy');
  assert.deepEqual(all, {
    ok: true,
    options: { deviceCode: true, fresh: true, dryRun: true, help: false, environmentId: 'Default-0f', displayName: 'My Hub', share: [PAT, GROUP] },
  });
  assert.deepEqual(parseArgs(['--environment-id=env-1', `--share=${GROUP}`], 'deploy'), {
    ok: true, options: { deviceCode: false, fresh: false, dryRun: false, help: false, environmentId: 'env-1', share: [GROUP] },
  });
  assert.deepEqual(parseArgs(['-h'], 'remove'), { ok: true, options: { deviceCode: false, fresh: false, dryRun: false, help: true } });
  assert.deepEqual(parseArgs(['--device-code'], 'remove'), { ok: true, options: { deviceCode: true, fresh: false, dryRun: false, help: false } });
});

test('parseArgs: says what is wrong with an option', () => {
  /** @type {[string[], 'deploy' | 'remove', string][]} */
  const cases = [
    [['--bogus'], 'deploy', 'Unknown option: --bogus'],
    [['extra'], 'deploy', 'Unknown option: extra'],
    [['--new=yes'], 'deploy', '--new takes no value.'],
    [['--dry-run=1'], 'deploy', '--dry-run takes no value.'],
    [['--device-code=1'], 'remove', '--device-code takes no value.'],
    [['--environment-id'], 'deploy', '--environment-id needs an environment ID.'],
    [['--environment-id', '--new'], 'deploy', '--environment-id needs an environment ID.'],
    [['--environment-id', 'env 1'], 'deploy', '--environment-id needs an environment ID.'],
    [['--environment-id=a/b'], 'deploy', '--environment-id needs an environment ID.'],
    [['--display-name'], 'deploy', '--display-name needs a name.'],
    [['--display-name', '  '], 'deploy', '--display-name needs a name.'],
    [['--share'], 'deploy', '--share needs emails or group object IDs.'],
    [['--share', 'pat'], 'deploy', 'pat isn\'t an email or an object ID.'],
    [['--new'], 'remove', 'Unknown option: --new'],
    [['--share', PAT], 'remove', 'Unknown option: --share'],
  ];
  for (const [argv, command, error] of cases) assert.deepEqual(parseArgs(argv, command), { ok: false, error }, argv.join(' '));
});

test('parseShareList: emails and object IDs, each once, however they\'re separated', () => {
  assert.deepEqual(parseShareList(` ${PAT}, ${SAM.toUpperCase()};${GROUP}  ${PAT.toUpperCase()}\n${SAM}`), { ok: true, principals: [PAT, SAM.toUpperCase(), GROUP] });
  assert.deepEqual(parseShareList(' , ; '), { ok: false, error: '--share needs emails or group object IDs.' });
  assert.deepEqual(parseShareList(`${PAT}, Analytics Hub Viewers`), { ok: false, error: 'Analytics isn\'t an email or an object ID.' });
});

test('npmSwallowed: finds the options npm took for itself, only when npm runs it', () => {
  assert.deepEqual(npmSwallowed({}), []);
  assert.deepEqual(npmSwallowed({ npm_config_new: 'true' }), [], 'not run by npm');
  assert.deepEqual(npmSwallowed({
    npm_lifecycle_event: 'deploy:managed',
    npm_config_new: 'true',
    npm_config_dry_run: 'false',
    npm_config_share: '',
    npm_config_environment_id: 'env-1',
    npm_config_device_code: 'true',
    npm_config_cache: 'x',
  }), ['--new', '--environment-id', '--device-code']);
});

test('nodeOk: takes Node.js 24.15 or later', () => {
  assert.equal(MIN_NODE, '24.15.0');
  /** @type {[string, boolean][]} */
  const cases = [
    ['v24.15.0', true], ['v24.15.1', true], ['v24.16.0', true], ['v25.0.0', true], ['v26.1.0', true], ['24.15.0', true], ['v24.15', true],
    ['v24.14.9', false], ['v24.11.0', false], ['v23.99.99', false], ['v22.20.0', false],
  ];
  for (const [version, ok] of cases) assert.equal(nodeOk(version), ok, version);
  assert.equal(nodeOk('v24.11.0', '24.11.0'), true);
});

test('npmCommand: the npm running this, else the one beside Node.js, else npm.cmd through cmd on Windows', () => {
  const execPath = join('n', 'node.exe');
  const running = join('n', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  assert.deepEqual(npmCommand({ env: { npm_execpath: running }, execPath, platform: 'win32', exists: () => true }), { command: execPath, args: [running], shell: false });
  const beside = join('n', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  assert.deepEqual(
    npmCommand({ env: { npm_execpath: join('p', 'pnpm.cjs') }, execPath, platform: 'win32', exists: (file) => file === beside }),
    { command: execPath, args: [beside], shell: false },
    'npm\'s own, not another package manager',
  );
  const lib = join('n', '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  assert.deepEqual(npmCommand({ env: {}, execPath, platform: 'linux', exists: (file) => file === lib }), { command: execPath, args: [lib], shell: false });
  assert.deepEqual(npmCommand({ env: { npm_execpath: running }, execPath, platform: 'win32', exists: () => false }), { command: 'npm.cmd', args: [], shell: true });
  assert.deepEqual(npmCommand({ env: {}, execPath, platform: 'darwin', exists: () => false }), { command: 'npm', args: [], shell: false });
});

/**
 * A child_process.spawn whose child exits, or fails to start.
 * @param {{ code?: number, error?: Error, throws?: Error }} [script]
 */
function fakeSpawn({ code = 0, error, throws } = {}) {
  /** @type {{ command: string, args: string[], options: any }[]} */
  const calls = [];
  /** @type {any} */
  const spawn = (/** @type {string} */ command, /** @type {any} */ args, /** @type {any} */ options) => {
    const shell = !Array.isArray(args);
    calls.push({ command, args: shell ? [] : args, options: shell ? args : options });
    if (throws) throw throws;
    const child = /** @type {any} */ (new EventEmitter());
    child.unref = () => {
      child.unrefed = true;
    };
    setImmediate(() => (error ? child.emit('error', error) : child.emit('close', code)));
    return child;
  };
  return { spawn, calls };
}

test('spawnNpm: runs npm on screen, gives its exit code, and null when it can\'t start', async () => {
  const env = { X: '1' };
  const fake = fakeSpawn({ code: 3 });
  assert.equal(await spawnNpm(['ci', '--no-audit'], 'app-dir', { env, spawn: fake.spawn }), 3);
  const npm = npmCommand({ env });
  const [call] = fake.calls;
  if (npm.shell) {
    assert.equal(call.command, [npm.command, ...npm.args, 'ci', '--no-audit'].join(' '));
    assert.equal(call.options.shell, true);
  } else {
    assert.equal(call.command, npm.command);
    assert.deepEqual(call.args, [...npm.args, 'ci', '--no-audit']);
  }
  assert.equal(call.options.cwd, 'app-dir');
  assert.equal(call.options.stdio, 'inherit');
  assert.equal(call.options.env, env);
  assert.equal(await spawnNpm(['ci'], 'app-dir', { env, spawn: fakeSpawn({ error: new Error('ENOENT') }).spawn }), null);
});

test('openInBrowser: opens https links with the platform\'s opener, detached, and never throws', async () => {
  /** @type {[NodeJS.Platform, string][]} */
  const openers = [['win32', 'explorer.exe'], ['darwin', 'open'], ['linux', 'xdg-open']];
  for (const [platform, command] of openers) {
    const fake = fakeSpawn();
    openInBrowser(PLAY, { platform, spawn: fake.spawn });
    assert.deepEqual(fake.calls, [{ command, args: [PLAY], options: { detached: true, stdio: 'ignore', windowsHide: true } }], platform);
  }
  const none = fakeSpawn();
  for (const url of ['http://play.example/app-1', 'file:///C:/app.html', 'javascript:alert(1)', '']) openInBrowser(url, { platform: 'win32', spawn: none.spawn });
  assert.deepEqual(none.calls, [], 'https links only');
  openInBrowser(PLAY, { platform: 'linux', spawn: fakeSpawn({ throws: new Error('ENOENT') }).spawn });
  openInBrowser(PLAY, { platform: 'linux', spawn: fakeSpawn({ error: new Error('ENOENT') }).spawn });
  await new Promise((done) => setImmediate(done));
});

test('terminalIo: reads piped answers line by line, then gives no answer', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = '';
  output.on('data', (chunk) => {
    written += chunk;
  });
  const io = terminalIo({ input, output });
  input.end('yes\r\n  no  \n');
  assert.equal(await io.ask('First? '), 'yes');
  assert.equal(await io.ask('Second? '), '  no  ');
  assert.equal(await io.ask('Third? '), undefined);
  io.say('Done.');
  io.say();
  io.close?.();
  assert.equal(written, 'First? \nSecond? \nThird? \nDone.\n\n');
});

test('yes: Enter takes the default, and it asks again until it gets y or n', async () => {
  /** @type {[(string | undefined)[], boolean, boolean | undefined][]} */
  const cases = [
    [[''], true, true], [[''], false, false], [['Y'], false, true], [[' yes '], false, true], [['N'], true, false], [['no'], true, false],
    [['maybe', 'y'], false, true], [[], true, undefined],
  ];
  for (const [answers, defaultYes, expected] of cases) assert.equal(await yes(fakeIo(answers).io, 'Go?', defaultYes), expected, JSON.stringify(answers));
  const said = fakeIo(['maybe', 'n']);
  await yes(said.io, 'Go?', true);
  assert.deepEqual(said.lines, ['Go? (Y/n) ', 'Type y or n.', 'Go? (Y/n) ']);
});

test('report: says what failed, then your step, or who to ask, how, and how to carry on', () => {
  const own = fakeIo();
  report(own.io, { who: 'you', message: 'Boom.', details: 'one\ntwo', what: 'Run it again.', link: 'https://example.com/x' }, 'npm run deploy:managed');
  assert.deepEqual(own.lines, ['', 'It stopped: Boom.', '  one', '  two', 'Run it again.', 'https://example.com/x']);

  const admin = fakeIo();
  report(admin.io, { who: 'Fabric admin', what: 'Turn it on.', link: 'https://example.com/y' }, 'npm run deploy:managed', 'Sharing failed');
  assert.deepEqual(admin.lines, ['', 'Sharing failed.', 'Ask your Fabric admin:', '  Turn it on.', '  https://example.com/y', 'Then run npm run deploy:managed again. It picks up where it stopped.']);

  const long = fakeIo();
  report(long.io, { who: 'you', what: 'Fix it.', details: Array.from({ length: 25 }, (_, i) => `line ${i + 1}`).join('\r\n') }, 'again');
  assert.deepEqual(long.lines.filter((line) => line.startsWith('  line')), Array.from({ length: 20 }, (_, i) => `  line ${i + 6}`), 'the last 20 lines');
});

// --- The scripts in app --------------------------------------------------------------------------------

test('deploy-managed.mjs and remove-managed.mjs: run the flow with the real options, outside npm', () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^npm_/i.test(name)));
  const script = (/** @type {string} */ name, /** @type {string[]} */ args) => spawnSync(process.execPath, [join(REPO, 'app', 'scripts', name), ...args], {
    cwd: join(REPO, 'app'), env, encoding: 'utf8', input: '', timeout: 60_000,
  });
  const help = script('deploy-managed.mjs', ['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /^npm run deploy:managed -- \[options\]/);
  const dry = script('deploy-managed.mjs', ['--dry-run', '--share', PAT]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.ok(dry.stdout.includes(`npm install -g ${CLI_PACKAGE}@${PIN}`), dry.stdout);
  assert.ok(dry.stdout.includes(`ms app share ${PAT} --access play`), dry.stdout);
  const wrong = script('deploy-managed.mjs', ['--bogus']);
  assert.equal(wrong.status, 2);
  const removeHelp = script('remove-managed.mjs', ['--help']);
  assert.equal(removeHelp.status, 0, removeHelp.stderr);
  assert.match(removeHelp.stdout, /^npm run remove:managed -- \[options\]/);
});
