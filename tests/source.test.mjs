import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  downloadBytes,
  resolveSourceFile,
} from '../scripts/lib/source.mjs';
import { fixtureRoot, hash } from './helpers/fixtures.mjs';

test('downloadBytes only accepts HTTPS and reports HTTP failures', async () => {
  await assert.rejects(
    () => downloadBytes('file:///tmp/font.ttf', { fetchImpl: fetch }),
    /HTTPS/,
  );
  await assert.rejects(
    () =>
      downloadBytes('https://example.com/missing', {
        fetchImpl: async () => new Response('missing', { status: 404 }),
      }),
    /HTTP 404/,
  );
  const data = await downloadBytes('https://example.com/font', {
    fetchImpl: async () =>
      new Response(Buffer.from('font-bytes'), {
        status: 200,
        headers: { 'content-length': '10' },
      }),
  });
  assert.equal(data.toString(), 'font-bytes');
});

test('bootstrap inputs verify size and SHA-256', async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'font-source-test-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const data = fs.readFileSync(path.join(fixtureRoot, 'fonts', 'fixture-sans.woff2'));
  const relative = 'source/fonts/fixture-sans.woff2';
  await fs.promises.mkdir(path.join(root, 'source', 'fonts'), { recursive: true });
  await fs.promises.writeFile(path.join(root, relative), data);
  const sourceFile = {
    fileName: 'fixture-sans.woff2',
    size: data.length,
    sha256: hash(data),
    bootstrapKey: relative,
  };
  const resolved = await resolveSourceFile(sourceFile, { bootstrapDir: root });
  assert.equal(resolved.origin, 'bootstrap');
  assert.deepEqual(resolved.data, data);

  await assert.rejects(
    () =>
      resolveSourceFile(
        { ...sourceFile, sha256: '0'.repeat(64) },
        { bootstrapDir: root },
      ),
    /SHA-256 mismatch/,
  );
  await assert.rejects(
    () => resolveSourceFile({ ...sourceFile, bootstrapKey: 'source/fonts/missing.woff2' }, { bootstrapDir: root }),
    /provide --bootstrap-dir/,
  );
});

test('source archives resolve a declared member and verify final hash', async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'font-download-test-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const zip = fs.readFileSync(path.join(fixtureRoot, 'fixtures.zip'));
  const font = fs.readFileSync(path.join(fixtureRoot, 'fonts', 'fixture-sans.ttf'));
  const sourceFile = {
    fileName: 'fixture-sans.ttf',
    size: font.length,
    sha256: hash(font),
    bootstrapKey: 'source/fonts/fixture-sans.ttf',
    download: {
      url: 'https://example.com/fixtures.zip',
      sha256: hash(zip),
      archiveMember: 'fonts/FixtureSans.ttf',
    },
  };
  const resolved = await resolveSourceFile(sourceFile, {
    cacheDir: path.join(root, 'cache'),
    fetchImpl: async () =>
      new Response(zip, {
        status: 200,
        headers: { 'content-length': String(zip.length) },
      }),
  });
  assert.equal(resolved.origin, 'download');
  assert.deepEqual(resolved.data, font);
});
