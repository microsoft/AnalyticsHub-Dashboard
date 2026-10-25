// @ts-check
// The hand-off pack: an index for the person running the installer, and a file for each admin to send as it is.
// Rendering and writing first, then the places a run writes it, each in a temp folder. Each admin's asks are in
// handoff.test.js and done-requests.test.js; the refusal in ensure-app.test.js; the Azure script in azure-apps.test.js.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { graphRolesCommand } from '../src/admin-commands.js';
import { emptyConfig } from '../src/config.js';
import { HttpError } from '../src/http.js';
import { rotateSecret, showPrereqs, summary } from '../src/install.js';
import { commandLine } from '../src/launch.js';
import { checkPrereqs, reportFlowPrereqs, reportPreflight, settingsToConfirm } from '../src/prereqs.js';
import { ADMIN_PACK_DIR, ADMIN_PACK_FILE, messageMarkdown, packFileName, renderAdminPack, writeAdminPackFiles } from '../src/steps/admin-pack.js';
import { azureSummary } from '../src/steps/azure/index.js';
import { ADMINS } from '../src/steps/handoff.js';
import { adminPack, handoffCommands, isResumeLater, secretHandoff, startHandoffPack, writeAdminPack, writeHandoffPack } from '../src/steps/identity.js';
import { letter } from '../src/steps/next-steps.js';
import { planAdminPack } from '../src/steps/plan.js';
import { fakeCtx, fakeFabric, fakeUi } from './fakes.js';

/** @typedef {import('../src/config.js').InstallConfig} InstallConfig */
/** @typedef {import('../src/steps/handoff.js').AdminRequest} AdminRequest */
/** @typedef {import('../src/steps/handoff.js').AdminKey} AdminKey */
/** @typedef {import('../src/steps/admin-pack.js').PackInput} PackInput */

const USER = { id: 'user-1', upn: 'analyst@contoso.com', tenantId: 't-1' };
const FROM = USER.upn;
const AT = new Date('2026-06-01T12:34:56Z');
const KEYS = Object.keys(ADMINS);
const PREFLIGHT = 'The installer checked the prerequisites before it changed anything.';
const APP_ADMIN = { roleTemplateId: '9b895d92-2cd3-44c7-9d02-a6ac2d5ea5c3', displayName: 'Application Administrator' };
/** Data checks whose identity match shows names, or conceals them. */
const SHOWN = { identity: { licensed: 10, audit: 5, matched: 10, masked: 0 } };
const HIDDEN = { identity: { licensed: 10, audit: 5, matched: 1, masked: 9 } };

/** @type {string[]} */
const dirs = [];
/** A temp folder for an install record, removed after the tests. */
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-admin-pack-'));
  dirs.push(dir);
  return dir;
};
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * A request, as adminRequests writes one.
 * @param {AdminKey} admin @param {string[]} asks @param {Partial<AdminRequest>} [more]
 * @returns {AdminRequest}
 */
const request = (admin, asks, more = {}) => ({
  admin,
  who: ADMINS[admin],
  rows: [],
  asks,
  message: letter([`I'm installing Analytics Hub, and I need your help with ${asks.length === 1 ? 'this' : 'these'}:`, '', ...asks.map((a) => `- ${a}`)], FROM),
  ...more,
});

const LICENCE = request('licence', ['Assign me a Power BI Pro licence (Premium Per User works too), to publish the Analytics Hub reports.'], {
  rows: ['Power BI Pro or Premium Per User licence'],
});
const APP = request('app-admin', ['Register the app Analytics Hub uses to collect data, in Microsoft Entra.'], {
  rows: ['Register apps in Entra'],
  notes: ['Check the app\'s name first.'],
  after: ['Run the installer again.'],
  back: ['The app\'s Application (client) ID.'],
});

/** @param {Partial<PackInput>} [o] @returns {PackInput} */
const input = (o = {}) => ({ admins: ADMINS, requests: [LICENCE, APP], by: 'install', at: AT, why: ['Something happened.'], from: FROM, resume: commandLine('install'), ...o });

/**
 * The pack in dir: the index, if any, and each file in its folder, by name.
 * @param {string} dir
 */
const readPack = (dir) => {
  const folder = join(dir, ADMIN_PACK_DIR);
  const names = existsSync(folder) ? readdirSync(folder).sort() : [];
  const index = join(dir, ADMIN_PACK_FILE);
  return {
    index: existsSync(index) ? readFileSync(index, 'utf8') : '',
    names,
    /** @type {Record<string, string>} */
    files: Object.fromEntries(names.map((n) => [n, readFileSync(join(folder, n), 'utf8')])),
  };
};

/**
 * Puts a value in every field of the record that holds a secret, a key ID or a token.
 * @param {InstallConfig} config
 */
const plant = (config) => {
  const c = /** @type {any} */ (config);
  Object.assign(c.app, {
    secretKeyId: 'PLANTED-key-id',
    pendingSecretKeyIds: ['PLANTED-pending-key'],
    retiredSecretKeyIds: ['PLANTED-retired-key'],
    secretAttempts: [{ ref: 'PLANTED-ref', at: '2026-06-01T12:00:00Z' }],
    clientSecret: 'PLANTED-client-secret',
  });
  Object.assign(c.keyVault, { secretKeyId: 'PLANTED-vault-key', previousSecretKeyIds: ['PLANTED-previous-key'] });
  Object.assign(c.semanticModel, { secretKeyId: 'PLANTED-model-key', pendingSecretKeyIds: ['PLANTED-model-pending'] });
  c.setup = { completed: [], uploads: [{ name: 'x', token: 'PLANTED-upload-token' }] };
  if (c.target === 'azure') {
    c.azure.webApp = { ...c.azure.webApp, clientSecret: 'PLANTED-web-secret', secretKeyId: 'PLANTED-web-key' };
    c.azure.sqlReader = { ...c.azure.sqlReader, secretKeyId: 'PLANTED-sql-key', pendingSecretKeyIds: ['PLANTED-sql-pending'] };
  }
  return config;
};

/**
 * No file in the pack has a client secret, a key, a token, a password or a sign-in code. The app admin's script
 * names the client secret and reads it with --query password, and their file says how to send its value, so those
 * words can be there; a value can't.
 * @param {string} dir
 */
