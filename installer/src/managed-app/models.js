// @ts-check
/**
 * Which semantic models the managed app reads, and the managed-app.config.json that names them. The IDs
 * come from that file when it's filled in, else from an install record (from either target), else from
 * links pasted one by one. The record's rules mirror the installer's: modelDeployed and the two below it
 * in steps/fabric.js, and azureSemanticModels in steps/azure/index.js.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isGuid } from './links.js';

/** The config the managed build reads (app/src/lib/managed/managed-config.ts). Gitignored. */
export const CONFIG_FILE = 'managed-app.config.json';
/** The installer's record. The EXE keeps it in Documents\Analytics Hub; a run from this repo, in installer/. */
export const INSTALL_RECORD_FILE = 'valuelens-install.json';
export const INSTALL_FOLDER = 'Analytics Hub';
/** The group the installer gives Build on the models. Matches VIEWER_GROUP_NAME in steps/access.js. */
export const VIEWER_GROUP = 'Analytics Hub Viewers';

/** @typedef {import('./links.js').ModelRef} ModelRef */
/** @typedef {'vl' | 'cc' | 'ae'} ModelAlias */
/** @typedef {Partial<Record<ModelAlias, ModelRef>>} Models */

/**
 * The models by the alias the pages use. Only the Analytics Hub Model is required: the others each add
 * pages, which stay hidden without them.
 * @type {readonly { alias: ModelAlias, name: string, required: boolean }[]}
 */
export const MODELS = [
  { alias: 'vl', name: 'Analytics Hub Model', required: true },
  { alias: 'cc', name: 'Consumption Central model', required: false },
  { alias: 'ae', name: 'Agent Evaluator model', required: false },
];

const USER_SHELL_FOLDERS = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders';
const SHELL_FOLDERS = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders';

/**
 * The models an install published, from its record: the Analytics Hub, Consumption and Agent Evaluator
 * models on Fabric, and the first two on Azure, which has no Agent Evaluator.
 * @param {any} record
 * @returns {Models}
 */
export function modelsFromRecord(record) {
  if (!record || typeof record !== 'object') return {};
  if (record.target === 'azure') {
    const pbi = record.azure?.powerBi ?? {};
    return only({ vl: ref(pbi.workspaceId, pbi.datasetId), cc: ref(pbi.workspaceId, pbi.consumptionDatasetId), ae: undefined });
  }
  const workspaceId = record.fabric?.workspaceId;
  const model = record.semanticModel;
  if (!(model?.enabled && model.id && model.bound)) return {};
  const consumption = record.consumption?.model;
  const evaluator = record.agentEvaluator?.model;
  return only({
    vl: ref(workspaceId, model.id),
    cc: record.modules?.consumption && consumption?.id && consumption.bound ? ref(workspaceId, consumption.id) : undefined,
    ae: record.modules?.agentEvaluator && evaluator?.id && evaluator.bound ? ref(workspaceId, evaluator.id) : undefined,
  });
}

/**
 * The viewer group the installer set up, when the record has one.
 * @param {any} record
 * @returns {{ id: string, name: string } | undefined}
 */
export function groupFromRecord(record) {
  const access = record?.access;
  return isGuid(access?.groupId) ? { id: access.groupId, name: access.groupName || VIEWER_GROUP } : undefined;
}

/**
 * The models the record says the viewer group has no Build on. Empty when it can't tell.
 * @param {any} record
 * @param {Models} models
 * @returns {string[]}  The models' names.
 */
export function modelsWithoutBuild(record, models) {
  const granted = record?.access?.grantedModels;
  if (!Array.isArray(granted)) return [];
  const have = new Set(granted.map((id) => String(id).toLowerCase()));
  return MODELS.filter(({ alias }) => {
    const model = models[alias];
    return model && !have.has(model.itemId.toLowerCase());
  }).map(({ name }) => name);
}

/**
 * The models with real IDs, when the Analytics Hub Model has them. Others without, such as the example's
 * placeholders, are left out, as the app leaves them out: their pages stay hidden. Otherwise undefined.
 * @param {unknown} semanticModels
 * @returns {Models | undefined}
 */
export function validModels(semanticModels) {
  if (!semanticModels || typeof semanticModels !== 'object' || Array.isArray(semanticModels)) return undefined;
  const given = /** @type {Record<string, any>} */ (semanticModels);
  const models = only({
    vl: ref(given.vl?.workspaceId, given.vl?.itemId),
    cc: ref(given.cc?.workspaceId, given.cc?.itemId),
    ae: ref(given.ae?.workspaceId, given.ae?.itemId),
  });
  return models.vl ? models : undefined;
}

/**
 * @typedef {{ state: 'missing' }
 *   | { state: 'invalid', error: string }
 *   | { state: 'unfilled', body: Record<string, unknown> }
 *   | { state: 'ready', body: Record<string, unknown>, models: Models }} ModelConfig
 */

/**
 * What managed-app.config.json holds. "unfilled" is valid JSON without a real Analytics Hub Model, such
 * as a copy of the example file; its other blocks are kept when the models are written.
 * @param {string} file
 * @returns {ModelConfig}
 */
