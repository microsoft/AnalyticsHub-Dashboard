// @ts-check
/**
 * Each step of setting up the managed app, as one or two CLI commands. Every step takes the runner from
 * cli.js and returns what happened, and none of them asks anything: the by-hand script and the installer
 * ask their own questions, then call these. A failed step says who fixes it (errors.js).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEPLOY_TIMEOUT_MS } from './cli.js';
import { ADMIN_STEPS, explain } from './errors.js';
import { isGuid } from './links.js';
import { stripBom } from './models.js';

/** @typedef {import('./cli.js').RunCli} RunCli */
/** @typedef {import('./cli.js').CliResult} CliResult */
/** @typedef {import('./errors.js').Problem} Problem */
/** @typedef {{ ok: false, problem: Problem, result?: CliResult }} Failed */

export const POWER_BI_CONNECTOR = 'shared_powerbi';
export const BUILD_COMMAND = 'npm run build:managed';
/** The Power BI actions the app can query through, such as ExecuteDatasetQueriesJson. Matches the app's own test. */
export const QUERY_ACTION = /execute\w*quer/i;
const POWER_BI_SOURCE = /power ?bi/i;
/** When the CLI can't add Power BI without asking, or without a browser, it runs again on screen. */
export const NEEDS_SCREEN = /multiple connections exist|cannot be created automatically|automatic connection creation failed/i;
const APP_CONFIG = 'ms.config.json';
const DATA_SOURCES = join('generated', 'dataSources.ts');
const PACKAGE_FILES = ['package.json', 'package-lock.json'];

/**
 * @param {string} step
 * @param {CliResult} result
 * @returns {Failed}
 */
const failed = (step, result) => ({ ok: false, problem: explain(step, result), result });

/**
 * Who's signed in to the CLI. A CLI that's never been signed in exits 3.
 * @param {RunCli} run
 * @returns {Promise<{ ok: true, signedIn: boolean, account?: string, accounts: string[] } | Failed>}
 */
export async function authStatus(run) {
  const result = await run(['auth', 'status']);
  if (!result.ok) return result.exitCode === 3 ? { ok: true, signedIn: false, accounts: [] } : failed('auth', result);
  const data = result.data ?? {};
  const accounts = Array.isArray(data.accounts) ? data.accounts.map((a) => a?.username).filter((u) => typeof u === 'string') : [];
  const account = typeof data.activeAccount?.username === 'string' ? data.activeAccount.username : undefined;
  return { ok: true, signedIn: Boolean(data.signedIn && account), ...(account ? { account } : {}), accounts };
}

/**
 * Makes an account the CLI already has the active one.
 * @param {RunCli} run
 * @param {string} account
 * @returns {Promise<{ ok: true } | Failed>}
 */
export async function switchAccount(run, account) {
  const result = await run(['auth', 'switch', '--account', account]);
  return result.ok ? { ok: true } : failed('auth', result);
}

/**
 * Signs in, on screen: a browser opens, or with --device-code, a code to type in one.
 * @param {RunCli} run
 * @param {{ account?: string, deviceCode?: boolean }} options
 * @returns {Promise<{ ok: true } | Failed>}
 */
export async function login(run, { account, deviceCode = false }) {
  const args = ['auth', 'login', ...(account ? ['--account', account] : []), ...(deviceCode ? ['--device-code'] : [])];
  const result = await run(args, { onScreen: true });
  return result.ok ? { ok: true } : failed('login', result);
}

/**
 * Checks the Power BI connector's "Run a query" actions aren't blocked in the environment, before
 * anything is created. It's read-only. Only Block is certain: when the CLI can't read the policy, it
 * says Allow, so the generated definitions are checked again once Power BI is added.
 * @param {RunCli} run
 * @param {{ environmentId?: string }} [options]
 * @returns {Promise<{ ok: true, allowed: string[], warning?: string } | Failed>}
 */
