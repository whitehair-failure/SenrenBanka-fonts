import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
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
