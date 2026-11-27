'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const STUDIO_DIR = path.resolve(ROOT, '..', 'Studio');
const OUT_ZIP = path.join(ROOT, 'src-tauri', 'debug-studio.zip');

const ALLOWED_DIRS = new Set([
  'assets',
  'css',
  'effects',
  'Extension',
  'extension-builder',
  'fticons',
  'js',
  'vendor',
]);

const ALLOWED_ROOT_FILES = new Set([
  'manifest.webmanifest',
  'version.json',
  'sw.js',
]);

if (!fs.existsSync(path.join(STUDIO_DIR, 'index.html'))) {
  console.error(`[pack-debug-studio] Studio directory not found at: ${STUDIO_DIR}`);
  process.exit(1);
}

// CRC32 table
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  crcTable[n] = c >>> 0;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function collectFiles(dir, relPrefix, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!relPrefix && !ALLOWED_DIRS.has(entry.name)) continue;
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      collectFiles(full, rel, out);
    } else if (entry.isFile()) {
      if (!relPrefix) {
        if (!entry.name.endsWith('.html') && !ALLOWED_ROOT_FILES.has(entry.name)) continue;
      }
      out.push({ full, rel: `studio/${rel}` });
    }
  }
}

const files = [];
collectFiles(STUDIO_DIR, '', files);

const localChunks = [];
const centralChunks = [];
let offset = 0;

for (const item of files) {
  const raw = fs.readFileSync(item.full);
  const compressed = zlib.deflateRawSync(raw, { level: 6 });
  const nameBuf = Buffer.from(item.rel, 'utf8');
  const crc = crc32(raw);

  // Local file header (30 bytes + name)
  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4); // version needed
  localHeader.writeUInt16LE(0x0800, 6); // UTF-8
  localHeader.writeUInt16LE(8, 8); // deflate
  localHeader.writeUInt16LE(0, 10); // mod time
  localHeader.writeUInt16LE(0, 12); // mod date
  localHeader.writeUInt32LE(crc, 14);
  localHeader.writeUInt32LE(compressed.length, 18);
  localHeader.writeUInt32LE(raw.length, 22);
  localHeader.writeUInt16LE(nameBuf.length, 26);
  localHeader.writeUInt16LE(0, 28); // extra len

  localChunks.push(localHeader, nameBuf, compressed);

  // Central directory header (46 bytes + name)
  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(0x02014b50, 0);
  centralHeader.writeUInt16LE(20, 4); // version made by
  centralHeader.writeUInt16LE(20, 6); // version needed
  centralHeader.writeUInt16LE(0x0800, 8); // UTF-8
  centralHeader.writeUInt16LE(8, 10); // deflate
  centralHeader.writeUInt16LE(0, 12);
  centralHeader.writeUInt16LE(0, 14);
  centralHeader.writeUInt32LE(crc, 16);
  centralHeader.writeUInt32LE(compressed.length, 20);
  centralHeader.writeUInt32LE(raw.length, 24);
  centralHeader.writeUInt16LE(nameBuf.length, 28);
  centralHeader.writeUInt16LE(0, 30); // extra len
  centralHeader.writeUInt16LE(0, 32); // comment len
  centralHeader.writeUInt16LE(0, 34); // disk start
  centralHeader.writeUInt16LE(0, 36); // internal attrs
  centralHeader.writeUInt32LE(0, 38); // external attrs
  centralHeader.writeUInt32LE(offset, 42);

  centralChunks.push(centralHeader, nameBuf);

  offset += localHeader.length + nameBuf.length + compressed.length;
}

const centralSize = centralChunks.reduce((sum, b) => sum + b.length, 0);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(0, 4);
eocd.writeUInt16LE(0, 6);
eocd.writeUInt16LE(files.length, 8);
eocd.writeUInt16LE(files.length, 10);
eocd.writeUInt32LE(centralSize, 12);
eocd.writeUInt32LE(offset, 16);
eocd.writeUInt16LE(0, 20);

const finalZip = Buffer.concat([...localChunks, ...centralChunks, eocd]);
fs.writeFileSync(OUT_ZIP, finalZip);
console.log(
  `[pack-debug-studio] Packed ${files.length} files from ${STUDIO_DIR} -> ${OUT_ZIP} (${(finalZip.length / (1024 * 1024)).toFixed(2)} MB)`
);
