import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  bootstrapSourcePlan,
  buildBootstrapBundle,
  verifyBootstrapBundleBuffer,
} from '../scripts/lib/bootstrap.mjs';
import { createDeterministicZip, readZipEntries } from '../scripts/lib/zip.mjs';
import {
  createFixtureRepo,
  makeFixedDescriptor,
} from './helpers/fixtures.mjs';
import {
  createStoredZip,
  rewriteZipEntryPaths,
  setZipEntryMode,
} from './helpers/zip-fixtures.mjs';

function bootstrapOnlyDescriptor(overrides = {}) {
  return makeFixedDescriptor({ id: 'fixture-bootstrap', ...overrides });
}

async function writeBootstrapFile(dir, relative, data) {
  const output = path.join(dir, ...relative.split('/'));
  await fs.promises.mkdir(path.dirname(output), { recursive: true });
  await fs.promises.writeFile(output, data);
}

test('bootstrap bundle includes only no-download sources in canonical sorted paths', async (t) => {
  const fixture = await createFixtureRepo([bootstrapOnlyDescriptor()]);
  t.after(() => fs.promises.rm(fixture.root, { recursive: true, force: true }));
  const descriptor = bootstrapOnlyDescriptor();
  const source = descriptor.source.files[0];
  const font = await fs.promises.readFile(
    path.join(fixture.bootstrap, 'source', 'fonts', source.fileName),
  );
  const extraPublic = {
    ...source,
    fileName: 'fixture-public.woff2',
    bootstrapKey: 'source/fonts/fixture-public.woff2',
    download: {
      url: 'https://example.com/fixture-public.woff2',
      sha256: source.sha256,
    },
  };
  descriptor.source.files.push(extraPublic);
  await writeBootstrapFile(fixture.bootstrap, extraPublic.bootstrapKey, font);

  const first = await buildBootstrapBundle({
    bootstrapDir: fixture.bootstrap,
    descriptors: [descriptor],
  });
  const second = await buildBootstrapBundle({
    bootstrapDir: fixture.bootstrap,
    descriptors: [descriptor],
  });
  assert.deepEqual(first.data, second.data);
  assert.equal(first.sha256, second.sha256);
  const entries = await readZipEntries(first.data, { strictDeterministic: true });
  assert.deepEqual(entries.map((entry) => entry.path), [source.bootstrapKey]);
  assert.equal(entries[0].data.toString('hex'), font.toString('hex'));
  assert.deepEqual(first.excluded, [extraPublic.bootstrapKey]);
  const verified = await verifyBootstrapBundleBuffer(first.data, [descriptor]);
  assert.deepEqual(verified.files.map((file) => file.path), [source.bootstrapKey]);
});

test('bootstrap generation rejects missing, undeclared, tampered, and non-regular inputs', async (t) => {
  const fixture = await createFixtureRepo([bootstrapOnlyDescriptor()]);
  t.after(() => fs.promises.rm(fixture.root, { recursive: true, force: true }));
  const descriptor = bootstrapOnlyDescriptor();
  const source = descriptor.source.files[0];
  const original = await fs.promises.readFile(
    path.join(fixture.bootstrap, source.bootstrapKey),
  );

  await fs.promises.rm(path.join(fixture.bootstrap, source.bootstrapKey));
  await assert.rejects(
    () => buildBootstrapBundle({ bootstrapDir: fixture.bootstrap, descriptors: [descriptor] }),
    /missing bootstrap input/,
  );

  await writeBootstrapFile(fixture.bootstrap, source.bootstrapKey, original);
  await writeBootstrapFile(
    fixture.bootstrap,
    'source/fonts/undeclared.woff2',
    Buffer.from('unexpected'),
  );
  await assert.rejects(
    () => buildBootstrapBundle({ bootstrapDir: fixture.bootstrap, descriptors: [descriptor] }),
    /undeclared file/,
  );

  await fs.promises.rm(path.join(fixture.bootstrap, 'source/fonts/undeclared.woff2'));
  const tampered = Buffer.from(original);
  tampered[0] ^= 0xff;
  await writeBootstrapFile(fixture.bootstrap, source.bootstrapKey, tampered);
  await assert.rejects(
    () => buildBootstrapBundle({ bootstrapDir: fixture.bootstrap, descriptors: [descriptor] }),
    /SHA-256 mismatch/,
  );

  await writeBootstrapFile(
    fixture.bootstrap,
    source.bootstrapKey,
    Buffer.concat([original, Buffer.from('x')]),
  );
  await assert.rejects(
    () => buildBootstrapBundle({ bootstrapDir: fixture.bootstrap, descriptors: [descriptor] }),
    /size mismatch/,
  );

  await writeBootstrapFile(fixture.bootstrap, source.bootstrapKey, original);
  await fs.promises.rm(path.join(fixture.bootstrap, source.bootstrapKey));
  const special = path.join(fixture.bootstrap, 'source', 'fonts', source.fileName);
  await fs.promises.mkdir(special);
  await assert.rejects(
    () => buildBootstrapBundle({ bootstrapDir: fixture.bootstrap, descriptors: [descriptor] }),
    /directory, not a file/,
  );
});

