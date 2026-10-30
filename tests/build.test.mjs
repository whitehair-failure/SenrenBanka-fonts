import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  createDeterministicTarGz,
  readTar as readArchive,
} from '../scripts/lib/archive.mjs';
import {
  formatUnicodeRanges,
  generateFontCss,
  inspectFont,
  intervalsFromCodePoints,
} from '../scripts/lib/font.mjs';
import { stableStringify } from '../scripts/lib/json.mjs';
import {
  verifyFamilyPair,
  verifyFamilyPackageBuffer,
  verifySourceArchiveBuffer,
} from '../scripts/lib/verify.mjs';
import {
  makeCoreDescriptor,
  makeFixedDescriptor,
  createFixtureRepo,
  repoRoot,
} from './helpers/fixtures.mjs';

const execFileAsync = promisify(execFile);
const child = path.join(repoRoot, 'tests', 'helpers', 'build-child.mjs');

async function buildFixture({ kind, root, out }) {
  await fs.promises.mkdir(out, { recursive: true });
  await execFileAsync(process.execPath, [child, '--kind', kind, '--root', root, '--out', out], {
    timeout: 60_000,
  });
  return JSON.parse(await fs.promises.readFile(path.join(out, 'result.json'), 'utf8'));
}

test('fixture data drives a deterministic fixed family package and source archive', async (t) => {
  const descriptors = [makeFixedDescriptor()];
  const fixture = await createFixtureRepo(descriptors);
  t.after(() => fs.promises.rm(fixture.root, { recursive: true, force: true }));
  const first = await buildFixture({
    kind: 'fixed',
    root: fixture.root,
    out: path.join(fixture.root, 'out-1'),
  });
  const second = await buildFixture({
    kind: 'fixed',
    root: fixture.root,
    out: path.join(fixture.root, 'out-2'),
  });
  assert.equal(first.packageSha256, second.packageSha256);
  assert.equal(first.sourceSha256, second.sourceSha256);
  assert.equal(first.variants, 1);

  const packageData = await fs.promises.readFile(
    path.join(fixture.root, 'out-1', first.packageFileName),
  );
  const sourceData = await fs.promises.readFile(
    path.join(fixture.root, 'out-1', first.sourceFileName),
  );
  const verified = verifyFamilyPair(packageData, sourceData, descriptors[0]);
  assert.equal(verified.family.manifest.role, 'fixed');
  assert.equal(verified.family.manifest.variants[0].font.familyName, 'Fixture Sans');

  const sourceEntries = readArchive(sourceData, {
    strictDeterministic: true,
    requireGzip: true,
  });
  await fs.promises.rm(path.join(fixture.root, 'bootstrap'), { recursive: true });
  for (const entry of sourceEntries) {
    const output = path.join(fixture.root, 'bootstrap', ...entry.path.split('/'));
    await fs.promises.mkdir(path.dirname(output), { recursive: true });
    await fs.promises.writeFile(output, entry.data);
  }
  const rebuilt = await buildFixture({
    kind: 'fixed',
    root: fixture.root,
    out: path.join(fixture.root, 'out-rebuilt'),
  });
  assert.equal(rebuilt.packageSha256, first.packageSha256);
  assert.equal(rebuilt.sourceSha256, first.sourceSha256);
});

test('fixture core family produces multiple disjoint shards covering the source cmap', async (t) => {
  const descriptors = [makeCoreDescriptor()];
  const fixture = await createFixtureRepo(descriptors);
  t.after(() => fs.promises.rm(fixture.root, { recursive: true, force: true }));
  const built = await buildFixture({
    kind: 'core',
    root: fixture.root,
    out: path.join(fixture.root, 'out'),
  });
  assert.ok(built.variants > 1);
  const packageData = await fs.promises.readFile(
    path.join(fixture.root, 'out', built.packageFileName),
  );
  const sourceData = await fs.promises.readFile(
    path.join(fixture.root, 'out', built.sourceFileName),
  );
  const verified = verifyFamilyPair(packageData, sourceData, descriptors[0]);
  assert.ok(verified.family.manifest.variants.length > 1);
});

