import { Buffer } from 'node:buffer';
import { create } from 'fontkitten';
import { assertSafeRelativePath } from './paths.mjs';

const WIDTH_CLASS_PERCENT = {
  1: 50,
  2: 62.5,
  3: 75,
  4: 87.5,
  5: 100,
  6: 112.5,
  7: 125,
  8: 150,
  9: 200,
};

const PRIMARY_NAME_IDS = new Set([1, 2, 3, 4, 6, 16, 17, 18, 20, 21, 22, 25]);

function parsePercent(value, label) {
  if (typeof value === 'number') return value;
  if (!/^\d+(?:\.\d+)?%$/.test(value ?? '')) {
    throw new Error(`invalid ${label} percentage: ${value}`);
  }
  return Number.parseFloat(value);
}

function parseWeightRange(value) {
  const parts = value.split(' ').map(Number);
  return { min: Math.min(...parts), max: Math.max(...parts) };
}

function parseStretchRange(value) {
  const parts = value.split(' ').map((part) => parsePercent(part, 'stretch'));
  return { min: Math.min(...parts), max: Math.max(...parts) };
}

function axesForManifest(font) {
  const result = {};
  for (const [tag, axis] of Object.entries(font.variationAxes ?? {})) {
    result[tag] = {
      min: axis.min,
      default: axis.default,
      max: axis.max,
    };
  }
  return result;
}

export function inspectFont(data, label = 'font') {
  let font;
  try {
    font = create(data);
  } catch (error) {
    throw new Error(`${label} could not be parsed as a font: ${error.message}`);
  }
  if (font.isCollection) throw new Error(`${label} must be a single font, not a collection`);
  const os2 = font['OS/2'];
  const characterSet = new Set(
    [...font.characterSet].filter((codePoint) => !isUnicodeNoncharacter(codePoint)),
  );
  return {
    font,
    metadata: {
      familyName: font.familyName,
      subfamilyName: font.subfamilyName,
      postscriptName: font.postscriptName,
      format: font.type,
      weight: os2.usWeightClass,
      widthClass: os2.usWidthClass,
      italicAngle: font.italicAngle,
      coverageCount: characterSet.size,
      variationAxes: axesForManifest(font),
    },
    characterSet,
  };
}

export function validateFontMetadata(
  inspection,
  descriptors,
  label = 'font',
  { requireWoff2 = true } = {},
) {
  const expected = Array.isArray(descriptors) ? descriptors : [descriptors];
  const actualFamily = inspection.metadata.familyName;
  if (!expected.some((item) => item.familyName === actualFamily)) {
    throw new Error(
      `${label} family mismatch: expected ${expected.map((item) => item.familyName).join(' or ')}, got ${actualFamily}`,
    );
  }

  for (const descriptor of expected) {
    if (descriptor.familyName !== actualFamily) continue;
    if (requireWoff2 && inspection.metadata.format !== 'WOFF2') {
      throw new Error(`${label} must be WOFF2, got ${inspection.metadata.format}`);
    }
    const style = inspection.font['OS/2'].fsSelection;
    const actualStyle =
      style.italic || style.oblique || Math.abs(inspection.font.italicAngle) > 0.001
        ? 'italic'
        : 'normal';
    if (descriptor.style === 'normal' && actualStyle !== 'normal') {
      throw new Error(`${label} style mismatch: expected normal, got ${actualStyle}`);
    }
    if (descriptor.style !== 'normal' && actualStyle === 'normal') {
      throw new Error(`${label} style mismatch: expected ${descriptor.style}, got normal`);
    }

    const weight = parseWeightRange(descriptor.weight);
    const weightAxis = inspection.metadata.variationAxes.wght;
    if (weightAxis) {
      if (weightAxis.min !== weight.min || weightAxis.max !== weight.max) {
        throw new Error(
          `${label} weight range mismatch: expected ${weight.min}-${weight.max}, got ${weightAxis.min}-${weightAxis.max}`,
        );
      }
    } else if (weight.min !== weight.max || inspection.metadata.weight !== weight.min) {
      throw new Error(
        `${label} weight mismatch: expected ${descriptor.weight}, got ${inspection.metadata.weight}`,
      );
    }

    if (descriptor.stretch) {
      const stretch = parseStretchRange(descriptor.stretch);
      const widthAxis = inspection.metadata.variationAxes.wdth;
      if (widthAxis) {
        if (widthAxis.min !== stretch.min || widthAxis.max !== stretch.max) {
          throw new Error(
            `${label} stretch range mismatch: expected ${stretch.min}-${stretch.max}, got ${widthAxis.min}-${widthAxis.max}`,
          );
        }
      } else if (WIDTH_CLASS_PERCENT[inspection.metadata.widthClass] !== stretch.min) {
        throw new Error(`${label} stretch does not match its OS/2 width class`);
      }
    }

    for (const [axis, value] of Object.entries(descriptor.variationSettings ?? {})) {
      const range = inspection.metadata.variationAxes[axis];
      if (!range) throw new Error(`${label} is missing declared variation axis ${axis}`);
      if (value < range.min || value > range.max) {
        throw new Error(`${label} variation setting ${axis}=${value} is out of range`);
      }
    }
    return inspection.metadata;
  }
  throw new Error(`${label} metadata could not be matched`);
}

