// @ts-check
/**
 * The by-hand route, start to end. In app, `npm run deploy:managed` runs runDeploy, and
 * `npm run remove:managed` runs runRemove. They ask their questions through io, so tests can answer
 * them, and run the steps in steps.js. Running it again picks up where it stopped: each step skips
 * what's done.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { CLI_PACKAGE, CLI_PACKAGE_DIR, createCli, installedVersion, pinnedVersion } from './cli.js';
import { ADMIN_STEPS, LINKS } from './errors.js';
import { isGuid, parseModelLink } from './links.js';
import {
  CONFIG_FILE, MODELS, VIEWER_GROUP, findInstallRecord, groupFromRecord, modelsFromRecord, modelsWithoutBuild,
  readModelConfig, writeModelConfig,
} from './models.js';
import { clearAppFiles, clearState, readSaved, restoreState, saveState, stateDir as defaultStateDir } from './state.js';
import * as steps from './steps.js';

/** @typedef {import('./cli.js').RunCli} RunCli */
/** @typedef {import('./errors.js').Problem} Problem */
/** @typedef {import('./models.js').Models} Models */
/** @typedef {import('./state.js').SavedApp} SavedApp */

/**
 * The oldest Node.js the by-hand route takes. The app's build needs 24.15 on Node 24, and the CLI needs 24.11.
 */
export const MIN_NODE = '24.15.0';
export const DEFAULT_NAME = 'Analytics Hub';
const DEPLOY = 'npm run deploy:managed';
const REMOVE = 'npm run remove:managed';
/** Packages the managed build needs. Without them, `npm ci` runs, as in a fresh download. */
const APP_PACKAGES = ['@microsoft/managed-apps', '@microsoft/managed-apps-vite-plugin', 'vite'];
/** Options npm takes for itself when they come before `--`, as npm_config_* variables. */
const NPM_SWALLOWS = ['new', 'dry_run', 'share', 'environment_id', 'display_name', 'device_code'];
const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

/**
 * @typedef {object} Io
 * @property {(question: string) => Promise<string | undefined>} ask  Undefined when there's no answer,
 *   such as at the end of piped input, or after Ctrl+C.
 * @property {(line?: string) => void} say
 * @property {() => void} [close]  Stops reading, so the process can end.
 */

/**
 * @typedef {object} FlowDeps
 * @property {Io} io
 * @property {string} appDir  The app folder.
 * @property {RunCli} [run]
 * @property {(args: string[], cwd: string) => Promise<number | null>} [runNpm]  Runs npm on screen, and gives its exit code.
 * @property {string} [cliDir]
 * @property {string} [stateDir]
 * @property {() => { path: string, record: any } | undefined} [findRecord]
 * @property {(url: string) => void} [openUrl]
 * @property {string} [nodeVersion]
 * @property {() => Date} [now]
 * @property {NodeJS.ProcessEnv} [env]
 */

/**
 * @typedef {object} Options
 * @property {string} [environmentId]
 * @property {string} [displayName]
 * @property {string[]} [share]
 * @property {boolean} deviceCode
 * @property {boolean} fresh  --new
 * @property {boolean} dryRun
 * @property {boolean} help
 */

const DEPLOY_HELP = `${DEPLOY} -- [options]

Sets up Analytics Hub as a Copilot managed app, or updates it. Run it again any time.

  --environment-id <id>   Use this environment, not your developer environment.
  --display-name <name>   The new app's name. Default: ${DEFAULT_NAME}.
  --share <list>          Share it with these emails or group object IDs, comma-separated.
  --device-code           Sign in with a code, in any browser.
  --new                   Make another app, instead of updating this one.
  --dry-run               Show the steps as ms commands. Runs nothing.

Remove it: ${REMOVE}
More: docs/MANAGED-APP.md`;

const REMOVE_HELP = `${REMOVE} -- [options]

Deletes the managed app this folder deployed, or the one you deployed last. It asks first.

  --device-code           Sign in with a code, in any browser.`;

/** Stops the run. With a problem, it says who fixes what first. */
class Stop extends Error {
  /**
   * @param {number} code
   * @param {Problem} [problem]
   */
  constructor(code, problem) {
    super(problem?.what ?? 'Stopped.');
    this.code = code;
    this.problem = problem;
  }
}

/**
 * npm run deploy:managed.
 * @param {string[]} argv
 * @param {FlowDeps} deps
 * @returns {Promise<number>}  The exit code: 0 done, 1 stopped, 2 a wrong option.
 */
