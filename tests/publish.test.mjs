import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sha256 } from '../scripts/lib/hash.mjs';
import {
  bootstrapArchiveFileName,
  bootstrapReleaseTag,
  catalogReleaseTag,
  familyReleaseTag,
} from '../scripts/lib/manifest.mjs';
import { publishCatalog } from '../scripts/lib/publish.mjs';

const FAMILY_ID = 'fixture-a';
const FAMILY_VERSION = '1.0.0';
const FAMILY_TAG = familyReleaseTag(FAMILY_ID, FAMILY_VERSION);
const BOOTSTRAP_TAG = bootstrapReleaseTag('1.0.0');
const CATALOG_TAG = catalogReleaseTag('1.0.0');

function catalogFixture() {
  const asset = {
    releaseTag: FAMILY_TAG,
    fileName: 'fixture-a-v1.0.0.tar.gz',
    sha256: 'a'.repeat(64),
    size: 10,
  };
  return {
    schemaVersion: 1,
    catalogVersion: '1.0.0',
    baseUrl: 'https://example.com/releases/download',
    families: {
      [FAMILY_ID]: {
        version: FAMILY_VERSION,
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

function releaseFileNames(catalog, { bootstrap = false } = {}) {
  const family = catalog.families[FAMILY_ID];
  const names = [
    family.package.fileName,
    `${family.package.fileName}.sha256`,
    family.source.fileName,
    `${family.source.fileName}.sha256`,
    'catalog.json',
    'catalog.json.sha256',
    'SHA256SUMS',
  ];
  if (bootstrap) {
    names.unshift(
      bootstrapArchiveFileName(catalog.catalogVersion),
      `${bootstrapArchiveFileName(catalog.catalogVersion)}.sha256`,
    );
  }
  return names;
}

function catalogReleaseFileNames({ bootstrap = false } = {}) {
  const names = ['catalog.json', 'catalog.json.sha256', 'SHA256SUMS'];
  if (bootstrap) {
    names.push(
      bootstrapArchiveFileName('1.0.0'),
      `${bootstrapArchiveFileName('1.0.0')}.sha256`,
    );
  }
  return names;
}

async function createArtifactSet(t, { bootstrap = false } = {}) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'font-publish-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const catalog = catalogFixture();
  const names = releaseFileNames(catalog, { bootstrap });
  const files = new Map();
  for (const fileName of names) {
    const file = path.join(dir, fileName);
    await fs.promises.writeFile(file, `fixture:${fileName}\n`);
    files.set(fileName, file);
  }
  return { dir, catalog, catalogVersion: catalog.catalogVersion, files };
}

function ok(value = {}) {
  return {
    status: 0,
    stdout: typeof value === 'string' ? value : JSON.stringify(value),
    stderr: '',
  };
}

function failure(stderr = 'boom') {
  return { status: 1, stdout: '', stderr };
}

function fieldValue(args, key) {
  for (let index = 0; index < args.length - 1; index += 1) {
    if ((args[index] === '-f' || args[index] === '-F') && args[index + 1].startsWith(`${key}=`)) {
      return args[index + 1].slice(key.length + 1);
    }
  }
  return undefined;
}

function endpointReleaseTag(args) {
  const endpoint = args.find((arg) => arg.includes('/releases/tags/'));
  return endpoint
    ? decodeURIComponent(endpoint.slice(endpoint.lastIndexOf('/') + 1))
    : null;
}

function apiMethod(call) {
  if (call.args[0] !== 'api') return null;
  const index = call.args.indexOf('--method');
  return index === -1 ? 'GET' : call.args[index + 1];
}

function createRemote({ before, after } = {}) {
  const releases = new Map();
  const calls = [];
  const publishOrder = [];
  let nextId = 1;

  function snapshot(release) {
    return {
      id: release.id,
      tag_name: release.tagName,
      draft: release.draft,
      assets: release.assets.map((asset) => ({ ...asset })),
    };
  }

  const remote = {
    calls,
    publishOrder,
    async seedRelease({ tag, draft, assets = [] }) {
      const release = { id: nextId, tagName: tag, draft, assets: [] };
      nextId += 1;
      releases.set(tag, release);
      for (const asset of assets) {
        await this.addAsset(tag, asset);
      }
      return release;
    },
    async addAsset(tag, { name, file, size, digest, state = 'uploaded' }) {
      const release = releases.get(tag);
      if (!release) throw new Error(`unknown fixture release ${tag}`);
      const bytes = file ? await fs.promises.readFile(file) : null;
      release.assets.push({
        name,
        size: size ?? bytes?.length ?? 0,
        digest: digest ?? (bytes ? `sha256:${sha256(bytes)}` : null),
        state,
      });
    },
    releaseFor(tag) {
      return releases.get(tag);
    },
    tagForId(id) {
      return [...releases.values()].find((release) => release.id === Number(id))?.tagName;
    },
    async run(call) {
      calls.push(call);
      if (before) {
        const override = await before(call, remote);
        if (override !== undefined) return override;
      }

      let result;
      if (call.args[0] === 'api') {
        const method = apiMethod(call);
        const endpoint = call.args.find((arg) => arg.startsWith('repos/'));
        if (method === 'GET' && endpoint?.includes('/releases/tags/')) {
          const tag = endpointReleaseTag(call.args);
          const release = releases.get(tag);
          result = release
            ? ok(snapshot(release))
            : failure('gh: Not Found (HTTP 404)');
        } else if (method === 'POST' && endpoint?.endsWith('/releases')) {
          const tag = fieldValue(call.args, 'tag_name');
          if (!tag || releases.has(tag)) {
            result = failure('gh: Validation Failed (HTTP 422)');
          } else {
            const release = {
              id: nextId,
              tagName: tag,
              draft: fieldValue(call.args, 'draft') === 'true',
              assets: [],
            };
            nextId += 1;
            releases.set(tag, release);
            result = ok(snapshot(release));
          }
        } else if (method === 'PATCH' && /\/releases\/\d+$/.test(endpoint ?? '')) {
          const id = Number(endpoint.slice(endpoint.lastIndexOf('/') + 1));
          const release = [...releases.values()].find((item) => item.id === id);
          if (!release) {
            result = failure('gh: Not Found (HTTP 404)');
          } else {
            release.draft = fieldValue(call.args, 'draft') === 'true';
            if (!release.draft) publishOrder.push(release.tagName);
            result = ok(snapshot(release));
          }
        } else {
          result = failure(`unexpected API call: ${call.args.join(' ')}`);
        }
      } else if (call.args[0] === 'release' && call.args[1] === 'upload') {
        const tag = call.args[2];
        const file = call.args[3];
        const release = releases.get(tag);
        const name = path.basename(file);
        if (!release || !release.draft || release.assets.some((asset) => asset.name === name)) {
          result = failure('gh: Validation Failed (HTTP 422)');
        } else {
          const bytes = await fs.promises.readFile(file);
          release.assets.push({
            name,
            size: bytes.length,
            digest: `sha256:${sha256(bytes)}`,
            state: 'uploaded',
          });
          result = ok();
        }
      } else {
        result = failure(`unexpected command: ${call.args.join(' ')}`);
      }

      if (after) {
        const override = await after(call, remote);
        if (override !== undefined) return override;
      }
      return result;
    },
  };
  return remote;
}

function mutationCalls(calls) {
  return calls.filter((call) => {
    const method = apiMethod(call);
    if (method) return method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE';
    return (
      call.args[0] === 'release' &&
      ['create', 'edit', 'delete', 'upload'].includes(call.args[1])
    );
  });
}

function assertNoForbiddenCalls(calls) {
  for (const call of calls) {
    assert.equal(call.args.includes('--clobber'), false);
    assert.equal(call.args.includes('--cleanup-tag'), false);
    assert.equal(
      call.args[0] === 'release' && ['create', 'delete', 'edit'].includes(call.args[1]),
      false,
    );
    assert.equal(call.args.some((arg) => String(arg).includes('immutable-releases')), false);
    assert.equal(call.args.some((arg) => String(arg).includes('/git/ref/tags/')), false);
  }
}

function uploadCalls(calls) {
  return calls
    .filter((call) => call.args[0] === 'release' && call.args[1] === 'upload')
    .map((call) => ({ tag: call.args[2], fileName: path.basename(call.args[3]) }));
}

function createCalls(calls) {
  return calls
    .filter((call) => apiMethod(call) === 'POST')
    .map((call) => fieldValue(call.args, 'tag_name'));
}

function baseOptions(artifact, run) {
  return {
    dir: artifact.dir,
    repo: 'owner/fonts',
    catalogVersion: artifact.catalogVersion,
    targetSha: 'a'.repeat(40),
    catalog: artifact.catalog,
    run,
  };
}

test('publishes empty drafts, uploads expected assets, verifies remotely, and publishes catalog last', async (t) => {
  const artifact = await createArtifactSet(t, { bootstrap: true });
  const remote = createRemote();
  const result = await publishCatalog(baseOptions(artifact, remote.run));
  const expectedOrder = [BOOTSTRAP_TAG, FAMILY_TAG, CATALOG_TAG];

  assert.deepEqual(result.published, expectedOrder);
  assert.deepEqual(remote.publishOrder, expectedOrder);
  assert.deepEqual(createCalls(remote.calls), expectedOrder);
  assertNoForbiddenCalls(remote.calls);

  const expectedUploads = [
    ...releaseFileNames(artifact.catalog, { bootstrap: true }).slice(0, 2).map((fileName) => ({
      tag: BOOTSTRAP_TAG,
      fileName,
    })),
    ...releaseFileNames(artifact.catalog).slice(0, 4).map((fileName) => ({
      tag: FAMILY_TAG,
      fileName,
    })),
    ...catalogReleaseFileNames({ bootstrap: true }).map((fileName) => ({
      tag: CATALOG_TAG,
      fileName,
    })),
  ];
  assert.deepEqual(uploadCalls(remote.calls), expectedUploads);

  for (const call of remote.calls.filter((item) => apiMethod(item) === 'POST')) {
    assert.ok(call.args.includes('-F'));
    assert.ok(call.args.includes('draft=true'));
    assert.equal(call.args.some((arg) => artifact.files.has(arg)), false);
  }
  for (const tag of expectedOrder) {
    assert.equal(
      remote.calls.filter(
        (call) => apiMethod(call) === 'GET' && endpointReleaseTag(call.args) === tag,
      ).length,
      2,
    );
  }
});

test('resumes a draft, skips matching assets, and uploads only missing assets', async (t) => {
  const artifact = await createArtifactSet(t);
  const family = artifact.catalog.families[FAMILY_ID];
  const packageName = family.package.fileName;
  const remote = createRemote();
  await remote.seedRelease({
    tag: FAMILY_TAG,
    draft: true,
    assets: [{ name: packageName, file: artifact.files.get(packageName) }],
  });

  const result = await publishCatalog(baseOptions(artifact, remote.run));

  assert.deepEqual(createCalls(remote.calls), [CATALOG_TAG]);
  assert.deepEqual(result.published, [FAMILY_TAG, CATALOG_TAG]);
  assert.deepEqual(remote.publishOrder, [FAMILY_TAG, CATALOG_TAG]);
  assert.deepEqual(
    uploadCalls(remote.calls)
      .filter((call) => call.tag === FAMILY_TAG)
      .map((call) => call.fileName),
    releaseFileNames(artifact.catalog).slice(1, 4),
  );
  assert.equal(
    uploadCalls(remote.calls).some(
      (call) => call.tag === FAMILY_TAG && call.fileName === packageName,
    ),
    false,
  );
  assertNoForbiddenCalls(remote.calls);
});

test('rejects conflicting and extra draft assets before any mutation', async (t) => {
  for (const variant of ['conflicting', 'extra']) {
    await t.test(variant, async (t) => {
      const artifact = await createArtifactSet(t);
      const family = artifact.catalog.families[FAMILY_ID];
      const packageName = family.package.fileName;
      const remote = createRemote();
      const assets =
        variant === 'conflicting'
          ? [
              {
                name: packageName,
                file: artifact.files.get(packageName),
                digest: `sha256:${'b'.repeat(64)}`,
              },
            ]
          : [
              {
                name: 'unexpected.txt',
                size: 1,
                digest: `sha256:${'b'.repeat(64)}`,
              },
            ];
      await remote.seedRelease({ tag: FAMILY_TAG, draft: true, assets });

      await assert.rejects(
        () => publishCatalog(baseOptions(artifact, remote.run)),
        variant === 'conflicting' ? /conflicts with local bytes/ : /unexpected assets/,
      );
      assert.deepEqual(mutationCalls(remote.calls), []);
      assertNoForbiddenCalls(remote.calls);
    });
  }
});

test('reuses exact published bootstrap and family releases and publishes only the new catalog', async (t) => {
  const artifact = await createArtifactSet(t, { bootstrap: true });
  const remote = createRemote();
  const bootstrapNames = releaseFileNames(artifact.catalog, { bootstrap: true }).slice(0, 2);
  const familyNames = releaseFileNames(artifact.catalog).slice(0, 4);
  await remote.seedRelease({
    tag: BOOTSTRAP_TAG,
    draft: false,
    assets: bootstrapNames.map((name) => ({ name, file: artifact.files.get(name) })),
  });
  await remote.seedRelease({
    tag: FAMILY_TAG,
    draft: false,
    assets: familyNames.map((name) => ({ name, file: artifact.files.get(name) })),
  });

  const result = await publishCatalog(baseOptions(artifact, remote.run));

  assert.deepEqual(result.reusedPublished, [BOOTSTRAP_TAG, FAMILY_TAG]);
  assert.deepEqual(result.published, [CATALOG_TAG]);
  assert.deepEqual(remote.publishOrder, [CATALOG_TAG]);
  assert.deepEqual(createCalls(remote.calls), [CATALOG_TAG]);
  assert.equal(
    uploadCalls(remote.calls).every((call) => call.tag === CATALOG_TAG),
    true,
  );
  assertNoForbiddenCalls(remote.calls);
});

test('rejects a conflicting published release without uploading or publishing', async (t) => {
  const artifact = await createArtifactSet(t);
  const family = artifact.catalog.families[FAMILY_ID];
  const packageName = family.package.fileName;
  const remote = createRemote();
  await remote.seedRelease({
    tag: FAMILY_TAG,
    draft: false,
    assets: [
      {
        name: packageName,
        file: artifact.files.get(packageName),
        digest: `sha256:${'b'.repeat(64)}`,
      },
    ],
  });

  await assert.rejects(
    () => publishCatalog(baseOptions(artifact, remote.run)),
    /asset set mismatch/,
  );

  assert.deepEqual(mutationCalls(remote.calls), []);
  assert.deepEqual(remote.publishOrder, []);
  assertNoForbiddenCalls(remote.calls);
});

test('a fully published catalog is a read-only verification when remote bytes match', async (t) => {
  const artifact = await createArtifactSet(t, { bootstrap: true });
  const remote = createRemote();
  const bootstrapNames = releaseFileNames(artifact.catalog, { bootstrap: true }).slice(0, 2);
  const familyNames = releaseFileNames(artifact.catalog).slice(0, 4);
  const catalogNames = catalogReleaseFileNames({ bootstrap: true });
  await remote.seedRelease({
    tag: BOOTSTRAP_TAG,
    draft: false,
    assets: bootstrapNames.map((name) => ({ name, file: artifact.files.get(name) })),
  });
  await remote.seedRelease({
    tag: FAMILY_TAG,
    draft: false,
    assets: familyNames.map((name) => ({ name, file: artifact.files.get(name) })),
  });
  await remote.seedRelease({
    tag: CATALOG_TAG,
    draft: false,
    assets: catalogNames.map((name) => ({ name, file: artifact.files.get(name) })),
  });

  const result = await publishCatalog(baseOptions(artifact, remote.run));

  assert.deepEqual(result.published, []);
  assert.deepEqual(result.reusedPublished, [BOOTSTRAP_TAG, FAMILY_TAG, CATALOG_TAG]);
  assert.deepEqual(mutationCalls(remote.calls), []);
  assertNoForbiddenCalls(remote.calls);
});

test('remote verification failure leaves created drafts unpublished and undeleted', async (t) => {
  const artifact = await createArtifactSet(t);
  const remote = createRemote({
    before(call, state) {
      if (apiMethod(call) === 'GET' && endpointReleaseTag(call.args) === FAMILY_TAG) {
        const release = state.releaseFor(FAMILY_TAG);
        if (release?.assets.length === 4) {
          release.assets[0].digest = `sha256:${'c'.repeat(64)}`;
        }
      }
      return undefined;
    },
  });

  await assert.rejects(
    () => publishCatalog(baseOptions(artifact, remote.run)),
    /conflicts with local bytes/,
  );

  assert.deepEqual(remote.publishOrder, []);
  assert.equal(remote.releaseFor(FAMILY_TAG).draft, true);
  assert.equal(remote.releaseFor(CATALOG_TAG).draft, true);
  assertNoForbiddenCalls(remote.calls);
  assert.equal(
    remote.calls.some((call) => call.args[0] === 'release' && call.args[1] === 'delete'),
    false,
  );
});

test('upload failure leaves drafts available for an idempotent retry', async (t) => {
  const artifact = await createArtifactSet(t);
  const remote = createRemote({
    before(call) {
      if (
        call.args[0] === 'release' &&
        call.args[1] === 'upload' &&
        call.args[2] === FAMILY_TAG
      ) {
        return failure('upload failed');
      }
      return undefined;
    },
  });

  await assert.rejects(
    () => publishCatalog(baseOptions(artifact, remote.run)),
    /failed to upload/,
  );

  assert.deepEqual(remote.publishOrder, []);
  assert.equal(remote.releaseFor(FAMILY_TAG).draft, true);
  assert.equal(remote.releaseFor(CATALOG_TAG).draft, true);
  assertNoForbiddenCalls(remote.calls);
});

test('publish failure never reaches the catalog and leaves its draft intact', async (t) => {
  const artifact = await createArtifactSet(t);
  const remote = createRemote({
    before(call, state) {
      if (apiMethod(call) === 'PATCH') {
        const endpoint = call.args.find((arg) => arg.startsWith('repos/'));
        const id = Number(endpoint.slice(endpoint.lastIndexOf('/') + 1));
        if (state.tagForId(id) === CATALOG_TAG) return failure('publish denied');
      }
      return undefined;
    },
  });

  await assert.rejects(
    () => publishCatalog(baseOptions(artifact, remote.run)),
    /failed to publish/,
  );

  assert.deepEqual(remote.publishOrder, [FAMILY_TAG]);
  assert.equal(remote.releaseFor(FAMILY_TAG).draft, false);
  assert.equal(remote.releaseFor(CATALOG_TAG).draft, true);
  assertNoForbiddenCalls(remote.calls);
});

test('dry-run records the empty-draft, upload, verify, and publish plan without invoking GitHub', async (t) => {
  const artifact = await createArtifactSet(t, { bootstrap: true });
  let invoked = false;
  const result = await publishCatalog({
    ...baseOptions(artifact, async () => {
      invoked = true;
      throw new Error('must not run');
    }),
    dryRun: true,
  });

  assert.equal(invoked, false);
  assert.equal(result.dryRun, true);
  assert.deepEqual(result.calls, []);
  assert.deepEqual(
    result.plan.filter((item) => item.action === 'publish').map((item) => item.tag),
    [BOOTSTRAP_TAG, FAMILY_TAG, CATALOG_TAG],
  );
  assert.equal(
    result.plan.some((item) => item.action === 'ensure-empty-draft'),
    true,
  );
  assert.equal(result.plan.some((item) => item.action === 'verify-draft'), true);
});

test('publish rejects an incomplete bootstrap artifact pair before invoking GitHub', async (t) => {
  const artifact = await createArtifactSet(t);
  const bootstrap = bootstrapArchiveFileName(artifact.catalogVersion);
  await fs.promises.writeFile(path.join(artifact.dir, bootstrap), 'fixture');
  await assert.rejects(
    () =>
      publishCatalog({
        ...baseOptions(artifact, async () => {
          throw new Error('runner must not be invoked');
        }),
      }),
    /must be present together/,
  );
});

test('publish implementation has no immutable API, tag-ref, overwrite, cleanup, or deletion path', async () => {
  const source = await fs.promises.readFile(
    new URL('../scripts/lib/publish.mjs', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(source, /immutable-releases/);
  assert.doesNotMatch(source, /git\/ref\/tags/);
  assert.doesNotMatch(source, /release['"],\s*['"]delete/);
  assert.doesNotMatch(source, /--clobber/);
  assert.doesNotMatch(source, /--cleanup-tag/);
});