test('bootstrap verification rejects missing, extra, tampered, traversal, and link members', async (t) => {
  const fixture = await createFixtureRepo([bootstrapOnlyDescriptor()]);
  t.after(() => fs.promises.rm(fixture.root, { recursive: true, force: true }));
  const descriptor = bootstrapOnlyDescriptor();
  const source = descriptor.source.files[0];
  const original = await buildBootstrapBundle({
    bootstrapDir: fixture.bootstrap,
    descriptors: [descriptor],
  });

  assert.throws(
    () =>
      verifyBootstrapBundleBuffer(
        createDeterministicZip([]),
        [descriptor],
      ),
    /at least one file/,
  );

  const extra = await readZipEntries(original.data, { strictDeterministic: true });
  extra.push({ path: 'source/fonts/extra.woff2', data: Buffer.from('extra') });
  await assert.rejects(
    () => verifyBootstrapBundleBuffer(createDeterministicZip(extra), [descriptor]),
    /extra: source\/fonts\/extra\.woff2/,
  );

  const onlyExtra = createDeterministicZip([
    { path: 'source/fonts/other.woff2', data: Buffer.from('other') },
  ]);
  await assert.rejects(
    () => verifyBootstrapBundleBuffer(onlyExtra, [descriptor]),
    /missing: source\/fonts\/fixture-sans\.woff2/,
  );

  const tamperedEntries = await readZipEntries(original.data, { strictDeterministic: true });
  const tampered = Buffer.from(tamperedEntries[0].data);
  tampered[0] ^= 0xff;
  tamperedEntries[0].data = tampered;
  await assert.rejects(
    () =>
      verifyBootstrapBundleBuffer(
        createDeterministicZip(tamperedEntries),
        [descriptor],
      ),
    /SHA-256 mismatch/,
  );

  const traversal = rewriteZipEntryPaths(original.data, (name) => {
    const replacement = '../evil.woff2';
    if (name.length !== replacement.length) {
      return replacement.padEnd(name.length, '.');
    }
    return replacement;
  });
  await assert.rejects(
    () => verifyBootstrapBundleBuffer(traversal, [descriptor]),
    /invalid relative path|unsafe path segment|relative POSIX path/,
  );

  const link = setZipEntryMode(original.data, source.bootstrapKey, 0o120777);
  await assert.rejects(
    () => verifyBootstrapBundleBuffer(link, [descriptor]),
    /symlink/,
  );

  const hardlink = setZipEntryMode(original.data, source.bootstrapKey, 0o100000);
  await assert.rejects(
    () => verifyBootstrapBundleBuffer(hardlink, [descriptor]),
    /non-regular entry|metadata/,
  );
});