export async function runDeploy(argv, deps) {
  const { io, appDir } = deps;
  const swallowed = npmSwallowed(deps.env ?? process.env);
  if (swallowed.length) return swallowedOptions(io, swallowed, DEPLOY);
  const parsed = parseArgs(argv, 'deploy');
  if (!parsed.ok) {
    io.say(parsed.error);
    io.say(`See the options: ${DEPLOY} -- --help`);
    return 2;
  }
  const { options } = parsed;
  if (options.help) {
    io.say(DEPLOY_HELP);
    return 0;
  }
  const cliDir = deps.cliDir ?? CLI_PACKAGE_DIR;
  if (options.dryRun) {
    dryRun(io, options, cliDir);
    return 0;
  }
  const version = deps.nodeVersion ?? process.version;
  if (!nodeOk(version)) {
    io.say(`It needs Node.js ${MIN_NODE} or later, and this is ${version}. Get it from ${LINKS.node}, then run it again.`);
    return 1;
  }

  try {
    io.say('Setting up the Analytics Hub managed app. If it stops, run it again: it picks up where it stopped.');
    await ensurePackages(deps, { app: true, cliDir });
    const dir = deps.stateDir ?? defaultStateDir();
    const now = deps.now ?? (() => new Date());
    let local = await chooseApp(io, appDir, dir, options);

    const found = (deps.findRecord ?? (() => findInstallRecord({ repoRoot: resolve(appDir, '..') })))();
    const models = await chooseModels(io, appDir, found);

    const run = deps.run ?? createCli({ cliDir }).run;
    const account = await signIn(run, io, options.deviceCode);
    const retry = retryAfterSignIn(run, io, account, options.deviceCode);

    if (!local) {
      const policy = must(await retry(() => steps.checkPolicy(run, { environmentId: options.environmentId })));
      if (policy.warning) io.say(policy.warning);
      const name = options.displayName ?? DEFAULT_NAME;
      io.say(`Making the app "${name}" in ${options.environmentId ? `environment ${options.environmentId}` : 'your developer environment'}.`);
      const created = must(await retry(() => steps.createApp(run, { appDir, displayName: name, environmentId: options.environmentId })));
      saveState(appDir, dir, { appId: created.appId, environmentId: created.environmentId, displayName: name }, now());
      local = steps.readAppConfig(appDir) ?? { appId: created.appId, environmentId: created.environmentId, displayName: name, config: {} };
    }
    const app = { appId: local.appId, environmentId: local.environmentId, displayName: local.displayName ?? options.displayName ?? DEFAULT_NAME };

    if (steps.powerBiSource(appDir) === undefined) io.say('Adding Power BI to the app. If you have more than one Power BI connection, it asks which.');
    const powerBi = must(await retry(() => steps.addPowerBi(run, { appDir })));
    if (powerBi.warning) io.say(powerBi.warning);
    saveState(appDir, dir, app, now());

    const known = readSaved(dir);
    const firstDeploy = !known?.deployedAt;
    io.say('Deploying. It builds the app, then uploads it. This takes a few minutes.');
    const deployed = must(await retry(() => steps.deployApp(run, { appDir })));
    for (const warning of deployed.warnings) io.say(`Note: ${warning}`);
    saveState(appDir, dir, { ...app, deployedAt: now().toISOString(), ...(deployed.playUrl ? { playUrl: deployed.playUrl } : {}) }, now());
    io.say('Deployed.');

    const url = deployed.playUrl ?? (await steps.playUrl(run, { appDir }).then((r) => (r.ok ? r.url : undefined)));
    /** @type {string[]} */
    let unshared = [];
    if (options.share || !known?.sharedAt) {
      unshared = await share(run, io, { appDir, options, found, models, retry });
      if (!unshared.length) saveState(appDir, dir, { ...app, sharedAt: now().toISOString() }, now());
    }

    io.say();
    if (url) {
      io.say(`Open it: ${url}`);
      io.say('If it opens as the wrong account, use an InPrivate window.');
      if (firstDeploy) (deps.openUrl ?? openInBrowser)(url);
    }
    io.say(`Signed in as ${account}.`);
    if (firstDeploy) checklist(io);
    if (unshared.length) {
      io.say();
      io.say(`It's deployed, but not shared with ${unshared.join(', ')}. To share it: ${DEPLOY} -- --share ${unshared.join(',')}`);
      return 1;
    }
    io.say(`To update it, run this again. To remove it: ${REMOVE}`);
    return 0;
  } catch (err) {
    return stopped(io, err, DEPLOY);
  }
}

