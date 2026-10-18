// @ts-check
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG_FILE, emptyConfig } from '../src/config.js';
import {
  CLI_PACKAGE, CLI_PACKAGE_DIR, COMMAND_TIMEOUT_MS, DEPLOY_TIMEOUT_MS, cliBin, createCli, installedVersion, parseJson, pinnedVersion,
} from '../src/managed-app/cli.js';
import { ADMIN_STEPS, CLI_APP_ID, LINKS, explain } from '../src/managed-app/errors.js';
import { isGuid, parseModelLink } from '../src/managed-app/links.js';
import {
  CONFIG_FILE, INSTALL_FOLDER, INSTALL_RECORD_FILE, MODELS, VIEWER_GROUP, expandEnv, findInstallRecord, groupFromRecord,
  modelsFromRecord, modelsWithoutBuild, readModelConfig, stripBom, validModels, writeModelConfig,
} from '../src/managed-app/models.js';
import { APP_FILES, STATE_FOLDER, clearAppFiles, clearState, readSaved, restoreState, saveState, stateDir } from '../src/managed-app/state.js';
import * as steps from '../src/managed-app/steps.js';
import { VIEWER_GROUP_NAME } from '../src/steps/access.js';
import { APP_ALIAS, CONSUMPTION_ALIAS, EVALUATOR_ALIAS, appModels } from '../src/steps/app.js';
import { azureSemanticModels } from '../src/steps/azure/index.js';
import { modelDeployed } from '../src/steps/fabric.js';

/** @typedef {import('../src/managed-app/cli.js').CliResult} CliResult */
/** @typedef {Partial<CliResult> | ((args: string[], options: any) => Partial<CliResult>)} Answer */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const WS = '00000000-0000-4000-8000-00000000000a';
const VL = '00000000-0000-4000-8000-00000000000b';
const CC = '00000000-0000-4000-8000-00000000000c';
const AE = '00000000-0000-4000-8000-00000000000d';
const GROUP = '00000000-0000-4000-8000-00000000000e';
const TENANT = '00000000-0000-4000-8000-00000000000f';
const USER = '00000000-0000-4000-8000-000000000001';
const NOW = '2026-06-01T12:00:00.000Z';
const PACKAGE_JSON = '{\r\n  "name": "analytics-hub-app"\r\n}\r\n';
const PACKAGE_LOCK = '{\n  "lockfileVersion": 3\n}\n';
const POWER_BI = { powerbi: { apis: { ExecuteDatasetQueriesJson: {}, GetDatasets: {} } } };
const NO_QUERY = { powerbi: { apis: { GetDatasets: {} } } };

/** @param {import('node:test').TestContext} t */
function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ahm-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * A fake CLI. Each answer is for the command whose words start the args, the longest first. Any other
 * command succeeds with no data.
 * @param {Record<string, Answer>} [answers]
 */
function fakeRun(answers = {}) {
  /** @type {{ args: string[], options: any }[]} */
  const calls = [];
  const commands = Object.keys(answers).sort((a, b) => b.length - a.length);
  /** @type {import('../src/managed-app/cli.js').RunCli} */
  const run = async (args, options = {}) => {
    calls.push({ args, options });
    const command = commands.find((c) => c.split(' ').every((word, i) => args[i] === word));
    const answer = command === undefined ? undefined : answers[command];
    const given = typeof answer === 'function' ? answer(args, options) : answer;
    return { ok: true, exitCode: 0, data: {}, stdout: '', stderr: '', ...given };
  };
  return { run, calls, commands: () => calls.map((c) => c.args.join(' ')) };
}

/**
 * @param {string} error
 * @param {number} [exitCode]
 * @returns {Partial<CliResult>}
 */
const failure = (error, exitCode = 1) => ({ ok: false, exitCode, error });

/**
 * A child_process.spawn that prints what it's told, then exits.
 * @param {{ stdout?: string, stderr?: string, code?: number | null, hang?: boolean, error?: Error, throws?: Error }} [script]
 */
function fakeSpawn(script = {}) {
  /** @type {{ command: string, args: string[], options: any }[]} */
  const calls = [];
  /** @type {any} */
  const spawn = (/** @type {string} */ command, /** @type {string[]} */ args, /** @type {any} */ options) => {
    calls.push({ command, args, options });
    if (script.throws) throw script.throws;
    const child = /** @type {any} */ (new EventEmitter());
    const piped = options.stdio !== 'inherit';
    child.stdout = piped ? new PassThrough() : null;
    child.stderr = piped ? new PassThrough() : null;
    child.kill = () => {
      setImmediate(() => child.emit('close', null));
      return true;
    };
    setImmediate(() => {
      if (script.error) {
        child.emit('error', script.error);
        return;
      }
      if (script.hang) return;
      const code = script.code === undefined ? 0 : script.code;
      if (!piped) {
        child.emit('close', code);
        return;
      }
      let open = 2;
      const ended = () => {
        if (--open === 0) child.emit('close', code);
      };
      child.stdout.on('end', ended);
      child.stderr.on('end', ended);
      child.stdout.end(script.stdout ?? '');
      child.stderr.end(script.stderr ?? '');
    });
    return child;
  };
  return { spawn, calls };
}

/**
 * What `ms app add data-source` writes: the connector's definitions, as `export default <JSON>;`.
 * @param {string} appDir
 * @param {unknown} sources  Or the file's text.
 */
function writeSources(appDir, sources) {
  mkdirSync(join(appDir, 'generated'), { recursive: true });
  writeFileSync(join(appDir, 'generated', 'dataSources.ts'), typeof sources === 'string' ? sources : `export default ${JSON.stringify(sources, null, 2)};\n`);
  return {};
}

/**
 * What `ms app init` does to the folder: writes ms.config.json, and adds the CLI to the package files.
 * @param {string} appDir
 * @param {Record<string, unknown>} config
 */
function init(appDir, config) {
  writeFileSync(join(appDir, 'ms.config.json'), JSON.stringify(config));
  writeFileSync(join(appDir, 'package.json'), '{ "name": "analytics-hub-app", "devDependencies": { "@microsoft/managed-apps-cli": "^0.29.0" } }');
  writeFileSync(join(appDir, 'package-lock.json'), '{}');
  return {};
}

/** @param {import('node:test').TestContext} t */
function appDirWithPackages(t) {
  const appDir = tempDir(t);
  writeFileSync(join(appDir, 'package.json'), PACKAGE_JSON);
  writeFileSync(join(appDir, 'package-lock.json'), PACKAGE_LOCK);
  return appDir;
}

/**
 * An app folder after init and add data-source, with its models.
 * @param {string} appDir
 */
function appFiles(appDir) {
  writeFileSync(join(appDir, 'ms.config.json'), JSON.stringify({ appId: 'app-1', environmentId: 'env-1', appDisplayName: 'Analytics Hub' }));
  writeSources(appDir, {});
  mkdirSync(join(appDir, '.ms'), { recursive: true });
  writeFileSync(join(appDir, '.ms', 'cache.json'), '{}');
  writeFileSync(join(appDir, CONFIG_FILE), '{"semanticModels":{}}');
  writeFileSync(join(appDir, 'package.json'), '{}');
}

// --- Links ---------------------------------------------------------------------------------------------

test('parseModelLink: reads the workspace and model from each link people copy', () => {
  const links = [
    `https://app.powerbi.com/groups/${WS}/datasets/${VL}/details?experience=power-bi`,
    `https://app.powerbi.com/groups/${WS}/settings/datasets/${VL}`,
    `https://app.fabric.microsoft.com/groups/${WS}/semanticmodels/${VL}?ctid=${TENANT}&experience=fabric-developer`,
    `https://app.powerbigov.us/groups/${WS}/datasets/${VL}/details`,
    `https://api.powerbi.com/v1.0/myorg/groups/${WS}/datasets/${VL}`,
    `https://app.powerbi.com/groups/${WS}/modeling/${VL}/modelView`,
    `https://app.powerbi.com/groups/${WS}/datasets/${VL}#details`,
    `app.powerbi.com/groups/${WS}/datasets/${VL}`,
    `  <https://app.powerbi.com/groups/${WS}/datasets/${VL}>  `,
    `"https://app.powerbi.com/groups/${WS}/datasets/${VL}"`,
    `'https://app.powerbi.com/groups/${WS}/datasets/${VL}'\n`,
    `HTTPS://APP.POWERBI.COM/GROUPS/${WS.toUpperCase()}/DATASETS/${VL.toUpperCase()}/DETAILS`,
  ];
  for (const link of links) assert.deepEqual(parseModelLink(link), { ok: true, workspaceId: WS, itemId: VL }, link);
});

