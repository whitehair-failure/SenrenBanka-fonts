import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  createDeterministicTarGz,
  extractArchiveMember,
  extractZipAll,
  readTar,
} from '../scripts/lib/archive.mjs';
import { fixtureRoot, hash } from './helpers/fixtures.mjs';

function updateTarChecksum(header) {
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
}

test('deterministic tar.gz is stable, sorted, and normalized', () => {
  const first = createDeterministicTarGz([
    { path: 'b.txt', data: 'bravo\n' },
    { path: 'a.txt', data: 'alpha\n' },
  ]);
  const second = createDeterministicTarGz([
    { path: 'a.txt', data: 'alpha\n' },
    { path: 'b.txt', data: 'bravo\n' },
  ]);
  assert.deepEqual(first, second);
  assert.equal(first.readUInt32LE(4), 0);
  assert.equal(first[8], 2);
  assert.equal(first[9], 255);
  const entries = readTar(first, { requireGzip: true, strictDeterministic: true });
  assert.deepEqual(entries.map((entry) => entry.path), ['a.txt', 'b.txt']);
  assert.equal(entries[0].data.toString(), 'alpha\n');
});

test('strict tar verification rejects unsorted, padded, trailing, and colliding data', () => {
  const archive = zlib.gunzipSync(
    createDeterministicTarGz([
      { path: 'a.txt', data: 'a' },
      { path: 'b.txt', data: 'b' },
    ]),
  );
  const unsorted = Buffer.from(archive);
  unsorted.fill(0, 0, 100);
  unsorted.write('b.txt', 0, 'utf8');
  unsorted.fill(0, 1024, 1124);
  unsorted.write('a.txt', 1024, 'utf8');
  updateTarChecksum(unsorted.subarray(0, 512));
  updateTarChecksum(unsorted.subarray(1024, 1536));
  assert.throws(
    () => readTar(unsorted, { strictDeterministic: true }),
    /not sorted/,
  );

  const single = zlib.gunzipSync(
    createDeterministicTarGz([{ path: 'a.txt', data: 'a' }]),
  );
  assert.throws(
    () =>
      readTar(Buffer.concat([single, Buffer.alloc(512)]), {
        strictDeterministic: true,
      }),
    /trailing data/,
  );

  const padded = Buffer.from(single);
  padded[512 + 1] = 1;
  assert.throws(
    () => readTar(padded, { strictDeterministic: true }),
    /nonzero padding/,
  );

  assert.throws(
    () =>
      createDeterministicTarGz([
        { path: 'A.txt', data: 'a' },
        { path: 'a.txt', data: 'b' },
      ]),
    /case-insensitive/,
  );
});

test('tar reader rejects path traversal, links, and duplicate entries', () => {
  const archive = zlib.gunzipSync(
    createDeterministicTarGz([
      { path: 'one.txt', data: '1' },
      { path: 'two.txt', data: '2' },
    ]),
  );

  const traversal = Buffer.from(archive);
  traversal.fill(0, 0, 100);
  traversal.write('../evil', 0, 'utf8');
  updateTarChecksum(traversal.subarray(0, 512));
  assert.throws(() => readTar(traversal, { strictDeterministic: true }), /unsafe path segment/);

  const linked = Buffer.from(archive);
  linked[156] = '2'.charCodeAt(0);
  updateTarChecksum(linked.subarray(0, 512));
  assert.throws(() => readTar(linked, { strictDeterministic: true }), /non-regular entry/);

  const duplicate = Buffer.from(archive);
  const secondHeader = 512 + 512;
  duplicate.fill(0, secondHeader, secondHeader + 100);
  duplicate.write('one.txt', secondHeader, 'utf8');
  updateTarChecksum(duplicate.subarray(secondHeader, secondHeader + 512));
  assert.throws(() => readTar(duplicate, { strictDeterministic: true }), /duplicate entry/);
});

test('ZIP extraction validates exact members, path traversal, symlinks, and CRC', async () => {
  const zip = await fs.promises.readFile(path.join(fixtureRoot, 'fixtures.zip'));
  const expected = await fs.promises.readFile(
    path.join(fixtureRoot, 'fonts', 'fixture-sans.ttf'),
  );
  const extracted = await extractArchiveMember(zip, 'fonts/FixtureSans.ttf');
  assert.equal(hash(extracted), hash(expected));

  const slip = await fs.promises.readFile(path.join(fixtureRoot, 'unsafe.zip'));
  await assert.rejects(
    () => extractArchiveMember(slip, 'fonts/FixtureSans.ttf'),
    /invalid relative path|unsafe path segment|symlink/,
  );
  const link = await fs.promises.readFile(path.join(fixtureRoot, 'unsafe-link.zip'));
  await assert.rejects(
    () => extractArchiveMember(link, 'link.ttf'),
    /symlink/,
  );

  const corrupted = await fs.promises.readFile(
    path.join(fixtureRoot, 'corrupt-crc.zip'),
  );
  await assert.rejects(
    () => extractArchiveMember(corrupted, 'fonts/FixtureSans.ttf'),
    /ZIP|CRC|invalid/i,
  );
});

test('ZIP directory extraction rejects unsafe archives before publishing files', async (t) => {
  const out = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'font-zip-out-'));
  t.after(() => fs.promises.rm(out, { recursive: true, force: true }));
  const sentinel = path.join(out, 'sentinel.txt');
  await fs.promises.writeFile(sentinel, 'keep\n');
  await assert.rejects(
    () =>
      extractZipAll(
        fs.readFileSync(path.join(fixtureRoot, 'unsafe-link.zip')),
        out,
      ),
    /symlink/,
  );
  assert.equal(await fs.promises.readFile(sentinel, 'utf8'), 'keep\n');
});
