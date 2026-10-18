// @ts-check
/**
 * Remembers the app a by-hand run deployed, so running it again from a fresh download updates that app
 * instead of making another. It keeps a copy of the app's local files in a folder per user, apart from
 * the installer's, so neither route overwrites the other's app. None of the files hold secrets: the
 * app's ID and environment, the Power BI connector's generated definitions, and the models' IDs.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { stripBom } from './models.js';

export const STATE_FOLDER = 'AnalyticsHub-ManagedApp';
const STATE_FILE = 'state.json';
const FILES_FOLDER = 'files';

/** What `ms app init` and `ms app add data-source` write in app, and the models. */
export const APP_FILES = ['ms.config.json', 'generated', '.ms', 'managed-app.config.json'];
/** The files that make the folder an app. The models stay, so a new app reads the same ones. */
const APP_IDENTITY = ['ms.config.json', 'generated', '.ms'];

/**
 * @typedef {object} SavedApp
 * @property {string} appId
 * @property {string} environmentId
 * @property {string} [displayName]
 * @property {string} [deployedAt]
 * @property {string} [playUrl]
 * @property {string} [sharedAt]  When it shared the app, or you chose no one, so a re-run doesn't ask again.
 * @property {string} [savedAt]
 */

/**
 * The per-user folder: %LOCALAPPDATA%\AnalyticsHub-ManagedApp on Windows. It's beside
 * %LOCALAPPDATA%\AnalyticsHub, not in it: the exe and install.ps1 delete every folder there but their own.
 * @param {{ platform?: NodeJS.Platform, env?: NodeJS.ProcessEnv, home?: string }} [where]
 */
export function stateDir({ platform = process.platform, env = process.env, home = homedir() } = {}) {
  if (platform === 'win32') return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), STATE_FOLDER);
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', STATE_FOLDER);
  return join(env.XDG_DATA_HOME || join(home, '.local', 'share'), STATE_FOLDER);
}

/**
 * The app saved there, or undefined.
 * @param {string} dir
 * @returns {SavedApp | undefined}
 */
export function readSaved(dir) {
  try {
    const saved = JSON.parse(stripBom(readFileSync(join(dir, STATE_FILE), 'utf8')));
    if (saved?.version === 1 && typeof saved.appId === 'string' && saved.appId && typeof saved.environmentId === 'string') {
      const { version: _version, ...app } = saved;
      return app;
    }
  } catch {
    // Nothing saved, or unreadable: treat both as nothing saved.
  }
  return undefined;
}

/**
 * Copies the app's files there, replacing what was saved, and records the app. What it knew about the
 * same app is kept, such as when it was deployed.
 * @param {string} appDir
 * @param {string} dir
 * @param {Partial<SavedApp> & { appId: string, environmentId: string }} app
 * @param {Date} [now]
 */
export function saveState(appDir, dir, app, now = new Date()) {
  const files = join(dir, FILES_FOLDER);
  mkdirSync(files, { recursive: true });
  for (const name of APP_FILES) {
    const to = join(files, name);
    rmSync(to, { recursive: true, force: true });
    const from = join(appDir, name);
    if (existsSync(from)) cpSync(from, to, { recursive: true });
  }
  const previous = readSaved(dir);
  const merged = { ...(previous?.appId === app.appId ? previous : {}), ...defined(app) };
  writeFileSync(join(dir, STATE_FILE), `${JSON.stringify({ version: 1, ...merged, savedAt: now.toISOString() }, null, 2)}\n`);
}

/**
 * Copies the saved files into app, skipping any already there.
 * @param {string} appDir
 * @param {string} dir
 * @returns {string[]}  What it copied.
 */
export function restoreState(appDir, dir) {
  /** @type {string[]} */
  const restored = [];
  for (const name of APP_FILES) {
    const from = join(dir, FILES_FOLDER, name);
    const to = join(appDir, name);
    if (!existsSync(from) || existsSync(to)) continue;
    cpSync(from, to, { recursive: true });
    restored.push(name);
  }
  return restored;
}

/** @param {string} dir */
export function clearState(dir) {
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Removes the app's identity from app, keeping managed-app.config.json.
 * @param {string} appDir
 */
export function clearAppFiles(appDir) {
  for (const name of APP_IDENTITY) rmSync(join(appDir, name), { recursive: true, force: true });
}

/**
 * @template {Record<string, unknown>} T
 * @param {T} value
 * @returns {Partial<T>}
 */
function defined(value) {
  return /** @type {Partial<T>} */ (Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)));
}
