// @ts-check
/**
 * Reads entries from a zip file, enough for a Power BI template (.pbit), and writes small ones.
 * Handles stored and deflated entries; no ZIP64, encryption or multi-disk archives.
 */
import { deflateRawSync, inflateRawSync } from 'node:zlib';

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/**
 * @typedef {{ name: string, method: number, compressedSize: number, size: number, offset: number }} ZipEntry
 */

/**
 * @param {Buffer} buf
 * @returns {Map<string, ZipEntry>}
 */
export function listZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a zip file.');
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  /** @type {Map<string, ZipEntry>} */
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(at) !== CENTRAL) throw new Error('The zip file\'s directory is damaged.');
    const method = buf.readUInt16LE(at + 10);
    const compressedSize = buf.readUInt32LE(at + 20);
    const size = buf.readUInt32LE(at + 24);
    const nameLength = buf.readUInt16LE(at + 28);
    const extraLength = buf.readUInt16LE(at + 30);
    const commentLength = buf.readUInt16LE(at + 32);
    const offset = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLength);
    entries.set(name, { name, method, compressedSize, size, offset });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * @param {Buffer} buf
 * @param {string} name
 * @returns {Buffer}
 */
export function readZipEntry(buf, name) {
  const entry = listZip(buf).get(name);
  if (!entry) throw new Error(`The file has no ${name}.`);
  return entryData(buf, entry);
}

/**
 * Every file whose name starts with `prefix`, in the zip's order. Folder entries are left out.
 * @param {Buffer} buf
 * @param {string} prefix
 * @returns {Map<string, Buffer>}
 */
export function readZipEntries(buf, prefix) {
  /** @type {Map<string, Buffer>} */
  const out = new Map();
  for (const entry of listZip(buf).values()) {
    if (entry.name.startsWith(prefix) && !entry.name.endsWith('/')) out.set(entry.name, entryData(buf, entry));
  }
  return out;
}

/** zlib.crc32 needs Node 20.15 or later. */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** @param {Buffer} data */
export function crc32(data) {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Builds a zip of deflated files, all dated `at`.
 * @param {{ name: string, data: Buffer | string }[]} files
 * @param {Date} [at]
 * @returns {Buffer}
 */
export function writeZip(files, at = new Date()) {
  const time = (at.getHours() << 11) | (at.getMinutes() << 5) | Math.floor(at.getSeconds() / 2);
  const date = ((Math.max(at.getFullYear(), 1980) - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate();
  /** @type {Buffer[]} */
  const locals = [];
  /** @type {Buffer[]} */
  const centrals = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, 'utf8');
    const packed = deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, packed);
    centrals.push(central, name);
    offset += 30 + name.length + packed.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(EOCD, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

/**
 * @param {Buffer} buf
 * @param {ZipEntry} entry
 * @returns {Buffer}
 */
function entryData(buf, entry) {
  const { name } = entry;
  if (buf.readUInt32LE(entry.offset) !== LOCAL) throw new Error(`The zip entry ${name} is damaged.`);
  const start = entry.offset + 30 + buf.readUInt16LE(entry.offset + 26) + buf.readUInt16LE(entry.offset + 28);
  const raw = buf.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method === 8) return inflateRawSync(raw);
  throw new Error(`${name} uses zip compression method ${entry.method}, which isn't supported.`);
}
