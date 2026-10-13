// @ts-check
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SCRIPT_NAME, ZIP_NAME, installScript, scriptCommand, scriptSha256, zipUrl } from '../packaging/script.js';
import { SCRIPT_COMMAND, SCRIPT_SHIM, SCRIPT_URL } from '../src/launch.js';
import { REPO } from '../src/update-check.js';

const TEMPLATE = readFileSync(fileURLToPath(new URL('../packaging/launcher/install.ps1', import.meta.url)), 'utf8');
const HASH = '748ed2f139d14f8babdabea867a809c4fe6da12ef9da3d07ecd93dba616224db';
const V = { version: '1.2.3', sha256: HASH.toUpperCase(), id: '1.2.3-748ed2f139', repo: 'octo/hub', sizeMb: 151.6 };

test('script: fills in every placeholder', () => {
  const s = installScript(TEMPLATE, V);
  assert.doesNotMatch(s, /\{\{/);
  assert.equal(scriptSha256(s), HASH);
  assert.match(s, /^\s*\$Version = '1\.2\.3'$/m);
  assert.match(s, /^\s*\$Id = '1\.2\.3-748ed2f139'$/m);
  assert.ok(s.includes(`$ZipUrl = 'https://github.com/octo/hub/releases/download/installer-v1.2.3/${ZIP_NAME}'`));
  assert.match(s, /^\s*\$SizeMb = '152'$/m);
  assert.ok(s.includes('irm https://github.com/octo/hub/releases/latest/download/install.ps1 | iex'));
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