/**
 * npm run remove:managed.
 * @param {string[]} argv
 * @param {FlowDeps} deps
 * @returns {Promise<number>}
 */
export async function runRemove(argv, deps) {
  const { io, appDir } = deps;
  const swallowed = npmSwallowed(deps.env ?? process.env);
  if (swallowed.length) return swallowedOptions(io, swallowed, REMOVE);
  const parsed = parseArgs(argv, 'remove');
  if (!parsed.ok) {
    io.say(parsed.error);
    io.say(`See the options: ${REMOVE} -- --help`);
    return 2;
  }
  if (parsed.options.help) {
    io.say(REMOVE_HELP);
    return 0;
  }
  const dir = deps.stateDir ?? defaultStateDir();
  const local = steps.readAppConfig(appDir);
  const saved = readSaved(dir);
  const app = local ?? saved;
  if (!app) {
    io.say('There\'s no managed app to remove. This folder has none, and none was saved.');
    return 0;
  }
  io.say(`This deletes "${app.displayName ?? DEFAULT_NAME}" (${app.appId}), in environment ${app.environmentId}. Everyone it's shared with loses it.`);
  const sure = await yes(io, 'Delete it?', false);
  if (!sure) {
    io.say('Nothing was deleted.');
    return sure === undefined ? 1 : 0;
  }

  try {
    const cliDir = deps.cliDir ?? CLI_PACKAGE_DIR;
    await ensurePackages(deps, { app: false, cliDir });
    const run = deps.run ?? createCli({ cliDir }).run;
    const account = await signIn(run, io, parsed.options.deviceCode);
    const retry = retryAfterSignIn(run, io, account, parsed.options.deviceCode);
    const deleted = must(await retry(() => steps.deleteApp(run, { appId: app.appId, environmentId: app.environmentId, cwd: appDir })));
    io.say(deleted.existed ? 'Deleted.' : 'It was already gone.');
    if (local) clearAppFiles(appDir);
    if (saved?.appId === app.appId) clearState(dir);
    io.say('The Power BI connection stays, for other apps. If you don\'t need it, delete it in Power Apps > Connections.');
    return 0;
  } catch (err) {
    return stopped(io, err, REMOVE);
  }
}

/**
 * Which app this run updates: this folder's, the one saved from an earlier run, or a new one.
 * @param {Io} io
 * @param {string} appDir
 * @param {string} dir
 * @param {Options} options
 */
async function chooseApp(io, appDir, dir, options) {
  let local = steps.readAppConfig(appDir);
  const saved = readSaved(dir);
  if (options.fresh) {
    const old = local ?? saved;
    if (old) io.say(`--new: it makes another app. "${old.displayName ?? DEFAULT_NAME}" (${old.appId}) stays deployed.`);
    clearAppFiles(appDir);
    return undefined;
  }
  if (!local && saved) {
    if (options.environmentId && !sameId(options.environmentId, saved.environmentId)) {
      throw new Stop(2, { who: 'you', what: `The app you set up on ${dateOf(saved)} is in environment ${saved.environmentId}. To make one in ${options.environmentId}, add --new.` });
    }
    if (await yesOrStop(io, `Update the "${saved.displayName ?? DEFAULT_NAME}" app you set up on ${dateOf(saved)}?`, true)) {
      restoreState(appDir, dir);
      local = steps.readAppConfig(appDir);
    } else {
      io.say('It makes a new app. The other one stays deployed.');
    }
  }
  if (local && options.environmentId && !sameId(options.environmentId, local.environmentId)) {
    throw new Stop(2, { who: 'you', what: `This app is in environment ${local.environmentId}. To make one in ${options.environmentId}, add --new.` });
  }
  if (local && options.displayName && options.displayName !== local.displayName) {
    io.say(`The app keeps its name, "${local.displayName ?? DEFAULT_NAME}". --display-name names a new app.`);
  }
  return local;
}

/**
 * The models from managed-app.config.json when it's filled in. Otherwise from an install record, if you
 * say so, or from links you paste. Then it writes them there.
 * @param {Io} io
 * @param {string} appDir
 * @param {{ path: string, record: any } | undefined} found
 * @returns {Promise<Models>}
 */