const noSecrets = (dir) => {
  const { index, files } = readPack(dir);
  assert.ok(index, 'a pack was written');
  for (const [name, text] of Object.entries({ [ADMIN_PACK_FILE]: index, ...files })) {
    assert.doesNotMatch(text, /PLANTED/, `${name}: nothing from the record's secret fields`);
    assert.doesNotMatch(text, /eyJ[\w-]+\.[\w-]+/, `${name}: no token`);
    assert.doesNotMatch(text, /[\w~.-]{3}8Q~[\w~.-]{30,}/, `${name}: no client secret`);
    assert.doesNotMatch(text, /\b(passcode|sign-in code|device code|user code|bearer|access token|refresh token|api key)\b/i, name);
    assert.doesNotMatch(text, /--value\s+(?!"\$\()/, `${name}: a secret goes into a vault only from the command that makes it`);
    assert.doesNotMatch(text, /\b(password|secret)\s*[:=]\s*\S/i, `${name}: no secret value`);
  }
};

/** A Fabric install's choices, with nothing on that needs a flow. */
const plainConfig = () => {
  const config = emptyConfig();
  Object.assign(config.dataSources, { productFeedback: 'csv', studioCredits: 'csv', resourceGraph: 'off' });
  config.modules.agentEvaluator = false;
  config.modules.consumption = false;
  config.semanticModel.enabled = false;
  return config;
};

/** Copilot Studio credits from the API, which needs the flows, in the Sales environment. @param {InstallConfig} config */
const chooseFlows = (config) => {
  config.dataSources.studioCredits = 'api';
  config.uploads = { flowEnvironment: { url: 'https://org1.crm.dynamics.com', id: 'env-1', name: 'Sales' } };
};

/**
 * A tenant where you have no admin role, and Fabric's tenant settings can't be read.
 * @param {{ canRegister?: boolean, roles?: any[] }} [o]
 */
const noRoles = (o = {}) => ({
  graph: {
    myDirectoryRoles: async () => o.roles ?? [],
    myEligibleRoles: async () => [],
    myGroupIds: async () => ['group-1'],
    myDirectGroupIds: async () => ['group-1'],
    myLicenseDetails: async () => [],
    subscribedSkus: async () => [],
    usersCanRegisterApps: async () => !!o.canRegister,
  },
  arm: {
    listSubscriptions: async () => [{ subscriptionId: 'sub-1', displayName: 'Production', state: 'Enabled' }],
    permissions: async () => [{ actions: ['*/read'], notActions: [] }],
    myRoleAssignments: async () => [],
    myEligibleRoles: async () => [],
    getVault: async () => ({ name: 'kv' }),
    resourceGraph: async () => ({ data: [] }),
  },
  fabric: {
    listCapacities: async () => [],
    listWorkspaces: async () => [],
    getWorkspace: async () => {
      throw new HttpError('404 Not Found', { method: 'GET', url: 'x', status: 404 });
    },
    tenantSettings: async () => {
      throw new HttpError('401 Unauthorized', { method: 'GET', url: 'x', status: 401 });
    },
  },
  discovery: { instances: async () => [] },
});

/** @param {InstallConfig} config @param {Parameters<typeof noRoles>[0]} [o] */
const check = (config, o) => checkPrereqs({ api: /** @type {any} */ (noRoles(o)), user: USER, config });

/**
 * What a run's ctx gives the pack, with the install record in dir.
 * @param {import('../src/ui.js').Ui} ui @param {InstallConfig} config @param {string} dir
 * @returns {any}
 */
const packCtx = (ui, config, dir) => ({ ui, config, user: USER, configFile: join(dir, 'valuelens-install.json'), now: () => AT, save() {} });

/** An index's "Who gets what" lines, one per file. @param {string} index */
const entries = (index) => index.match(/^\d+\. .*$/gm) ?? [];

test('renderAdminPack: the index says who gets which file, with what to do before and after, and how to carry on; each admin\'s file is their request', () => {
  const pack = renderAdminPack(input({ notes: ['A note for you.'] }));
  assert.equal(pack.index.name, ADMIN_PACK_FILE);
  assert.deepEqual(pack.files.map((f) => [f.key, f.who, f.name]), [
    ['app-admin', ADMINS['app-admin'], 'app-admin.md'],
    ['licence', ADMINS.licence, 'licence.md'],
  ], 'in the order of ADMINS');
  assert.equal(
    pack.index.text,
    [
      '# Analytics Hub: your admin pack',
      '',
      'Written by an install on 2026-06-01 at 12:34 UTC.',
      '',
      'Something happened.',
      '',
      'Send each admin their own file, from the analytics-hub-admin-pack folder next to this one, as it is. It says what to do, with the exact names of the settings and roles, and any commands to run. Nothing in it is secret.',
      '',
      '## Who gets what',
      '',
      '1. An Application Administrator or Cloud Application Administrator: [analytics-hub-admin-pack/app-admin.md](analytics-hub-admin-pack/app-admin.md)',
      '   - For: Register apps in Entra',
      '   - Before you send it: Check the app\'s name first.',
      '   - Once it\'s done: Run the installer again.',
      '2. Your licence admin: [analytics-hub-admin-pack/licence.md](analytics-hub-admin-pack/licence.md)',
      '   - For: Power BI Pro or Premium Per User licence',
      '',
      'A note for you.',
      '',
      '## Carry on',
      '',
      'Once your admins have done their part, run the installer again. It picks up where it stopped:',
      '',
      '```',
      commandLine('install'),
      '```',
      '',
    ].join('\n'),
  );
  assert.equal(
    pack.files[0].text,
    [
      '# Analytics Hub: a request for your help',
      '',
      '- **To:** An Application Administrator or Cloud Application Administrator',
      '- **For:** Register apps in Entra',
      '',
      'Hi,',
      '',
      'I\'m installing Analytics Hub, and I need your help with this:',
      '',
      '- Register the app Analytics Hub uses to collect data, in Microsoft Entra.',
      '',
      'Thanks',
      FROM,
      '',
      '## What to send back',
      '',
      '- The app\'s Application (client) ID.',
      '',
      '## What happens next',
      '',
      `Once it's done, tell ${FROM}. When they run the installer again, it picks up what you did.`,
      '',
    ].join('\n'),
  );
  assert.ok(pack.files[0].text.includes(APP.message), 'the message as letter() signs it');
  assert.doesNotMatch(pack.files.map((f) => f.text).join('\n'), /valuelens-install|Before you send it|Once it's done:/, 'the command to carry on, and your notes, are in the index only');
});

test('renderAdminPack: what wrote it, a finished install, optional requests, extras for an admin\'s own request, and nothing waiting', () => {
  const index = (/** @type {Partial<PackInput>} */ o) => renderAdminPack(input(o)).index.text;
  assert.match(index({ by: 'prereqs' }), /\nWritten by the prerequisites check on 2026-06-01 at 12:34 UTC\.\n/);
  assert.ok(index({ by: 'prereqs' }).includes(`Once your admins have done their part, run the installer:\n\n\`\`\`\n${commandLine('install')}\n\`\`\``));
  assert.match(index({ by: 'repair' }), /\nWritten by a Repair on /);
  assert.match(index({ by: 'update', resume: commandLine('update') }), /\nWritten by an update on [^]*\n```\n.*update\n```\n$/);
  assert.match(index({ why: [] }), /^# Analytics Hub: your admin pack\n\nWritten by an install on 2026-06-01 at 12:34 UTC\.\n\nSend each admin/);

  const done = renderAdminPack(input({ done: true, resume: undefined }));
  assert.ok(done.index.text.endsWith('## Carry on\n\nOnce an admin has done their part, do what its "Once it\'s done" line says, if it has one.\n'));
  assert.doesNotMatch(done.index.text, /```/, 'nothing to run');
  assert.ok(done.files[1].text.endsWith(`## What happens next\n\nOnce it's done, tell ${FROM}.\n`), 'no run to pick it up');

  const anon = renderAdminPack(input({ from: undefined }));
  assert.ok(anon.files[1].text.endsWith('Once it\'s done, tell the person who sent you this. When they run the installer again, it picks up what you did.\n'));

  const optional = renderAdminPack(input({ requests: [{ ...LICENCE, optional: true, rows: [] }] }));
  assert.ok(optional.index.text.includes('\n1. Your licence admin (optional): [analytics-hub-admin-pack/licence.md](analytics-hub-admin-pack/licence.md)\n\n## Carry on'), 'no For line without rows');
  assert.ok(optional.files[0].text.startsWith('# Analytics Hub: a request for your help\n\n- **To:** Your licence admin\n- **Optional:** Analytics Hub works without it.\n\nHi,'));

  // Extras go to the admin's own request, not to one with its own addressee, and replace what it sends back and what
  // happens next.
  const own = { ...LICENCE, who: 'The licence admin for Sales', back: ['Its name.'] };
  const extras = renderAdminPack(
    input({ requests: [{ ...LICENCE, back: ['Its name.'] }, own], extras: { licence: { sections: ['## More', '', 'Details.'], sendBack: ['A thing.'], next: ['Something next.'] } } }),
  );
  assert.deepEqual(extras.files.map((f) => f.name), ['licence.md', 'licence-the-licence-admin-for-sales.md']);
  assert.ok(extras.files[0].text.endsWith(`Thanks\n${FROM}\n\n## More\n\nDetails.\n\n## What to send back\n\n- A thing.\n\n## What happens next\n\nSomething next.\n`));
  assert.ok(extras.files[1].text.endsWith(`Thanks\n${FROM}\n\n## What to send back\n\n- Its name.\n\n## What happens next\n\nOnce it's done, tell ${FROM}. When they run the installer again, it picks up what you did.\n`));
  assert.ok(extras.index.text.includes('2. The licence admin for Sales: [analytics-hub-admin-pack/licence-the-licence-admin-for-sales.md]'));

  const odd = renderAdminPack(input({ requests: [/** @type {any} */ ({ ...LICENCE, admin: 'nobody', who: 'Someone' }), LICENCE] }));
  assert.deepEqual(odd.files.map((f) => f.name), ['licence.md', 'nobody-someone.md'], 'an admin ADMINS doesn\'t know goes last');

  const none = renderAdminPack(input({ requests: [], why: ['The install finished.'] }));
  assert.deepEqual(none.files, []);
  assert.equal(none.index.text, '# Analytics Hub: your admin pack\n\nWritten by an install on 2026-06-01 at 12:34 UTC.\n\nThe install finished.\n\nNothing is waiting on an admin.\n');
});

test('packFileName: the admin\'s key, with a short slug of who it goes to when that isn\'t ADMINS\' name, and never two the same', () => {
  /** @type {Set<string>} */
  const used = new Set();
  const name = (/** @type {string} */ admin, /** @type {string} */ who) => packFileName(/** @type {any} */ ({ admin, who }), ADMINS, used);
  assert.equal(name('app-admin', ADMINS['app-admin']), 'app-admin.md');
  assert.equal(name('power-platform', 'A System Administrator of Sales Europe1 West'), 'power-platform-a-system-administrator-of-sales-europe1.md', 'cut at 40 characters, with no hyphen left at the end');
  assert.equal(name('power-platform', 'A System Administrator of Sales'), 'power-platform-a-system-administrator-of-sales.md');
  assert.equal(name('power-platform', 'A SYSTEM Administrator of Sales!'), 'power-platform-a-system-administrator-of-sales-2.md', 'the same slug twice');
  assert.equal(name('teams', '..\\..\\Windows/System32'), 'teams-windows-system32.md', 'letters, digits and hyphens only');
  assert.equal(name('other', ADMINS.other), 'other.md');
  assert.equal(name('other', '!!!'), 'other-2.md', 'no slug left');
  assert.equal(name('other', 'Ünïcode'), 'other-n-code.md');
});

test('messageMarkdown: the commands after an ask\'s "(Bash):" go in a bash code block; the rest stays as it is', () => {
  const message = [
    'Hi,',
    '',
    'Run this in Azure Cloud Shell (Bash):',
    '',
    '- Give the roles. In Azure Cloud Shell (Bash):',
    '  az one',
    '    az two',
    '- Then this:',
    '  1. A step.',
    '  2. Another (Bash):',
    '  az three',
    '',
    '- Last (Bash):',
    '',
    'Thanks',
  ].join('\n');
  assert.deepEqual(messageMarkdown(message), [
    'Hi,',
    '',
    'Run this in Azure Cloud Shell (Bash):',
    '',
    '- Give the roles. In Azure Cloud Shell (Bash):',
    '  ```bash',
    '  az one',
    '  az two',
    '  ```',
    '- Then this:',
    '  1. A step.',
    '  2. Another (Bash):',
    '  ```bash',
    '  az three',
    '  ```',
    '',
    '- Last (Bash):',
    '',
    'Thanks',
  ]);
  assert.deepEqual(messageMarkdown('- One (Bash):\n  az one'), ['- One (Bash):', '  ```bash', '  az one', '  ```'], 'closed at the end');
});

test('writeAdminPackFiles: writes the index and a file per admin, rewrites only what changed, and removes only the admins\' files no longer needed', () => {
  const dir = tmp();
  const folder = join(dir, ADMIN_PACK_DIR);
  const pack = renderAdminPack(input());
  assert.deepEqual(writeAdminPackFiles(dir, pack, KEYS), {
    index: join(dir, ADMIN_PACK_FILE),
    files: [
      { who: ADMINS['app-admin'], path: join(folder, 'app-admin.md') },
      { who: ADMINS.licence, path: join(folder, 'licence.md') },
    ],
    changed: true,
    written: true,
  });
  const read = readPack(dir);
  assert.equal(read.index, pack.index.text);
  assert.deepEqual(read.files, { 'app-admin.md': pack.files[0].text, 'licence.md': pack.files[1].text });
  assert.equal(writeAdminPackFiles(dir, pack, KEYS).changed, false, 'the same pack again');

  // Your own files stay; an admin's file from an earlier write goes, with or without a slug.
  for (const name of ['notes.md', 'app-admin.txt', 'app-admin (copy).md', 'power-platform-a-system-administrator-of-sales.md']) writeFileSync(join(folder, name), 'x');
  const less = writeAdminPackFiles(dir, renderAdminPack(input({ requests: [LICENCE] })), KEYS);
  assert.equal(less.changed, true);
  assert.deepEqual(readPack(dir).names, ['app-admin (copy).md', 'app-admin.txt', 'licence.md', 'notes.md']);

  // Nothing left: the index says so, and the folder stays with your files in it.
  const none = writeAdminPackFiles(dir, renderAdminPack(input({ requests: [] })), KEYS);
  assert.deepEqual(none, { index: join(dir, ADMIN_PACK_FILE), files: [], changed: true, written: true });
  assert.deepEqual(readPack(dir).names, ['app-admin (copy).md', 'app-admin.txt', 'notes.md']);
  assert.match(readPack(dir).index, /\n\nNothing is waiting on an admin\.\n$/);

  const emptied = tmp();
  writeAdminPackFiles(emptied, renderAdminPack(input()), KEYS);
  writeAdminPackFiles(emptied, renderAdminPack(input({ requests: [] })), KEYS);
  assert.deepEqual(readdirSync(join(emptied, ADMIN_PACK_DIR)), [], 'an emptied folder stays');

  // Nothing needed and no index yet: nothing written, not even the folder.
  const fresh = tmp();
  assert.deepEqual(writeAdminPackFiles(fresh, renderAdminPack(input({ requests: [] })), KEYS), { index: join(fresh, ADMIN_PACK_FILE), files: [], changed: false, written: false });
  assert.deepEqual(readdirSync(fresh), []);
  // A folder left without its index is left alone too.
  const orphan = tmp();
  mkdirSync(join(orphan, ADMIN_PACK_DIR));
  writeFileSync(join(orphan, ADMIN_PACK_DIR, 'licence.md'), 'x');
  assert.equal(writeAdminPackFiles(orphan, renderAdminPack(input({ requests: [] })), KEYS).written, false);
  assert.deepEqual(readdirSync(join(orphan, ADMIN_PACK_DIR)), ['licence.md']);
});

test('pack, prerequisites check: a file per admin with the exact setting and role names, an index that says what wrote it, and the paths after the requests', async () => {
  const dir = tmp();
  const t = fakeUi();
  const config = plant(plainConfig());
  config.semanticModel.enabled = true;
  config.access = /** @type {any} */ ({ rls: { enabled: true } });
  const ctx = { ...packCtx(t.ui, config, dir), api: noRoles() };
  await showPrereqs(ctx);
  const { index, names, files } = readPack(dir);
  assert.deepEqual(names, ['app-admin.md', 'capacity-admin.md', 'compliance.md', 'fabric-admin.md', 'licence.md', 'role-admin.md']);
  assert.ok(index.startsWith('# Analytics Hub: your admin pack\n\nWritten by the prerequisites check on 2026-06-01 at 12:34 UTC.\n\nIt changes nothing in your tenant: it lists what an admin needs to do before you install.\n'));
  assert.deepEqual(entries(index), [
    '1. An Application Administrator or Cloud Application Administrator: [analytics-hub-admin-pack/app-admin.md](analytics-hub-admin-pack/app-admin.md)',
    '2. A Privileged Role Administrator or Global Administrator: [analytics-hub-admin-pack/role-admin.md](analytics-hub-admin-pack/role-admin.md)',
    '3. A Fabric administrator: [analytics-hub-admin-pack/fabric-admin.md](analytics-hub-admin-pack/fabric-admin.md)',
    '4. A Fabric capacity admin: [analytics-hub-admin-pack/capacity-admin.md](analytics-hub-admin-pack/capacity-admin.md)',
    '5. A Compliance Administrator: [analytics-hub-admin-pack/compliance.md](analytics-hub-admin-pack/compliance.md)',
    '6. Your licence admin: [analytics-hub-admin-pack/licence.md](analytics-hub-admin-pack/licence.md)',
  ]);
  assert.ok(index.includes('\n   - For: Global Administrator or Privileged Role Administrator; Audit log access for Copilot interactions (AuditLogsQuery.Read.All)\n'));
  assert.ok(index.includes('To have an admin register the app for you, choose "An admin will register the app for me" when the installer asks about the app. It adds the Cloud Shell script and portal steps to analytics-hub-admin-pack/app-admin.md.'));
  assert.ok(index.endsWith(`Once your admins have done their part, run the installer:\n\n\`\`\`\n${commandLine('install')}\n\`\`\`\n`));
  const settings = settingsToConfirm(config);
  assert.equal(settings.length, 7);
  assert.ok(files['fabric-admin.md'].includes(`turn on any that are off: ${settings.join('; ')}. They're in Fabric under Admin portal > Tenant settings: https://learn.microsoft.com/fabric/admin/tenant-settings-index`));
  assert.ok(files['capacity-admin.md'].includes('- Set the XMLA endpoint to Read Write on the Fabric capacity Analytics Hub\'s workspace uses.'));
  assert.ok(files['compliance.md'].includes('Microsoft Purview > Audit, and turn it on if it isn\'t: https://purview.microsoft.com/audit/auditsearch'));
  assert.ok(files['app-admin.md'].includes('I\'ll send you the installer\'s Cloud Shell script and portal steps for it, which say what to send back.'), 'no pack is waiting yet');
  for (const [name, text] of Object.entries(files)) {
    assert.ok(text.startsWith('# Analytics Hub: a request for your help\n\n- **To:** '), name);
    assert.ok(text.includes(`\nThanks\n${FROM}\n`), name);
    assert.ok(text.endsWith(`## What happens next\n\nOnce it's done, tell ${FROM}. When they run the installer again, it picks up what you did.\n`), name);
  }
  noSecrets(dir);

  const out = t.text();
  const start = out.indexOf(`\n  Admin pack, a file for each admin to send as it is. Start here: ${join(dir, ADMIN_PACK_FILE)}\n`);
  assert.ok(start > out.indexOf('Requests for your admins'), 'after the requests it goes with');
  for (const name of names) assert.ok(out.includes(`\n     ${ADMINS[/** @type {AdminKey} */ (name.slice(0, -3))]}: ${join(dir, ADMIN_PACK_DIR, name)}\n`), name);
});

test('pack, preflight: written before a --yes run stops, so the stopped run leaves it', async () => {
  const dir = tmp();
  const t = fakeUi({ yes: true });
  const config = plant(plainConfig());
  const ctx = packCtx(t.ui, config, dir);
  startHandoffPack(ctx, 'install');
  const items = await check(config);
  assert.throws(() => reportPreflight(ctx, items), /with --yes the installer can't create its app registration/);
  const { index, names, files } = readPack(dir);
  assert.deepEqual(names, ['app-admin.md', 'compliance.md', 'licence.md', 'role-admin.md']);
  assert.ok(index.includes(`Written by an install on 2026-06-01 at 12:34 UTC.\n\n${PREFLIGHT}\n`));
  assert.ok(index.endsWith(`It picks up where it stopped:\n\n\`\`\`\n${commandLine('install')}\n\`\`\`\n`));
  assert.ok(files['app-admin.md'].includes('- **For:** Register apps in Entra'));
  assert.ok(t.text().indexOf('Admin pack, a file for each admin') < t.text().indexOf('Stopped before creating anything'));
  noSecrets(dir);
});

test('pack, preflight then the flows: the flows\' requests merge with preflight\'s, and a write that changes nothing prints nothing', async () => {
  const dir = tmp();
  const t = fakeUi();
  const config = plant(plainConfig());
  const ctx = packCtx(t.ui, config, dir);
  startHandoffPack(ctx, 'install');
  reportPreflight(ctx, await check(config));
  assert.deepEqual(readPack(dir).names, ['app-admin.md', 'compliance.md', 'licence.md', 'role-admin.md']);

  chooseFlows(config);
  reportFlowPrereqs(ctx);
  const pack = readPack(dir);
  assert.deepEqual(pack.names, ['app-admin.md', 'compliance.md', 'licence.md', 'power-platform.md', 'role-admin.md'], 'preflight\'s files stay');
  assert.ok(pack.index.includes(`${PREFLIGHT}\nOnce you chose the flows, it checked what they need too.\n`));
  assert.match(pack.files['licence.md'], /\n- \*\*For:\*\* Power BI Pro or Premium Per User licence; Power Automate Premium[^\n]*\n/, 'one request each, merged');
  assert.match(pack.files['power-platform.md'], /\n- \*\*For:\*\* Power Platform Administrator[^\n]*; Data policy\n/);
  assert.ok(pack.files['app-admin.md'], 'preflight\'s request stays');
  noSecrets(dir);

  const before = t.text();
  reportFlowPrereqs(ctx);
  assert.equal(t.text(), before, 'nothing new to say');
  assert.deepEqual(readPack(dir), pack);
});

test('pack, the plan\'s admin pack: the app admin\'s file gets the script, the portal steps and who can do it, with preflight\'s and the flows\' requests', async () => {
  const dir = tmp();
  const t = fakeUi({ yes: true });
  const config = plant(plainConfig());
  const ctx = packCtx(t.ui, config, dir);
  startHandoffPack(ctx, 'install');
  reportPreflight(ctx, await check(config, { canRegister: true }));
  assert.deepEqual(readPack(dir).names, ['compliance.md', 'licence.md', 'role-admin.md'], 'you can register apps, so preflight had no app admin request');
  chooseFlows(config);
  reportFlowPrereqs(ctx);

  await assert.rejects(planAdminPack(ctx, { canConsent: false }), (err) => isResumeLater(err));
  assert.equal(config.app.adminPack, join(dir, ADMIN_PACK_FILE), 'the record keeps the index\'s path');
  const { index, names, files } = readPack(dir);
  assert.deepEqual(names, ['app-admin.md', 'compliance.md', 'licence.md', 'power-platform.md', 'role-admin.md']);
  const app = files['app-admin.md'];
  assert.ok(app.includes('\n- **For:** Register apps in Entra\n'));
  assert.ok(app.includes('- Register the app Analytics Hub uses to collect data, in Microsoft Entra. The installer\'s Cloud Shell script and portal steps for it are in app-admin.md, from its admin pack, with what to send back.'));
  assert.ok(app.includes('\n## Who can do it\n\nRegistering the app needs an Application Administrator or Cloud Application Administrator, or anyone who can register apps:\n'));
  assert.ok(app.includes(['## Azure Cloud Shell (Bash)', '', '```bash', ...adminPack(ctx).script, '```'].join('\n')), 'the script, as adminPack builds it');
  assert.ok(app.includes(['## Or in the portal', '', ...adminPack(ctx).checklist.map((s, i) => `${i + 1}. ${s}`)].join('\n')));
  assert.ok(app.includes('\n## What to send back\n\n- The app\'s Application (client) ID.\n- The client secret\'s value, through a secure channel: never by plain email or chat.\n'));
  assert.ok(app.endsWith(`## What happens next\n\nOnce ${FROM} has the client ID, they run the installer again and enter it, and the install carries on.\n`));
  assert.ok(index.includes(`${PREFLIGHT}\nOnce you chose the flows, it checked what they need too.\nYou chose "An admin will register the app for me", so an Application Administrator or Cloud Application Administrator registers it for you, with the script and portal steps in their file.\n`));
  assert.ok(index.includes('\n   - Once it\'s done: Run the installer again, choose "An admin will register the app for me", and enter the client ID they send you.\n'));
  assert.doesNotMatch(index, /To have an admin register the app for you/, 'you already chose it');
  noSecrets(dir);
});

test('pack, an earlier pack: the record\'s adminPack, even from before the pack was split, makes registering the app a hand-off; once the app is registered, nothing waits on the app admin', async () => {
  const dir = tmp();
  const old = join(dir, ADMIN_PACK_FILE);
  writeFileSync(old, '# Analytics Hub: register the app\n\nRun this in Azure Cloud Shell (Bash):\n\n    APP_ID=$(az ad app create ...)\n');
  const t = fakeUi();
  const config = plant(plainConfig());
  Object.assign(config.app, { adminPack: old, existing: true });
  const items = await check(config, { canRegister: true, roles: [APP_ADMIN] });
  assert.equal(items.find((it) => it.id === 'register-apps')?.status, 'handoff', 'whatever your role or the tenant setting seems to allow');
  const ctx = packCtx(t.ui, config, dir);
  startHandoffPack(ctx, 'install');
  reportPreflight(ctx, items);
  let pack = readPack(dir);
  assert.match(pack.index, /^# Analytics Hub: your admin pack\n/, 'the old pack is now the index');
  assert.ok(pack.names.includes('app-admin.md'));
  assert.match(pack.files['app-admin.md'], /az ad app create --display-name "Analytics Hub Data Collector"/);
  assert.ok(pack.index.includes('\n   - Once it\'s done: Run the installer again, choose "An admin will register the app for me", and enter the client ID they send you.\n'));
  assert.equal(config.app.adminPack, old, 'the record keeps it');
  noSecrets(dir);

  config.app.appId = 'app-1';
  const registered = await check(config, { canRegister: true, roles: [APP_ADMIN] });
  assert.equal(registered.find((it) => it.id === 'register-apps')?.status, 'met');
  startHandoffPack(ctx, 'install');
  reportPreflight(ctx, registered);
  pack = readPack(dir);
  assert.ok(!pack.names.includes('app-admin.md'), 'nothing pending');
  assert.doesNotMatch(pack.index, /app-admin\.md/);
  assert.equal(config.app.adminPack, old, 'S7d never clears it');

  // A run with nothing to ask turns the index into "nothing waiting".
  startHandoffPack(ctx, 'install');
  writeHandoffPack(ctx, { asked: [], all: registered, why: PREFLIGHT });
  pack = readPack(dir);
  assert.deepEqual(pack.names, []);
  assert.ok(pack.index.endsWith(`${PREFLIGHT}\n\nNothing is waiting on an admin.\n`));
});

test('pack, the end of a Repair: what it left replaces preflight\'s files, with no command to carry on; with nothing left, nothing is waiting', async () => {
  const dir = tmp();
  const fake = fakeUi();
  const config = emptyConfig();
  Object.assign(config.app, { appId: 'app-1', servicePrincipalId: 'sp-1' });
  Object.assign(config.dataSources, { resourceGraph: 'skip', productFeedback: 'csv', studioCredits: 'csv' });
  config.modules.consumption = false;
  config.modules.agentEvaluator = false;
  const t = fakeCtx({ ui: fake.ui, fabric: fakeFabric().api, oneLake: { readJson: async () => null }, graph: { myDirectoryRoles: async () => [] }, config: plant(config) });
  t.config.fabric.workspaceName = 'Analytics Hub';
  t.ctx.configFile = join(dir, 'valuelens-install.json');
  startHandoffPack(t.ctx, 'repair');
  const rows = await check(plainConfig());
  writeHandoffPack(t.ctx, { asked: rows.filter((it) => ['power-bi-pro', 'fabric-capacity'].includes(it.id)), all: rows, why: PREFLIGHT });
  assert.deepEqual(readPack(dir).names, ['capacity-admin.md', 'licence.md']);

  await summary(t.ctx, { dataCheck: HIDDEN });
  let pack = readPack(dir);
  assert.deepEqual(pack.names, ['global-admin.md']);
  assert.ok(pack.index.startsWith('# Analytics Hub: your admin pack\n\nWritten by a Repair on 2026-06-01 at 12:00 UTC.\n\nThe Repair finished. This is what it left for an admin.\n\n'));
  assert.doesNotMatch(pack.index, /checked the prerequisites|```/, 'the end replaces what came before, and there\'s nothing to run');
  assert.deepEqual(entries(pack.index), ['1. A Global Administrator: [analytics-hub-admin-pack/global-admin.md](analytics-hub-admin-pack/global-admin.md)']);
  assert.ok(pack.index.endsWith('Once an admin has done their part, do what its "Once it\'s done" line says, if it has one.\n'));
  const ga = pack.files['global-admin.md'];
  assert.ok(ga.includes('\n- **For:** Concealed names\n'));
  assert.ok(ga.includes('I\'ve installed Analytics Hub, and I need your help with this:'));
  assert.ok(ga.endsWith('## What happens next\n\nOnce it\'s done, tell admin@contoso.com.\n'));
  assert.ok(fake.text().lastIndexOf('Admin pack, a file for each admin') > fake.text().indexOf('Still to do by your admins'), 'after the requests it goes with');
  noSecrets(dir);

  await summary(t.ctx, { dataCheck: SHOWN });
  pack = readPack(dir);
  assert.deepEqual(pack.names, []);
  assert.ok(pack.index.endsWith('Written by a Repair on 2026-06-01 at 12:00 UTC.\n\nThe Repair finished.\n\nNothing is waiting on an admin.\n'));
  assert.match(fake.text(), /\n {2}Admin pack: nothing is waiting on an admin\. .*analytics-hub-admin-pack\.md\n/);
});

test('pack, the end of an install: it keeps preflight\'s and the flows\' asks that a finished install doesn\'t settle, and drops the rest', async () => {
  const dir = tmp();
  const fake = fakeUi();
  const config = plant(plainConfig());
  config.semanticModel.enabled = true;
  // Preflight runs before the install registers the app, or makes the workspace and its items.
  const items = await check(config);
  const t = fakeCtx({ ui: fake.ui, fabric: fakeFabric().api, oneLake: { readJson: async () => null }, graph: { myDirectoryRoles: async () => [] }, config });
  const { appId } = t.config.app;
  const { workspaceId, lakehouseId } = t.config.fabric;
  t.config.app.appId = undefined;
  Object.assign(t.config.fabric, { workspaceId: undefined, lakehouseId: undefined, workspaceName: 'Analytics Hub' });
  t.ctx.configFile = join(dir, 'valuelens-install.json');
  startHandoffPack(t.ctx, 'install');
  reportPreflight(t.ctx, items);
  chooseFlows(t.config);
  reportFlowPrereqs(t.ctx);
  let pack = readPack(dir);
  assert.deepEqual(pack.names, ['app-admin.md', 'azure-owner.md', 'compliance.md', 'fabric-admin.md', 'licence.md', 'power-platform.md', 'role-admin.md']);
  assert.match(
    pack.files['fabric-admin.md'],
    /: "Create workspaces" .*; "Users can create Fabric items"; "Service principals can call Fabric public APIs"; "Semantic Model Execute Queries REST API"; the Fabric apps setting, under "Fabric apps \(preview\)"; "Allow visuals created using the Power BI SDK"\. They're in Fabric/,
    'before the plan, every setting it might need',
  );
  assert.match(pack.files['licence.md'], /\n- \*\*For:\*\* Power BI Pro or Premium Per User licence; Power Automate Premium licence\n/);
  assert.match(pack.files['power-platform.md'], /\n- \*\*For:\*\* Power Platform Administrator; Power Platform environments, System Administrator in each; Data policy\n/);
  noSecrets(dir);

  t.config.app.appId = appId;
  Object.assign(t.config.fabric, { workspaceId, lakehouseId, pipelineId: 'pl-1' });
  await summary(t.ctx, { dataCheck: SHOWN });
  pack = readPack(dir);
  assert.deepEqual(pack.names, ['compliance.md', 'fabric-admin.md', 'licence.md', 'power-platform.md'], 'the app, the vault\'s access and consent are settled, or asked for from the record');
  assert.ok(pack.index.startsWith('# Analytics Hub: your admin pack\n\nWritten by an install on 2026-06-01 at 12:00 UTC.\n\nThe install finished. This is what it left for an admin.\n\n'));
  const whos = ['fabric-admin', 'compliance', 'power-platform', 'licence'].map((k) => ADMINS[/** @type {AdminKey} */ (k)]);
  assert.deepEqual(entries(pack.index).map((e) => e.replace(/^\d+\. (.*): \[.*$/, '$1')), whos);
  const out = fake.text();
  const done = out.slice(out.lastIndexOf('Still to do by your admins'), out.lastIndexOf('Admin pack, a file for each admin'));
  assert.deepEqual(done.match(/^ {2}\d+\. .*$/gm)?.map((l) => l.replace(/^ {2}\d+\. /, '')), whos, 'the terminal lists the same requests');

  assert.ok(pack.index.includes(`\n   - Once it's done: If they turned it on, new records take from 60 minutes to 24 hours to appear. Then run "${commandLine('check-audit')}" to test it.\n`));
  assert.ok(pack.index.includes(`\n   - Once it's done: Run "${commandLine('update')}": it saves any flow the policy turned down, and turns on each flow that's off once its connections are signed in.\n`));
  assert.ok(pack.index.includes(`\n   - Once it's done: Run "${commandLine('update')}": it turns on each flow that's off, once its connections are signed in.\n`));
  const { files } = pack;
  assert.ok(files['compliance.md'].includes('\n- **For:** Audit logging in Microsoft Purview\n'));
  assert.ok(files['compliance.md'].includes('- Check that audit logging is on in Microsoft Purview > Audit, and turn it on if it isn\'t: '));
  assert.ok(
    files['fabric-admin.md'].includes(': "Service principals can call Fabric public APIs". They\'re in Fabric under Admin portal > Tenant settings'),
    'the workspace and its items prove two, and the plan chose neither the app nor the reports',
  );
  assert.ok(files['licence.md'].includes('\n- **For:** Power Automate Premium licence\n'), 'the Power BI licence is settled');
  assert.ok(files['power-platform.md'].includes('\n- **For:** Data policy\n'), 'the environment is settled, and its connections are yours to sign in');
  for (const [name, text] of Object.entries(files)) assert.ok(text.includes('\nI\'ve installed Analytics Hub, and I need your help with this:\n'), name);
  noSecrets(dir);
});

test('pack, the end of an Azure install: a Graph role repeated in graphRoles.pending shows once, preflight\'s Purview ask is kept, and an update writes nothing', async () => {
  const dir = tmp();
  const fake = fakeUi();
  const config = emptyConfig();
  Object.assign(config.app, { appId: 'app-1', servicePrincipalId: 'sp-1' });
  Object.assign(config.dataSources, { resourceGraph: 'skip', productFeedback: 'csv', studioCredits: 'csv' });
  config.modules.consumption = false;
  config.modules.agentEvaluator = false;
  config.target = 'azure';
  config.azure = /** @type {any} */ ({
    ...config.azure,
    resourceGroup: 'rg-ah',
    location: 'uksouth',
    outputs: { identityPrincipalId: 'mi-1', identityClientId: 'mi-client-1', identityId: 'id-1' },
    graphRoles: { assigned: ['User.Read.All'], pending: ['AuditLogsQuery.Read.All', 'User.Read.All', 'Reports.Read.All', 'AuditLogsQuery.Read.All'] },
  });
  const t = fakeCtx({ ui: fake.ui, graph: { myDirectoryRoles: async () => [] }, config: plant(config) });
  t.ctx.configFile = join(dir, 'valuelens-install.json');

  startHandoffPack(t.ctx, 'update');
  await azureSummary(t.ctx, { update: true });
  assert.deepEqual(readdirSync(dir), [], 'an update has no end refresh');

  startHandoffPack(t.ctx, 'install');
  // Preflight asked for audit logging in Microsoft Purview, which nothing at the end proves is on.
  writeHandoffPack(t.ctx, { asked: [{ id: 'audit-ingestion', label: 'Audit log access', neededFor: 'x', howTo: 'x', detail: '', status: 'handoff' }], why: PREFLIGHT });
  await azureSummary(t.ctx);
  const { index, files } = readPack(dir);
  assert.ok(files['compliance.md'].includes('\n- Check that audit logging is on in Microsoft Purview > Audit, and turn it on if it isn\'t: '));
  assert.match(index, /\n\d+\. A Compliance Administrator: \[[^\n]*\n {3}- For: Audit logging in Microsoft Purview\n(?! {3}- Once)/, 'Azure has no audit check to run afterwards');
  const roles = files['role-admin.md'];
  const command = graphRolesCommand('mi-1', ['AuditLogsQuery.Read.All', 'Reports.Read.All']);
  assert.ok(
    roles.includes(`these Microsoft Graph application permissions: AuditLogsQuery.Read.All, Reports.Read.All. In Azure Cloud Shell (Bash):\n  \`\`\`bash\n  ${command}\n  \`\`\`\n`),
    roles,
  );
  assert.equal(roles.split('AuditLogsQuery.Read.All').length - 1, 2, 'once in the ask, once in the command');
  assert.doesNotMatch(roles, /User\.Read\.All/, 'none already assigned');
  noSecrets(dir);
});

test('pack, a failed write: where the pack isn\'t the only way on, it warns once and the run carries on; writeAdminPack still throws', async () => {
  const dir = tmp();
  mkdirSync(join(dir, ADMIN_PACK_FILE));
  const t = fakeUi();
  const config = plainConfig();
  const ctx = packCtx(t.ui, config, dir);
  startHandoffPack(ctx, 'install');
  const items = await check(config);
  reportPreflight(ctx, items);
  chooseFlows(config);
  reportFlowPrereqs(ctx);
  const warned = t.text().match(/Couldn't write the admin pack in [^\n]*The requests above are still yours to send\./g) ?? [];
  assert.equal(warned.length, 1, t.text());
  assert.ok(warned[0].startsWith(`Couldn't write the admin pack in ${dir}: `));
  assert.doesNotMatch(t.text(), /Admin pack, a file for each admin/);
  assert.throws(() => writeAdminPack(ctx));
});

test('pack, no install record: a write keeps the requests for later and writes nothing, here or in the working folder', async () => {
  const dir = tmp();
  const t = fakeUi();
  const config = plainConfig();
  const ctx = /** @type {any} */ ({ ui: t.ui, config, user: USER, file: join(dir, 'valuelens-install.json'), now: () => AT, save() {} });
  startHandoffPack(ctx, 'install');
  const items = await check(config);
  reportPreflight(ctx, items);
  assert.equal(writeHandoffPack(ctx, { asked: items.filter((it) => it.id === 'power-bi-pro'), all: items }), undefined);
  assert.deepEqual(readdirSync(dir), []);
  assert.ok(!existsSync(join(process.cwd(), ADMIN_PACK_FILE)));
  assert.ok(ctx.handoffPack.asked.has('register-apps') && ctx.handoffPack.asked.has('power-bi-pro'), 'kept for a later write');
  assert.doesNotMatch(t.text(), /Admin pack/);
});

/** A Fabric install whose client secret a vault admin adds, to a private vault with Azure RBAC that you can't read. */
const vaultConfig = () => {
  const config = plant(plainConfig());
  Object.assign(config.app, { appId: 'app-1', objectId: 'obj-1', servicePrincipalId: 'sp-1', existing: false });
  Object.assign(config.keyVault, {
    existing: false,
    name: 'kv-ah',
    id: '/subscriptions/sub-1/resourceGroups/rg-ah/providers/Microsoft.KeyVault/vaults/kv-ah',
    uri: 'https://kv-ah.vault.azure.net/',
    secretName: 'ah-client-secret',
    mode: 'keyvault-admin',
    rbac: true,
    private: true,
    handoff: { grantRead: true },
  });
  return config;
};
const VAULT_ENTRY = '1. A Key Vault admin: [analytics-hub-admin-pack/vault-admin.md](analytics-hub-admin-pack/vault-admin.md)';
const ADDED = 'When it asks "Has the admin added the secret?", choose "Yes, carry on".';
/** What happens next in the vault admin's file, when the installer isn't waiting for them. @param {string} from */
const VAULT_NEXT = (from) =>
  `\n## What happens next\n\nOnce it's done, tell ${from}. Analytics Hub can't load its data until the secret is there.\nThe installer never sees the secret's value.\n`;

test('pack, a vault admin: the steps for the client secret are their own file, written before the installer asks whether they\'ve done it', async () => {
  const dir = tmp();
  const t = fakeUi({ answers: [''] });
  /** @type {string[]} */
  let before = [];
  /** @type {any} */ (t.ui).select = async (/** @type {string} */ message) => {
    t.asked.push(message);
    before = readPack(dir).names;
    return 'stop';
  };
  const config = vaultConfig();
  const ctx = packCtx(t.ui, config, dir);
  startHandoffPack(ctx, 'install');
  await assert.rejects(secretHandoff(ctx), (err) => isResumeLater(err));
  assert.equal(t.asked.at(-1), 'Has the admin added the secret?');
  assert.deepEqual(before, ['vault-admin.md']);
  const { index, names, files } = readPack(dir);
  assert.deepEqual(names, ['vault-admin.md']);
  const file = files['vault-admin.md'];
  assert.ok(
    file.startsWith(
      '# Analytics Hub: a request for your help\n\n- **To:** A Key Vault admin\n- **For:** Client secret in Key Vault\n\n' +
        'Hi,\n\nI\'m installing Analytics Hub, and I need your help with this:\n\n' +
        '- Create a client secret for the app "Analytics Hub Data Collector" (application ID app-1), and add it to the Key Vault kv-ah as a secret named ah-client-secret.\n',
    ),
    file,
  );
  for (const line of [
    `The vault in the Azure portal: https://portal.azure.com/#@t-1/resource${config.keyVault.id}/secrets`,
    'Also give me (analyst@contoso.com) Key Vault Secrets User on kv-ah, so scheduled runs can read it.',
    'Creating the secret needs an owner of the app, or an Application Administrator or Cloud Application Administrator. Adding it to kv-ah needs Key Vault Secrets Officer.',
    'kv-ah blocks public network access, so do this from a network that can reach the vault.',
    '1. App registrations > Analytics Hub Data Collector > Certificates & secrets > New client secret.',
    '2. Copy its Value into kv-ah > Secrets > Generate/Import, with the name ah-client-secret.',
    '3. In kv-ah > Access control (IAM) > Add role assignment, give me (analyst@contoso.com) Key Vault Secrets User.',
  ])
    assert.ok(file.includes(`\n  ${line}\n`), line);
  const commands = handoffCommands(config, { userId: USER.id });
  assert.equal(commands.length, 2, 'your read access, then the secret');
  assert.ok(file.includes(`\n  In Azure Cloud Shell (Bash):\n  \`\`\`bash\n${commands.map((l) => `  ${l}\n`).join('')}  \`\`\`\n`), 'the commands the console shows, to paste');
  assert.ok(file.endsWith('\n## What happens next\n\nOnce it\'s done, tell analyst@contoso.com, and the installer carries on.\nThe installer never sees the secret\'s value.\n'), file);
  assert.ok(!file.includes(commandLine('install')), 'the command to carry on is yours');
  assert.ok(index.includes('\n\nA vault admin needs to add the app\'s client secret in kv-ah, with the steps in their file. The installer never sees its value.\n\n'), index);
  assert.deepEqual(entries(index), [VAULT_ENTRY]);
  assert.ok(index.includes('\n   - For: Client secret in Key Vault\n   - Once it\'s done: When the installer asks "Has the admin added the secret?", choose "Yes, carry on".\n'), index);
  assert.ok(index.endsWith(`It picks up where it stopped:\n\n\`\`\`\n${commandLine('install')}\n\`\`\`\n`), index);
  const out = t.text();
  assert.ok(out.indexOf('Admin pack, a file for each admin') > out.indexOf('az keyvault secret set'), 'after the steps it goes with');
  noSecrets(dir);
});

test('pack, a vault admin with --yes: the install carries on, and their file says Analytics Hub can\'t load its data until the secret is there', async () => {
  const dir = tmp();
  const t = fakeUi({ yes: true });
  const ctx = packCtx(t.ui, vaultConfig(), dir);
  startHandoffPack(ctx, 'install');
  assert.equal(await secretHandoff(ctx), false);
  assert.deepEqual(t.asked, []);
  const { index, names, files } = readPack(dir);
  assert.deepEqual(names, ['vault-admin.md']);
  assert.ok(files['vault-admin.md'].includes('\nI\'m installing Analytics Hub, and I need your help with this:\n'), 'an install under way');
  assert.ok(files['vault-admin.md'].endsWith(VAULT_NEXT('analyst@contoso.com')), files['vault-admin.md']);
  assert.ok(index.includes(`\n   - Once it's done: Run the installer again without --yes. ${ADDED}\n`), 'nothing installed yet to repair');
  assert.ok(t.text().indexOf('Carrying on. Data loads fail until the secret is in kv-ah.') > t.text().indexOf('Admin pack, a file for each admin'));
  noSecrets(dir);
});

test('pack, a vault admin who has added the secret: their file goes, and the index says so', async () => {
  const dir = tmp();
  const t = fakeUi({ answers: ['', 'go'] });
  const config = vaultConfig();
  const ctx = packCtx(t.ui, config, dir);
  startHandoffPack(ctx, 'install');
  assert.equal(await secretHandoff(ctx), true);
  assert.ok(config.keyVault.secretSetAt);
  const { index, names } = readPack(dir);
  assert.deepEqual(names, []);
  assert.ok(index.endsWith('UTC.\n\nThe vault admin has added the client secret in kv-ah.\n\nNothing is waiting on an admin.\n'), index);
  assert.match(t.text(), /\n {2}Admin pack: nothing is waiting on an admin\. /);
  noSecrets(dir);
});

test('pack, a vault admin an earlier run asked: their request stays, from the install record, until you say the secret is there', async () => {
  const rows = await check(plainConfig());
  const licence = rows.filter((it) => it.id === 'power-bi-pro');
  /** @param {(config: InstallConfig) => void} [change] */
  const write = (change) => {
    const dir = tmp();
    const config = vaultConfig();
    config.keyVault.handoff = { grantRead: true, shownAt: '2026-05-31T09:00:00Z' };
    change?.(config);
    const ctx = packCtx(fakeUi().ui, config, dir);
    startHandoffPack(ctx, 'prereqs');
    writeHandoffPack(ctx, { asked: licence, all: rows, why: PREFLIGHT });
    noSecrets(dir);
    return readPack(dir);
  };
  let pack = write();
  assert.deepEqual(pack.names, ['licence.md', 'vault-admin.md']);
  assert.deepEqual(entries(pack.index).map((e) => e.replace(/: \[.*$/, '')), ['1. A Key Vault admin', `2. ${ADMINS.licence}`], 'in the order of ADMINS');
  assert.ok(pack.index.includes(`\n   - Once it's done: Run the installer again without --yes. ${ADDED}\n`), pack.index);
  assert.ok(pack.files['vault-admin.md'].endsWith(VAULT_NEXT('analyst@contoso.com')));
  assert.ok(pack.files['vault-admin.md'].includes('\nI\'m installing Analytics Hub, and I need your help with this:\n'));

  pack = write((config) => Object.assign(config.fabric, { workspaceId: 'ws-1', lakehouseId: 'lh-1' }));
  assert.ok(pack.index.includes(`\n   - Once it's done: Run the installer again without --yes and choose Repair or change. ${ADDED}\n`), pack.index);

  /** @type {[string, (config: InstallConfig) => void][]} */
  const none = [
    ['never shown', (config) => delete config.keyVault.handoff?.shownAt],
    ['added', (config) => (config.keyVault.secretSetAt = '2026-05-31T10:00:00Z')],
    ['Azure', (config) => (config.target = 'azure')],
  ];
  for (const [why, change] of none) assert.deepEqual(write(change).names, ['licence.md'], why);
});

test('pack, rotate-secret with a vault admin: its pack is the new secret\'s request alone, and says so', async () => {
  const dir = tmp();
  const config = vaultConfig();
  config.keyVault.secretSetAt = '2026-05-01T00:00:00Z';
  const rows = await check(plainConfig());
  const first = packCtx(fakeUi().ui, config, dir);
  startHandoffPack(first, 'install');
  writeHandoffPack(first, { asked: rows.filter((it) => it.id === 'power-bi-pro'), all: rows, why: PREFLIGHT });
  assert.deepEqual(readPack(dir).names, ['licence.md']);

  const stop = fakeUi({ answers: [true, '', 'stop'] });
  await assert.rejects(rotateSecret(packCtx(stop.ui, config, dir)), (err) => isResumeLater(err));
  let { index, names, files } = readPack(dir);
  assert.deepEqual(names, ['vault-admin.md'], 'in place of what the install left');
  assert.ok(
    index.startsWith(
      '# Analytics Hub: your admin pack\n\nWritten by Create new secrets (rotate-secret) on 2026-06-01 at 12:34 UTC.\n\n' +
        'A vault admin needs to replace the app\'s client secret in kv-ah, with the steps in their file. The installer never sees its value.\n' +
        'Create new secrets only writes the request for the new client secret. To see anything else still waiting on an admin, run the installer again and choose Repair or change.\n\n',
    ),
    index,
  );
  assert.ok(
    index.includes(
      '\n   - Once it\'s done: When the installer asks "Has the admin replaced the secret?", choose "Yes, carry on".\n' +
        '   - Once it\'s done: Once a run has succeeded with the new secret, delete the old one from the app\'s Certificates & secrets page, or ask the vault admin to.\n',
    ),
    index,
  );
  assert.ok(
    index.endsWith(
      '## Carry on\n\nIf you stopped it, run this once the vault admin has replaced the secret. It shows their steps again, then asks whether they have:\n\n' +
        `\`\`\`\n${commandLine('rotate-secret')}\n\`\`\`\n`,
    ),
    index,
  );
  const file = files['vault-admin.md'];
  assert.ok(file.includes('\nHi,\n\nI\'ve installed Analytics Hub, and I need your help with this:\n'), 'a rotation comes after the install');
  assert.doesNotMatch(file, /I'm installing/);
  assert.ok(
    file.includes(
      '\n- Replace the client secret of the app "Analytics Hub Data Collector" (application ID app-1) in the Key Vault kv-ah: create a new one, and add it as a new ' +
        'version of the secret ah-client-secret. Keep the old one on the app until a run has succeeded with the new one.\n',
    ),
    file,
  );
  assert.ok(file.includes('\n  2. Copy its Value into kv-ah > Secrets > ah-client-secret > New Version.\n'));
  noSecrets(dir);

  const go = fakeUi({ answers: [true, '', 'go'] });
  await rotateSecret(packCtx(go.ui, config, dir));
  ({ index, names } = readPack(dir));
  assert.deepEqual(names, []);
  assert.ok(index.endsWith('UTC.\n\nThe vault admin has replaced the client secret in kv-ah.\nCreate new secrets only writes the request for the new client secret. To see anything else still waiting on an admin, run the installer again and choose Repair or change.\n'), index);
  assert.doesNotMatch(index + go.text(), /[Nn]othing is waiting on an admin/, 'it only knows about the secret');
});

test('pack, the end of an install that carried on without the secret: the vault admin\'s request is one of what it left, and the summary says it\'s waiting', async () => {
  const dir = tmp();
  const fake = fakeUi();
  const t = fakeCtx({ ui: fake.ui, fabric: fakeFabric().api, oneLake: { readJson: async () => null }, graph: { myDirectoryRoles: async () => [] }, config: vaultConfig() });
  t.ctx.configFile = join(dir, 'valuelens-install.json');
  startHandoffPack(t.ctx, 'install');
  await summary(t.ctx, { dataCheck: SHOWN });
  let pack = readPack(dir);
  assert.deepEqual(pack.names, ['vault-admin.md']);
  assert.deepEqual(entries(pack.index), [VAULT_ENTRY]);
  assert.ok(pack.index.includes(`\n   - Once it's done: Run the installer again without --yes and choose Repair or change. ${ADDED}\n`), pack.index);
  const file = pack.files['vault-admin.md'];
  assert.ok(file.includes('\nI\'ve installed Analytics Hub, and I need your help with this:\n'));
  assert.ok(file.endsWith(VAULT_NEXT('admin@contoso.com')), file);
  let out = fake.text();
  assert.match(out, /\n {4}Secret: +kv-ah \/ ah-client-secret +Waiting for a vault admin to add it\. Data loads fail until it's there\.\n/);
  const done = out.slice(out.lastIndexOf('Still to do by your admins'), out.lastIndexOf('Admin pack, a file for each admin'));
  assert.deepEqual(done.match(/^ {2}\d+\. .*$/gm), ['  1. A Key Vault admin'], 'the terminal lists the same request');
  noSecrets(dir);

  t.config.keyVault.secretSetAt = '2026-06-01T11:00:00Z';
  await summary(t.ctx, { dataCheck: SHOWN });
  pack = readPack(dir);
  assert.deepEqual(pack.names, []);
  assert.ok(pack.index.endsWith('UTC.\n\nThe install finished.\n\nNothing is waiting on an admin.\n'), pack.index);
  out = fake.text();
  assert.match(out.slice(out.lastIndexOf('Secret:')), /^Secret: +kv-ah \/ ah-client-secret +Added by a vault admin\.\n/);
});