function parseHexToken(token) {
  const [startText, endText] = token.split('-');
  if (startText.includes('?')) {
    if (endText) throw new Error(`wildcard unicode range cannot have an end: ${token}`);
    if (!/^[0-9A-F?]+$/i.test(startText)) throw new Error(`invalid unicode range: ${token}`);
    const minText = startText.replaceAll('?', '0');
    const maxText = startText.replaceAll('?', 'F');
    return { min: Number.parseInt(minText, 16), max: Number.parseInt(maxText, 16) };
  }
  const min = Number.parseInt(startText, 16);
  const max = endText ? Number.parseInt(endText, 16) : min;
  if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) {
    throw new Error(`invalid unicode range: ${token}`);
  }
  if (max > 0x10ffff) throw new Error(`unicode range exceeds U+10FFFF: ${token}`);
  return { min, max };
}

export function parseUnicodeRanges(values) {
  const intervals = [];
  for (const value of values) {
    for (const rawToken of value.split(',')) {
      const token = rawToken.trim().toUpperCase();
      const match = /^U\+([0-9A-F?]{1,6}(?:-[0-9A-F]{1,6})?)$/.exec(token);
      if (!match) throw new Error(`invalid unicode-range token: ${rawToken}`);
      intervals.push(parseHexToken(match[1]));
    }
  }
  if (intervals.length === 0) throw new Error('unicode-range must not be empty');
  intervals.sort((left, right) => left.min - right.min || left.max - right.max);
  const merged = [];
  for (const interval of intervals) {
    const previous = merged.at(-1);
    if (!previous || interval.min > previous.max + 1) {
      merged.push({ ...interval });
    } else {
      previous.max = Math.max(previous.max, interval.max);
    }
  }
  return merged;
}

export function formatUnicodeRanges(intervals) {
  return intervals.map(({ min, max }) => {
    const start = min.toString(16).toUpperCase().padStart(4, '0');
    if (min === max) return `U+${start}`;
    const end = max.toString(16).toUpperCase().padStart(4, '0');
    return `U+${start}-${end}`;
  });
}

export function intervalsFromCodePoints(codePoints) {
  const sorted = [...new Set(codePoints)].sort((left, right) => left - right);
  const intervals = [];
  for (const codePoint of sorted) {
    const previous = intervals.at(-1);
    if (!previous || codePoint > previous.max + 1) {
      intervals.push({ min: codePoint, max: codePoint });
    } else {
      previous.max = codePoint;
    }
  }
  return intervals;
}

export function isUnicodeNoncharacter(codePoint) {
  return (
    (codePoint >= 0xfdd0 && codePoint <= 0xfdef) ||
    (codePoint & 0xffff) === 0xfffe ||
    (codePoint & 0xffff) === 0xffff
  );
}

export function intervalsOverlap(left, right) {
  return left.min <= right.max && right.min <= left.max;
}

export function intervalContains(intervals, codePoint) {
  let low = 0;
  let high = intervals.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const interval = intervals[middle];
    if (codePoint < interval.min) high = middle - 1;
    else if (codePoint > interval.max) low = middle + 1;
    else return true;
  }
  return false;
}

export function* codePointsInIntervals(intervals) {
  for (const interval of intervals) {
    for (let codePoint = interval.min; codePoint <= interval.max; codePoint += 1) {
      yield codePoint;
    }
  }
}