test('bootstrap verifier enforces exact member set and bounded expansion', async (t) => {
  const fixture = await createFixtureRepo([bootstrapOnlyDescriptor()]);
  t.after(() => fs.promises.rm(fixture.root, { recursive: true, force: true }));
  const descriptor = bootstrapOnlyDescriptor();
  const source = descriptor.source.files[0];
  const font = await fs.promises.readFile(
    path.join(fixture.bootstrap, source.bootstrapKey),
  );
  const onlySource = createDeterministicZip([{ path: source.bootstrapKey, data: font }]);
  assert.deepEqual(
    (await readZipEntries(onlySource, { strictDeterministic: true })).map((entry) => entry.path),
    [source.bootstrapKey],
  );
  await assert.rejects(
    () =>
      verifyBootstrapBundleBuffer(onlySource, [descriptor], {
        limits: {
          maxArchiveBytes: 1024 * 1024,
          maxExpandedBytes: 1,
          maxEntries: 10,
        },
      }),
    /expanded size limit/,
  );
  await assert.rejects(
    () => verifyBootstrapBundleBuffer(onlySource, [descriptor], {
      limits: {
        maxArchiveBytes: 1,
        maxExpandedBytes: 10,
        maxEntries: 10,
      },
    }),
    /archive size limit/,
  );

  const caseCollision = createStoredZip([
    { path: source.bootstrapKey, data: font },
    { path: source.bootstrapKey.toUpperCase(), data: font },
  ]);
  await assert.rejects(
    () => readZipEntries(caseCollision),
    /case-insensitive path collision/,
  );
});

test('bootstrap generator rejects symlinked source inputs', async (t) => {
  const fixture = await createFixtureRepo([bootstrapOnlyDescriptor()]);
  t.after(() => fs.promises.rm(fixture.root, { recursive: true, force: true }));
  const descriptor = bootstrapOnlyDescriptor();
  const source = descriptor.source.files[0];
  const sourcePath = path.join(fixture.bootstrap, source.bootstrapKey);
  const target = path.join(fixture.root, 'fixture-target.woff2');
  await fs.promises.rename(sourcePath, target);
  try {
    await fs.promises.symlink(target, sourcePath, 'file');
  } catch (error) {
    if (
      process.platform === 'win32' &&
      ['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)
    ) {
      const junctionTarget = path.join(fixture.root, 'junction-target');
      await fs.promises.mkdir(junctionTarget);
      await fs.promises.symlink(junctionTarget, sourcePath, 'junction');
    } else {
      t.skip(`symlink creation unavailable: ${error.code}`);
      return;
    }
  }
  await assert.rejects(
    () => buildBootstrapBundle({ bootstrapDir: fixture.bootstrap, descriptors: [descriptor] }),
    /must not be a symlink/,
  );
});

test('bootstrap verifier rejects non-normalized ZIP timestamps', async (t) => {
  const fixture = await createFixtureRepo([bootstrapOnlyDescriptor()]);
  t.after(() => fs.promises.rm(fixture.root, { recursive: true, force: true }));
  const descriptor = bootstrapOnlyDescriptor();
  const source = descriptor.source.files[0];
  const font = await fs.promises.readFile(
    path.join(fixture.bootstrap, source.bootstrapKey),
  );
  const unnormalized = createStoredZip([
    { path: source.bootstrapKey, data: font },
  ]);
  await assert.rejects(
    () => verifyBootstrapBundleBuffer(unnormalized, [descriptor]),
    /timestamp is not normalized/,
  );
});

test('bootstrap path planning rejects non-canonical, duplicate, and case-colliding sources', () => {
  const descriptor = bootstrapOnlyDescriptor();
  const bad = structuredClone(descriptor);
  bad.source.files[0].bootstrapKey = 'source/fonts/nested/fixture-sans.woff2';
  assert.throws(() => bootstrapSourcePlan([bad]), /canonical path/);

  const duplicate = structuredClone(descriptor);
  duplicate.source.files.push({ ...duplicate.source.files[0] });
  assert.throws(() => bootstrapSourcePlan([duplicate]), /declared more than once/);

  const collision = structuredClone(descriptor);
  collision.source.files[0].fileName = 'fixture-sans.woff2';
  collision.source.files.push({
    ...collision.source.files[0],
    fileName: 'Fixture-Sans.woff2',
    bootstrapKey: 'source/fonts/Fixture-Sans.woff2',
  });
  assert.throws(() => bootstrapSourcePlan([collision]), /case-insensitive/);
  assert.throws(
    () =>
      createDeterministicZip([
        { path: 'source/fonts/A.woff2', data: 'a' },
        { path: 'source/fonts/a.woff2', data: 'a' },
      ]),
    /case-insensitive/,
  );
});
