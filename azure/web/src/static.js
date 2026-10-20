import fs from 'node:fs/promises';
import path from 'node:path';
import { acceptedEncodings, appendVary, isCompressible } from './http-utils.js';

const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'], ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'], ['.png', 'image/png'], ['.svg', 'image/svg+xml'],
  ['.ico', 'image/x-icon'], ['.woff', 'font/woff'], ['.woff2', 'font/woff2']
]);
/** Where precompress.js writes each encoding's copy of a file. */
export const PRECOMPRESSED_SUFFIX = { br: '.br', gzip: '.gz' };

export function contentTypeFor(filePath) { return MIME_TYPES.get(path.extname(filePath).toLowerCase()) || 'application/octet-stream'; }

export function createStaticHandler(publicDir) {
  const root = path.resolve(publicDir);
  return async function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    let filePath = safeResolve(root, pathname === '/' ? '/index.html' : pathname);
    if (!filePath) return false;
    let stat = await statOrNull(filePath);
    const acceptsHtml = String(req.headers.accept || '').includes('text/html');
    if ((!stat || !stat.isFile()) && acceptsHtml && !pathname.startsWith('/api/')) {
      filePath = path.join(root, 'index.html');
      stat = await statOrNull(filePath);
    }
    if (!stat || !stat.isFile()) return false;
    const contentType = contentTypeFor(filePath);
    res.statusCode = 200;
    res.setHeader('Content-Type', contentType);
    if (pathname.startsWith('/assets/')) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    else if (path.basename(filePath) === 'index.html') res.setHeader('Cache-Control', 'no-cache');
    let bodyPath = filePath;
    if (isCompressible(contentType)) {
      appendVary(res, 'Accept-Encoding');
      const variant = await precompressedVariant(filePath, stat, acceptedEncodings(req.headers['accept-encoding']));
      if (variant) { res.setHeader('Content-Encoding', variant.encoding); bodyPath = variant.path; }
    }
    if (req.method === 'HEAD') return res.end();
    res.end(await fs.readFile(bodyPath));
    return true;
  };
}

/**
 * The best accepted copy written by precompress.js at image build; static files are never compressed at run time.
 * precompress.js gives each copy its file's modified time, so a copy that doesn't match (its file changed since) is ignored.
 */
async function precompressedVariant(filePath, stat, encodings) {
  for (const encoding of encodings) {
    const variantPath = filePath + PRECOMPRESSED_SUFFIX[encoding];
    const variant = await statOrNull(variantPath);
    if (variant?.isFile() && Math.abs(variant.mtimeMs - stat.mtimeMs) < 1) return { encoding, path: variantPath };
  }
  return null;
}

function safeResolve(root, requestPath) {
  let decoded;
  try { decoded = decodeURIComponent(requestPath); } catch { return null; }
  const resolved = path.resolve(root, decoded.replace(/^\/+/, ''));
  return resolved === root || resolved.startsWith(root + path.sep) ? resolved : null;
}
async function statOrNull(filePath) { try { return await fs.stat(filePath); } catch { return null; } }