export function parseCssFontFaces(css, label = 'font.css') {
  const faces = [];
  const facePattern = /@font-face\s*\{([^}]*)\}/gi;
  let match;
  while ((match = facePattern.exec(css))) {
    const properties = new Map();
    const propertyPattern = /([a-z-]+)\s*:\s*([^;]+);/gi;
    let property;
    while ((property = propertyPattern.exec(match[1]))) {
      properties.set(property[1].toLowerCase(), property[2].trim());
    }
    const source = properties.get('src');
    if (!source) throw new Error(`${label} @font-face is missing src`);
    const urlMatch = /url\(\s*["']?(?:\.\/)?([^"')]+\.woff2)["']?\s*\)/i.exec(source);
    if (!urlMatch) throw new Error(`${label} @font-face src is not a WOFF2 URL`);
    const unicodeRange = properties.get('unicode-range');
    if (!unicodeRange) throw new Error(`${label} @font-face is missing unicode-range`);
    faces.push({
      file: assertSafeRelativePath(urlMatch[1], `${label} font URL`),
      unicodeRange: formatUnicodeRanges(parseUnicodeRanges([unicodeRange])),
      style: properties.get('font-style') ?? 'normal',
      weight: properties.get('font-weight') ?? '400',
      display: properties.get('font-display') ?? 'swap',
    });
  }
  if (faces.length === 0) throw new Error(`${label} contains no @font-face rules`);
  return faces;
}