export function readModelConfig(file) {
  /** @type {string} */
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return { state: 'missing' };
    return { state: 'invalid', error: /** @type {Error} */ (err).message };
  }
  /** @type {unknown} */
  let body;
  try {
    body = JSON.parse(stripBom(text));
  } catch (err) {
    return { state: 'invalid', error: /** @type {Error} */ (err).message };
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { state: 'invalid', error: 'It must be a JSON object.' };
  const record = /** @type {Record<string, unknown>} */ (body);
  const models = validModels(record.semanticModels);
  return models ? { state: 'ready', body: record, models } : { state: 'unfilled', body: record };
}

/**
 * Writes the models into managed-app.config.json, replacing its semanticModels and keeping its other blocks.
 * @param {string} file
 * @param {Models} models
 * @param {Record<string, unknown>} [body]  What the file held, if anything.
 */
export function writeModelConfig(file, models, body = {}) {
  writeFileSync(file, `${JSON.stringify({ ...body, semanticModels: models }, null, 2)}\n`);
}

/**
 * @typedef {object} RecordSearch
 * @property {NodeJS.Platform} [platform]
 * @property {NodeJS.ProcessEnv} [env]
 * @property {string} [home]
 * @property {string} [repoRoot]  This repo's folder, for an install run from it.
 * @property {(key: string) => string | undefined} [readRegistry]  The Personal (Documents) value under that registry key.
 * @property {(file: string) => number | undefined} [modified]  When the file last changed, in ms. Undefined when it doesn't exist.
 * @property {(file: string) => string} [read]
 */

/**
 * Finds the newest install record. Documents may be moved, for example to OneDrive, so it looks where
 * Windows says Documents is, as the EXE's launcher does, and in the usual places.
 * @param {RecordSearch} [search]
 * @returns {{ path: string, record: any } | undefined}
 */
export function findInstallRecord({
  platform = process.platform,
  env = process.env,
  home = homedir(),
  repoRoot,
  readRegistry = registryDocuments,
  modified = changedAt,
  read = (file) => readFileSync(file, 'utf8'),
} = {}) {
  const files = new Set([
    ...documentsFolders(platform, env, home, readRegistry).map((dir) => join(dir, INSTALL_FOLDER, INSTALL_RECORD_FILE)),
    ...(repoRoot ? [join(repoRoot, 'installer', INSTALL_RECORD_FILE)] : []),
  ]);
  /** @type {{ path: string, at: number }[]} */
  const found = [];
  for (const path of files) {
    const at = modified(path);
    if (at !== undefined) found.push({ path, at });
  }
  found.sort((a, b) => b.at - a.at);
  for (const { path } of found) {
    try {
      const record = JSON.parse(stripBom(read(path)));
      if (record && typeof record === 'object' && !Array.isArray(record)) return { path, record };
    } catch {
      // Not a record: try the next.
    }
  }
  return undefined;
}

/**
 * @param {NodeJS.Platform} platform
 * @param {NodeJS.ProcessEnv} env
 * @param {string} home
 * @param {(key: string) => string | undefined} readRegistry
 */
function documentsFolders(platform, env, home, readRegistry) {
  if (platform !== 'win32') return [join(home, 'Documents')];
  /** @type {string[]} */
  const dirs = [];
  for (const key of [USER_SHELL_FOLDERS, SHELL_FOLDERS]) {
    const value = readRegistry(key);
    if (value) dirs.push(expandEnv(value, env));
  }
  for (const oneDrive of [env.OneDriveCommercial, env.OneDrive]) {
    if (oneDrive) dirs.push(join(oneDrive, 'Documents'));
  }
  dirs.push(join(env.USERPROFILE || home, 'Documents'));
  return dirs;
}

/**
 * Windows' %NAME% variables, case-insensitively, as the registry stores Documents.
 * @param {string} value
 * @param {NodeJS.ProcessEnv} env
 */
export function expandEnv(value, env) {
  return value.replace(/%([^%]+)%/g, (whole, name) => {
    const key = Object.keys(env).find((k) => k.toLowerCase() === String(name).toLowerCase());
    return key && env[key] ? /** @type {string} */ (env[key]) : whole;
  });
}

/** @param {string} key */
function registryDocuments(key) {
  try {
    const out = execFileSync('reg', ['query', key, '/v', 'Personal'], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    });
    return /Personal\s+REG_(?:EXPAND_)?SZ\s+(.+)/i.exec(out)?.[1]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** @param {string} file */
function changedAt(file) {
  try {
    const stat = statSync(file);
    return stat.isFile() ? stat.mtimeMs : undefined;
  } catch {
    return undefined;
  }
}

/** @param {string} text */
export const stripBom = (text) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

/**
 * @param {unknown} workspaceId
 * @param {unknown} itemId
 * @returns {ModelRef | undefined}
 */
function ref(workspaceId, itemId) {
  return isGuid(workspaceId) && isGuid(itemId) ? { workspaceId, itemId } : undefined;
}

/**
 * @param {Record<ModelAlias, ModelRef | undefined>} models
 * @returns {Models}
 */
function only(models) {
  /** @type {Models} */
  const out = {};
  for (const { alias } of MODELS) {
    const model = models[alias];
    if (model) out[alias] = model;
  }
  return out;
}
