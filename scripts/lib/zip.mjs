import yauzl from 'yauzl';
import { DEFAULT_ARCHIVE_LIMITS } from './archive.mjs';
import { compareText } from './json.mjs';
import { assertSafeRelativePath } from './paths.mjs';

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_SIGNATURE = 0x06054b50;
const ZIP_VERSION = 20;
const ZIP_MADE_BY_UNIX = 0x0314;
const ZIP_UTF8_FLAG = 0x0800;
const ZIP_STORE = 0;
const DOS_TIME_1980 = 0;
const DOS_DATE_1980_01_01 = 0x0021;
const REGULAR_FILE_MODE = 0o100644;
const REGULAR_FILE_ATTRS = REGULAR_FILE_MODE * 0x10000;
const UINT32_MAX = 0xffffffff;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(data) {
  let value = 0xffffffff;
  for (const byte of data) {
    value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function portablePath(value) {
  return value.normalize('NFC').toLowerCase();
}

function validateEntryPaths(entries) {
  const seen = new Set();
  const portableSeen = new Map();
  for (const entry of entries) {
    assertSafeRelativePath(entry.path, 'ZIP entry');
    if (seen.has(entry.path)) throw new Error(`duplicate ZIP entry: ${entry.path}`);
    const portable = portablePath(entry.path);
    const collision = portableSeen.get(portable);
    if (collision) {
      throw new Error(
        `ZIP entries collide on a case-insensitive filesystem: ${collision}, ${entry.path}`,
      );
    }
    seen.add(entry.path);
    portableSeen.set(portable, entry.path);
  }
}

export function createDeterministicZip(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('ZIP archive must contain at least one file');
  }
  if (entries.length > 0xffff) throw new Error('ZIP archive has too many entries');
  const normalized = entries.map((entry) => ({
    path: entry.path,
    data: Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data),
  }));
  validateEntryPaths(normalized);
  normalized.sort((left, right) => compareText(left.path, right.path));

  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of normalized) {
    if (entry.data.length > UINT32_MAX) throw new Error('ZIP member is too large');
    const name = Buffer.from(entry.path, 'utf8');
    if (name.length > 0xffff) throw new Error(`ZIP entry name is too long: ${entry.path}`);
    const checksum = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_HEADER_SIGNATURE, 0);
    local.writeUInt16LE(ZIP_VERSION, 4);
    local.writeUInt16LE(ZIP_UTF8_FLAG, 6);
    local.writeUInt16LE(ZIP_STORE, 8);
    local.writeUInt16LE(DOS_TIME_1980, 10);
    local.writeUInt16LE(DOS_DATE_1980_01_01, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, entry.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_HEADER_SIGNATURE, 0);
    central.writeUInt16LE(ZIP_MADE_BY_UNIX, 4);
    central.writeUInt16LE(ZIP_VERSION, 6);
    central.writeUInt16LE(ZIP_UTF8_FLAG, 8);
    central.writeUInt16LE(ZIP_STORE, 10);
    central.writeUInt16LE(DOS_TIME_1980, 12);
    central.writeUInt16LE(DOS_DATE_1980_01_01, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(REGULAR_FILE_ATTRS, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);

    offset += local.length + name.length + entry.data.length;
    if (offset > UINT32_MAX) throw new Error('ZIP archive exceeds 32-bit offsets');
  }

  const centralOffset = offset;
  const central = Buffer.concat(centralParts);
  const centralEnd = centralOffset + central.length;
  if (centralEnd > UINT32_MAX) throw new Error('ZIP archive exceeds 32-bit offsets');

  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL_SIGNATURE, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(normalized.length, 8);
  end.writeUInt16LE(normalized.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, central, end]);
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
        chunks.push(Buffer.from(chunk));
      });
      stream.on('error', reject);
      stream.on('end', () => {
        const data = Buffer.concat(chunks);
        if (data.length !== entry.uncompressedSize) {
          reject(new Error(`ZIP member size mismatch: ${entry.fileName}`));
          return;
        }
        if (crc32(data) !== entry.crc32 >>> 0) {
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

function entryMode(entry) {
  return (entry.externalFileAttributes >>> 16) & 0xffff;
}

function assertStrictZipMetadata(entry) {
  const mode = entryMode(entry);
  if (entry.versionMadeBy !== ZIP_MADE_BY_UNIX) {
    throw new Error(`ZIP entry was not made by a normalized Unix writer: ${entry.fileName}`);
  }
  if (entry.versionNeededToExtract !== ZIP_VERSION) {
    throw new Error(`ZIP entry version is not normalized: ${entry.fileName}`);
  }
  if (entry.generalPurposeBitFlag !== ZIP_UTF8_FLAG || entry.compressionMethod !== ZIP_STORE) {
    throw new Error(`ZIP entry flags or compression are not normalized: ${entry.fileName}`);
  }
  if (
    entry.lastModFileTime !== DOS_TIME_1980 ||
    entry.lastModFileDate !== DOS_DATE_1980_01_01
  ) {
    throw new Error(`ZIP entry timestamp is not normalized: ${entry.fileName}`);
  }
  if (
    mode !== REGULAR_FILE_MODE ||
    entry.internalFileAttributes !== 0 ||
    entry.externalFileAttributes !== REGULAR_FILE_ATTRS
  ) {
    throw new Error(`ZIP entry metadata is not normalized: ${entry.fileName}`);
  }
  if ((entry.extraFields?.length ?? 0) !== 0 || (entry.comment ?? '') !== '') {
    throw new Error(`ZIP entry contains unexpected metadata: ${entry.fileName}`);
  }
}

export async function readZipEntries(
  input,
  {
    limits = DEFAULT_ARCHIVE_LIMITS,
    label = 'ZIP archive',
    strictDeterministic = false,
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

  const entries = [];
  const seen = new Set();
  const portableSeen = new Map();
  let expanded = 0;
  let count = 0;
  let previousPath = '';
  try {
    for await (const entry of zipfile.eachEntry()) {
      count += 1;
      if (count > limits.maxEntries) throw new Error(`${label} has too many entries`);
      if (entry.fileName.endsWith('/')) {
        throw new Error(`${label} contains a directory entry: ${entry.fileName}`);
      }
      assertSafeRelativePath(entry.fileName, `${label} entry`);
      if ((entry.generalPurposeBitFlag & 1) !== 0) {
        throw new Error(`${label} contains an encrypted entry: ${entry.fileName}`);
      }
      if (![0, 8].includes(entry.compressionMethod)) {
        throw new Error(`${label} uses an unsupported compression method: ${entry.fileName}`);
      }
      const mode = entryMode(entry);
      const fileType = mode & 0o170000;
      if (fileType === 0o120000) {
        throw new Error(`${label} contains a symlink: ${entry.fileName}`);
      }
      if (fileType !== 0o100000) {
        throw new Error(`${label} contains a non-regular entry: ${entry.fileName}`);
      }
      if (strictDeterministic) assertStrictZipMetadata(entry);
      if (seen.has(entry.fileName)) {
        throw new Error(`${label} contains a duplicate entry: ${entry.fileName}`);
      }
      const portable = portablePath(entry.fileName);
      const collision = portableSeen.get(portable);
      if (collision) {
        throw new Error(
          `${label} contains a case-insensitive path collision: ${collision}, ${entry.fileName}`,
        );
      }
      seen.add(entry.fileName);
      portableSeen.set(portable, entry.fileName);
      if (strictDeterministic && previousPath && entry.fileName < previousPath) {
        throw new Error(`${label} entries are not sorted: ${entry.fileName}`);
      }
      previousPath = entry.fileName;
      expanded += entry.uncompressedSize;
      if (expanded > limits.maxExpandedBytes) {
        throw new Error(`${label} exceeds expanded size limit`);
      }
      const data = await readZipEntry(zipfile, entry, limits.maxExpandedBytes);
      entries.push({ path: entry.fileName, data });
    }
  } finally {
    zipfile.close();
  }
  return entries;
}

export { crc32, REGULAR_FILE_MODE };