test('parseModelLink: says what is wrong with anything else', () => {
  /** @type {[string | undefined, RegExp][]} */
  const cases = [
    ['', /^Paste the model's link\.$/],
    ['   ', /^Paste the model's link\.$/],
    [undefined, /^Paste the model's link\.$/],
    ['not a link at all', /^That isn't a link\./],
    [`http://app.powerbi.com/groups/${WS}/datasets/${VL}`, /^That isn't a link\./],
    [`ftp://app.powerbi.com/groups/${WS}/datasets/${VL}`, /^That isn't a link\./],
    [`https://app.powerbi.com/groups/me/datasets/${VL}`, /My workspace, which other people can't read from/],
    [`https://app.powerbi.com/groups/${WS}/reports/${VL}/ReportSection`, /^That's a report link\./],
    [`https://app.powerbi.com/groups/${WS}/rdlreports/${VL}`, /^That's a report link\./],
    [`https://app.powerbi.com/groups/${WS}/dashboards/${VL}`, /^That's a report link\./],
    [`https://app.powerbi.com/groups/${WS}/datasets/sales`, /^That isn't a semantic model link\./],
    [`https://app.fabric.microsoft.com/groups/${WS}/lakehouses/${VL}`, /^That isn't a semantic model link\./],
    [`https://app.powerbi.com/groups/${WS}`, /^That isn't a semantic model link\./],
    ['https://app.powerbi.com/groups', /^That isn't a semantic model link\./],
    ['https://app.powerbi.com/home', /^That isn't a semantic model link\./],
    [`https://app.powerbi.com/groups/sales/datasets/${VL}`, /^That isn't a semantic model link\./],
  ];
  for (const [text, error] of cases) {
    const result = /** @type {any} */ (parseModelLink(text));
    assert.equal(result.ok, false, String(text));
    assert.match(result.error, error, String(text));
  }
});

test('isGuid: takes GUIDs in either case, and nothing else', () => {
  assert.equal(isGuid(VL), true);
  assert.equal(isGuid(VL.toUpperCase()), true);
  for (const value of ['', 'x', ` ${VL}`, `${VL}x`, `{${VL}}`, undefined, null, 42]) assert.equal(isGuid(value), false, String(value));
});

// --- Models --------------------------------------------------------------------------------------------

test('managed models: the names match the installer, the app and the EXE', () => {
  assert.equal(INSTALL_RECORD_FILE, DEFAULT_CONFIG_FILE);
  assert.equal(VIEWER_GROUP, VIEWER_GROUP_NAME);
  assert.deepEqual(MODELS.map((m) => m.alias), [APP_ALIAS, CONSUMPTION_ALIAS, EVALUATOR_ALIAS]);
  assert.deepEqual(MODELS.filter((m) => m.required).map((m) => m.alias), [APP_ALIAS], 'only the Analytics Hub Model is required');
  const runtime = readFileSync(join(REPO, 'app', 'src', 'lib', 'runtime-config.ts'), 'utf8');
  assert.ok(runtime.includes(`MANAGED_CONFIG_PATH = "${CONFIG_FILE}"`), 'the managed build reads the file setup writes');
  const launcher = readFileSync(join(REPO, 'installer', 'packaging', 'launcher', 'Launcher.cs'), 'utf8');
  assert.ok(launcher.includes(`WorkFolder = "${INSTALL_FOLDER}"`), 'the EXE keeps its record where setup looks');
  const example = /** @type {any} */ (readModelConfig(join(REPO, 'app', 'managed-app.config.example.json')));
  assert.equal(example.state, 'unfilled', 'the example has placeholders, not IDs');
  assert.deepEqual(Object.keys(example.body.semanticModels), MODELS.map((m) => m.alias));
});

/**
 * A Fabric install record, from the installer's own empty config.
 * @param {Record<string, boolean>} parts
 */
function fabricRecord({ model, bound, consumption, consumptionModel, evaluator, evaluatorModel }) {
  const record = /** @type {any} */ (emptyConfig());
  record.fabric.workspaceId = WS;
  if (model) Object.assign(record.semanticModel, { enabled: true, id: VL, bound });
  record.modules.consumption = consumption;
  if (consumptionModel) Object.assign(record.consumption.model, { id: CC, bound: true });
  record.modules.agentEvaluator = evaluator;
  if (evaluatorModel) Object.assign(record.agentEvaluator.model, { id: AE, bound: true });
  return record;
}

test('modelsFromRecord: takes the models a Fabric install deployed, by the installer\'s own rules', () => {
  /** @type {Record<string, string>} */
  const ids = { [APP_ALIAS]: VL, [CONSUMPTION_ALIAS]: CC, [EVALUATOR_ALIAS]: AE };
  const flags = ['model', 'bound', 'consumption', 'consumptionModel', 'evaluator', 'evaluatorModel'];
  for (let bits = 0; bits < 2 ** flags.length; bits++) {
    const parts = Object.fromEntries(flags.map((flag, i) => [flag, Boolean(bits & (1 << i))]));
    const record = fabricRecord(parts);
    const models = /** @type {any} */ (modelsFromRecord(record));
    const expected = modelDeployed(record) ? appModels(record) : [];
    assert.deepEqual(Object.keys(models), expected, JSON.stringify(parts));
    for (const alias of expected) assert.deepEqual(models[alias], { workspaceId: WS, itemId: ids[alias] });
  }
  const all = fabricRecord({ model: true, bound: true, consumption: true, consumptionModel: true, evaluator: true, evaluatorModel: true });
  all.fabric.workspaceId = 'sales';
  assert.deepEqual(modelsFromRecord(all), {}, 'GUIDs only');
  delete all.fabric.workspaceId;
  assert.deepEqual(modelsFromRecord(all), {});
});

test('modelsFromRecord: takes the models an Azure install published, as the Azure web app does', () => {
  for (const powerBi of [
    {},
    { workspaceId: WS, datasetId: VL },
    { workspaceId: WS, datasetId: VL, consumptionDatasetId: CC },
    { workspaceId: WS, consumptionDatasetId: CC },
  ]) {
    const record = { target: 'azure', azure: { powerBi } };
    assert.deepEqual(modelsFromRecord(record), azureSemanticModels(/** @type {any} */ (record.azure)), JSON.stringify(powerBi));
  }
  const azure = { ...emptyConfig(), target: 'azure', semanticModel: { name: 'x', enabled: true, id: VL, bound: true }, azure: { powerBi: {} } };
  assert.deepEqual(modelsFromRecord(azure), {}, 'an Azure record\'s Fabric fields are ignored');
  assert.deepEqual(modelsFromRecord({ target: 'azure', azure: { powerBi: { workspaceId: 'sales', datasetId: VL } } }), {}, 'GUIDs only');
  assert.deepEqual(modelsFromRecord({ target: 'azure' }), {});
  assert.deepEqual(modelsFromRecord(null), {});
  assert.deepEqual(modelsFromRecord('x'), {});
});

test('groupFromRecord and modelsWithoutBuild: the viewer group, and the models it has no Build on', () => {
  assert.deepEqual(groupFromRecord({ access: { groupId: GROUP, groupName: 'Hub readers' } }), { id: GROUP, name: 'Hub readers' });
  assert.deepEqual(groupFromRecord({ access: { groupId: GROUP } }), { id: GROUP, name: VIEWER_GROUP });
  assert.equal(groupFromRecord({ access: { groupId: 'readers' } }), undefined);
  assert.equal(groupFromRecord({}), undefined);
  assert.equal(groupFromRecord(undefined), undefined);

  const models = { vl: { workspaceId: WS, itemId: VL }, cc: { workspaceId: WS, itemId: CC } };
  assert.deepEqual(modelsWithoutBuild({ access: { grantedModels: [VL.toUpperCase()] } }, models), ['Consumption Central model']);
  assert.deepEqual(modelsWithoutBuild({ access: { grantedModels: [VL, CC] } }, models), []);
  assert.deepEqual(modelsWithoutBuild({ access: {} }, models), [], 'it can\'t tell, so it doesn\'t warn');
  assert.deepEqual(modelsWithoutBuild(undefined, models), []);
});

test('validModels: keeps models with real IDs, when the Analytics Hub Model has them', () => {
  const vl = { workspaceId: WS, itemId: VL };
  const ae = { workspaceId: WS, itemId: AE };
  const placeholder = { workspaceId: '<workspace ID>', itemId: '<model ID>' };
  assert.deepEqual(validModels({ vl, cc: placeholder, ae }), { vl, ae });
  assert.deepEqual(validModels({ vl: { ...vl, extra: true } }), { vl }, 'only the IDs');
  for (const given of [undefined, null, 'x', [], {}, { vl: placeholder, cc: { workspaceId: WS, itemId: CC } }, { vl: { workspaceId: WS } }]) {
    assert.equal(validModels(given), undefined, JSON.stringify(given));
  }
});

test('readModelConfig: tells a missing, invalid, unfilled and ready file apart', (t) => {
  const dir = tempDir(t);
  const file = join(dir, CONFIG_FILE);
  assert.deepEqual(readModelConfig(file), { state: 'missing' });

  writeFileSync(file, '{ "semanticModels": ');
  assert.equal(readModelConfig(file).state, 'invalid');
  for (const text of ['[]', 'null', '"x"']) {
    writeFileSync(file, text);
    assert.deepEqual(readModelConfig(file), { state: 'invalid', error: 'It must be a JSON object.' }, text);
  }
  assert.equal(readModelConfig(dir).state, 'invalid', 'a folder');

  const example = readFileSync(join(REPO, 'app', 'managed-app.config.example.json'), 'utf8');
  writeFileSync(file, example);
  const unfilled = /** @type {any} */ (readModelConfig(file));
  assert.equal(unfilled.state, 'unfilled');
  assert.deepEqual(unfilled.body, JSON.parse(example));

  const vl = { workspaceId: WS, itemId: VL };
  writeFileSync(file, `\uFEFF${JSON.stringify({ semanticModels: { vl, cc: { workspaceId: '<x>', itemId: '<y>' } } })}`);
  const ready = /** @type {any} */ (readModelConfig(file));
  assert.equal(ready.state, 'ready', 'with a byte order mark, as Notepad saves it');
  assert.deepEqual(ready.models, { vl });
});

test('writeModelConfig: replaces the models and keeps the other blocks', (t) => {
  const file = join(tempDir(t), CONFIG_FILE);
  const vl = { workspaceId: WS, itemId: VL };
  writeModelConfig(file, { vl });
  assert.equal(readFileSync(file, 'utf8'), `${JSON.stringify({ semanticModels: { vl } }, null, 2)}\n`);
  writeModelConfig(file, { vl }, { semanticModels: { vl: { workspaceId: '<x>', itemId: '<y>' } }, diagnostics: { launchCredits: 0.1 } });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { semanticModels: { vl }, diagnostics: { launchCredits: 0.1 } });
});

test('findInstallRecord: looks where Windows says Documents is, then the usual places, and takes the newest record', () => {
  const env = { USERPROFILE: 'C:\\Users\\pat', OneDriveCommercial: 'C:\\Users\\pat\\OneDrive - Contoso', OneDrive: 'C:\\Users\\pat\\OneDrive' };
  const at = (/** @type {string} */ dir) => join(dir, INSTALL_FOLDER, INSTALL_RECORD_FILE);
  const repoRecord = join('C:\\code\\hub', 'installer', INSTALL_RECORD_FILE);
  /** @type {Map<string, { at: number, text: string }>} */
  const files = new Map([
    [at('D:\\Docs'), { at: 100, text: JSON.stringify({ target: 'fabric' }) }],
    [at(join(env.USERPROFILE, 'Documents')), { at: 150, text: `\uFEFF${JSON.stringify({ target: 'azure' })}` }],
    [repoRecord, { at: 200, text: '[]' }],
    [at(join(env.OneDrive, 'Documents')), { at: 300, text: '{ "target": ' }],
  ]);
  /** @type {string[]} */
  const keys = [];
  /** @type {string[]} */
  const looked = [];
  const found = findInstallRecord({
    platform: 'win32',
    env,
    home: 'C:\\Users\\home',
    repoRoot: 'C:\\code\\hub',
    readRegistry: (key) => {
      keys.push(key);
      return key.endsWith('\\User Shell Folders') ? '%USERPROFILE%\\Docs' : 'D:\\Docs';
    },
    modified: (file) => {
      looked.push(file);
      return files.get(file)?.at;
    },
    read: (file) => /** @type {{ text: string }} */ (files.get(file)).text,
  });
  assert.deepEqual(keys.map((key) => key.split('\\').pop()), ['User Shell Folders', 'Shell Folders']);
  assert.deepEqual(looked, [
    at('C:\\Users\\pat\\Docs'),
    at('D:\\Docs'),
    at(join(env.OneDriveCommercial, 'Documents')),
    at(join(env.OneDrive, 'Documents')),
    at(join(env.USERPROFILE, 'Documents')),
    repoRecord,
  ]);
  assert.deepEqual(found, { path: at(join(env.USERPROFILE, 'Documents')), record: { target: 'azure' } }, 'the newest that is a record');

  /** @type {string[]} */
  const once = [];
  const none = findInstallRecord({
    platform: 'win32', env: {}, home: 'C:\\Users\\pat', readRegistry: () => 'D:\\Docs', modified: (file) => { once.push(file); return undefined; },
  });
  assert.equal(none, undefined);
  assert.deepEqual(once, [at('D:\\Docs'), at(join('C:\\Users\\pat', 'Documents'))], 'each place once');

  /** @type {string[]} */
  const posix = [];
  findInstallRecord({
    platform: 'linux',
    env: {},
    home: '/home/pat',
    repoRoot: '/src/hub',
    readRegistry: () => assert.fail('no registry off Windows'),
    modified: (file) => { posix.push(file); return undefined; },
  });
  assert.deepEqual(posix, [at(join('/home/pat', 'Documents')), join('/src/hub', 'installer', INSTALL_RECORD_FILE)]);
});

test('expandEnv: expands %NAME% in any case, and leaves unknown or empty ones', () => {
  const env = { USERPROFILE: 'C:\\Users\\pat', HOMEDRIVE: 'C:', EMPTY: '' };
  assert.equal(expandEnv('%userprofile%\\Documents', env), 'C:\\Users\\pat\\Documents');
  assert.equal(expandEnv('%HOMEDRIVE%\\x\\%UserProfile%', env), 'C:\\x\\C:\\Users\\pat');
  assert.equal(expandEnv('%NOPE%\\Documents', env), '%NOPE%\\Documents');
  assert.equal(expandEnv('%EMPTY%\\Documents', env), '%EMPTY%\\Documents');
  assert.equal(stripBom('\uFEFF{}'), '{}');
  assert.equal(stripBom('{}'), '{}');
});

// --- The CLI -------------------------------------------------------------------------------------------

test('createCli: runs the pinned CLI with Node, off screen with JSON, and reads what it printed', async () => {
  const stdout = 'Working...\n{"success":true,"appId":"app-1"}\n';
  const fake = fakeSpawn({ stdout, stderr: 'progress\n' });
  const cli = createCli({ cliDir: join('x', 'cli'), env: { MS_CLI_CONFIG_DIR: 'y' }, spawn: fake.spawn, node: 'node-bin' });
  assert.equal(cli.bin, join('x', 'cli', 'node_modules', '@microsoft', 'managed-apps-cli', 'dist', 'Bin.js'));
  const result = await cli.run(['app', 'deploy'], { cwd: 'app-dir' });
  assert.deepEqual(result, { ok: true, exitCode: 0, data: { success: true, appId: 'app-1' }, stdout, stderr: 'progress\n' });
  const [call] = fake.calls;
  assert.equal(call.command, 'node-bin');
  assert.deepEqual(call.args, [cli.bin, 'app', 'deploy', '--non-interactive', '--json', '--no-color']);
  assert.equal(call.options.cwd, 'app-dir');
  assert.deepEqual(call.options.stdio, ['ignore', 'pipe', 'pipe']);
  assert.equal(call.options.windowsHide, true);
  assert.equal(call.options.env.MS_CLI_CONFIG_DIR, 'y');
  assert.equal(call.options.env.PATH ?? call.options.env.Path, process.env.PATH ?? process.env.Path, 'keeps this process\'s environment');
});

test('createCli: a failure gives the CLI\'s message, its details and its exit code', async () => {
  const json = JSON.stringify({ success: false, errorMessage: '  Build command exited with code 1.  ', errorData: { stderrTail: 'tsc failed' } });
  let result = await createCli({ spawn: fakeSpawn({ stdout: json, code: 1 }).spawn }).run(['app', 'deploy']);
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 1);
  assert.equal(result.error, 'Build command exited with code 1.');
  assert.deepEqual(result.errorData, { stderrTail: 'tsc failed' });

  result = await createCli({ spawn: fakeSpawn({ stdout: '{"success":false}', stderr: 'Denied.', code: 0 }).spawn }).run(['app', 'share', 'x']);
  assert.equal(result.ok, false, 'exit 0 that says success: false failed');
  assert.equal(result.error, 'Denied.');

  const stderr = ['one', '', '  two  ', 'three', 'four', 'five', 'six', ''].join('\n');
  result = await createCli({ spawn: fakeSpawn({ stderr, code: 2 }).spawn }).run(['app', 'init']);
  assert.equal(result.error, 'two\nthree\nfour\nfive\nsix', 'the last five lines');
  result = await createCli({ spawn: fakeSpawn({ code: 2 }).spawn }).run(['app', 'init']);
  assert.equal(result.error, 'The CLI stopped with exit code 2.');
  result = await createCli({ spawn: fakeSpawn({ code: null }).spawn }).run(['app', 'init']);
  assert.equal(result.error, 'The CLI stopped.');

  result = await createCli({ spawn: fakeSpawn({ stderr: '{"success":true,"url":"https://play.example/app-1"}' }).spawn }).run(['app', 'play']);
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, { success: true, url: 'https://play.example/app-1' }, 'JSON on stderr when stdout has none');
});

test('createCli: on screen it hands over the terminal, without the JSON flags', async () => {
  const fake = fakeSpawn({ code: 0 });
  const cli = createCli({ spawn: fake.spawn });
  const result = await cli.run(['auth', 'login', '--account', 'pat@contoso.com'], { onScreen: true });
  assert.deepEqual(result, { ok: true, exitCode: 0, data: undefined, stdout: '', stderr: '' });
  const [call] = fake.calls;
  assert.equal(call.command, process.execPath, 'the Node.js running this');
  assert.deepEqual(call.args, [cli.bin, 'auth', 'login', '--account', 'pat@contoso.com']);
  assert.equal(call.options.stdio, 'inherit');
  assert.equal(call.options.windowsHide, false);
});

test('createCli: stops a command that runs too long, and says when the CLI can\'t start', async () => {
  let result = await createCli({ spawn: fakeSpawn({ hang: true }).spawn, timeoutMs: 20 }).run(['app', 'deploy']);
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.match(String(result.error), /^It didn't finish within \d+ minutes, so it was stopped\.$/);
  result = await createCli({ spawn: fakeSpawn({ hang: true }).spawn }).run(['app', 'deploy'], { timeoutMs: 20 });
  assert.equal(result.timedOut, true, 'each command can set its own limit');

  result = await createCli({ spawn: fakeSpawn({ throws: new Error('EACCES') }).spawn }).run(['auth', 'status']);
  assert.deepEqual(result, { ok: false, exitCode: null, data: undefined, error: 'Couldn\'t start the managed apps CLI: EACCES', stdout: '', stderr: '' });
  result = await createCli({ spawn: fakeSpawn({ error: new Error('ENOENT') }).spawn }).run(['auth', 'status']);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'Couldn\'t start the managed apps CLI: ENOENT');

  assert.equal(COMMAND_TIMEOUT_MS, 5 * 60_000);
  assert.equal(DEPLOY_TIMEOUT_MS, 30 * 60_000);
});

test('pinnedVersion: a new CLI version is a deliberate change, tested live first', (t) => {
  assert.equal(CLI_PACKAGE_DIR, join(REPO, 'installer', 'managed-cli'));
  assert.equal(pinnedVersion(), '0.29.0');
  assert.equal(cliBin(), join(CLI_PACKAGE_DIR, 'node_modules', '@microsoft', 'managed-apps-cli', 'dist', 'Bin.js'));
  const dir = tempDir(t);
  assert.equal(installedVersion(dir), undefined);
  mkdirSync(join(dir, 'node_modules', '@microsoft', 'managed-apps-cli'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', '@microsoft', 'managed-apps-cli', 'package.json'), '{"version":"0.29.0"}');
  assert.equal(installedVersion(dir), '0.29.0');
});

test('parseJson: finds the JSON object the CLI printed, after other output', () => {
  assert.equal(parseJson(''), undefined);
  assert.equal(parseJson(undefined), undefined);
  assert.equal(parseJson('[1, 2]'), undefined, 'objects only');
  assert.equal(parseJson('{ not json'), undefined);
  assert.equal(parseJson('Done.'), undefined);
  assert.deepEqual(parseJson('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJson('Building...\n{\n  "a": {\n    "b": 1\n  }\n}\n'), { a: { b: 1 } });
  assert.deepEqual(parseJson('{"a":1}\n{"b":2}'), { b: 2 }, 'the last one');
  assert.deepEqual(parseJson('note\r\n{\r\n  "a": 1\r\n}\r\n'), { a: 1 }, 'Windows line ends');
  assert.deepEqual(parseJson('{"a":1}\nDone.'), { a: 1 });
  assert.deepEqual(parseJson('{\n  "a": 1\n}\nDone.'), { a: 1 });
});

// --- Errors --------------------------------------------------------------------------------------------

test('explain: says who fixes each failure the CLI reports, and how', () => {
  /** @type {[string, import('../src/managed-app/errors.js').Failure, string, RegExp][]} */
  const cases = [
    ['login', { exitCode: 3, error: 'AADSTS53003: Access has been blocked by Conditional Access policies.' }, 'Entra admin', new RegExp(CLI_APP_ID)],
    ['deploy', { timedOut: true, error: 'It didn\'t finish within 30 minutes, so it was stopped.' }, 'you', /took too long/],
    ['init', { exitCode: 3, error: 'Unauthorized.' }, 'you', /sign-in didn't work or has expired/],
    ['init', { exitCode: 1, error: 'Your sign-in session has expired.' }, 'you', /sign-in didn't work or has expired/],
    ['init', { error: 'You don\'t have permission to create an app in this environment.' }, 'Power Platform admin', /Allow app creation with the Copilot Managed Runtime CLI/],
    ['init', { error: 'ms.config.json already exists in this folder.' }, 'you', /already has an app/],
    ['init', { error: 'An app named "Analytics Hub" already exists.' }, 'you', /--display-name/],
    ['init', { error: 'Environment 1234 was not found.' }, 'you', /environment wasn't found/],
    ['deploy', { error: 'External artifacts are not allowed in this environment.' }, 'Power Platform admin', /External artifacts in managed apps/],
    ['add', { error: 'The connector is blocked by your organization\'s connector policy.' }, 'Power Platform admin', /connector policy/],
    ['add', { error: 'It is blocked by your organisation\'s connector policy.' }, 'Power Platform admin', /connector policy/],
    ['share', { error: 'The sharing limit for this app has been reached.' }, 'you', /group's object ID/],
    ['share', { error: 'Sharing is blocked by an environment or tenant policy.' }, 'Power Platform admin', /A policy blocks sharing/],
    ['share', { error: 'The sharing request was rejected.' }, 'you', /in your organisation/],
    ['share', { error: 'Graph 403: Insufficient privileges.' }, 'you', /object IDs/],
    ['deploy', { exitCode: 5, error: 'Request failed.' }, 'you', /couldn't reach Microsoft/],
    ['deploy', { error: 'getaddrinfo ENOTFOUND api.example' }, 'you', /couldn't reach Microsoft/],
    ['deploy', { error: 'The service is temporarily unavailable.' }, 'you', /busy/],
    ['deploy', { error: 'Request failed with status 429.' }, 'you', /busy/],
    ['deploy', { error: 'The app package exceeds the 50 MB limit.' }, 'you', /too big/],
    ['deploy', { error: 'Build command exited with code 1.' }, 'you', /The build failed/],
    ['init', { error: 'Build command exited with code 1.' }, 'you', /^Run it again\./],
    ['init', { error: 'Something new.' }, 'you', /^Run it again\./],
  ];
  for (const [step, failed, who, what] of cases) {
    const problem = explain(step, failed);
    assert.equal(problem.who, who, `${step}: ${failed.error}`);
    assert.match(problem.what, what, `${step}: ${failed.error}`);
  }
  assert.equal(explain('add', { error: 'blocked by your organization\'s connector policy' }).link, LINKS.connectorPolicy);
  assert.equal(explain('init', { error: 'Ask an admin to grant you the required permission.' }).link, LINKS.cliSetting);
  assert.equal(explain('share', { error: 'The sharing request was rejected.' }).link, LINKS.share);
  assert.equal(explain('init', { error: 'Something new.' }).link, LINKS.issues);
});

test('explain: keeps the CLI\'s message and the useful details, and leaves out empty ones', () => {
  const problem = explain('deploy', {
    error: '  Build command exited with code 2.  ',
    errorData: { serverMessage: ' Bad request ', stderrTail: 'error TS2304\nline 2', stdoutTail: 42, other: 'x' },
  });
  assert.equal(problem.message, 'Build command exited with code 2.');
  assert.equal(problem.details, 'Bad request\nerror TS2304\nline 2');
  const bare = explain('deploy', { error: '   ', errorData: 'text' });
  assert.equal('message' in bare, false);
  assert.equal('details' in bare, false);
});

test('errors: every link is https, the admin steps link to Learn, and the CLI\'s app ID is a GUID', () => {
  for (const link of Object.values(LINKS)) assert.match(link, /^https:\/\//);
  for (const step of Object.values(ADMIN_STEPS)) {
    assert.ok(Object.values(LINKS).includes(step.link), step.link);
    assert.match(step.link, /^https:\/\/learn\.microsoft\.com\//);
  }
  assert.equal(isGuid(CLI_APP_ID), true);
});

// --- State ---------------------------------------------------------------------------------------------

test('stateDir: a per-user folder on each platform', () => {
  const home = join('h', 'pat');
  assert.equal(STATE_FOLDER, 'AnalyticsHub-ManagedApp');
  assert.equal(stateDir({ platform: 'win32', env: { LOCALAPPDATA: join('L', 'Local') }, home }), join('L', 'Local', STATE_FOLDER));
  assert.equal(stateDir({ platform: 'win32', env: {}, home }), join(home, 'AppData', 'Local', STATE_FOLDER));
  assert.equal(stateDir({ platform: 'darwin', env: {}, home }), join(home, 'Library', 'Application Support', STATE_FOLDER));
  assert.equal(stateDir({ platform: 'linux', env: { XDG_DATA_HOME: join('x', 'data') }, home }), join('x', 'data', STATE_FOLDER));
  assert.equal(stateDir({ platform: 'linux', env: {}, home }), join(home, '.local', 'share', STATE_FOLDER));
});

test('stateDir: outside the folders the launchers clear, so a new installer version doesn\'t forget the app', () => {
  const launchers = join(REPO, 'installer', 'packaging', 'launcher');
  const ps1 = readFileSync(join(launchers, 'install.ps1'), 'utf8');
  const exe = readFileSync(join(launchers, 'Launcher.cs'), 'utf8');
  // Both delete every folder in their home but their own version.
  assert.match(ps1, /\$AhHome = Join-Path \$env:LOCALAPPDATA 'AnalyticsHub'/);
  assert.match(ps1, /\$AhHome = Join-Path \$HOME '\.analytics-hub'/);
  assert.match(ps1, /Get-ChildItem -LiteralPath \$AhHome -Directory/);
  assert.match(exe, /HomeFolder = "AnalyticsHub"/);
  assert.match(exe, /RemoveOtherVersions\(home, id\)/);
  const local = join('L', 'Local');
  const windows = stateDir({ platform: 'win32', env: { LOCALAPPDATA: local }, home: 'h' });
  assert.equal(relative(join(local, 'AnalyticsHub'), windows).startsWith('..'), true, windows);
  const linux = stateDir({ platform: 'linux', env: {}, home: 'h' });
  assert.equal(relative(join('h', '.analytics-hub'), linux).startsWith('..'), true, linux);
});

test('saveState and readSaved: keep the app\'s files, and what is known about it', (t) => {
  const appDir = tempDir(t);
  const dir = join(tempDir(t), 'state');
  appFiles(appDir);
  saveState(appDir, dir, { appId: 'app-1', environmentId: 'env-1', displayName: 'Analytics Hub', playUrl: undefined }, new Date(NOW));
  assert.deepEqual(readSaved(dir), { appId: 'app-1', environmentId: 'env-1', displayName: 'Analytics Hub', savedAt: NOW });
  for (const name of APP_FILES) assert.ok(existsSync(join(dir, 'files', name)), name);
  assert.equal(readFileSync(join(dir, 'files', '.ms', 'cache.json'), 'utf8'), '{}');
  assert.equal(existsSync(join(dir, 'files', 'package.json')), false, 'only the app\'s own files');

  const later = '2026-06-02T09:00:00.000Z';
  saveState(appDir, dir, { appId: 'app-1', environmentId: 'env-1', deployedAt: later }, new Date(later));
  assert.deepEqual(readSaved(dir), { appId: 'app-1', environmentId: 'env-1', displayName: 'Analytics Hub', deployedAt: later, savedAt: later }, 'the same app keeps what was known');

  rmSync(join(appDir, 'generated'), { recursive: true });
  saveState(appDir, dir, { appId: 'app-2', environmentId: 'env-1' }, new Date(later));
  assert.deepEqual(readSaved(dir), { appId: 'app-2', environmentId: 'env-1', savedAt: later }, 'another app starts afresh');
  assert.equal(existsSync(join(dir, 'files', 'generated')), false, 'a file the app no longer has is dropped');
});

test('readSaved: ignores a state file it can\'t trust', (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'state.json');
  assert.equal(readSaved(dir), undefined);
  for (const text of [
    '{', '[]', 'null',
    '{"version":2,"appId":"a","environmentId":"e"}',
    '{"version":1,"appId":"","environmentId":"e"}',
    '{"version":1,"appId":"a"}',
    '{"version":1,"appId":5,"environmentId":"e"}',
  ]) {
    writeFileSync(file, text);
    assert.equal(readSaved(dir), undefined, text);
  }
  writeFileSync(file, '\uFEFF{"version":1,"appId":"a","environmentId":"e"}');
  assert.deepEqual(readSaved(dir), { appId: 'a', environmentId: 'e' });
});

test('restoreState: copies the saved files back, and keeps any already there', (t) => {
  const from = tempDir(t);
  const dir = join(tempDir(t), 'state');
  appFiles(from);
  saveState(from, dir, { appId: 'app-1', environmentId: 'env-1' }, new Date(NOW));
  const appDir = tempDir(t);
  writeFileSync(join(appDir, CONFIG_FILE), '{"mine":true}');
  assert.deepEqual(restoreState(appDir, dir), ['ms.config.json', 'generated', '.ms']);
  assert.equal(readFileSync(join(appDir, CONFIG_FILE), 'utf8'), '{"mine":true}', 'your models stay');
  assert.equal(readFileSync(join(appDir, '.ms', 'cache.json'), 'utf8'), '{}');
  assert.equal(steps.readAppConfig(appDir)?.appId, 'app-1');
  assert.deepEqual(restoreState(appDir, dir), [], 'nothing twice');
  assert.deepEqual(restoreState(appDir, join(dir, 'nowhere')), []);
});

test('clearAppFiles and clearState: forget the app, and keep the models', (t) => {
  const appDir = tempDir(t);
  const dir = join(tempDir(t), 'state');
  appFiles(appDir);
  saveState(appDir, dir, { appId: 'app-1', environmentId: 'env-1' }, new Date(NOW));
  clearAppFiles(appDir);
  assert.deepEqual(readdirSync(appDir).sort(), [CONFIG_FILE, 'package.json'].sort());
  clearState(dir);
  assert.equal(existsSync(dir), false);
  clearState(dir);
});

// --- Steps ---------------------------------------------------------------------------------------------

test('authStatus: who is signed in, and a CLI that never was', async () => {
  const pat = 'pat@contoso.com';
  let fake = fakeRun({ 'auth status': { data: { signedIn: true, activeAccount: { username: pat }, accounts: [{ username: pat }, { username: 'sam@contoso.com' }, {}] } } });
  assert.deepEqual(await steps.authStatus(fake.run), { ok: true, signedIn: true, account: pat, accounts: [pat, 'sam@contoso.com'] });
  assert.deepEqual(fake.calls[0].args, ['auth', 'status']);
  fake = fakeRun({ 'auth status': failure('Not signed in.', 3) });
  assert.deepEqual(await steps.authStatus(fake.run), { ok: true, signedIn: false, accounts: [] });
  fake = fakeRun({ 'auth status': { data: { signedIn: true, accounts: [] } } });
  assert.deepEqual(await steps.authStatus(fake.run), { ok: true, signedIn: false, accounts: [] }, 'no active account');
  const offline = /** @type {any} */ (await steps.authStatus(fakeRun({ 'auth status': failure('getaddrinfo ENOTFOUND login.example', 5) }).run));
  assert.equal(offline.ok, false);
  assert.match(offline.problem.what, /couldn't reach Microsoft/);
});

test('switchAccount and login: switch to an account the CLI has, or sign in on screen', async () => {
  const fake = fakeRun({ 'auth switch': failure('No such account.') });
  assert.equal((await steps.switchAccount(fake.run, 'sam@contoso.com')).ok, false);
  assert.deepEqual(fake.calls[0].args, ['auth', 'switch', '--account', 'sam@contoso.com']);
  assert.deepEqual(await steps.switchAccount(fakeRun().run, 'sam@contoso.com'), { ok: true });

  const login = fakeRun();
  assert.deepEqual(await steps.login(login.run, { account: 'pat@contoso.com', deviceCode: true }), { ok: true });
  assert.deepEqual(await steps.login(login.run, {}), { ok: true });
  assert.deepEqual(login.calls, [
    { args: ['auth', 'login', '--account', 'pat@contoso.com', '--device-code'], options: { onScreen: true } },
    { args: ['auth', 'login'], options: { onScreen: true } },
  ]);
  const blocked = /** @type {any} */ (await steps.login(fakeRun({ 'auth login': failure('AADSTS53003: blocked.') }).run, {}));
  assert.equal(blocked.problem.who, 'Entra admin');
});

test('checkPolicy: stops only when every query action is blocked, before anything is made', async () => {
  const items = (/** @type {Record<string, string>} */ behaviors) => ({ data: { items: Object.entries(behaviors).map(([id, behavior]) => ({ id, behavior })) } });
  let fake = fakeRun({ 'connector list-actions': items({ ExecuteDatasetQueriesJson: 'Allow', ExecuteQueries: 'Block', GetDatasets: 'Block' }) });
  assert.deepEqual(await steps.checkPolicy(fake.run, { environmentId: 'env-1' }), { ok: true, allowed: ['ExecuteDatasetQueriesJson'] });
  assert.deepEqual(fake.calls[0].args, ['connector', 'list-actions', '--connector', 'shared_powerbi', '--environment-id', 'env-1']);

  fake = fakeRun({ 'connector list-actions': items({ ExecuteDatasetQueriesJson: 'Block', ExecuteQueries: 'block', GetDatasets: 'Allow' }) });
  const blocked = /** @type {any} */ (await steps.checkPolicy(fake.run));
  assert.deepEqual(fake.calls[0].args, ['connector', 'list-actions', '--connector', 'shared_powerbi']);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.problem.who, ADMIN_STEPS.queryAction.who);
  assert.equal(blocked.problem.what, ADMIN_STEPS.queryAction.what);
  assert.match(blocked.problem.message, /"Run a query" action is blocked/);
  assert.equal(blocked.result, undefined, 'an admin\'s step, not one to retry');

  const none = /** @type {any} */ (await steps.checkPolicy(fakeRun({ 'connector list-actions': items({ GetDatasets: 'Block' }) }).run));
  assert.equal(none.ok, true);
  assert.match(none.warning, /Couldn't find the Power BI connector's query actions/);

  const unreadable = /** @type {any} */ (await steps.checkPolicy(fakeRun({ 'connector list-actions': failure('Server error.') }).run));
  assert.equal(unreadable.ok, true, 'it carries on: the definitions are checked again once Power BI is added');
  assert.equal(unreadable.warning, 'Couldn\'t check the Power BI connector\'s policy, so it carries on. Server error.');

  const expired = /** @type {any} */ (await steps.checkPolicy(fakeRun({ 'connector list-actions': failure('Session expired.', 3) }).run));
  assert.equal(expired.ok, false);
  assert.equal(expired.result.exitCode, 3, 'kept, so it can sign in again and retry');
});

test('createApp: makes the app, reads its ID, and puts package.json back byte for byte', async (t) => {
  const appDir = appDirWithPackages(t);
  const fake = fakeRun({ 'app init': () => init(appDir, { appId: 'app-1', environmentId: 'env-1', appDisplayName: 'Hub' }) });
  assert.deepEqual(await steps.createApp(fake.run, { appDir, displayName: 'Hub', environmentId: 'env-1' }), { ok: true, appId: 'app-1', environmentId: 'env-1' });
  assert.deepEqual(fake.calls, [{
    args: ['app', 'init', '--repo', 'none', '--display-name', 'Hub', '--build-command', 'npm run build:managed', '--environment-id', 'env-1'],
    options: { cwd: appDir },
  }]);
  assert.equal(readFileSync(join(appDir, 'package.json'), 'utf8'), PACKAGE_JSON);
  assert.equal(readFileSync(join(appDir, 'package-lock.json'), 'utf8'), PACKAGE_LOCK);
});

test('createApp: takes the ID the CLI printed, can deploy a built folder, and says what failed', async (t) => {
  const appDir = appDirWithPackages(t);
  let fake = fakeRun({ 'app init': { data: { appId: 'app-2', environmentId: 'env-2' } } });
  assert.deepEqual(await steps.createApp(fake.run, { appDir, displayName: 'Hub', buildType: 'none', buildPath: 'dist' }), { ok: true, appId: 'app-2', environmentId: 'env-2' });
  assert.deepEqual(fake.calls[0].args, ['app', 'init', '--repo', 'none', '--display-name', 'Hub', '--build-type', 'none', '--build-path', 'dist']);

  fake = fakeRun({ 'app init': { data: { appId: 'app-3' } } });
  assert.deepEqual(await steps.createApp(fake.run, { appDir, displayName: 'Hub', environmentId: 'env-9' }), { ok: true, appId: 'app-3', environmentId: 'env-9' }, 'the environment it asked for');

  fake = fakeRun({ 'app init': () => ({ ...init(appDir, {}), ...failure('ms.config.json already exists.') }) });
  const exists = /** @type {any} */ (await steps.createApp(fake.run, { appDir, displayName: 'Hub' }));
  assert.match(exists.problem.what, /already has an app/);
  assert.equal(readFileSync(join(appDir, 'package.json'), 'utf8'), PACKAGE_JSON, 'put back after a failure too');

  rmSync(join(appDir, 'ms.config.json'));
  const lost = /** @type {any} */ (await steps.createApp(fakeRun().run, { appDir, displayName: 'Hub' }));
  assert.match(lost.problem.what, /Run it again with --new/);
  assert.ok(lost.result);

  const thrown = fakeRun({
    'app init': () => {
      init(appDir, {});
      throw new Error('crashed');
    },
  });
  await assert.rejects(steps.createApp(thrown.run, { appDir, displayName: 'Hub' }), /crashed/);
  assert.equal(readFileSync(join(appDir, 'package.json'), 'utf8'), PACKAGE_JSON, 'and when it throws');
});

test('addPowerBi: adds the connector as actions, checks its query action is there, and only checks next time', async (t) => {
  const appDir = tempDir(t);
  const fake = fakeRun({ 'app add data-source': () => writeSources(appDir, POWER_BI) });
  assert.deepEqual(await steps.addPowerBi(fake.run, { appDir }), { ok: true, added: true });
  assert.deepEqual(fake.calls, [{ args: ['app', 'add', 'data-source', '--connector', 'shared_powerbi', '--as', 'action'], options: { cwd: appDir } }]);

  const again = fakeRun();
  assert.deepEqual(await steps.addPowerBi(again.run, { appDir }), { ok: true, added: false });
  assert.equal(again.calls.length, 0);
});

test('addPowerBi: when the query action is missing, it fetches the definitions again, then adds Power BI again', async (t) => {
  const appDir = tempDir(t);
  writeSources(appDir, NO_QUERY);
  let fake = fakeRun({ 'app refresh data-source': () => writeSources(appDir, POWER_BI) });
  assert.deepEqual(await steps.addPowerBi(fake.run, { appDir }), { ok: true, added: false });
  assert.deepEqual(fake.commands(), ['app refresh data-source']);

  writeSources(appDir, NO_QUERY);
  fake = fakeRun({ 'app add data-source': () => writeSources(appDir, POWER_BI) });
  assert.deepEqual(await steps.addPowerBi(fake.run, { appDir }), { ok: true, added: true }, 'after an admin allowed it');
  assert.deepEqual(fake.commands(), [
    'app refresh data-source',
    'app remove data-source --name powerbi --force',
    'app add data-source --connector shared_powerbi --as action',
  ]);

  writeSources(appDir, NO_QUERY);
  const still = /** @type {any} */ (await steps.addPowerBi(fakeRun({ 'app add data-source': () => writeSources(appDir, NO_QUERY) }).run, { appDir }));
  assert.equal(still.problem.who, 'Power Platform admin', 'still blocked');
  assert.match(still.problem.message, /"Run a query" action is blocked/);

  assert.equal((await steps.addPowerBi(fakeRun({ 'app refresh data-source': failure('Server error.') }).run, { appDir })).ok, false);
  assert.equal((await steps.addPowerBi(fakeRun({ 'app remove data-source': failure('Server error.') }).run, { appDir })).ok, false);
});

test('addPowerBi: an app that references Power BI without its definitions', async (t) => {
  const appDir = tempDir(t);
  writeFileSync(join(appDir, 'ms.config.json'), JSON.stringify({
    appId: 'a', environmentId: 'e', connectionReferences: { pbi: { id: '/providers/Microsoft.PowerApps/apis/shared_powerbi' } },
  }));
  const unread = /** @type {any} */ (await steps.addPowerBi(fakeRun().run, { appDir }));
  assert.equal(unread.ok, true, 'it can\'t check, so it carries on');
  assert.equal(unread.added, false);
  assert.match(unread.warning, /Couldn't read the Power BI connector's definitions/);

  writeSources(appDir, {});
  const fake = fakeRun();
  const blocked = /** @type {any} */ (await steps.addPowerBi(fake.run, { appDir }));
  assert.equal(blocked.problem.who, 'Power Platform admin');
  assert.deepEqual(fake.commands(), ['app refresh data-source'], 'no name to remove it by');
});

test('addPowerBi: asks on screen when the CLI can\'t choose or make a connection itself', async (t) => {
  const appDir = tempDir(t);
  const fake = fakeRun({
    'app add data-source': (_args, options) => (options.onScreen ? writeSources(appDir, POWER_BI) : failure('Multiple connections exist for shared_powerbi.')),
  });
  assert.deepEqual(await steps.addPowerBi(fake.run, { appDir }), { ok: true, added: true });
  assert.deepEqual(fake.calls.map((c) => c.options), [{ cwd: appDir }, { cwd: appDir, onScreen: true }]);

  const stderr = fakeRun({ 'app add data-source': { ...failure('Failed.'), stderr: 'Automatic connection creation failed: consent is needed.' } });
  assert.equal((await steps.addPowerBi(stderr.run, { appDir: tempDir(t) })).ok, false);
  assert.equal(stderr.calls.length, 2, 'the stderr says so too');

  const other = fakeRun({ 'app add data-source': failure('Server error.') });
  assert.equal((await steps.addPowerBi(other.run, { appDir: tempDir(t) })).ok, false);
  assert.equal(other.calls.length, 1, 'other failures don\'t ask');
});

test('addPowerBi: says when Power BI wasn\'t added, or its definitions can\'t be read', async (t) => {
  const nothing = /** @type {any} */ (await steps.addPowerBi(fakeRun().run, { appDir: tempDir(t) }));
  assert.match(nothing.problem.what, /Power BI wasn't added/);

  const appDir = tempDir(t);
  const broken = await steps.addPowerBi(fakeRun({
    'app add data-source': () => {
      writeFileSync(join(appDir, 'ms.config.json'), JSON.stringify({ appId: 'a', environmentId: 'e', connectionReferences: { pbi: { id: 'shared_powerbi' } } }));
      return writeSources(appDir, 'export default {broken');
    },
  }).run, { appDir });
  assert.deepEqual(broken, {
    ok: true, added: true, warning: 'Couldn\'t read the Power BI connector\'s definitions to check its query action. If the app can\'t query, open Diagnostics in it.',
  });
});

test('powerBiSource and queryActions: read the generated definitions, and the app\'s references', (t) => {
  const appDir = tempDir(t);
  assert.equal(steps.powerBiSource(appDir), undefined);
  assert.equal(steps.queryActions(appDir), undefined);
  writeSources(appDir, { 'Power BI': { apis: { ExecuteDatasetQueriesJson: {}, ExecuteQueries: {}, GetGroups: {} } }, sql: { apis: { ExecuteQuery: {} } } });
  assert.equal(steps.powerBiSource(appDir), 'Power BI');
  assert.deepEqual(steps.queryActions(appDir), ['ExecuteDatasetQueriesJson', 'ExecuteQueries'], 'Power BI\'s only');
  writeSources(appDir, 'const sources = {};\n');
  assert.equal(steps.queryActions(appDir), undefined, 'not the shape it expects');
  writeSources(appDir, 'export default [];\n');
  assert.equal(steps.queryActions(appDir), undefined);
  /** @type {[string, string | undefined][]} */
  const references = [
    ['shared_powerbi', ''],
    ['/providers/Microsoft.PowerApps/apis/shared_powerbi', ''],
    ['powerbi', ''],
    ['shared_powerbiembedded', undefined],
    ['shared_sql', undefined],
  ];
  for (const [id, expected] of references) {
    writeFileSync(join(appDir, 'ms.config.json'), JSON.stringify({ appId: 'a', environmentId: 'e', connectionReferences: { one: { id } } }));
    assert.equal(steps.powerBiSource(appDir), expected, id);
  }
  assert.equal(steps.POWER_BI_CONNECTOR, 'shared_powerbi');
  assert.equal(steps.BUILD_COMMAND, 'npm run build:managed');
});

test('deployApp: builds and uploads with a long limit, and gives the link and any warnings', async () => {
  const fake = fakeRun({ 'app deploy': { data: { appPlayUri: 'https://play.example/app-1', warnings: ['Large bundle.', { message: 'Slow.' }, { code: 7 }, ''] } } });
  assert.deepEqual(await steps.deployApp(fake.run, { appDir: 'app' }), { ok: true, playUrl: 'https://play.example/app-1', warnings: ['Large bundle.', 'Slow.', '{"code":7}'] });
  assert.deepEqual(fake.calls, [{ args: ['app', 'deploy'], options: { cwd: 'app', timeoutMs: DEPLOY_TIMEOUT_MS } }]);
  assert.deepEqual(await steps.deployApp(fakeRun().run, { appDir: 'app' }), { ok: true, warnings: [] });
  const failed = /** @type {any} */ (await steps.deployApp(fakeRun({ 'app deploy': { ...failure('Build command exited with code 2.'), errorData: { stderrTail: 'error TS2304' } } }).run, { appDir: 'app' }));
  assert.match(failed.problem.what, /The build failed/);
  assert.equal(failed.problem.details, 'error TS2304');
});

test('shareApp: shares in one call, and says who it couldn\'t share with', async () => {
  const fake = fakeRun({ 'app share': { data: { partialFailure: true, warnings: [{ input: 'sam@contoso.com', reason: 'Not found in the directory.' }, 'Something else.'] } } });
  assert.deepEqual(await steps.shareApp(fake.run, { appDir: 'app', principals: ['pat@contoso.com', 'sam@contoso.com', GROUP] }), {
    ok: true, partial: true, rejected: ['sam@contoso.com'], warnings: ['sam@contoso.com: Not found in the directory.', 'Something else.'],
  });
  assert.deepEqual(fake.calls, [{ args: ['app', 'share', `pat@contoso.com,sam@contoso.com,${GROUP}`, '--access', 'play'], options: { cwd: 'app' } }]);
  assert.deepEqual(await steps.shareApp(fakeRun().run, { appDir: 'app', principals: [GROUP] }), { ok: true, partial: false, rejected: [], warnings: [] });
  const limit = /** @type {any} */ (await steps.shareApp(fakeRun({ 'app share': failure('The sharing limit for this app has been reached.') }).run, { appDir: 'app', principals: [GROUP] }));
  assert.match(limit.problem.what, /group's object ID/);
});

test('verifyShare: checks the object IDs took, and skips emails, which the CLI can\'t list', async () => {
  const none = fakeRun();
  assert.deepEqual(await steps.verifyShare(none.run, { appDir: 'app', ids: ['pat@contoso.com'] }), { ok: true, missing: [] });
  assert.equal(none.calls.length, 0);
  const fake = fakeRun({ 'app share list': { data: { results: [{ value: [{ principalObjectId: GROUP.toUpperCase() }, {}] }, { value: 'x' }, null] } } });
  assert.deepEqual(await steps.verifyShare(fake.run, { appDir: 'app', ids: [GROUP, USER, 'pat@contoso.com'] }), { ok: true, missing: [USER] });
  assert.deepEqual(fake.calls, [{ args: ['app', 'share', 'list', '--access', 'play'], options: { cwd: 'app' } }]);
  assert.equal((await steps.verifyShare(fakeRun({ 'app share list': failure('Server error.') }).run, { appDir: 'app', ids: [GROUP] })).ok, false);
});

test('playUrl and deleteApp: the link without a browser, and a delete that doesn\'t mind the app being gone', async () => {
  const play = fakeRun({ 'app play': { data: { url: 'https://play.example/app-1' } } });
  assert.deepEqual(await steps.playUrl(play.run, { appDir: 'app' }), { ok: true, url: 'https://play.example/app-1' });
  assert.deepEqual(play.calls, [{ args: ['app', 'play', '--no-browser'], options: { cwd: 'app' } }]);
  assert.equal((await steps.playUrl(fakeRun().run, { appDir: 'app' })).ok, false, 'no link');

  const del = fakeRun({ 'app delete': { data: { existed: true } } });
  assert.deepEqual(await steps.deleteApp(del.run, { appId: 'app-1', environmentId: 'env-1', cwd: 'app' }), { ok: true, existed: true });
  assert.deepEqual(del.calls, [{ args: ['app', 'delete', '--force', '--app', 'app-1', '--environment-id', 'env-1'], options: { cwd: 'app' } }]);
  assert.deepEqual(await steps.deleteApp(fakeRun({ 'app delete': failure('Not found.', 6) }).run, { appId: 'app-1' }), { ok: true, existed: false });
  assert.deepEqual(await steps.deleteApp(fakeRun({ 'app delete': { data: { existed: false } } }).run, { appId: 'app-1' }), { ok: true, existed: false });
  assert.deepEqual(await steps.deleteApp(fakeRun().run, { appId: 'app-1' }), { ok: true, existed: true });
  assert.equal((await steps.deleteApp(fakeRun({ 'app delete': failure('Forbidden.') }).run, { appId: 'app-1' })).ok, false);
  const bare = fakeRun();
  await steps.deleteApp(bare.run, { appId: 'app-1' });
  assert.deepEqual(bare.calls[0].args, ['app', 'delete', '--force', '--app', 'app-1']);
});

test('readAppConfig: the app\'s ID, environment and name, when the folder is an app', (t) => {
  const appDir = tempDir(t);
  assert.equal(steps.readAppConfig(appDir), undefined);
  const config = { appId: 'app-1', environmentId: 'env-1', appDisplayName: 'Hub', connectionReferences: {} };
  writeFileSync(join(appDir, 'ms.config.json'), `\uFEFF${JSON.stringify(config)}`);
  assert.deepEqual(steps.readAppConfig(appDir), { appId: 'app-1', environmentId: 'env-1', displayName: 'Hub', config });
  for (const bad of [{ appId: '', environmentId: 'e' }, { appId: 'a' }, { appId: 1, environmentId: 'e' }]) {
    writeFileSync(join(appDir, 'ms.config.json'), JSON.stringify(bad));
    assert.equal(steps.readAppConfig(appDir), undefined, JSON.stringify(bad));
  }
  writeFileSync(join(appDir, 'ms.config.json'), '{"appId":"a","environmentId":"e"}');
  assert.deepEqual(steps.readAppConfig(appDir), { appId: 'a', environmentId: 'e', config: { appId: 'a', environmentId: 'e' } });
});

test('keepFiles: puts back what changed, leaves the rest alone, and skips files that weren\'t there', (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, 'a.json'), 'A');
  writeFileSync(join(dir, 'b.json'), 'B');
  const past = new Date('2020-01-01T00:00:00Z');
  utimesSync(join(dir, 'b.json'), past, past);
  const kept = steps.keepFiles(dir, ['a.json', 'b.json', 'c.json']);
  writeFileSync(join(dir, 'a.json'), 'changed');
  writeFileSync(join(dir, 'c.json'), 'new');
  kept.restore();
  assert.equal(readFileSync(join(dir, 'a.json'), 'utf8'), 'A');
  assert.equal(statSync(join(dir, 'b.json')).mtimeMs, past.getTime(), 'unchanged, so not written');
  assert.equal(readFileSync(join(dir, 'c.json'), 'utf8'), 'new');
  rmSync(join(dir, 'a.json'));
  kept.restore();
  assert.equal(readFileSync(join(dir, 'a.json'), 'utf8'), 'A', 'and deleted ones');
});

// --- The repo ------------------------------------------------------------------------------------------

test('managed app: its modules import only Node built-ins and each other, so they run from a ZIP', () => {
  const dir = join(REPO, 'installer', 'src', 'managed-app');
  const files = readdirSync(dir).filter((file) => file.endsWith('.js'));
  assert.ok(files.includes('flow.js'));
  for (const file of files) {
    const src = readFileSync(join(dir, file), 'utf8');
    for (const [, from, dynamic] of src.matchAll(/\bfrom\s+'([^']+)'|\bimport\(\s*'([^']+)'\s*\)/g)) {
      assert.match(from ?? dynamic, /^(node:|\.\/)/, `${file} imports ${from ?? dynamic}`);
    }
  }
});

test('managed CLI package: pins one exact CLI version, from the public registry, with integrity', () => {
  const dir = join(REPO, 'installer', 'managed-cli');
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8'));
  const pinned = pinnedVersion();
  assert.equal(pkg.private, true);
  assert.deepEqual(Object.keys(pkg.dependencies), [CLI_PACKAGE]);
  assert.match(pinned, /^\d+\.\d+\.\d+$/, 'an exact version, not a range');
  assert.equal(lock.lockfileVersion, 3);
  assert.equal(lock.packages[''].dependencies[CLI_PACKAGE], pinned);
  assert.equal(lock.packages[`node_modules/${CLI_PACKAGE}`].version, pinned);
  const entries = Object.entries(lock.packages).filter(([path]) => path);
  assert.ok(entries.length > 1);
  for (const [path, entry] of entries) {
    assert.ok(String(entry.resolved).startsWith('https://registry.npmjs.org/'), `${path} comes from the public registry`);
    // A feed that serves only SHA-1 shasums writes sha1- entries. Check those tarballs, then record their SHA-512.
    assert.match(String(entry.integrity), /^sha512-[A-Za-z0-9+/]{86}==$/, `${path} has SHA-512 integrity`);
  }
});

test('managed app: npm run deploy:managed and remove:managed run the flow', () => {
  const pkg = JSON.parse(readFileSync(join(REPO, 'app', 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['deploy:managed'], 'node scripts/deploy-managed.mjs');
  assert.equal(pkg.scripts['remove:managed'], 'node scripts/remove-managed.mjs');
  for (const [file, run] of [['deploy-managed.mjs', 'runDeploy'], ['remove-managed.mjs', 'runRemove']]) {
    const src = readFileSync(join(REPO, 'app', 'scripts', file), 'utf8');
    const from = /from '([^']+\/flow\.js)'/.exec(src)?.[1];
    assert.ok(from, `${file} imports the flow`);
    assert.ok(existsSync(resolve(REPO, 'app', 'scripts', from)), `${from} is there`);
    assert.ok(src.includes(`await ${run}(process.argv.slice(2), { io, appDir })`), `${file} runs ${run}`);
  }
});

test('managed app: git ignores every file setup writes in app, and the pinned CLI\'s packages', () => {
  const ignored = readFileSync(join(REPO, 'app', '.gitignore'), 'utf8').split(/\r?\n/).map((line) => line.trim());
  for (const name of APP_FILES) assert.ok(ignored.includes(name) || ignored.includes(`${name}/`), name);
  assert.ok(readFileSync(join(REPO, 'installer', '.gitignore'), 'utf8').split(/\r?\n/).includes('node_modules/'));
});
