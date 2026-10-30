import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildCatalog } from '../scripts/lib/catalog.mjs';
import { stableStringify, parseJson } from '../scripts/lib/json.mjs';
import {
  compareCatalogDirectories,
  verifyCatalogDirectory,
} from '../scripts/lib/verify.mjs';
import {
  createFixtureRepo,
  makeFixedDescriptor,
} from './helpers/fixtures.mjs';

function descriptorsForCatalog() {
  const secondSource = makeFixedDescriptor({ id: 'fixture-b' }).source.files[0];
  secondSource.fileName = 'fixture-b.woff2';
  secondSource.bootstrapKey = 'source/fonts/fixture-b.woff2';
  const secondDescriptor = makeFixedDescriptor({ id: 'fixture-b' });
  secondDescriptor.source.files = [secondSource];
  secondDescriptor.output.variants[0].sourceFile = 'fixture-b.woff2';
  secondDescriptor.output.variants[0].file = 'fixture-b.woff2';
  return [
    { descriptor: makeFixedDescriptor({ id: 'fixture-a' }) },
    { descriptor: secondDescriptor },
  ];
}

async function buildFixtureCatalog(t) {
  const descriptors = descriptorsForCatalog();
  const fixture = await createFixtureRepo(descriptors.map((item) => item.descriptor));
  t.after(() => fs.promises.rm(fixture.root, { recursive: true, force: true }));
  const outDir = path.join(fixture.root, 'artifacts');
  await buildCatalog({
    repoRoot: fixture.root,
    descriptors,
    outDir,
    catalogVersion: '1.0.0',
    baseUrl: 'https://example.com/fonts/releases/download',
    bootstrapDir: fixture.bootstrap,
  });
  return { fixture, descriptors, outDir };
}

test('catalog build is deterministic and release verification checks every pointer', async (t) => {
  const { fixture, descriptors, outDir } = await buildFixtureCatalog(t);
  const catalog = await verifyCatalogDirectory({ dir: outDir, descriptors });
  assert.deepEqual(Object.keys(catalog.families), ['fixture-a', 'fixture-b']);

  const repro = path.join(fixture.root, 'artifacts-repro');
  await buildCatalog({
    repoRoot: fixture.root,
    descriptors,
    outDir: repro,
    catalogVersion: '1.0.0',
    baseUrl: 'https://example.com/fonts/releases/download',
    bootstrapDir: fixture.bootstrap,
  });
  await compareCatalogDirectories(outDir, repro);
});

test('catalog verification rejects missing assets, hash drift, version drift, and extras', async (t) => {
  const { fixture, descriptors, outDir } = await buildFixtureCatalog(t);

  const missing = path.join(fixture.root, 'missing');
  await fs.promises.cp(outDir, missing, { recursive: true });
  await fs.promises.rm(path.join(missing, 'fixture-a-v1.0.0.tar.gz'));
  await assert.rejects(
    () => verifyCatalogDirectory({ dir: missing, descriptors }),
    /missing asset/,
  );

  const badHash = path.join(fixture.root, 'bad-hash');
  await fs.promises.cp(outDir, badHash, { recursive: true });
  const catalogPath = path.join(badHash, 'catalog.json');
  const catalog = parseJson(await fs.promises.readFile(catalogPath, 'utf8'));
  catalog.families['fixture-a'].package.sha256 = '0'.repeat(64);
  await fs.promises.writeFile(catalogPath, stableStringify(catalog));
  await assert.rejects(
    () => verifyCatalogDirectory({ dir: badHash, descriptors }),
    /SHA-256 mismatch/,
  );

  const driftDescriptors = structuredClone(descriptors);
  driftDescriptors[0].descriptor.version = '1.0.1';
  await assert.rejects(
    () => verifyCatalogDirectory({ dir: outDir, descriptors: driftDescriptors }),
    /pointer drift/,
  );

  const extra = path.join(fixture.root, 'extra');
  await fs.promises.cp(outDir, extra, { recursive: true });
  await fs.promises.writeFile(path.join(extra, 'unexpected.txt'), 'nope');
  await assert.rejects(
    () => verifyCatalogDirectory({ dir: extra, descriptors }),
    /extra: unexpected\.txt/,
  );

  const extraDirectory = path.join(fixture.root, 'extra-directory');
  await fs.promises.cp(outDir, extraDirectory, { recursive: true });
  await fs.promises.mkdir(path.join(extraDirectory, 'nested'), { recursive: true });
  await assert.rejects(
    () => verifyCatalogDirectory({ dir: extraDirectory, descriptors }),
    /non-regular entry/,
  );

  const missingBootstrap = path.join(fixture.root, 'missing-bootstrap');
  await fs.promises.cp(outDir, missingBootstrap, { recursive: true });
  const bootstrapName = 'bootstrap-sources-v1.0.0.zip';
  await fs.promises.rm(path.join(missingBootstrap, bootstrapName));
  await assert.rejects(
    () => verifyCatalogDirectory({ dir: missingBootstrap, descriptors }),
    /missing bootstrap archive/,
  );
});

test('catalog build rejects a bootstrap bundle that differs from the published hash', async (t) => {
  const descriptors = descriptorsForCatalog();
  const fixture = await createFixtureRepo(descriptors.map((item) => item.descriptor));
  t.after(() => fs.promises.rm(fixture.root, { recursive: true, force: true }));
  await assert.rejects(
    () =>
      buildCatalog({
        repoRoot: fixture.root,
        descriptors,
        outDir: path.join(fixture.root, 'artifacts-mismatch'),
        catalogVersion: '1.0.0',
        baseUrl: 'https://example.com/fonts/releases/download',
        bootstrapDir: fixture.bootstrap,
        expectedBootstrapSha256: '0'.repeat(64),
      }),
    /bootstrap bundle SHA-256 mismatch/,
  );
});

test('catalog build rejects a bootstrap SHA when every source has a public download', async (t) => {
  const descriptor = makeFixedDescriptor({ id: 'fixture-public' });
  descriptor.source.files[0].download = {
    url: 'https://example.com/fixture-sans.woff2',
    sha256: descriptor.source.files[0].sha256,
  };
  const fixture = await createFixtureRepo([descriptor]);
  t.after(() => fs.promises.rm(fixture.root, { recursive: true, force: true }));
  await assert.rejects(
    () =>
      buildCatalog({
        repoRoot: fixture.root,
        descriptors: [{ descriptor }],
        outDir: path.join(fixture.root, 'artifacts-unexpected-bootstrap'),
        catalogVersion: '1.0.0',
        baseUrl: 'https://example.com/fonts/releases/download',
        bootstrapDir: fixture.bootstrap,
        expectedBootstrapSha256: 'a'.repeat(64),
      }),
    /no bootstrap-only sources/,
  );
});
