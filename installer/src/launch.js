// @ts-check
/** How the installer was started, so messages name the command people actually run. */
import { REPO } from './update-check.js';

/** Set by AnalyticsHubInstaller.exe, which runs the installer with the Node.js it carries. */
export const EXE_ENV = 'ANALYTICS_HUB_EXE';
export const EXE_NAME = 'AnalyticsHubInstaller.exe';
/**
 * Set by install.ps1 and the command it leaves behind: `pwsh` on Windows, where they run the same
 * download as the exe, and `cloudshell` in Azure Cloud Shell, where they run the release's source.
 */
export const LAUNCHER_ENV = 'ANALYTICS_HUB_LAUNCHER';
/** The PowerShell one-liner that downloads and starts the latest installer. */
export const SCRIPT_URL = `https://github.com/${REPO}/releases/latest/download/install.ps1`;
export const SCRIPT_COMMAND = `irm ${SCRIPT_URL} | iex`;
/** The command install.ps1 leaves behind, as typed in PowerShell. */
export const SCRIPT_SHIM = '& $env:LOCALAPPDATA\\AnalyticsHub\\analytics-hub.cmd';
/** The command install.ps1 leaves behind in Azure Cloud Shell, for Bash or PowerShell. */
export const CLOUD_SHELL_SHIM = '~/.analytics-hub/analytics-hub';
/** `1` makes the installer and install.ps1 treat this shell as Azure Cloud Shell, `0` as not. */
export const CLOUD_SHELL_ENV = 'ANALYTICS_HUB_CLOUD_SHELL';

/**
 * Whether this runs in Azure Cloud Shell, which has no browser, signs in with a code, and ends a
 * session after 20 minutes without input.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function inCloudShell(env = process.env) {
  if (env[CLOUD_SHELL_ENV] === '1') return true;
  if (env[CLOUD_SHELL_ENV] === '0') return false;
  return env[LAUNCHER_ENV] === 'cloudshell' || /^cloud-shell/i.test(env.AZUREPS_HOST_ENVIRONMENT ?? '') || !!env.ACC_CLOUD;
}

/**
 * How the installer was started: the downloaded exe, the PowerShell launcher on Windows or in
 * Azure Cloud Shell, or Node.js from a clone.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {'exe' | 'pwsh' | 'cloudshell' | 'node'}
 */
export function launcher(env = process.env) {
  if (env[EXE_ENV] === '1') return 'exe';
  if (env[LAUNCHER_ENV] === 'pwsh') return 'pwsh';
  if (env[LAUNCHER_ENV] === 'cloudshell') return 'cloudshell';
  return 'node';
}

/**
 * Whether the installer was started from the downloaded exe.
 * @param {NodeJS.ProcessEnv} [env]
 */
export const fromExe = (env = process.env) => launcher(env) === 'exe';

/**
 * Whether the installer runs from the release download on Windows, with its own Node.js and the
 * app already built: through the exe or the PowerShell launcher.
 * @param {NodeJS.ProcessEnv} [env]
 */
export const bundled = (env = process.env) => ['exe', 'pwsh'].includes(launcher(env));

/**
 * The command to run the installer with, optionally followed by its arguments.
 * @param {string} [args]
 * @param {NodeJS.ProcessEnv} [env]
 */
export function commandLine(args = '', env = process.env) {
  const how = launcher(env);
  const name = how === 'exe' ? EXE_NAME : how === 'pwsh' ? SCRIPT_SHIM : how === 'cloudshell' ? CLOUD_SHELL_SHIM : 'valuelens-install';
  return args ? `${name} ${args}` : name;
}

/**
 * Where the installer prints its messages and the wizard link.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function installerWindow(env = process.env) {
  const how = launcher(env);
  return how === 'exe' ? 'the installer window' : how === 'pwsh' ? 'the PowerShell window' : how === 'cloudshell' ? 'Cloud Shell' : 'your terminal';
}

/**
 * How to start the installer again once it has stopped.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function reopenHint(env = process.env) {
  const how = launcher(env);
  if (how === 'exe') return `To open it again, run ${EXE_NAME}.`;
  if (how === 'pwsh') return `To open it again, run ${SCRIPT_SHIM} in PowerShell, or the install command again.`;
  if (how === 'cloudshell') return `To run it again, run ${CLOUD_SHELL_SHIM} in Cloud Shell.`;
  return 'To open it again, run valuelens-install --ui in your terminal.';
}

/**
 * How to get a newer installer, after "Installer x.y.z is available."
 * @param {string} url  The release page.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function updateHint(url, env = process.env) {
  const how = launcher(env);
  if (how === 'cloudshell') return `Run "${SCRIPT_COMMAND}" again in Cloud Shell's PowerShell, then install to repair or change.`;
  return how === 'pwsh'
    ? `Close the installer and run "${SCRIPT_COMMAND}" again in PowerShell, then choose Repair or change.`
    : `Download it from ${url}, then choose Repair or change.`;
}