test('core pair verification rejects a package that no longer covers the source cmap', async (t) => {
  const descriptor = makeCoreDescriptor();
  const fixture = await createFixtureRepo([descriptor]);
  t.after(() => fs.promises.rm(fixture.root, { recursive: true, force: true }));
  const built = await buildFixture({
    kind: 'core',
    root: fixture.root,
    out: path.join(fixture.root, 'out'),
  });
  const packageData = await fs.promises.readFile(
    path.join(fixture.root, 'out', built.packageFileName),
  );
  const sourceData = await fs.promises.readFile(
    path.join(fixture.root, 'out', built.sourceFileName),
  );
  const entries = readArchive(packageData, {
    strictDeterministic: true,
    requireGzip: true,
  });
  const manifestEntry = entries.find((entry) => entry.path === 'manifest.json');
  const manifest = JSON.parse(manifestEntry.data.toString('utf8'));
  const firstVariant = manifest.variants[0];
  const firstVariantEntry = entries.find(
    (entry) => entry.path === firstVariant.file,
  );
  const firstInspection = inspectFont(firstVariantEntry.data);
  const chosen = [...firstInspection.characterSet].sort((left, right) => left - right)[0];
  firstVariant.unicodeRange = formatUnicodeRanges(intervalsFromCodePoints([chosen]));
  firstVariant.cmapAliases = [...firstInspection.characterSet]
    .filter((codePoint) => codePoint !== chosen)
    .sort((left, right) => left - right);
  const tampered = entries.map((entry) => {
    if (entry.path === 'manifest.json') {
      return { ...entry, data: Buffer.from(stableStringify(manifest)) };
    }
    if (entry.path === 'font.css') {
      return {
        ...entry,
        data: Buffer.from(
          generateFontCss({
            familyName: manifest.familyName,
            variants: manifest.variants,
          }),
        ),
      };
    }
    return entry;
  });
  assert.throws(
    () =>
      verifyFamilyPair(
        createDeterministicTarGz(tampered),
        sourceData,
        descriptor,
      ),
    /do not cover source character/,
  );
});

test('source verification rejects a nested source path with an undeclared location', async (t) => {
  const descriptor = makeFixedDescriptor();
  const fixture = await createFixtureRepo([descriptor]);
  t.after(() => fs.promises.rm(fixture.root, { recursive: true, force: true }));
  const built = await buildFixture({
    kind: 'fixed',
    root: fixture.root,
    out: path.join(fixture.root, 'out'),
  });
  const sourceData = await fs.promises.readFile(
    path.join(fixture.root, 'out', built.sourceFileName),
  );
  const entries = readArchive(sourceData, {
    strictDeterministic: true,
    requireGzip: true,
  });
  const manifestEntry = entries.find(
    (entry) => entry.path === 'source-manifest.json',
  );
  const manifest = JSON.parse(manifestEntry.data.toString('utf8'));
  const originalPath = manifest.files[0].file;
  const nestedPath = `source/fonts/nested/${originalPath.slice('source/fonts/'.length)}`;
  manifest.files[0].file = nestedPath;
  const tampered = entries.map((entry) => {
    if (entry.path === 'source-manifest.json') {
      return { ...entry, data: Buffer.from(stableStringify(manifest)) };
    }
    if (entry.path === originalPath) {
      return { ...entry, path: nestedPath };
    }
    return entry;
  });
  assert.throws(
    () => verifySourceArchiveBuffer(createDeterministicTarGz(tampered), descriptor),
    /undeclared file/,
  );
});

test('package verification rejects changed, missing, and undeclared files', async (t) => {
  const descriptor = makeFixedDescriptor();
  const fixture = await createFixtureRepo([descriptor]);
  t.after(() => fs.promises.rm(fixture.root, { recursive: true, force: true }));
  const built = await buildFixture({
    kind: 'fixed',
    root: fixture.root,
    out: path.join(fixture.root, 'out'),
  });
  const original = await fs.promises.readFile(
    path.join(fixture.root, 'out', built.packageFileName),
  );
  const entries = readArchive(original, {
    strictDeterministic: true,
    requireGzip: true,
  });

  const tampered = entries.map((entry) => ({ ...entry }));
  const font = tampered.find((entry) => entry.path.startsWith('fonts/'));
  const changed = Buffer.from(font.data);
  changed[changed.length - 1] ^= 0xff;
  font.data = changed;
  assert.throws(
    () =>
      verifyFamilyPackageBuffer(
        createDeterministicTarGz(tampered),
        descriptor,
      ),
    /SHA-256 mismatch/,
  );

  const missing = entries.filter((entry) => entry.path !== 'manifest.json');
  assert.throws(
    () =>
      verifyFamilyPackageBuffer(
        createDeterministicTarGz(missing),
        descriptor,
      ),
    /manifest\.json/,
  );

  const extra = [...entries, { path: 'extras/undeclared.bin', data: Buffer.from('x') }];
  assert.throws(
    () =>
      verifyFamilyPackageBuffer(
        createDeterministicTarGz(extra),
        descriptor,
      ),
    /extra: extras\/undeclared\.bin/,
  );
});
