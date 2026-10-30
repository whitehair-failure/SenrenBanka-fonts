import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sha256 } from '../scripts/lib/hash.mjs';
import { publishCatalog } from '../scripts/lib/publish.mjs';

function catalogFixture() {
  const asset = {
    releaseTag: 'font-fixture-a-v1.0.0',
    fileName: 'fixture-a-v1.0.0.tar.gz',
    sha256: 'a'.repeat(64),
    size: 10,
  };
  return {
    schemaVersion: 1,
    catalogVersion: '1.0.0',
    baseUrl: 'https://example.com/releases/download',
    families: {
      'fixture-a': {
        version: '1.0.0',
        role: 'fixed',
        package: asset,
        source: {
          ...asset,
          fileName: 'fixture-a-v1.0.0-source.tar.gz',
        },
      },
    },
  };
}

function bootstrapReleaseFixture() {
  const catalog = catalogFixture();
  return {
    catalog,
    bootstrapFiles: [
      'bootstrap-sources-v1.0.0.zip',
      'bootstrap-sources-v1.0.0.zip.sha256',
    ],
  };
}

function successfulRunner({ failEdit = false } = {}) {
  const calls = [];
  return {
    calls,
    async run(call) {
      calls.push(call);
      const args = call.args;
      if (args[0] === 'api' && args[1]?.includes('immutable-releases')) {
        return { status: 0, stdout: 'true\n', stderr: '' };
      }
      if (args[0] === 'api' && args[1]?.includes('/git/ref/tags/')) {
        return { status: 1, stdout: '', stderr: 'HTTP 404: Not Found' };
      }
      if (args[0] === 'release' && args[1] === 'view') {
        return { status: 1, stdout: '', stderr: 'release not found' };
      }
      if (args[0] === 'release' && args[1] === 'edit' && failEdit) {
        return { status: 1, stdout: '', stderr: 'boom' };
      }
      return { status: 0, stdout: '', stderr: '' };
    },
  };
}

const baseOptions = {
  dir: path.resolve('artifacts'),
  repo: 'owner/fonts',
  catalogVersion: '1.0.0',
  targetSha: 'a'.repeat(40),
  catalog: catalogFixture(),
};

test('publish preflights immutable releases and existing tags before creating drafts', async () => {
  const runner = successfulRunner();
  const result = await publishCatalog({ ...baseOptions, run: runner.run });
  assert.equal(result.releases.at(-1), 'catalog-v1.0.0');
  const firstCreate = runner.calls.findIndex(
    (call) => call.args[0] === 'release' && call.args[1] === 'create',
  );
  assert.ok(firstCreate > 0);
  const immutableCheck = runner.calls.findIndex((call) =>
    call.args[1]?.includes('immutable-releases'),
  );
  assert.ok(immutableCheck < firstCreate);
  assert.ok(
    runner.calls
      .slice(0, firstCreate)
      .every((call) => !(call.args[0] === 'release' && call.args[1] === 'create')),
  );
});

test('publishing aborts when Immutable Releases is disabled', async () => {
  const calls = [];
  await assert.rejects(
    () =>
      publishCatalog({
        ...baseOptions,
        run: async (call) => {
          calls.push(call);
          return { status: 0, stdout: 'false\n', stderr: '' };
        },
      }),
    /Immutable Releases/,
  );
  assert.equal(
    calls.some((call) => call.args[0] === 'release' && call.args[1] === 'create'),
    false,
  );
});

test('failed draft workflow removes drafts and never publishes a partial catalog', async () => {
  const runner = successfulRunner({ failEdit: true });
  await assert.rejects(
    () => publishCatalog({ ...baseOptions, run: runner.run }),
    /failed to publish/,
  );
  const publishIndex = runner.calls.findIndex(
    (call) => call.args[0] === 'release' && call.args[1] === 'edit',
  );
  assert.ok(publishIndex > 0);
  const laterCalls = runner.calls.slice(publishIndex + 1);
  assert.equal(
    laterCalls.some(
      (call) =>
        call.args[0] === 'release' &&
        call.args[1] === 'edit' &&
        call.args[2] === 'catalog-v1.0.0',
    ),
    false,
  );
});

test('a failed release create cleans up a draft that was created before the error', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'font-publish-fail-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const catalog = catalogFixture();
  const files = [
    catalog.families['fixture-a'].package.fileName,
    `${catalog.families['fixture-a'].package.fileName}.sha256`,
    catalog.families['fixture-a'].source.fileName,
    `${catalog.families['fixture-a'].source.fileName}.sha256`,
    'catalog.json',
    'catalog.json.sha256',
    'SHA256SUMS',
  ];
  for (const fileName of files) {
    await fs.promises.writeFile(path.join(dir, fileName), `fixture:${fileName}\n`);
  }
  const calls = [];
  const runner = {
    async run(call) {
      calls.push(call);
      const args = call.args;
      if (args[0] === 'api' && args[1]?.includes('immutable-releases')) {
        return { status: 0, stdout: 'true\n', stderr: '' };
      }
      if (args[0] === 'api' && args[1]?.includes('/git/ref/tags/')) {
        return { status: 1, stdout: '', stderr: 'HTTP 404: Not Found' };
      }
      if (args[0] === 'release' && args[1] === 'view') {
        if (args.includes('isDraft')) {
          return { status: 0, stdout: '{"isDraft":true}\n', stderr: '' };
        }
        return { status: 1, stdout: '', stderr: 'release not found' };
      }
      if (args[0] === 'release' && args[1] === 'create') {
        return { status: 1, stdout: '', stderr: 'upload failed' };
      }
      return { status: 0, stdout: '', stderr: '' };
    },
  };
  await assert.rejects(
    () => publishCatalog({ ...baseOptions, dir, catalog, run: runner.run }),
    /failed to create draft release/,
  );
  assert.ok(
    calls.some(
      (call) =>
        call.args[0] === 'release' &&
        call.args[1] === 'delete' &&
        call.args[2] === 'font-fixture-a-v1.0.0',
    ),
  );
});

