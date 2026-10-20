import { promisify } from 'node:util';
import zlib from 'node:zlib';

const brotliCompress = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);

/** Bodies smaller than this go out as they are: compressing them saves less than it costs. */
export const COMPRESSION_MIN_BYTES = 1024;

export function applySecurityHeaders(res) {
  res.setHeader('Content-Security-Policy', [
    "frame-ancestors 'self' https://teams.microsoft.com https://*.teams.microsoft.com https://*.cloud.microsoft https://*.office.com https://*.microsoft365.com https://outlook.office.com https://outlook.office365.com",
    "default-src 'self'",
    "connect-src 'self' https://login.microsoftonline.com",
    "img-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self' https://res.cdn.office.net",
    "frame-src https://login.microsoftonline.com"
  ].join('; '));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
}

export function sendJson(res, status, body, headers = {}) {
  for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  return sendBody(res, JSON.stringify(body));
}

/** The encodings this server can send that the client accepts, best first. Brotli wins a tie. */
export function acceptedEncodings(header) {
  const weights = new Map();
  for (const part of String(header || '').split(',')) {
    const [name, ...params] = part.split(';').map((s) => s.trim().toLowerCase());
    if (!name) continue;
    const q = params.find((p) => p.startsWith('q='));
    const weight = q === undefined ? 1 : Number(q.slice(2));
    weights.set(name, Number.isFinite(weight) ? weight : 0);
  }
  const weightOf = (name) => weights.get(name) ?? weights.get('*') ?? 0;
  return ['br', 'gzip'].filter((name) => weightOf(name) > 0).sort((a, b) => weightOf(b) - weightOf(a));
}

/** Text, JSON, JavaScript and SVG shrink well. Images and fonts are compressed already, and an event stream mustn't be held back. */
export function isCompressible(contentType) {
  const type = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (type === 'text/event-stream') return false;
  return type.startsWith('text/') || /^application\/(?:json|javascript|xml)$/.test(type) || /\+(?:json|xml)$/.test(type);
}

export function appendVary(res, field) {
  const values = String(res.getHeader('Vary') || '').split(',').map((v) => v.trim()).filter(Boolean);
  if (values.includes('*') || values.some((v) => v.toLowerCase() === field.toLowerCase())) return;
  res.setHeader('Vary', [...values, field].join(', '));
}

/** Moderate levels: the container has half a vCPU. Static files are compressed once, harder, by precompress.js. */
const COMPRESS_DYNAMIC = {
  br: (data) => brotliCompress(data, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4, [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length } }),
  gzip: (data) => gzip(data, { level: 6 })
};

/**
 * Ends the response with body: compressed with br or gzip when its type shrinks well, it's at least
 * COMPRESSION_MIN_BYTES and the request accepts the encoding. Never rejects; if compression fails, the body goes as it is.
 */
export async function sendBody(res, body) {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(body == null ? '' : String(body), 'utf8');
  try {
    if (isCompressible(res.getHeader('Content-Type')) && !res.getHeader('Content-Encoding')) {
      appendVary(res, 'Accept-Encoding');
      const [encoding] = data.length >= COMPRESSION_MIN_BYTES ? acceptedEncodings(res.req?.headers?.['accept-encoding']) : [];
      if (encoding) {
        const compressed = await COMPRESS_DYNAMIC[encoding](data);
        if (compressed.length < data.length) {
          res.setHeader('Content-Encoding', encoding);
          return res.end(compressed);
        }
      }
    }
  } catch { /* send it uncompressed */ }
  return res.end(data);
}

export async function readJsonBody(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error('Request body is too large');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error('Request body must be valid JSON');
    error.statusCode = 400;
    throw error;
  }
}
