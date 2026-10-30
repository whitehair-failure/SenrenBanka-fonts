import { crc32 } from '../../scripts/lib/zip.mjs';

function findEndOfCentralDirectory(data) {
  for (let offset = data.length - 22; offset >= 0; offset -= 1) {
    if (data.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error('fixture ZIP has no end of central directory');
}

export function rewriteZipEntryPaths(data, rewrite) {
  const output = Buffer.from(data);
  const endOffset = findEndOfCentralDirectory(output);
  const entryCount = output.readUInt16LE(endOffset + 10);
  const centralOffset = output.readUInt32LE(endOffset + 16);
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (output.readUInt32LE(cursor) !== 0x02014b50) throw new Error('bad central header');
    const nameLength = output.readUInt16LE(cursor + 28);
    const extraLength = output.readUInt16LE(cursor + 30);
    const commentLength = output.readUInt16LE(cursor + 32);
    const oldName = output.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    const newName = rewrite(oldName);
    const encoded = Buffer.from(newName, 'utf8');
    if (encoded.length !== nameLength) {
      throw new Error('fixture rewrite must preserve the UTF-8 name byte length');
    }
    encoded.copy(output, cursor + 46);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return output;
}

export function setZipEntryMode(data, entryName, mode) {
  const output = Buffer.from(data);
  const endOffset = findEndOfCentralDirectory(output);
  const entryCount = output.readUInt16LE(endOffset + 10);
  const centralOffset = output.readUInt32LE(endOffset + 16);
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    const nameLength = output.readUInt16LE(cursor + 28);
    const extraLength = output.readUInt16LE(cursor + 30);
    const commentLength = output.readUInt16LE(cursor + 32);
    const name = output.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    if (name === entryName) {
      output.writeUInt32LE((mode * 0x10000) >>> 0, cursor + 38);
      return output;
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`fixture ZIP has no entry ${entryName}`);
}

export function createStoredZip(entries, { mode = 0o100644 } = {}) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of [...entries].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    const name = Buffer.from(entry.path, 'utf8');
    const data = Buffer.from(entry.data);
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((mode * 0x10000) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += 30 + name.length + data.length;
  }
  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, central, end]);
}
