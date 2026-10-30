import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  generateFontCss,
  inspectFont,
  intervalsFromCodePoints,
  intervalsOverlap,
  parseCssFontFaces,
  parseUnicodeRanges,
  renameSfntFont,
  validateFontMetadata,
} from '../scripts/lib/font.mjs';
import { fixtureRoot } from './helpers/fixtures.mjs';

test('font metadata and variation ranges are verified', () => {
  const font = fs.readFileSync(path.join(fixtureRoot, 'fonts', 'fixture-sans.woff2'));
  const inspection = inspectFont(font);
  assert.equal(inspection.metadata.familyName, 'Fixture Sans');
  const metadata = validateFontMetadata(
    inspection,
    { familyName: 'Fixture Sans', weight: '400', style: 'normal' },
    'fixture',
  );
  assert.ok(metadata.coverageCount >= 175);
  assert.throws(
    () =>
      validateFontMetadata(
        inspection,
        { familyName: 'Wrong Family', weight: '400', style: 'normal' },
        'fixture',
      ),
    /family mismatch/,
  );
});

test('unicode ranges normalize, overlap, and generate deterministic CSS', () => {
  const intervals = intervalsFromCodePoints([0x43, 0x41, 0x42, 0x46]);
  assert.deepEqual(intervals, [
    { min: 0x41, max: 0x43 },
    { min: 0x46, max: 0x46 },
  ]);
  assert.equal(intervalsOverlap(intervals[0], { min: 0x43, max: 0x45 }), true);
  assert.equal(
    intervalsOverlap(intervals[0], { min: 0x44, max: 0x45 }),
    false,
  );
  const css = generateFontCss({
    familyName: 'Fixture Sans',
    variants: [
      {
        file: 'fonts/test.woff2',
        weight: '400',
        style: 'normal',
        display: 'swap',
        unicodeRange: ['U+0041-0043'],
      },
    ],
  });
  const faces = parseCssFontFaces(css);
  assert.equal(faces[0].file, 'fonts/test.woff2');
  assert.deepEqual(faces[0].unicodeRange, ['U+0041-0043']);
  assert.throws(() => parseUnicodeRanges(['U+110000']), /U\+10FFFF/);
});

test('RFN rename changes user-facing names and preserves a valid sfnt checksum', () => {
  const input = fs.readFileSync(path.join(fixtureRoot, 'fonts', 'fixture-sans.ttf'));
  const renamed = renameSfntFont(input, {
    reservedNames: ['Fixture'],
    replacement: 'Derived',
  });
  const inspection = inspectFont(renamed, 'renamed fixture');
  assert.equal(inspection.metadata.familyName, 'Derived Sans');
  assert.equal(inspection.metadata.postscriptName, 'DerivedSans-Regular');
  assert.doesNotMatch(
    `${inspection.font.familyName} ${inspection.font.fullName}`,
    /Fixture/i,
  );
  const padded = Buffer.alloc(Math.ceil(renamed.length / 4) * 4);
  renamed.copy(padded);
  let checksum = 0;
  for (let offset = 0; offset < padded.length; offset += 4) {
    checksum = (checksum + padded.readUInt32BE(offset)) >>> 0;
  }
  assert.equal(checksum, 0xb1b0afba);
  assert.throws(
    () =>
      renameSfntFont(input, {
        reservedNames: ['Fixture'],
        replacement: 'Fixture Clone',
      }),
    /still contains a reserved name/,
  );
});
