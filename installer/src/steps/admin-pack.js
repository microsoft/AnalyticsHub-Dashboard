// @ts-check
/**
 * The hand-off pack: an index for the person running the installer, and a file for each admin that they can send as
 * it is. renderAdminPack is pure; writeAdminPackFiles puts what it returns on disk.
 *
 * The requests, and handoff.js's ADMINS, come in as arguments, so this module imports nothing of the installer's and
 * adds no import cycle.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The index, next to the install record. Before 0.6.9 it was the whole pack: the app admin's script and steps. */
export const ADMIN_PACK_FILE = 'analytics-hub-admin-pack.md';
/** The folder beside the index, with a file for each admin. */
export const ADMIN_PACK_DIR = 'analytics-hub-admin-pack';
/** The longest slug a request with its own addressee adds to its file's name. */
const SLUG_MAX = 40;
/**
 * The file an admin's request goes in, by their ADMINS key, as the pack's messages name it.
 * @param {string} key
 */
export const adminFileName = (key) => `${key}.md`;

/**
 * @typedef {import('./handoff.js').AdminRequest} AdminRequest
 *
 * @typedef {'prereqs' | 'install' | 'repair' | 'update'} PackWriter  What wrote the pack.
 *
 * What an admin's file has beyond their request.
 * @typedef {object} AdminExtra
 * @property {string[]} [sections]  Markdown after the request, with its own "## " headings.
 * @property {string[]} [sendBack]  What to send back, one item each.
 * @property {string[]} [next]  What happens next, in place of the usual line.
 *
 * @typedef {object} PackInput
 * @property {Record<string, string>} admins  handoff.js's ADMINS: their order, and who each one is.
 * @property {AdminRequest[]} requests
 * @property {PackWriter} by
 * @property {Date} at
 * @property {string[]} why  What happened, a sentence each.
 * @property {string} [from]  Who runs the installer, as the requests sign it.
 * @property {string} [resume]  The command to carry on with.
 * @property {string[]} [notes]  More for the person running the installer, after the list.
 * @property {Record<string, AdminExtra>} [extras]  By ADMINS key, for the request addressed to that admin.
 * @property {boolean} [done]  The requests are what an install left.
 *
 * @typedef {{ key: string, who: string, name: string, text: string, request: AdminRequest }} AdminFile
 * @typedef {{ index: { name: string, text: string }, files: AdminFile[] }} RenderedPack
 * @typedef {{ index: string, files: { who: string, path: string }[], done?: boolean }} PackPaths  The index's path and each admin's file; done: it's what an install left.
 * @typedef {PackPaths & { changed: boolean, written: boolean }} WrittenPack
 */

/** @type {Record<PackWriter, string>} */
const WRITERS = { prereqs: 'the prerequisites check', install: 'an install', repair: 'a Repair', update: 'an update' };

/**
 * A request's message as Markdown, to send as it is. A line that starts "- " starts an ask. In an ask, the lines after
 * one that ends "(Bash):" are Cloud Shell commands, up to the next ask or a blank line: they go in a bash code block.
 * The rest stays as it is.
 * @param {string} message
 * @returns {string[]}
 */
export function messageMarkdown(message) {
  /** @type {string[]} */
  const out = [];
  /** @type {string[] | null} */
  let code = null;
  let inAsk = false;
  const flush = () => {
    if (code?.length) out.push('  ```bash', ...code.map((l) => `  ${l}`), '  ```');
    code = null;
  };
  for (const line of message.split('\n')) {
    if (!line.trim()) {
      flush();
      inAsk = false;
      out.push(line);
      continue;
    }
    if (line.startsWith('- ')) {
      flush();
      inAsk = true;
    } else if (code) {
      code.push(line.trim());
      continue;
    }
    out.push(line);
    if (inAsk && /\(Bash\):$/.test(line.trimEnd())) code = [];
  }
  flush();
  return out;
}

/**
 * A request's file name: its admin's key, and for a request with its own addressee, a slug of who that is. No two
 * requests in one pack share a name.
 * @param {Pick<AdminRequest, 'admin' | 'who'>} r
 * @param {Record<string, string>} admins
 * @param {Set<string>} used  The names taken so far; this one is added.
 */
export function packFileName(r, admins, used) {
  const slug =
    r.who === admins[r.admin]
      ? ''
      : r.who
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+/, '')
          .slice(0, SLUG_MAX)
          .replace(/-+$/, '');
  const base = slug ? `${r.admin}-${slug}` : r.admin;
  let name = adminFileName(base);
  for (let n = 2; used.has(name); n++) name = `${base}-${n}.md`;
  used.add(name);
  return name;
}

/**
 * @param {AdminRequest} r
 * @param {AdminExtra | undefined} extra
 * @param {PackInput} input
 */