async function chooseModels(io, appDir, found) {
  const file = join(appDir, CONFIG_FILE);
  const current = readModelConfig(file);
  if (current.state === 'invalid') {
    throw new Stop(1, { who: 'you', message: current.error, what: `${CONFIG_FILE}, in app, isn't valid. Fix it, or delete it and paste the links when it asks.` });
  }
  if (current.state === 'ready') {
    io.say(`Models: ${modelNames(current.models)}, from ${CONFIG_FILE}.`);
    return current.models;
  }
  /** @type {Models | undefined} */
  let models;
  const fromRecord = found ? modelsFromRecord(found.record) : {};
  if (found && fromRecord.vl) {
    io.say(`Found your install record: ${found.path}`);
    io.say(`It has: ${modelNames(fromRecord)}.`);
    if (await yesOrStop(io, 'Use those models?', true)) models = fromRecord;
  }
  models ??= await askModels(io);
  writeModelConfig(file, models, current.state === 'unfilled' ? current.body : undefined);
  io.say(`Saved them in ${CONFIG_FILE}.`);
  return models;
}

/**
 * @param {Io} io
 * @returns {Promise<Models>}
 */
async function askModels(io) {
  io.say('Paste each semantic model\'s link. Open the model in Power BI or Fabric, and copy the address bar.');
  /** @type {Models} */
  const models = {};
  for (const { alias, name, required } of MODELS) {
    for (;;) {
      const answer = await io.ask(required ? `${name} link: ` : `${name} link (Enter to skip): `);
      if (answer === undefined) throw noAnswer(io);
      if (!required && !answer.trim()) break;
      const link = parseModelLink(answer);
      if (link.ok) {
        models[alias] = { workspaceId: link.workspaceId, itemId: link.itemId };
        break;
      }
      io.say(link.error);
    }
  }
  return models;
}

/**
 * Signs in to the CLI as the account you choose, and gives it.
 * @param {RunCli} run
 * @param {Io} io
 * @param {boolean} deviceCode
 * @returns {Promise<string>}
 */
async function signIn(run, io, deviceCode) {
  const status = must(await steps.authStatus(run));
  if (status.signedIn && status.account && (await yesOrStop(io, `Signed in as ${status.account}. Use this account?`, true))) {
    return status.account;
  }
  const email = await askEmail(io);
  if (status.accounts.some((account) => sameId(account, email)) && (await steps.switchAccount(run, email)).ok) {
    const switched = await steps.authStatus(run);
    if (switched.ok && switched.account && sameId(switched.account, email)) return switched.account;
  }
  io.say(`Signing in as ${email}.${deviceCode ? ' It shows a code to enter in a browser.' : ''}`);
  must(await steps.login(run, { account: email, deviceCode }));
  const after = must(await steps.authStatus(run));
  if (!after.signedIn || !after.account) throw new Stop(1, { who: 'you', what: 'It didn\'t sign in. Run it again.' });
  if (!sameId(after.account, email) && !(await yesOrStop(io, `It signed in as ${after.account}, not ${email}. Carry on as ${after.account}?`, false))) {
    throw new Stop(1, { who: 'you', what: `Run it again, and sign in as ${email}. If another account signs in, add --device-code, and open the link in an InPrivate window.` });
  }
  return after.account;
}

/**
 * A step that fails because the sign-in expired runs once more after you sign in again.
 * @param {RunCli} run
 * @param {Io} io
 * @param {string} account
 * @param {boolean} deviceCode
 */
function retryAfterSignIn(run, io, account, deviceCode) {
  /**
   * @template {{ ok: boolean }} T
   * @param {() => Promise<T>} step
   * @returns {Promise<T>}
   */
  async function retry(step) {
    const first = await step();
    if (first.ok || /** @type {any} */ (first).result?.exitCode !== 3) return first;
    io.say('Your sign-in has expired. Sign in again.');
    must(await steps.login(run, { account, deviceCode }));
    return step();
  }
  return retry;
}

/**
 * Shares the app: with the installer's viewer group if you say so, and anyone else you name, or with
 * --share. Then it checks the group IDs took. Gives who it couldn't share with.
 * @param {RunCli} run
 * @param {Io} io
 * @param {object} context
 * @param {string} context.appDir
 * @param {Options} context.options
 * @param {{ path: string, record: any } | undefined} context.found
 * @param {Models} context.models
 * @param {ReturnType<typeof retryAfterSignIn>} context.retry
 * @returns {Promise<string[]>}
 */
