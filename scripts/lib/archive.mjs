import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import yauzl from 'yauzl';
import {
  assertReplaceableDirectory,
  assertSafeRelativePath,
  resolveInside,
} from './paths.mjs';

const TAR_BLOCK_SIZE = 512;
const DEFAULT_ARCHIVE_LIMITS = {
  maxArchiveBytes: 256 * 1024 * 1024,
  maxExpandedBytes: 512 * 1024 * 1024,
  maxEntries: 4096,
};

function parseOctal(buffer, label) {
  const text = buffer.toString('ascii').replace(/\0.*$/, '').trim();
  if (text === '') return 0;
  if (!/^[0-7]+$/.test(text)) throw new Error(`invalid tar ${label}`);
  return Number.parseInt(text, 8);
}

function writeOctal(buffer, offset, width, value) {
  const text = value.toString(8).padStart(width - 1, '0');
  if (text.length !== width - 1) throw new Error('tar numeric field overflow');
  buffer.write(`${text}\0`, offset, width, 'ascii');
}

function splitTarPath(filePath) {
  if (Buffer.byteLength(filePath) <= 100) return { name: filePath, prefix: '' };
  for (let index = filePath.lastIndexOf('/'); index > 0; index = filePath.lastIndexOf('/', index - 1)) {
    const prefix = filePath.slice(0, index);
    const name = filePath.slice(index + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
      return { name, prefix };
    }
  }
  throw new Error(`archive path cannot be represented in USTAR: ${filePath}`);
}

function buildTarHeader(entry) {
  const { name, prefix } = splitTarPath(entry.path);
  const header = Buffer.alloc(TAR_BLOCK_SIZE, 0);
  header.write(name, 0, 100, 'utf8');
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, entry.data.length);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header.write('0', 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  header.write(prefix, 345, 155, 'utf8');
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return header;
}

export function createDeterministicTarGz(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('archive must contain at least one file');
  }
  const seen = new Set();
  const portableSeen = new Map();
  const sorted = entries
    .map((entry) => {
      const archivePath = assertSafeRelativePath(entry.path, 'archive entry');
      const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
      if (seen.has(archivePath)) throw new Error(`duplicate archive entry: ${archivePath}`);
      const portable = archivePath.normalize('NFC').toLowerCase();
      const collision = portableSeen.get(portable);
      if (collision) {
        throw new Error(
          `archive entries collide on a case-insensitive filesystem: ${collision}, ${archivePath}`,
        );
      }
      seen.add(archivePath);
      portableSeen.set(portable, archivePath);
      return { path: archivePath, data };
    })
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));

  const chunks = [];
  for (const entry of sorted) {
    chunks.push(buildTarHeader(entry), entry.data);
    const remainder = entry.data.length % TAR_BLOCK_SIZE;
    if (remainder) chunks.push(Buffer.alloc(TAR_BLOCK_SIZE - remainder, 0));
  }
  chunks.push(Buffer.alloc(TAR_BLOCK_SIZE * 2, 0));
  const compressed = zlib.gzipSync(Buffer.concat(chunks), { level: 9, mtime: 0 });
  if (
    compressed.length < 18 ||
    compressed[0] !== 0x1f ||
    compressed[1] !== 0x8b ||
    compressed[2] !== 8 ||
    compressed[3] !== 0
  ) {
    throw new Error('gzip writer produced an unexpected header');
  }
  // zlib writes a platform-specific OS byte. Fix the complete volatile header
  // so Windows and Linux produce identical archives.
  compressed.writeUInt32LE(0, 4);
  compressed[8] = 2;
  compressed[9] = 255;
  return compressed;
}