test('an unchanged existing family release is reused while a new catalog tag is created', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'font-publish-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const catalog = catalogFixture();
  const familyFiles = [
    catalog.families['fixture-a'].package.fileName,
    `${catalog.families['fixture-a'].package.fileName}.sha256`,
    catalog.families['fixture-a'].source.fileName,
    `${catalog.families['fixture-a'].source.fileName}.sha256`,
    'catalog.json',
    'catalog.json.sha256',
    'SHA256SUMS',
  ];
  const contents = new Map();
  for (const fileName of familyFiles) {
    const data = Buffer.from(`fixture:${fileName}\n`);
    contents.set(fileName, data);
    await fs.promises.writeFile(path.join(dir, fileName), data);
  }

  const calls = [];
  const runner = {
    async run(call) {
      calls.push(call);
      const args = call.args;
      if (args[0] === 'api' && args[1]?.includes('immutable-releases')) {
        return { status: 0, stdout: 'true\n', stderr: '' };
      }
      if (args[0] === 'api' && args[1]?.includes('font-fixture-a-v1.0.0')) {
        return { status: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'api' && args[1]?.includes('catalog-v1.0.0')) {
        return { status: 1, stdout: '', stderr: 'HTTP 404: Not Found' };
      }
      if (args[0] === 'release' && args[1] === 'view') {
        if (args.includes('tagName,isDraft,assets')) {
          return {
            status: 0,
            stdout: JSON.stringify({
              tagName: 'font-fixture-a-v1.0.0',
              isDraft: false,
              assets: [...contents.entries()]
                .filter(([name]) => name.startsWith('fixture-a-'))
                .map(([name, data]) => ({
                  name,
                  size: data.length,
                  digest: `sha256:${sha256(data)}`,
                })),
            }),
            stderr: '',
          };
        }
        return { status: 1, stdout: '', stderr: 'release not found' };
      }
      return { status: 0, stdout: '', stderr: '' };
    },
  };

  const result = await publishCatalog({
    ...baseOptions,
    dir,
    catalog,
    run: runner.run,
  });
  assert.ok(result.releases.includes('font-fixture-a-v1.0.0'));
  assert.equal(
    calls.some(
      (call) =>
        call.args[0] === 'release' &&
        call.args[1] === 'create' &&
        call.args[2] === 'font-fixture-a-v1.0.0',
    ),
    false,
  );
  assert.equal(
    calls.some(
      (call) =>
        call.args[0] === 'release' &&
        call.args[1] === 'create' &&
        call.args[2] === 'catalog-v1.0.0',
    ),
    true,
  );
});

test('dry-run records the plan without invoking the release runner', async () => {
  let invoked = false;
  const result = await publishCatalog({
    ...baseOptions,
    dryRun: true,
    run: async () => {
      invoked = true;
      throw new Error('must not run');
    },
  });
  assert.equal(invoked, false);
  assert.equal(result.dryRun, true);
  assert.ok(result.calls.some((call) => call.args.includes('--draft')));
});

test('catalog release uploads bootstrap archive when it exists in the artifact set', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'font-publish-bootstrap-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const { catalog, bootstrapFiles } = bootstrapReleaseFixture();
  for (const fileName of [
    'catalog.json',
    'catalog.json.sha256',
    'SHA256SUMS',
    ...bootstrapFiles,
    catalog.families['fixture-a'].package.fileName,
    `${catalog.families['fixture-a'].package.fileName}.sha256`,
    catalog.families['fixture-a'].source.fileName,
    `${catalog.families['fixture-a'].source.fileName}.sha256`,
  ]) {
    await fs.promises.writeFile(path.join(dir, fileName), `fixture:${fileName}\n`);
  }
  const runner = successfulRunner();
  const result = await publishCatalog({ ...baseOptions, dir, catalog, run: runner.run });
  assert.ok(result.releases.includes('catalog-v1.0.0'));
  const catalogCreate = runner.calls.find(
    (call) =>
      call.args[0] === 'release' &&
      call.args[1] === 'create' &&
      call.args[2] === 'catalog-v1.0.0',
  );
  assert.ok(catalogCreate);
  assert.ok(catalogCreate.args.some((arg) => arg.endsWith(bootstrapFiles[0])));
  assert.ok(catalogCreate.args.some((arg) => arg.endsWith(bootstrapFiles[1])));
  assert.ok(
    runner.calls.some(
      (call) =>
        call.args[0] === 'release' &&
        call.args[1] === 'create' &&
        call.args[2] === 'bootstrap-v1.0.0',
    ),
  );
});
