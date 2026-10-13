// @ts-check
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SCRIPT_NAME, ZIP_NAME, installScript, scriptCommand, scriptSha256, zipUrl } from '../packaging/script.js';
import { CLOUD_SHELL_SHIM, SCRIPT_COMMAND, SCRIPT_SHIM, SCRIPT_URL } from '../src/launch.js';
import { REPO } from '../src/update-check.js';

const TEMPLATE = readFileSync(fileURLToPath(new URL('../packaging/launcher/install.ps1', import.meta.url)), 'utf8');
const HASH = '748ed2f139d14f8babdabea867a809c4fe6da12ef9da3d07ecd93dba616224db';
const V = { version: '1.2.3', sha256: HASH.toUpperCase(), id: '1.2.3-748ed2f139', repo: 'octo/hub', sizeMb: 151.6, commit: 'D793F32'.padEnd(40, 'A'), nodeVersion: '24.11.1' };

test('script: fills in every placeholder', () => {
  const s = installScript(TEMPLATE, V);
  assert.doesNotMatch(s, /\{\{/);
  assert.equal(scriptSha256(s), HASH);
  assert.match(s, /^\s*\$Version = '1\.2\.3'$/m);
  assert.match(s, /^\s*\$Id = '1\.2\.3-748ed2f139'$/m);
  assert.ok(s.includes(`$ZipUrl = 'https://github.com/octo/hub/releases/download/installer-v1.2.3/${ZIP_NAME}'`));
  assert.match(s, /^\s*\$SizeMb = '152'$/m);
  assert.ok(s.includes('irm https://github.com/octo/hub/releases/latest/download/install.ps1 | iex'));
  assert.match(s, /^\s*\$Commit = 'd793f32a{33}'$/m);
  assert.match(s, /^\s*\$NodeVersion = '24\.11\.1'$/m);
  assert.ok(s.includes("$RepoUrl = 'https://github.com/octo/hub.git'"));
});

test('script: is plain ASCII with Windows line endings, for Windows PowerShell 5.1', () => {
  const s = installScript(TEMPLATE, V);
  assert.ok([...s].every((ch) => ch.charCodeAt(0) < 0x7f));
  assert.doesNotMatch(s, /[^\r]\n/);
  assert.throws(() => installScript(`${TEMPLATE}\n# caf\u00e9`, V), /plain ASCII/);
});

test('script: refuses values that would break out of a PowerShell string', () => {
  assert.throws(() => installScript(TEMPLATE, { ...V, sha256: 'abc' }), /isn't a SHA-256/);
  assert.throws(() => installScript(TEMPLATE, { ...V, version: "1'; rm -r ~; '" }), /letters, digits/);
  assert.throws(() => installScript(TEMPLATE, { ...V, repo: 'octo/hub/../x' }), /owner\/name/);
  assert.throws(() => installScript(TEMPLATE, { ...V, commit: 'd793f32' }), /full commit ID/);
  assert.throws(() => installScript(TEMPLATE, { ...V, commit: "main'; rm -r ~; '".padEnd(40, 'a') }), /full commit ID/);
  assert.throws(() => installScript(TEMPLATE, { ...V, nodeVersion: '24' }), /Node\.js version/);
  assert.throws(() => installScript('{{NOPE}}', V), /unknown placeholder \{\{NOPE\}\}/);
});

test('script: the whole launcher runs in a script block, so iex leaves nothing behind in the session', () => {
  const body = TEMPLATE.replace(/^<#[\s\S]*?#>\s*/, '');
  assert.match(body, /^& \{/);
  assert.match(body, /\} @args\r?\nif \(\$MyInvocation\.MyCommand\.Path -and \$LASTEXITCODE\) \{ exit \$LASTEXITCODE \}\r?\n$/);
  assert.doesNotMatch(TEMPLATE, /\bparam\s*\(/i, 'a param block would bind installer commands such as "status" as launcher options');
  assert.match(TEMPLATE, /ANALYTICS_HUB_LAUNCHER=pwsh/);
  assert.match(TEMPLATE, /ANALYTICS_HUB_LAUNCHER = 'pwsh'/);
});

test('script: commands and URLs agree between the launcher and the installer', () => {
  assert.equal(SCRIPT_NAME, 'install.ps1');
  assert.equal(scriptCommand(REPO), SCRIPT_COMMAND);
  assert.equal(SCRIPT_URL, `https://github.com/${REPO}/releases/latest/download/install.ps1`);
  assert.equal(scriptCommand('octo/hub', '1.2.3'), 'irm https://github.com/octo/hub/releases/download/installer-v1.2.3/install.ps1 | iex');
  assert.equal(zipUrl('octo/hub', '1.2.3'), 'https://github.com/octo/hub/releases/download/installer-v1.2.3/AnalyticsHubInstaller.zip');
  assert.ok(TEMPLATE.includes("Join-Path $AhHome 'analytics-hub.cmd'"));
  assert.equal(SCRIPT_SHIM, '& $env:LOCALAPPDATA\\AnalyticsHub\\analytics-hub.cmd');
});

test('script: in Azure Cloud Shell, gets the pinned commit and runs the installer in the terminal', () => {
  const cloud = TEMPLATE.slice(TEMPLATE.indexOf('if ($CloudShell) {'), TEMPLATE.indexOf("if ($env:OS -ne 'Windows_NT')"));
  assert.ok(cloud.length > 1000, 'the Cloud Shell branch comes before the Windows-only check');
  assert.match(cloud, /\$env:ANALYTICS_HUB_LAUNCHER = 'cloudshell'/);
  assert.match(cloud, /export ANALYTICS_HUB_LAUNCHER=cloudshell/);
  assert.match(cloud, /fetch --quiet --depth 1 \$RepoUrl \$Commit/);
  assert.match(cloud, /rev-parse HEAD[\s\S]*\$head -ne \$Commit/, 'checks it got the commit it asked for');
  assert.match(cloud, /npm ci --omit=dev/);
  assert.match(cloud, /SHASUMS256\.txt[\s\S]*Get-FileHash[\s\S]*\$got -ne \$want/, 'checks the Node.js it downloads');
  assert.doesNotMatch(cloud, /--ui/, 'Cloud Shell has no browser for the wizard');
  assert.ok(cloud.includes("$AhHome = Join-Path $HOME '.analytics-hub'") && cloud.includes("$Shim = Join-Path $AhHome 'analytics-hub'"));
  assert.equal(CLOUD_SHELL_SHIM, '~/.analytics-hub/analytics-hub');
});