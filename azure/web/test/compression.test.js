import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import { COMPRESSION_MIN_BYTES, acceptedEncodings, isCompressible } from '../src/http-utils.js';
import { precompress } from '../src/precompress.js';
import { authHeader, startTestServer } from './helpers.js';

const ROWS = { results: [{ tables: [{ rows: Array.from({ length: 400 }, (_, i) => ({ '[Person]': `Person ${i}`, '[Department]': `Department ${i % 7}`, '[Prompts]': i * 3 })) }] }] };
const QUERY = JSON.stringify({ workspaceId: 'workspace-1', itemId: 'dataset-1', query: 'EVALUATE ROW("x", 1)' });

/** A raw request, so the test sees the bytes on the wire: fetch would decode them. */
function rawRequest(baseUrl, pathname, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${baseUrl}${pathname}`, { method, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}
function decoded(response) {
  const encoding = response.headers['content-encoding'];
  if (encoding === 'br') return zlib.brotliDecompressSync(response.body);
  if (encoding === 'gzip') return zlib.gunzipSync(response.body);
  assert.equal(encoding, undefined);
  return response.body;
}
const varies = (response) => String(response.headers.vary || '').split(',').map((v) => v.trim().toLowerCase()).includes('accept-encoding');

test('the encodings a client accepts, best first', () => {
  assert.deepEqual(acceptedEncodings('gzip, deflate, br, zstd'), ['br', 'gzip']);
  assert.deepEqual(acceptedEncodings('gzip, deflate'), ['gzip']);
  assert.deepEqual(acceptedEncodings('br;q=0.5, gzip'), ['gzip', 'br']);
  assert.deepEqual(acceptedEncodings('BR;Q=0.9, GZIP;q=0.8'), ['br', 'gzip']);
  assert.deepEqual(acceptedEncodings('*'), ['br', 'gzip']);
  assert.deepEqual(acceptedEncodings('*;q=0.2, gzip'), ['gzip', 'br']);
  assert.deepEqual(acceptedEncodings('*, br;q=0'), ['gzip']);
  for (const none of [undefined, '', 'identity', 'deflate', 'br;q=0, gzip;q=0', 'br;q=nonsense']) assert.deepEqual(acceptedEncodings(none), [], String(none));
});

test('only types that shrink are compressed: text, JSON and SVG, never PNG, icons, fonts or an event stream', () => {
  for (const type of ['application/json; charset=utf-8', 'text/javascript; charset=utf-8', 'text/html', 'text/css', 'image/svg+xml', 'application/problem+json']) assert.ok(isCompressible(type), type);
  for (const type of ['text/event-stream', 'image/png', 'image/x-icon', 'font/woff2', 'application/octet-stream', '', undefined]) assert.ok(!isCompressible(type), String(type));
});

test('query results go out in the encoding each request accepts, with Vary, and are cached uncompressed', async () => {
  const calls = [];
  const fetchImpl = async (url) => { calls.push(url); return new Response(JSON.stringify(ROWS), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } }); };
  const { server, baseUrl } = await startTestServer({ fetchImpl });
  try {
    for (const [accept, expected] of [['gzip, deflate, br, zstd', 'br'], ['gzip, deflate', 'gzip'], ['br;q=0.5, gzip', 'gzip'], [undefined, undefined], ['identity', undefined], ['br;q=0, gzip;q=0', undefined]]) {
      const headers = { ...authHeader('user'), 'Content-Type': 'application/json', ...(accept ? { 'Accept-Encoding': accept } : {}) };
      const response = await rawRequest(baseUrl, '/api/query', { method: 'POST', headers, body: QUERY });
      assert.equal(response.status, 200, String(accept));
      assert.equal(response.headers['content-encoding'], expected, String(accept));
      assert.ok(varies(response), String(accept));
      assert.equal(Number(response.headers['content-length']), response.body.length);
      assert.deepEqual(JSON.parse(decoded(response)), ROWS);
      if (expected) assert.ok(response.body.length < JSON.stringify(ROWS).length / 4, `${expected} should shrink the rows`);
    }
    assert.equal(calls.length, 1);
  } finally { server.close(); }
});

test('a body under the threshold goes out as it is, still with Vary', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const response = await rawRequest(baseUrl, '/api/health', { headers: { 'Accept-Encoding': 'br, gzip' } });
    assert.ok(response.body.length < COMPRESSION_MIN_BYTES);
    assert.equal(response.headers['content-encoding'], undefined);
    assert.ok(varies(response));
    assert.equal(JSON.parse(response.body).status, 'ok');
  } finally { server.close(); }
});

test('static files are served from the copies precompress writes, and never from a stale one', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'valuelens-public-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, 'assets'));
  const appJs = Array.from({ length: 600 }, (_, i) => `export const value${i} = () => "Analytics Hub ${i}";`).join('\n');
  const indexHtml = `<!doctype html><html><head><title>Analytics Hub</title></head><body>${'<div class="tile"><span>Copilot</span></div>'.repeat(60)}<script type="module" src="/assets/app.js"></script></body></html>`;
  const png = randomBytes(4096);
  await fs.writeFile(path.join(dir, 'assets', 'app.js'), appJs);
  await fs.writeFile(path.join(dir, 'index.html'), indexHtml);
  await fs.writeFile(path.join(dir, 'assets', 'small.css'), 'body { margin: 0; }');
  await fs.writeFile(path.join(dir, 'assets', 'logo.png'), png);

  const written = await precompress(dir);
  assert.deepEqual(written.map((p) => path.relative(dir, p).split(path.sep).join('/')).sort(), ['assets/app.js.br', 'assets/app.js.gz', 'index.html.br', 'index.html.gz']);

  const { server, baseUrl } = await startTestServer({ publicDir: dir });
  try {
    for (const [accept, expected] of [['gzip, deflate, br', 'br'], ['gzip', 'gzip'], [undefined, undefined]]) {
      const response = await rawRequest(baseUrl, '/assets/app.js', { headers: accept ? { 'Accept-Encoding': accept } : {} });
      assert.equal(response.status, 200);
      assert.equal(response.headers['content-encoding'], expected, String(accept));
      assert.equal(response.headers['content-type'], 'text/javascript; charset=utf-8');
      assert.equal(response.headers['cache-control'], 'public, max-age=31536000, immutable');
      assert.ok(varies(response));
      assert.equal(decoded(response).toString(), appJs);
    }
    const page = await rawRequest(baseUrl, '/', { headers: { Accept: 'text/html', 'Accept-Encoding': 'gzip, br' } });
    assert.equal(page.headers['content-encoding'], 'br');
    assert.equal(page.headers['cache-control'], 'no-cache');
    assert.equal(decoded(page).toString(), indexHtml);

    const head = await rawRequest(baseUrl, '/assets/app.js', { method: 'HEAD', headers: { 'Accept-Encoding': 'br' } });
    assert.equal(head.headers['content-encoding'], 'br');
    assert.equal(head.body.length, 0);

    const image = await rawRequest(baseUrl, '/assets/logo.png', { headers: { 'Accept-Encoding': 'br, gzip' } });
    assert.equal(image.headers['content-encoding'], undefined);
    assert.equal(image.headers.vary, undefined);
    assert.deepEqual(image.body, png);

    const css = await rawRequest(baseUrl, '/assets/small.css', { headers: { 'Accept-Encoding': 'br, gzip' } });
    assert.equal(css.headers['content-encoding'], undefined);
    assert.ok(varies(css));

    const changed = `${appJs}\nexport const added = true;`;
    const appPath = path.join(dir, 'assets', 'app.js');
    await fs.writeFile(appPath, changed);
    const later = new Date(Date.now() + 10_000);
    await fs.utimes(appPath, later, later);
    const stale = await rawRequest(baseUrl, '/assets/app.js', { headers: { 'Accept-Encoding': 'br, gzip' } });
    assert.equal(stale.headers['content-encoding'], undefined);
    assert.equal(stale.body.toString(), changed);
  } finally { server.close(); }

  await fs.writeFile(path.join(dir, 'index.html'), '<!doctype html><title>Analytics Hub</title>');
  const rewritten = await precompress(dir);
  assert.deepEqual(rewritten.map((p) => path.basename(p)).sort(), ['app.js.br', 'app.js.gz']);
  for (const gone of ['index.html.br', 'index.html.gz']) await assert.rejects(fs.access(path.join(dir, gone)), gone);
});

test('a static file whose copy can\'t be read gets a plain 500, without the file\'s encoding or caching headers', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'valuelens-public-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, 'assets'));
  const appJs = Array.from({ length: 600 }, (_, i) => `export const value${i} = ${i};`).join('\n');
  await fs.writeFile(path.join(dir, 'assets', 'app.js'), appJs);
  await precompress(dir);
  // static.js reads through this same fs/promises object, so only its read of the Brotli copy fails.
  const readFile = fs.readFile;
  t.mock.method(fs, 'readFile', (file, ...rest) => (String(file).endsWith('.br')
    ? Promise.reject(Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' }))
    : readFile.call(fs, file, ...rest)));
  const errors = t.mock.method(console, 'error', () => {});

  const { server, baseUrl } = await startTestServer({ publicDir: dir });
  try {
    const failed = await rawRequest(baseUrl, '/assets/app.js', { headers: { 'Accept-Encoding': 'br, gzip' } });
    assert.equal(failed.status, 500);
    assert.equal(failed.headers['content-encoding'], undefined);
    assert.equal(failed.headers['cache-control'], undefined);
    assert.match(failed.headers['content-type'], /^application\/json/);
    assert.equal(JSON.parse(failed.body).error.message, 'Internal server error.');
    assert.equal(errors.mock.callCount(), 1);

    const gzip = await rawRequest(baseUrl, '/assets/app.js', { headers: { 'Accept-Encoding': 'gzip' } });
    assert.equal(gzip.status, 200);
    assert.equal(gzip.headers['content-encoding'], 'gzip');
    assert.equal(gzip.headers['cache-control'], 'public, max-age=31536000, immutable');
    assert.equal(decoded(gzip).toString(), appJs);
  } finally { server.close(); }
});

test('precompress runs from the command line, as the image build runs it', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'valuelens-public-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'index.html'), `<html>${'<p>Analytics Hub</p>'.repeat(100)}</html>`);
  const script = fileURLToPath(new URL('../src/precompress.js', import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, [script, dir]);
  assert.match(stdout, /wrote 2 compressed copies/);
  await fs.access(path.join(dir, 'index.html.br'));
  await fs.access(path.join(dir, 'index.html.gz'));
});