function cssString(value) {
  return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

export function generateFontCss({ familyName, variants }) {
  const blocks = [];
  for (const variant of variants) {
    const lines = [
      '@font-face {',
      `  font-family: ${cssString(familyName)};`,
      `  font-style: ${variant.style};`,
      `  font-display: ${variant.display};`,
      `  font-weight: ${variant.weight};`,
    ];
    if (variant.stretch) lines.push(`  font-stretch: ${variant.stretch};`);
    lines.push(`  src: url("./${variant.file}") format("woff2");`);
    if (variant.unicodeRange?.length) {
      lines.push(`  unicode-range: ${variant.unicodeRange.join(', ')};`);
    }
    lines.push('}', '');
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n');
}

function readCString(buffer, offset, length) {
  return buffer.subarray(offset, offset + length).toString('ascii').replace(/\0.*$/, '');
}

function readUInt32(buffer, offset) {
  return buffer.readUInt32BE(offset);
}

function tableChecksum(data) {
  let sum = 0;
  const padded = Buffer.alloc(Math.ceil(data.length / 4) * 4, 0);
  data.copy(padded);
  for (let offset = 0; offset < padded.length; offset += 4) {
    sum = (sum + padded.readUInt32BE(offset)) >>> 0;
  }
  return sum;
}

function decodeNameRecord(record, stringPool, platformId) {
  const data = stringPool.subarray(record.offset, record.offset + record.length);
  if (platformId === 0 || platformId === 3) {
    if (data.length % 2 !== 0) throw new Error('font name table contains malformed UTF-16');
    return Buffer.from(data).swap16().toString('utf16le');
  }
  return data.toString('latin1');
}

function encodeNameRecord(text, platformId) {
  if (platformId === 0 || platformId === 3) {
    return Buffer.from(text, 'utf16le').swap16();
  }
  if ([...text].some((character) => character.codePointAt(0) > 0x7f)) {
    throw new Error('RFN rename requires pure ASCII for legacy Mac name records');
  }
  return Buffer.from(text, 'latin1');
}

/**
 * Rename the user-facing name table of a TrueType font. CFF/OTF sources fail
 * closed because their internal name strings cannot be rewritten here.
 */
export function renameSfntFont(data, { reservedNames, replacement }) {
  if (!Array.isArray(reservedNames) || reservedNames.length === 0) {
    throw new Error('RFN rename requires at least one reserved name');
  }
  if (
    reservedNames.some((name) =>
      replacement.toLowerCase().includes(name.toLowerCase()),
    )
  ) {
    throw new Error('RFN replacement still contains a reserved name');
  }
  const signature = data.subarray(0, 4);
  if (signature.readUInt32BE(0) !== 0x00010000) {
    throw new Error(
      'RFN rename currently supports TrueType TTF sources only; CFF/OTF name rewriting is not implemented',
    );
  }
  const numTables = data.readUInt16BE(4);
  const records = [];
  let nameRecord = null;
  let headRecord = null;
  for (let index = 0; index < numTables; index += 1) {
    const offset = 12 + index * 16;
    const tag = readCString(data, offset, 4);
    const checksum = readUInt32(data, offset + 4);
    const tableOffset = readUInt32(data, offset + 8);
    const length = readUInt32(data, offset + 12);
    const record = { offset, tag, checksum, tableOffset, length };
    records.push(record);
    if (tag === 'name') nameRecord = record;
    if (tag === 'head') headRecord = record;
  }
  if (!nameRecord || !headRecord) throw new Error('font is missing a name or head table');

  const nameStart = nameRecord.tableOffset;
  const format = data.readUInt16BE(nameStart);
  if (format !== 0) throw new Error(`unsupported name table format ${format}`);
  const count = data.readUInt16BE(nameStart + 2);
  const stringOffset = data.readUInt16BE(nameStart + 4);
  const stringPool = data.subarray(nameStart + stringOffset, nameStart + nameRecord.length);
  const nameEntries = [];
  for (let index = 0; index < count; index += 1) {
    const offset = nameStart + 6 + index * 12;
    const platformId = data.readUInt16BE(offset);
    const entry = {
      platformId,
      encodingId: data.readUInt16BE(offset + 2),
      languageId: data.readUInt16BE(offset + 4),
      nameId: data.readUInt16BE(offset + 6),
      length: data.readUInt16BE(offset + 8),
      offset: data.readUInt16BE(offset + 10),
    };
    if (PRIMARY_NAME_IDS.has(entry.nameId)) {
      const text = decodeNameRecord(entry, stringPool, platformId);
      let renamed = text;
      for (const reserved of reservedNames) {
        renamed = renamed.replace(
          new RegExp(reserved.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'),
          () => replacement,
        );
      }
      entry.data = encodeNameRecord(renamed, platformId);
    } else {
      entry.data = Buffer.from(
        stringPool.subarray(entry.offset, entry.offset + entry.length),
      );
    }
    nameEntries.push(entry);
  }

  const header = Buffer.alloc(6 + nameEntries.length * 12);
  header.writeUInt16BE(0, 0);
  header.writeUInt16BE(nameEntries.length, 2);
  header.writeUInt16BE(header.length, 4);
  let stringDataLength = 0;
  nameEntries.forEach((entry, index) => {
    const offset = 6 + index * 12;
    header.writeUInt16BE(entry.platformId, offset);
    header.writeUInt16BE(entry.encodingId, offset + 2);
    header.writeUInt16BE(entry.languageId, offset + 4);
    header.writeUInt16BE(entry.nameId, offset + 6);
    header.writeUInt16BE(entry.data.length, offset + 8);
    header.writeUInt16BE(stringDataLength, offset + 10);
    stringDataLength += entry.data.length;
  });
  const newNameTable = Buffer.concat([header, ...nameEntries.map((entry) => entry.data)]);

  const oldHead = data.subarray(headRecord.tableOffset, headRecord.tableOffset + headRecord.length);
  const newHead = Buffer.from(oldHead);
  newHead.writeUInt32BE(0, 8);
  const newHeadChecksum = tableChecksum(newHead);

  const nameDirectory = records.find((record) => record.tag === 'name');
  nameDirectory.length = newNameTable.length;
  nameDirectory.checksum = tableChecksum(newNameTable);
  if (newNameTable.length > nameRecord.length) {
    throw new Error('RFN rename unexpectedly grew the name table');
  }

  const output = Buffer.from(data);
  newNameTable.copy(output, nameRecord.tableOffset);
  newHead.copy(output, headRecord.tableOffset);
  output.writeUInt32BE(nameDirectory.checksum, nameDirectory.offset + 4);
  output.writeUInt32BE(newNameTable.length, nameDirectory.offset + 12);
  output.writeUInt32BE(newHeadChecksum, headRecord.offset + 4);
  const checksumAdjustment =
    (0xb1b0afba - tableChecksum(output)) >>> 0;
  output.writeUInt32BE(checksumAdjustment, headRecord.tableOffset + 8);

  const inspection = inspectFont(output, 'renamed font');
  for (const reserved of reservedNames) {
    const primaryNames = [
      inspection.font.familyName,
      inspection.font.subfamilyName,
      inspection.font.fullName,
      inspection.font.postscriptName,
      inspection.font.getName('typographicFamily'),
      inspection.font.getName('typographicSubfamily'),
      inspection.font.getName('wwsFamilyName'),
      inspection.font.getName('wwsSubfamilyName'),
    ]
      .filter(Boolean)
      .join(' ');
    if (primaryNames.toLowerCase().includes(reserved.toLowerCase())) {
      throw new Error(`RFN rename left reserved name ${reserved} in the primary font names`);
    }
  }
  return output;
}
