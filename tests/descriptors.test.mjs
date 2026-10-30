import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadCurrentDescriptors } from '../scripts/lib/descriptors.mjs';
import { loadAndVerifyLicenses } from '../scripts/lib/license.mjs';
import { schemas } from '../scripts/lib/schema.mjs';
import { stableStringify } from '../scripts/lib/json.mjs';
import { repoRoot } from './helpers/fixtures.mjs';

test('initial catalog describes exactly the 20 local-provider families', async () => {
  const descriptors = await loadCurrentDescriptors(repoRoot);
  assert.equal(descriptors.length, 20);
  const core = descriptors
    .filter((item) => item.descriptor.role === 'core-cjk')
    .map((item) => item.descriptor.id)
    .sort();
  assert.deepEqual(core, ['ark-pixel-12px', 'lxgw-wenkai', 'zhuque-fangsong']);
  assert.equal(descriptors.filter((item) => item.descriptor.role === 'fixed').length, 17);
  for (const item of descriptors) {
    const text = JSON.stringify(item.descriptor);
    assert.doesNotMatch(text, /F:\\\\|file:\/\//i);
    await loadAndVerifyLicenses(repoRoot, item.descriptor);
  }
});

test('committed JSON schemas match the versioned Zod contracts', async () => {
  for (const [fileName, schema] of Object.entries(schemas)) {
    const actual = await fs.promises.readFile(
      path.join(repoRoot, 'schemas', fileName),
      'utf8',
    );
    assert.equal(actual, stableStringify(schema), `${fileName} is stale`);
  }
});

test('workflow verifies and uploads before the publish job runs', async () => {
  const workflow = await fs.promises.readFile(
    path.join(repoRoot, '.github', 'workflows', 'release.yml'),
    'utf8',
  );
  const testIndex = workflow.indexOf('run: npm test');
  const firstVerify = workflow.indexOf('run: npm run release:verify');
  const compare = workflow.indexOf('--compare-dir artifacts-repro');
  const upload = workflow.indexOf('uses: actions/upload-artifact@v4');
  const publishJob = workflow.indexOf('\n  publish:');
  const publishCommand = workflow.lastIndexOf('run: node scripts/publish.mjs --dir artifacts');
  assert.ok(testIndex >= 0 && testIndex < firstVerify);
  assert.ok(firstVerify < compare && compare < upload);
  assert.ok(upload < publishJob && publishJob < publishCommand);
  assert.match(workflow.slice(publishJob), /needs: build/);
  assert.match(workflow.slice(publishJob), /actions\/download-artifact@v4/);
});