export function readTar(
  input,
  {
    limits = DEFAULT_ARCHIVE_LIMITS,
    strictDeterministic = false,
    requireGzip = false,
    label = 'tar archive',
  } = {},
) {
  if (input.length > limits.maxArchiveBytes) {
    throw new Error(`${label} exceeds archive size limit`);
  }
  const isGzip = input.length >= 2 && input[0] === 0x1f && input[1] === 0x8b;
  if (requireGzip && !isGzip) throw new Error(`${label} must be gzip-compressed`);
  if (isGzip) {
    if (
      strictDeterministic &&
      (input.length < 10 ||
        input[2] !== 8 ||
        input[3] !== 0 ||
        input.readUInt32LE(4) !== 0 ||
        input[8] !== 2 ||
        input[9] !== 255)
    ) {
      throw new Error(`${label} gzip header is not platform-independent`);
    }
    try {
      input = zlib.gunzipSync(input, { maxOutputLength: limits.maxExpandedBytes });
    } catch (error) {
      throw new Error(`${label} could not be decompressed: ${error.message}`);
    }
  }
  if (input.length % TAR_BLOCK_SIZE !== 0) {
    throw new Error(`${label} has an invalid tar length`);
  }

  const entries = [];
  const seen = new Set();
  const portableSeen = new Map();
  let offset = 0;
  let expanded = 0;
  let ended = false;
  let previousPath = '';
  while (offset + TAR_BLOCK_SIZE <= input.length) {
    const header = input.subarray(offset, offset + TAR_BLOCK_SIZE);
    offset += TAR_BLOCK_SIZE;
    if (header.every((byte) => byte === 0)) {
      if (offset + TAR_BLOCK_SIZE > input.length || !input.subarray(offset, offset + TAR_BLOCK_SIZE).every((byte) => byte === 0)) {
        throw new Error(`${label} is missing the two-block tar terminator`);
      }
      if (strictDeterministic && offset + TAR_BLOCK_SIZE !== input.length) {
        throw new Error(`${label} contains trailing data after the tar terminator`);
      }
      offset += TAR_BLOCK_SIZE;
      ended = true;
      break;
    }

    const storedChecksum = parseOctal(header.subarray(148, 156), 'checksum');
    const checksumHeader = Buffer.from(header);
    checksumHeader.fill(0x20, 148, 156);
    let actualChecksum = 0;
    for (const byte of checksumHeader) actualChecksum += byte;
    if (storedChecksum !== actualChecksum) throw new Error(`${label} has a bad tar checksum`);

    const rawName = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const entryPath = assertSafeRelativePath(prefix ? `${prefix}/${rawName}` : rawName, 'tar entry');
    const magic = header.subarray(257, 263).toString('ascii');
    if (magic !== 'ustar\0') throw new Error(`${label} contains a non-USTAR entry`);
    const type = String.fromCharCode(header[156] || 0x30);
    if (type !== '0') {
      throw new Error(`${label} contains a non-regular entry: ${entryPath}`);
    }
    const linkName = header.subarray(157, 257).toString('utf8').replace(/\0.*$/, '');
    if (strictDeterministic && linkName) throw new Error(`${label} contains a link target`);
    const size = parseOctal(header.subarray(124, 136), 'size');
    const mode = parseOctal(header.subarray(100, 108), 'mode');
    const uid = parseOctal(header.subarray(108, 116), 'uid');
    const gid = parseOctal(header.subarray(116, 124), 'gid');
    const mtime = parseOctal(header.subarray(136, 148), 'mtime');
    if (strictDeterministic && (mode !== 0o644 || uid !== 0 || gid !== 0 || mtime !== 0)) {
      throw new Error(`${label} entry metadata is not normalized: ${entryPath}`);
    }
    if (seen.has(entryPath)) throw new Error(`${label} contains duplicate entry: ${entryPath}`);
    const portable = entryPath.normalize('NFC').toLowerCase();
    const collision = portableSeen.get(portable);
    if (collision) {
      throw new Error(
        `${label} contains a case-insensitive path collision: ${collision}, ${entryPath}`,
      );
    }
    portableSeen.set(portable, entryPath);
    if (strictDeterministic && previousPath && entryPath < previousPath) {
      throw new Error(`${label} entries are not sorted: ${entryPath}`);
    }
    previousPath = entryPath;
    seen.add(entryPath);
    if (offset + size > input.length) throw new Error(`${label} entry is truncated: ${entryPath}`);
    expanded += size;
    if (expanded > limits.maxExpandedBytes) throw new Error(`${label} exceeds expanded size limit`);
    entries.push({ path: entryPath, data: input.subarray(offset, offset + size) });
    if (entries.length > limits.maxEntries) throw new Error(`${label} has too many entries`);
    const nextOffset = offset + Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
    if (
      strictDeterministic &&
      input.subarray(offset + size, nextOffset).some((byte) => byte !== 0)
    ) {
      throw new Error(`${label} contains nonzero padding for ${entryPath}`);
    }
    offset = nextOffset;
  }
  if (!ended) throw new Error(`${label} is missing its tar terminator`);
  return entries;
}