async function share(run, io, { appDir, options, found, models, retry }) {
  const group = found ? groupFromRecord(found.record) : undefined;
  /** @type {string[]} */
  const principals = [...(options.share ?? [])];
  if (!options.share) {
    if (group && (await yesOrStop(io, `Share it with ${group.name}? That group has access to the models.`, true))) principals.push(group.id);
    principals.push(...(await askOthers(io)).filter((p) => !principals.some((q) => sameId(p, q))));
  }
  if (!principals.length) {
    io.say(`It isn't shared with anyone else yet. To share it: ${DEPLOY} -- --share <emails or group object IDs>`);
    return [];
  }

  const label = (/** @type {string} */ p) => (group && sameId(p, group.id) ? group.name : p);
  const shared = await retry(() => steps.shareApp(run, { appDir, principals }));
  if (!shared.ok) {
    report(io, shared.problem, DEPLOY, 'Sharing failed');
    return principals;
  }
  for (const warning of shared.warnings) io.say(`Not shared: ${warning}`);
  // A partial failure that names no one could be anyone, so all of them are tried again.
  const rejected = shared.partial && !shared.rejected.length ? principals : shared.rejected;
  const sent = principals.filter((p) => !rejected.some((r) => sameId(r, p)));
  if (sent.length) {
    const checked = await steps.verifyShare(run, { appDir, ids: sent });
    if (!checked.ok) io.say('Couldn\'t check who it\'s shared with.');
    else if (checked.missing.length) io.say(`Couldn't see it shared with ${checked.missing.map(label).join(', ')} yet. It can take a few minutes.`);
    io.say(`Shared with ${sent.map(label).join(', ')}.`);
  }
  if (group && sent.some((p) => sameId(p, group.id))) {
    const lacking = modelsWithoutBuild(found?.record, models);
    if (lacking.length) {
      io.say(`${group.name} has no Build on: ${lacking.join(', ')}. Its members can open the app, but can't read those. Run the installer again, or give the group Build on each.`);
    }
  }
  return principals.filter((p) => !sent.some((s) => sameId(s, p)));
}

/**
 * @param {Io} io
 * @returns {Promise<string[]>}
 */
async function askOthers(io) {
  for (;;) {
    const answer = await io.ask('Anyone else? Emails or group object IDs, comma-separated (Enter for no one): ');
    if (answer === undefined) throw noAnswer(io);
    if (!answer.trim()) return [];
    const list = parseShareList(answer);
    if (list.ok) return list.principals;
    io.say(list.error);
  }
}

/** @param {Io} io */
async function askEmail(io) {
  for (;;) {
    const answer = await io.ask('Your work email: ');
    if (answer === undefined) throw noAnswer(io);
    const email = answer.trim();
    if (EMAIL.test(email)) return email;
    io.say('That isn\'t an email.');
  }
}

/** @param {Io} io */
function checklist(io) {
  const { executeQueries, licences } = ADMIN_STEPS;
  io.say();
  io.say('Before others use it, check these. Setup can\'t:');
  io.say(`  1. ${executeQueries.who}: ${executeQueries.what}`);
  io.say(`     ${executeQueries.link}`);
  io.say(`  2. Each viewer has Build on the models. The installer gives it to ${VIEWER_GROUP}.`);
  io.say(`  3. ${licences.who}: ${licences.what}`);
  io.say(`     ${licences.link}`);
  io.say('  4. Open the app as a viewer, then Diagnostics > Check who the model sees. It shows who the model sees, and their row-level security.');
}

/**
 * Installs the app's packages when they're missing, and the pinned CLI when it isn't there.
 * @param {FlowDeps} deps
 * @param {{ app: boolean, cliDir: string }} options
 */
async function ensurePackages(deps, { app, cliDir }) {
  const { io, appDir } = deps;
  const npm = deps.runNpm ?? ((args, cwd) => spawnNpm(args, cwd, { env: deps.env ?? process.env }));
  if (app && !appPackagesReady(appDir)) {
    io.say('Installing the app\'s build tools (npm ci). This takes a few minutes the first time.');
    if ((await npm(['ci', '--no-audit', '--no-fund'], appDir)) !== 0) {
      throw new Stop(1, { who: 'you', what: 'npm ci failed in app. Check the messages above, then run it again.' });
    }
  }
  /** @type {string} */
  let pinned;
  try {
    pinned = pinnedVersion(cliDir);
  } catch {
    throw new Stop(1, { who: 'you', what: `The managed apps CLI's package is missing from ${cliDir}. Download the code again.` });
  }
  if (installedVersion(cliDir) === pinned) return;
  io.say(`Installing the managed apps CLI ${pinned}, just for this. It takes a minute.`);
  const code = await npm(['ci', '--no-audit', '--no-fund', '--ignore-scripts'], cliDir);
  if (code !== 0 || installedVersion(cliDir) !== pinned) {
    throw new Stop(1, { who: 'you', what: 'Couldn\'t install the managed apps CLI. Check the messages above, then run it again.' });
  }
}