function adminFileText(r, extra, input) {
  const name = input.from ?? 'the person who sent you this';
  const lines = [
    '# Analytics Hub: a request for your help',
    '',
    `- **To:** ${r.who}`,
    ...(r.rows.length ? [`- **For:** ${r.rows.join('; ')}`] : []),
    ...(r.optional ? ['- **Optional:** Analytics Hub works without it.'] : []),
    '',
    ...messageMarkdown(r.message),
  ];
  if (extra?.sections?.length) lines.push('', ...extra.sections);
  const back = extra?.sendBack ?? r.back ?? [];
  if (back.length) lines.push('', '## What to send back', '', ...back.map((s) => `- ${s}`));
  const next = extra?.next ?? [
    input.done ? `Once it's done, tell ${name}.` : `Once it's done, tell ${name}. When they run the installer again, it picks up what you did.`,
  ];
  lines.push('', '## What happens next', '', ...next, '');
  return lines.join('\n');
}

/**
 * @param {PackInput} input
 * @param {AdminFile[]} files
 */
function indexText(input, files) {
  const at = input.at.toISOString();
  const lines = ['# Analytics Hub: your admin pack', '', `Written by ${WRITERS[input.by]} on ${at.slice(0, 10)} at ${at.slice(11, 16)} UTC.`];
  if (input.why.length) lines.push('', ...input.why);
  if (!files.length) {
    lines.push('', 'Nothing is waiting on an admin.', '');
    return lines.join('\n');
  }
  lines.push(
    '',
    `Send each admin their own file, from the ${ADMIN_PACK_DIR} folder next to this one, as it is. It says what to do, ` +
      'with the exact names of the settings and roles, and any commands to run. Nothing in it is secret.',
    '',
    '## Who gets what',
    '',
  );
  files.forEach((f, i) => {
    const r = f.request;
    const path = `${ADMIN_PACK_DIR}/${f.name}`;
    lines.push(`${i + 1}. ${r.who}${r.optional ? ' (optional)' : ''}: [${path}](${path})`);
    if (r.rows.length) lines.push(`   - For: ${r.rows.join('; ')}`);
    for (const n of r.notes ?? []) lines.push(`   - Before you send it: ${n}`);
    for (const a of r.after ?? []) lines.push(`   - Once it's done: ${a}`);
  });
  if (input.notes?.length) lines.push('', ...input.notes);
  lines.push('', '## Carry on', '');
  if (input.resume) {
    const run =
      input.by === 'prereqs'
        ? 'Once your admins have done their part, run the installer:'
        : 'Once your admins have done their part, run the installer again. It picks up where it stopped:';
    lines.push(run, '', '```', input.resume, '```');
  } else lines.push('Once an admin has done their part, do what its "Once it\'s done" line says, if it has one.');
  lines.push('');
  return lines.join('\n');
}

/**
 * The pack's files: the index, and a file for each request, named after the admin it goes to. Pure.
 * @param {PackInput} input
 * @returns {RenderedPack}
 */
export function renderAdminPack(input) {
  const keys = Object.keys(input.admins);
  const order = (/** @type {AdminRequest} */ r) => {
    const i = keys.indexOf(r.admin);
    return i < 0 ? keys.length : i;
  };
  /** @type {Set<string>} */
  const used = new Set();
  const files = [...input.requests]
    .sort((a, b) => order(a) - order(b))
    .map((r) => {
      const extra = r.who === input.admins[r.admin] ? input.extras?.[r.admin] : undefined;
      return { key: r.admin, who: r.who, name: packFileName(r, input.admins, used), text: adminFileText(r, extra, input), request: r };
    });
  return { index: { name: ADMIN_PACK_FILE, text: indexText(input, files) }, files };
}

/**
 * Puts a rendered pack in dir: the index, and the admins' files in ADMIN_PACK_DIR beside it. Writes only the files
 * whose text changed, and removes the admins' files no longer needed: a file there named after an ADMINS key, alone
 * or with a "-" and a slug. Any other file stays, and so does the folder. With nothing needed and no index yet, it
 * writes nothing.
 * @param {string} dir
 * @param {RenderedPack} pack
 * @param {string[]} keys  ADMINS' keys.
 * @returns {WrittenPack}
 */
export function writeAdminPackFiles(dir, pack, keys) {
  const index = join(dir, pack.index.name);
  const folder = join(dir, ADMIN_PACK_DIR);
  const files = pack.files.map((f) => ({ who: f.who, path: join(folder, f.name) }));
  if (!pack.files.length && !existsSync(index)) return { index, files, changed: false, written: false };
  let changed = false;
  /** @param {string} path @param {string} text */
  const put = (path, text) => {
    if (existsSync(path) && readFileSync(path, 'utf8') === text) return;
    writeFileSync(path, text, 'utf8');
    changed = true;
  };
  const ours = new RegExp(`^(?:${keys.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?:-[a-z0-9-]+)?\\.md$`);
  const keep = new Set(pack.files.map((f) => f.name));
  for (const name of existsSync(folder) ? readdirSync(folder) : []) {
    if (!ours.test(name) || keep.has(name)) continue;
    rmSync(join(folder, name), { force: true });
    changed = true;
  }
  if (pack.files.length) mkdirSync(folder, { recursive: true });
  for (const f of pack.files) put(join(folder, f.name), f.text);
  put(index, pack.index.text);
  return { index, files, changed, written: true };
}