function zipEntryIsSymlink(entry) {
  const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
  return (mode & 0xf000) === 0xa000;
}

function readZipEntry(zipfile, entry, maxBytes) {
  return new Promise(async (resolve, reject) => {
    try {
      const stream = await zipfile.openReadStreamPromise(entry);
      const chunks = [];
      let total = 0;
      stream.on('data', (chunk) => {
        total += chunk.length;
        if (total > maxBytes) {
          stream.destroy(new Error('ZIP member exceeds size limit'));
          return;
        }
        chunks.push(chunk);
      });
      stream.on('error', reject);
      stream.on('end', () => {
        const data = Buffer.concat(chunks);
        const crc = typeof zlib.crc32 === 'function' ? zlib.crc32(data) : null;
        if (crc !== null && crc >>> 0 !== entry.crc32 >>> 0) {
          reject(new Error(`ZIP member CRC mismatch: ${entry.fileName}`));
          return;
        }
        resolve(data);
      });
    } catch (error) {
      reject(error);
    }
  });
}

export async function extractZipMember(
  input,
  memberPath,
  {
    limits = DEFAULT_ARCHIVE_LIMITS,
    label = 'ZIP archive',
  } = {},
) {
  assertSafeRelativePath(memberPath, 'ZIP member');
  if (input.length > limits.maxArchiveBytes) {
    throw new Error(`${label} exceeds archive size limit`);
  }
  let zipfile;
  try {
    zipfile = await yauzl.fromBufferPromise(input, {
      decodeStrings: true,
      strictFileNames: true,
      validateEntrySizes: true,
    });
  } catch (error) {
    throw new Error(`${label} is not a valid ZIP: ${error.message}`);
  }

  const seen = new Set();
  let expanded = 0;
  let count = 0;
  let selected = null;
  for await (const entry of zipfile.eachEntry()) {
    count += 1;
    if (count > limits.maxEntries) throw new Error(`${label} has too many entries`);
    const entryPath = entry.fileName;
    if (entryPath.endsWith('/')) {
      if (entry.uncompressedSize !== 0 || entry.fileName !== entryPath) {
        throw new Error(`${label} has an invalid directory entry`);
      }
      assertSafeRelativePath(entryPath.slice(0, -1), 'ZIP directory');
      continue;
    }
    assertSafeRelativePath(entryPath, 'ZIP entry');
    if (seen.has(entryPath)) throw new Error(`${label} has a duplicate entry: ${entryPath}`);
    seen.add(entryPath);
    if (zipEntryIsSymlink(entry)) {
      throw new Error(`${label} contains a symlink: ${entryPath}`);
    }
    expanded += entry.uncompressedSize;
    if (expanded > limits.maxExpandedBytes) {
      throw new Error(`${label} exceeds expanded size limit`);
    }
    if (entryPath === memberPath) {
      selected = await readZipEntry(zipfile, entry, limits.maxExpandedBytes);
    }
  }
  if (!selected) throw new Error(`${label} is missing member: ${memberPath}`);
  return selected;
}