/**
 * Whether the app's packages for the managed build are installed.
 * @param {string} appDir
 */
export const appPackagesReady = (appDir) => APP_PACKAGES.every((name) => existsSync(join(appDir, 'node_modules', ...name.split('/'), 'package.json')));

/**
 * @param {Io} io
 * @param {Options} options
 * @param {string} cliDir
 */
function dryRun(io, options, cliDir) {
  /** @type {string | undefined} */
  let pinned;
  try {
    pinned = pinnedVersion(cliDir);
  } catch {
    pinned = undefined;
  }
  const environment = options.environmentId ? ` --environment-id ${options.environmentId}` : '';
  io.say('Nothing runs with --dry-run. These are its steps, in app:');
  io.say();
  for (const line of [
    'npm ci   (when packages are missing)',
    `ms auth login --account <your email>${options.deviceCode ? ' --device-code' : ''}`,
    `ms connector list-actions --connector ${steps.POWER_BI_CONNECTOR}${environment}`,
    `ms app init --repo none --display-name ${JSON.stringify(options.displayName ?? DEFAULT_NAME)} --build-command ${JSON.stringify(steps.BUILD_COMMAND)}${environment}`,
    `ms app add data-source --connector ${steps.POWER_BI_CONNECTOR} --as action`,
    'ms app deploy',
    `ms app share ${options.share ? options.share.join(',') : '<emails or group object IDs>'} --access play`,
    'ms app play',
  ]) {
    io.say(`  ${line}`);
  }
  io.say();
  io.say('To run them yourself:');
  io.say(`  - Install the CLI: npm install -g ${CLI_PACKAGE}${pinned ? `@${pinned}` : ''}`);
  io.say('  - Before init, copy managed-app.config.example.json to managed-app.config.json, and fill in the model IDs.');
  io.say('  - After init, put package.json back as it was. init adds the CLI to it, which breaks npm ci.');
  io.say('  - Next time, skip init and add data-source.');
}

/**
 * @param {string[]} argv
 * @param {'deploy' | 'remove'} command
 * @returns {{ ok: true, options: Options } | { ok: false, error: string }}
 */
export function parseArgs(argv, command) {
  /** @type {Options} */
  const options = { deviceCode: false, fresh: false, dryRun: false, help: false };
  /** @param {string} error */
  const wrong = (error) => /** @type {{ ok: false, error: string }} */ ({ ok: false, error });
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') continue;
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    const inline = eq > 0 ? arg.slice(eq + 1) : undefined;
    const flag = () => (inline === undefined ? undefined : wrong(`${name} takes no value.`));
    const value = () => {
      if (inline !== undefined) return inline;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) return undefined;
      i++;
      return next;
    };

    if (name === '--help' || name === '-h') {
      options.help = true;
      continue;
    }
    if (name === '--device-code') {
      options.deviceCode = true;
      const bad = flag();
      if (bad) return bad;
      continue;
    }
    if (command === 'remove') return wrong(`Unknown option: ${arg}`);

    if (name === '--new' || name === '--dry-run') {
      const bad = flag();
      if (bad) return bad;
      if (name === '--new') options.fresh = true;
      else options.dryRun = true;
    } else if (name === '--environment-id') {
      const id = value()?.trim();
      if (!id || !/^[\w-]+$/.test(id)) return wrong('--environment-id needs an environment ID.');
      options.environmentId = id;
    } else if (name === '--display-name') {
      const display = value()?.trim();
      if (!display) return wrong('--display-name needs a name.');
      options.displayName = display;
    } else if (name === '--share') {
      const list = parseShareList(value() ?? '');
      if (!list.ok) return wrong(list.error);
      options.share = list.principals;
    } else {
      return wrong(`Unknown option: ${arg}`);
    }
  }
  return { ok: true, options };
}

/**
 * Emails and object IDs, separated by commas, semicolons or spaces. Each once.
 * @param {string} text
 * @returns {{ ok: true, principals: string[] } | { ok: false, error: string }}
 */