export async function checkPolicy(run, { environmentId } = {}) {
  const args = ['connector', 'list-actions', '--connector', POWER_BI_CONNECTOR, ...(environmentId ? ['--environment-id', environmentId] : [])];
  const result = await run(args);
  if (!result.ok) {
    if (result.exitCode === 3) return failed('policy', result);
    return { ok: true, allowed: [], warning: `Couldn't check the Power BI connector's policy, so it carries on. ${result.error ?? ''}`.trim() };
  }
  const items = Array.isArray(result.data?.items) ? result.data.items : [];
  const queries = items.filter((item) => typeof item?.id === 'string' && QUERY_ACTION.test(item.id));
  if (!queries.length) return { ok: true, allowed: [], warning: 'Couldn\'t find the Power BI connector\'s query actions, so it carries on.' };
  const allowed = queries.filter((item) => String(item.behavior).toLowerCase() !== 'block').map((item) => item.id);
  return allowed.length ? { ok: true, allowed } : { ok: false, problem: { ...ADMIN_STEPS.queryAction, message: QUERY_BLOCKED } };
}

const QUERY_BLOCKED = 'The Power BI connector\'s "Run a query" action is blocked in this environment.';

/**
 * Makes the folder a managed app, in your developer environment unless you name another. `ms app init`
 * also adds the CLI to package.json, which would break the next `npm ci`, so the package files are put back.
 * @param {RunCli} run
 * @param {object} options
 * @param {string} options.appDir
 * @param {string} options.displayName
 * @param {string} [options.environmentId]
 * @param {'build' | 'none'} [options.buildType]  none: deploy a folder that's already built, from buildPath.
 * @param {string} [options.buildPath]
 * @returns {Promise<{ ok: true, appId: string, environmentId: string } | Failed>}
 */
export async function createApp(run, { appDir, displayName, environmentId, buildType = 'build', buildPath }) {
  const args = [
    'app', 'init', '--repo', 'none', '--display-name', displayName,
    ...(buildType === 'none' ? ['--build-type', 'none'] : ['--build-command', BUILD_COMMAND]),
    ...(buildPath ? ['--build-path', buildPath] : []),
    ...(environmentId ? ['--environment-id', environmentId] : []),
  ];
  const kept = keepFiles(appDir, PACKAGE_FILES);
  /** @type {CliResult} */
  let result;
  try {
    result = await run(args, { cwd: appDir });
  } finally {
    kept.restore();
  }
  if (!result.ok) return failed('init', result);
  const config = readAppConfig(appDir);
  const appId = result.data?.appId ?? config?.appId;
  const environment = result.data?.environmentId ?? config?.environmentId ?? environmentId;
  if (!appId || !environment) {
    return { ok: false, problem: { who: 'you', what: 'The app was made, but its ID wasn\'t saved. Run it again with --new.' }, result };
  }
  return { ok: true, appId, environmentId: environment };
}

/**
 * Adds the Power BI connector, as actions, and checks its query action is there. Without prompts, the
 * CLI uses your one Power BI connection, or makes one. If it needs you, it runs again on screen. Once
 * added, a run only checks; if the query action is missing, say after an admin changed the policy, it
 * fetches the definitions again, then adds the connector again.
 * @param {RunCli} run
 * @param {{ appDir: string }} options
 * @returns {Promise<{ ok: true, added: boolean, warning?: string } | Failed>}
 */
export async function addPowerBi(run, { appDir }) {
  if (powerBiSource(appDir) !== undefined) {
    if (queryActions(appDir)?.length) return { ok: true, added: false };
    const refreshed = await run(['app', 'refresh', 'data-source'], { cwd: appDir });
    if (!refreshed.ok) return failed('add', refreshed);
    const actions = queryActions(appDir);
    if (actions === undefined) return { ok: true, added: false, warning: unreadable };
    if (actions.length) return { ok: true, added: false };
    // Still missing, so add it again, which applies the policy as it is now.
    const name = powerBiSource(appDir);
    if (!name) return { ok: false, problem: { ...ADMIN_STEPS.queryAction, message: QUERY_BLOCKED } };
    const removed = await run(['app', 'remove', 'data-source', '--name', name, '--force'], { cwd: appDir });
    if (!removed.ok) return failed('add', removed);
  }

  let result = await run(['app', 'add', 'data-source', '--connector', POWER_BI_CONNECTOR, '--as', 'action'], { cwd: appDir });
  if (!result.ok && NEEDS_SCREEN.test(`${result.error ?? ''}\n${result.stderr}`)) {
    result = await run(['app', 'add', 'data-source', '--connector', POWER_BI_CONNECTOR, '--as', 'action'], { cwd: appDir, onScreen: true });
  }
  if (!result.ok) return failed('add', result);
  if (powerBiSource(appDir) === undefined) {
    return { ok: false, problem: { who: 'you', what: 'Power BI wasn\'t added to the app. Run it again.' }, result };
  }
  const actions = queryActions(appDir);
  if (actions === undefined) return { ok: true, added: true, warning: unreadable };
  return actions.length ? { ok: true, added: true } : { ok: false, problem: { ...ADMIN_STEPS.queryAction, message: QUERY_BLOCKED }, result };
}

