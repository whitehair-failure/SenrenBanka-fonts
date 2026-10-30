import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  compareVersions,
  loadCurrentDescriptors,
} from '../scripts/lib/descriptors.mjs';
import { loadAndVerifyLicenses } from '../scripts/lib/license.mjs';
import { bootstrapSourcePlan } from '../scripts/lib/bootstrap.mjs';
import { assertNoTrackedFontBinaries } from '../scripts/lib/validate.mjs';
import { schemas } from '../scripts/lib/schema.mjs';
import { stableStringify } from '../scripts/lib/json.mjs';
import {
  hash,
  makeCoreDescriptor,
  repoRoot,
} from './helpers/fixtures.mjs';

test('initial catalog describes exactly the 20 local-provider families', async () => {
  const descriptors = await loadCurrentDescriptors(repoRoot);
  assert.equal(descriptors.length, 20);
  const core = descriptors
    .filter((item) => item.descriptor.role === 'core-cjk')
    .map((item) => item.descriptor.id)
    .sort();
  assert.deepEqual(core, ['ark-pixel-12px', 'lxgw-wenkai', 'zhuque-fangsong']);
  assert.equal(descriptors.filter((item) => item.descriptor.role === 'fixed').length, 17);
  const bootstrapPlan = bootstrapSourcePlan(descriptors);
  assert.equal(bootstrapPlan.selected.length, 12);
  assert.ok(bootstrapPlan.selected.every((source) => !source.hasDownload));
  for (const item of descriptors) {
    const text = JSON.stringify(item.descriptor);
    assert.doesNotMatch(text, /F:\\\\|file:\/\//i);
    await loadAndVerifyLicenses(repoRoot, item.descriptor);
  }
});

test('semantic version ordering treats hyphens inside prerelease identifiers correctly', () => {
  assert.ok(compareVersions('1.0.0-alpha-beta', '1.0.0-alpha-alpha') > 0);
  assert.ok(compareVersions('1.0.0-beta', '1.0.0-alpha-beta') > 0);
  assert.equal(compareVersions('1.0.0+build.2', '1.0.0+build.1'), 0);
});

test('binary tracking gate fails closed when Git cannot inspect the tree', async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'font-git-gate-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  assert.throws(
    () => assertNoTrackedFontBinaries(root),
    /Git is required for the binary gate/,
  );
});

test('RFN permission evidence must be an excerpt of the reviewed license text', async (t) => {
  const descriptor = makeCoreDescriptor();
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'font-license-test-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const licenseText = Buffer.from(
    'Copyright Fixture. This Font Software is licensed under the SIL Open Font License, Version 1.1. [ADDITIONAL PERMISSION] Fixture may be subsetted.',
  );
  const licenseDir = path.join(root, 'licenses', descriptor.id);
  await fs.promises.mkdir(licenseDir, { recursive: true });
  await fs.promises.writeFile(path.join(licenseDir, 'LICENSE.txt'), licenseText);
  descriptor.license.files = [
    { name: 'LICENSE.txt', sha256: hash(licenseText) },
  ];
  descriptor.license.reservedFontNames = ['Fixture'];
  descriptor.license.rfn = {
    status: 'permission-granted',
    basis: 'Fixture explicitly permits web subsetting.',
    permissionText:
      '[ADDITIONAL PERMISSION] Fixture may be subsetted, with fabricated conditions.',
    permissionEvidenceUrl: 'https://example.com/fixture-permission',
  };
  await assert.rejects(
    () => loadAndVerifyLicenses(root, descriptor),
    /exact excerpt/,
  );
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
  assert.match(workflow, /^\s*group: font-catalog-release$/m);
  assert.doesNotMatch(workflow, /^\s*run:.*\$\{\{\s*inputs\./m);
  assert.match(workflow.slice(publishJob), /permissions:\s*\n\s+contents: write/);
  assert.match(workflow, /node scripts\/bootstrap-bundle\.mjs/);
  assert.match(workflow, /node scripts\/verify-bootstrap\.mjs/);
  assert.match(workflow, /bootstrap-sources-v\$CATALOG_VERSION\.zip/);
  assert.match(workflow, /bootstrapSourceUrl/);
  assert.match(workflow, /bootstrapSourceSha256/);
  assert.match(workflow, /--url "\$BOOTSTRAP_URL"/);
  assert.match(workflow, /--sha256 "\$BOOTSTRAP_SHA256"/);
  assert.match(workflow, /Bootstrap sidecar does not match the workflow input hash/);
  assert.doesNotMatch(workflow, /[A-Za-z]:[\\/]/);
  assert.match(
    workflow,
    /IMMUTABLE_RELEASES_CONFIRMED:\s*\$\{\{\s*vars\.IMMUTABLE_RELEASES_CONFIRMED\s*\}\}/,
  );
  assert.match(
    workflow,
    /"\$IMMUTABLE_RELEASES_CONFIRMED"\s*!=\s*"true"/,
  );
  assert.ok(
    workflow.indexOf('Require administrator confirmation') < testIndex,
  );
});