export function parseShareList(text) {
  /** @type {string[]} */
  const principals = [];
  for (const entry of text.split(/[,;\s]+/).filter(Boolean)) {
    if (!EMAIL.test(entry) && !isGuid(entry)) return { ok: false, error: `${entry} isn't an email or an object ID.` };
    if (!principals.some((p) => sameId(p, entry))) principals.push(entry);
  }
  return principals.length ? { ok: true, principals } : { ok: false, error: '--share needs emails or group object IDs.' };
}

/**
 * The options npm took for itself because they came before `--`. For example, without `--`,
 * `npm run deploy:managed --dry-run` would deploy.
 * @param {NodeJS.ProcessEnv} env
 * @returns {string[]}
 */
export function npmSwallowed(env) {
  if (!env.npm_lifecycle_event) return [];
  return NPM_SWALLOWS.filter((name) => {
    const value = env[`npm_config_${name}`];
    return value !== undefined && value !== '' && value !== 'false';
  }).map((name) => `--${name.replace(/_/g, '-')}`);
}

/**
 * @param {Io} io
 * @param {string[]} swallowed
 * @param {string} command
 */
function swallowedOptions(io, swallowed, command) {
  io.say(`npm took ${swallowed.join(' ')} for itself, so nothing ran. Put -- before the options:`);
  io.say(`  ${command} -- <options>`);
  return 2;
}

/**
 * Whether this Node.js is new enough.
 * @param {string} version  Such as v24.15.0.
 * @param {string} [min]
 */
export function nodeOk(version, min = MIN_NODE) {
  const parts = (/** @type {string} */ v) => v.replace(/^v/, '').split('.').map((n) => Number.parseInt(n, 10) || 0);
  const have = parts(version);
  const need = parts(min);
  for (let i = 0; i < 3; i++) {
    if ((have[i] ?? 0) !== (need[i] ?? 0)) return (have[i] ?? 0) > (need[i] ?? 0);
  }
  return true;
}

/**
 * How to run npm without a shell: the npm that's running this, else the one beside this Node.js. Only
 * if neither is found, npm.cmd through cmd on Windows, which needs no PowerShell script.
 * @param {{ env?: NodeJS.ProcessEnv, execPath?: string, platform?: NodeJS.Platform, exists?: (file: string) => boolean }} [where]
 * @returns {{ command: string, args: string[], shell: boolean }}
 */