const unreadable = 'Couldn\'t read the Power BI connector\'s definitions to check its query action. If the app can\'t query, open Diagnostics in it.';

/**
 * Builds the app with build:managed, uploads it and waits for it to go live. With --json, the CLI
 * shows nothing while it builds, so say first that it takes a few minutes.
 * @param {RunCli} run
 * @param {{ appDir: string }} options
 * @returns {Promise<{ ok: true, playUrl?: string, warnings: string[] } | Failed>}
 */
export async function deployApp(run, { appDir }) {
  const result = await run(['app', 'deploy'], { cwd: appDir, timeoutMs: DEPLOY_TIMEOUT_MS });
  if (!result.ok) return failed('deploy', result);
  const playUrl = typeof result.data?.appPlayUri === 'string' ? result.data.appPlayUri : undefined;
  return { ok: true, ...(playUrl ? { playUrl } : {}), warnings: textsOf(result.data?.warnings) };
}

/**
 * Lets people and groups open the app. That doesn't give them the data: each also needs Build on the models.
 * @param {RunCli} run
 * @param {{ appDir: string, principals: string[] }} options  Emails, or user or group object IDs.
 * @returns {Promise<{ ok: true, partial: boolean, rejected: string[], warnings: string[] } | Failed>}  rejected: the
 *   entries the CLI named as not shared.
 */
export async function shareApp(run, { appDir, principals }) {
  const result = await run(['app', 'share', principals.join(','), '--access', 'play'], { cwd: appDir });
  if (!result.ok) return failed('share', result);
  const list = Array.isArray(result.data?.warnings) ? result.data.warnings : [];
  const warnings = list.map((/** @type {any} */ w) => (w && typeof w === 'object' ? [w.input, w.reason].filter(Boolean).join(': ') : String(w)));
  const rejected = list.map((/** @type {any} */ w) => w?.input).filter((input) => typeof input === 'string' && input);
  return { ok: true, partial: Boolean(result.data?.partialFailure), rejected, warnings };
}

/**
 * Which of the object IDs the app isn't shared with yet. The CLI lists object IDs only, so emails can't be checked.
 * @param {RunCli} run
 * @param {{ appDir: string, ids: string[] }} options
 * @returns {Promise<{ ok: true, missing: string[] } | Failed>}
 */
export async function verifyShare(run, { appDir, ids }) {
  const wanted = ids.filter(isGuid);
  if (!wanted.length) return { ok: true, missing: [] };
  const result = await run(['app', 'share', 'list', '--access', 'play'], { cwd: appDir });
  if (!result.ok) return failed('share', result);
  const shared = new Set();
  for (const page of Array.isArray(result.data?.results) ? result.data.results : []) {
    for (const entry of Array.isArray(page?.value) ? page.value : []) {
      if (typeof entry?.principalObjectId === 'string') shared.add(entry.principalObjectId.toLowerCase());
    }
  }
  return { ok: true, missing: wanted.filter((id) => !shared.has(id.toLowerCase())) };
}

/**
 * The app's link, without opening a browser.
 * @param {RunCli} run
 * @param {{ appDir: string }} options
 * @returns {Promise<{ ok: true, url: string } | Failed>}
 */
