import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import { COMPRESSION_MIN_BYTES, isCompressible } from './http-utils.js';
import { PRECOMPRESSED_SUFFIX, contentTypeFor } from './static.js';

const brotliCompress = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);

/** Maximum levels: this runs once, at image build, so the container's half vCPU never compresses a static file. */
const COMPRESS_STATIC = {
  br: (data) => brotliCompress(data, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: zlib.constants.BROTLI_MAX_QUALITY, [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length } }),
  gzip: (data) => gzip(data, { level: zlib.constants.Z_BEST_COMPRESSION })
};

/**
 * Writes a .br and a .gz copy next to every compressible file of at least COMPRESSION_MIN_BYTES under dir, for static.js
 * to serve. Each copy gets its file's modified time, and static.js ignores a copy whose time doesn't match. A copy that
 * wouldn't be smaller isn't written, and an old one is removed. Returns the paths written.
 */
export async function precompress(dir) {
  const written = [];
  for (const entry of await fs.readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const filePath = path.join(entry.parentPath, entry.name);
    if (!isCompressible(contentTypeFor(filePath))) continue;
    const stat = await fs.stat(filePath);
    const data = await fs.readFile(filePath);
    for (const [encoding, suffix] of Object.entries(PRECOMPRESSED_SUFFIX)) {
      const variantPath = filePath + suffix;
      const compressed = data.length >= COMPRESSION_MIN_BYTES ? await COMPRESS_STATIC[encoding](data) : null;
      if (!compressed || compressed.length >= data.length) {
        await fs.rm(variantPath, { force: true });
        continue;
      }
      await fs.writeFile(variantPath, compressed);
      await fs.utimes(variantPath, stat.atimeMs / 1000, stat.mtimeMs / 1000);
      written.push(variantPath);
    }
  }
  return written;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2] || process.env.VALUELENS_PUBLIC_DIR || 'public';
  precompress(dir).then(
    (written) => console.log(`precompress: wrote ${written.length} compressed copies under ${dir}`),
    (error) => { console.error(`precompress failed: ${error.message}`); process.exitCode = 1; }
  );
}