export function npmCommand({ env = process.env, execPath = process.execPath, platform = process.platform, exists = existsSync } = {}) {
  const running = env.npm_execpath;
  if (running && /^npm-cli\.js$/i.test(basename(running)) && exists(running)) return { command: execPath, args: [running], shell: false };
  const nodeDir = dirname(execPath);
  for (const cli of [join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')]) {
    if (exists(cli)) return { command: execPath, args: [cli], shell: false };
  }
  return platform === 'win32' ? { command: 'npm.cmd', args: [], shell: true } : { command: 'npm', args: [], shell: false };
}

/**
 * Runs npm on screen, so its progress shows.
 * @param {string[]} args  Fixed words only: with a shell, they're joined as they are.
 * @param {string} cwd
 * @param {{ env?: NodeJS.ProcessEnv, spawn?: typeof nodeSpawn }} [options]
 * @returns {Promise<number | null>}
 */
export function spawnNpm(args, cwd, { env = process.env, spawn = nodeSpawn } = {}) {
  const npm = npmCommand({ env });
  return new Promise((done) => {
    const child = npm.shell
      ? spawn([npm.command, ...npm.args, ...args].join(' '), { cwd, env, stdio: 'inherit', shell: true })
      : spawn(npm.command, [...npm.args, ...args], { cwd, env, stdio: 'inherit' });
    child.on('error', () => done(null));
    child.on('close', (code) => done(code));
  });
}

/**
 * Opens the app in the default browser. It's printed too, so a failure here doesn't matter.
 * @param {string} url
 * @param {{ platform?: NodeJS.Platform, spawn?: typeof nodeSpawn }} [options]
 */
export function openInBrowser(url, { platform = process.platform, spawn = nodeSpawn } = {}) {
  if (!/^https:\/\//i.test(url)) return;
  const command = platform === 'win32' ? 'explorer.exe' : platform === 'darwin' ? 'open' : 'xdg-open';
  try {
    const child = spawn(command, [url], { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // The link is printed above.
  }
}

/**
 * Questions in a terminal. Each question has its own reader, closed once answered, so a CLI command that
 * runs on screen in between can read the keyboard. Piped answers are read line by line.
 * @param {{ input?: NodeJS.ReadableStream & { isTTY?: boolean }, output?: NodeJS.WritableStream }} [streams]
 * @returns {Io}
 */
export function terminalIo({ input = process.stdin, output = process.stdout } = {}) {
  const say = (/** @type {string | undefined} */ line = '') => {
    output.write(`${line}\n`);
  };
  if (!input.isTTY) {
    /** @type {import('node:readline').Interface | undefined} */
    let reader;
    /** @type {AsyncIterator<string> | undefined} */
    let lines;
    return {
      say,
      async ask(question) {
        output.write(question);
        reader ??= createInterface({ input, crlfDelay: Infinity });
        lines ??= reader[Symbol.asyncIterator]();
        const next = await lines.next();
        output.write('\n');
        return next.done ? undefined : next.value;
      },
      close() {
        reader?.close();
      },
    };
  }
  let ended = false;
  return {
    say,
    ask(question) {
      if (ended) return Promise.resolve(undefined);
      return new Promise((done) => {
        const reader = createInterface({ input, output });
        let answered = false;
        reader.on('SIGINT', () => reader.close());
        reader.on('close', () => {
          if (answered) return;
          ended = true;
          output.write('\n');
          done(undefined);
        });
        reader.question(question, (answer) => {
          answered = true;
          reader.close();
          done(answer);
        });
      });
    },
  };
}

/**
 * A yes or no question. Enter takes the default. Undefined when there's no answer.
 * @param {Io} io
 * @param {string} question
 * @param {boolean} defaultYes
 * @returns {Promise<boolean | undefined>}
 */
export async function yes(io, question, defaultYes) {
  for (;;) {
    const answer = await io.ask(`${question} ${defaultYes ? '(Y/n)' : '(y/N)'} `);
    if (answer === undefined) return undefined;
    const word = answer.trim().toLowerCase();
    if (!word) return defaultYes;
    if (word === 'y' || word === 'yes') return true;
    if (word === 'n' || word === 'no') return false;
    io.say('Type y or n.');
  }
}

/**
 * @param {Io} io
 * @param {string} question
 * @param {boolean} defaultYes
 */
async function yesOrStop(io, question, defaultYes) {
  const answer = await yes(io, question, defaultYes);
  if (answer === undefined) throw noAnswer(io);
  return answer;
}

/** @param {Io} io */
function noAnswer(io) {
  io.say('No answer, so it stopped.');
  return new Stop(1);
}

/**
 * @template {{ ok: boolean }} T
 * @param {T} result
 * @returns {Extract<T, { ok: true }>}
 */
function must(result) {
  if (!result.ok) throw new Stop(1, /** @type {{ problem?: Problem }} */ (/** @type {unknown} */ (result)).problem);
  return /** @type {Extract<T, { ok: true }>} */ (result);
}

/**
 * @param {Io} io
 * @param {unknown} err
 * @param {string} again  The command that picks up where it stopped.
 */
function stopped(io, err, again) {
  if (err instanceof Stop) {
    if (err.problem) report(io, err.problem, again);
    return err.code;
  }
  report(io, { who: 'you', message: err instanceof Error ? err.message : String(err), what: 'Run it again. If it fails the same way, open an issue with the message above.', link: LINKS.issues }, again);
  return 1;
}

/**
 * What stopped it, and who fixes it. Someone else's step comes with a link, and how to carry on.
 * @param {Io} io
 * @param {Problem} problem
 * @param {string} again
 * @param {string} [lead]  What failed, such as "Sharing failed" when the run carries on.
 */
export function report(io, problem, again, lead = 'It stopped') {
  io.say();
  io.say(problem.message ? `${lead}: ${problem.message}` : `${lead}.`);
  if (problem.details) {
    for (const line of problem.details.split(/\r?\n/).slice(-20)) io.say(`  ${line}`);
  }
  if (problem.who === 'you') {
    io.say(problem.what);
    if (problem.link) io.say(problem.link);
    return;
  }
  io.say(`Ask your ${problem.who}:`);
  io.say(`  ${problem.what}`);
  if (problem.link) io.say(`  ${problem.link}`);
  io.say(`Then run ${again} again. It picks up where it stopped.`);
}

/** @param {Models} models */
const modelNames = (models) => MODELS.filter(({ alias }) => models[alias]).map(({ name }) => name).join(', ');

/** @param {SavedApp} saved */
const dateOf = (saved) => (saved.deployedAt ?? saved.savedAt ?? '').slice(0, 10) || 'an earlier run';

/**
 * @param {string} a
 * @param {string} b
 */
const sameId = (a, b) => a.toLowerCase() === b.toLowerCase();