export async function playUrl(run, { appDir }) {
  const result = await run(['app', 'play', '--no-browser'], { cwd: appDir });
  if (!result.ok || typeof result.data?.url !== 'string') return failed('play', result);
  return { ok: true, url: result.data.url };
}

/**
 * Deletes the app. It doesn't need the app's folder. One that's already gone isn't an error.
 * @param {RunCli} run
 * @param {{ appId: string, environmentId?: string, cwd?: string }} options
 * @returns {Promise<{ ok: true, existed: boolean } | Failed>}
 */
export async function deleteApp(run, { appId, environmentId, cwd }) {
  const result = await run(['app', 'delete', '--force', '--app', appId, ...(environmentId ? ['--environment-id', environmentId] : [])], { cwd });
  if (!result.ok) return result.exitCode === 6 ? { ok: true, existed: false } : failed('delete', result);
  return { ok: true, existed: result.data?.existed !== false };
}

/**
 * The app's ID, environment and name from ms.config.json, when the folder is an app.
 * @param {string} appDir
 * @returns {{ appId: string, environmentId: string, displayName?: string, config: Record<string, any> } | undefined}
 */
export function readAppConfig(appDir) {
  try {
    const config = JSON.parse(stripBom(readFileSync(join(appDir, APP_CONFIG), 'utf8')));
    if (typeof config?.appId !== 'string' || !config.appId || typeof config.environmentId !== 'string') return undefined;
    return {
      appId: config.appId,
      environmentId: config.environmentId,
      ...(typeof config.appDisplayName === 'string' ? { displayName: config.appDisplayName } : {}),
      config,
    };
  } catch {
    return undefined;
  }
}

/**
 * The Power BI data source's name when the app has one, '' when ms.config.json references Power BI but
 * no definitions were generated, or undefined when it has none.
 * @param {string} appDir
 * @returns {string | undefined}
 */
export function powerBiSource(appDir) {
  const name = Object.keys(readDataSources(appDir) ?? {}).find((key) => POWER_BI_SOURCE.test(key));
  if (name) return name;
  const references = readAppConfig(appDir)?.config.connectionReferences;
  const referenced = Object.values(references && typeof references === 'object' ? references : {}).some(
    (ref) => typeof ref?.id === 'string' && /(?:^|\/)(?:shared_)?powerbi$/i.test(ref.id),
  );
  return referenced ? '' : undefined;
}

/**
 * The Power BI query actions in the app's generated definitions. Undefined when they can't be read.
 * @param {string} appDir
 * @returns {string[] | undefined}
 */
export function queryActions(appDir) {
  const sources = readDataSources(appDir);
  if (!sources) return undefined;
  return Object.entries(sources)
    .filter(([name]) => POWER_BI_SOURCE.test(name))
    .flatMap(([, source]) => Object.keys(source?.apis && typeof source.apis === 'object' ? source.apis : {}))
    .filter((action) => QUERY_ACTION.test(action));
}

/**
 * generated/dataSources.ts, which the CLI writes as `export default <JSON>;`.
 * @param {string} appDir
 * @returns {Record<string, any> | undefined}
 */
function readDataSources(appDir) {
  try {
    const text = readFileSync(join(appDir, DATA_SOURCES), 'utf8');
    const marker = 'export default ';
    const at = text.indexOf(marker);
    if (at < 0) return undefined;
    const value = JSON.parse(text.slice(at + marker.length).trimEnd().replace(/;$/, ''));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Keeps files' bytes, to put them back exactly. It writes only those that changed.
 * @param {string} dir
 * @param {string[]} names
 */
export function keepFiles(dir, names) {
  const kept = names.map((name) => {
    const file = join(dir, name);
    return { file, bytes: existsSync(file) ? readFileSync(file) : undefined };
  });
  return {
    restore() {
      for (const { file, bytes } of kept) {
        if (!bytes) continue;
        const now = existsSync(file) ? readFileSync(file) : undefined;
        if (!now || !now.equals(bytes)) writeFileSync(file, bytes);
      }
    },
  };
}

/** @param {unknown} list */
function textsOf(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => (typeof item === 'string' ? item : typeof item?.message === 'string' ? item.message : JSON.stringify(item)))
    .filter(Boolean);
}