export async function extractZipAll(
  input,
  destination,
  {
    limits = DEFAULT_ARCHIVE_LIMITS,
    label = 'ZIP archive',
  } = {},
) {
  if (input.length > limits.maxArchiveBytes) {
    throw new Error(`${label} exceeds archive size limit`);
  }
  let zipfile;
  try {
    zipfile = await yauzl.fromBufferPromise(input, {
      decodeStrings: true,
      strictFileNames: true,
      validateEntrySizes: true,
    });
  } catch (error) {
    throw new Error(`${label} is not a valid ZIP: ${error.message}`);
  }

  const destinationRoot = assertReplaceableDirectory(destination, {
    label: 'ZIP output directory',
  });
  const temporaryRoot = `${destinationRoot}.partial-${process.pid}-${randomUUID()}`;
  await fs.promises.mkdir(path.dirname(destinationRoot), { recursive: true });
  await fs.promises.rm(temporaryRoot, { recursive: true, force: true });
  await fs.promises.mkdir(temporaryRoot, { recursive: true });
  const seen = new Set();
  const portableSeen = new Map();
  let expanded = 0;
  let count = 0;
  let committed = false;
  try {
    for await (const entry of zipfile.eachEntry()) {
      count += 1;
      if (count > limits.maxEntries) throw new Error(`${label} has too many entries`);
      const isDirectory = entry.fileName.endsWith('/');
      const entryPath = isDirectory ? entry.fileName.slice(0, -1) : entry.fileName;
      assertSafeRelativePath(entryPath, isDirectory ? 'ZIP directory' : 'ZIP entry');
      if (isDirectory && entry.uncompressedSize !== 0) {
        throw new Error(`${label} has an invalid directory`);
      }
      if (seen.has(entryPath)) throw new Error(`${label} has a duplicate entry`);
      const portable = entryPath.normalize('NFC').toLowerCase();
      const collision = portableSeen.get(portable);
      if (collision) {
        throw new Error(
          `${label} contains a case-insensitive path collision: ${collision}, ${entryPath}`,
        );
      }
      seen.add(entryPath);
      portableSeen.set(portable, entryPath);
      if (isDirectory) continue;
      if (zipEntryIsSymlink(entry)) throw new Error(`${label} contains a symlink`);
      expanded += entry.uncompressedSize;
      if (expanded > limits.maxExpandedBytes) {
        throw new Error(`${label} exceeds expanded size limit`);
      }
      const data = await readZipEntry(zipfile, entry, limits.maxExpandedBytes);
      const output = resolveInside(temporaryRoot, entry.fileName, 'ZIP output path');
      await fs.promises.mkdir(path.dirname(output), { recursive: true });
      await fs.promises.writeFile(output, data);
    }
    await fs.promises.rm(destinationRoot, { recursive: true, force: true });
    await fs.promises.rename(temporaryRoot, destinationRoot);
    committed = true;
  } finally {
    if (!committed) {
      await fs.promises.rm(temporaryRoot, { recursive: true, force: true });
    }
  }
}

export function extractArchiveMember(input, memberPath, options = {}) {
  const isZip = input.length >= 4 && input[0] === 0x50 && input[1] === 0x4b;
  const isGzip = input.length >= 2 && input[0] === 0x1f && input[1] === 0x8b;
  const looksLikeTar =
    input.length >= 512 &&
    input.subarray(257, 262).toString('ascii') === 'ustar';
  if (isZip) return extractZipMember(input, memberPath, options);
  if (isGzip || looksLikeTar) {
    const entries = readTar(input, {
      ...options,
      label: options.label ?? 'TAR archive',
    });
    const match = entries.find((entry) => entry.path === memberPath);
    if (!match) throw new Error(`TAR archive is missing member: ${memberPath}`);
    return Buffer.from(match.data);
  }
  throw new Error('source archive format is not supported');
}

export { DEFAULT_ARCHIVE_LIMITS };
