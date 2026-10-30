import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { bootstrapSourcePlan } from './bootstrap.mjs';
import { loadAllDescriptors, loadCurrentDescriptors } from './descriptors.mjs';
import { loadAndVerifyLicenses } from './license.mjs';

const FORBIDDEN_BINARY =
  /\.(?:ttf|otf|woff2?|tar|tgz|gz|zip)$/i;

function assertNoMachinePaths(value, label) {
  const text = JSON.stringify(value);
  const patterns = [
    /(?:^|[^A-Za-z0-9+.-])[A-Za-z]:[\\/]/,
    /file:\/\//i,
    /\/Users\//,
    /\/home\/[^/]+\//,
  ];
  if (patterns.some((pattern) => pattern.test(text))) {
    throw new Error(`${label} contains a machine-specific path or file: URL`);
  }
}

function assertPolicy(descriptor) {
  if (descriptor.output.type === 'core-cjk') {
    if (descriptor.output.chunkSize !== 71680) {
      throw new Error(`${descriptor.id} core-cjk chunkSize must be 71680 bytes`);
    }
    if (descriptor.source.files.length !== 1) {
      throw new Error(`${descriptor.id} core-cjk must have exactly one source font`);
    }
    const source = descriptor.source.files[0];
    if (!/\.(?:ttf|otf)$/i.test(source.fileName)) {
      throw new Error(`${descriptor.id} core-cjk source must be an uncompressed TTF/OTF`);
    }
    if (!source.bootstrapKey.startsWith('source/fonts/')) {
      throw new Error(`${descriptor.id} bootstrap key must be under source/fonts/`);
    }
  } else {
    for (const source of descriptor.source.files) {
      if (!/\.woff2$/i.test(source.fileName)) {
        throw new Error(`${descriptor.id} fixed sources must be WOFF2 files`);
      }
    }
    for (const variant of descriptor.output.variants) {
      if (!/\.woff2$/i.test(variant.file)) {
        throw new Error(`${descriptor.id} fixed outputs must be WOFF2 files`);
      }
    }
  }
  for (const source of descriptor.source.files) {
    if (!source.bootstrapKey.startsWith('source/fonts/')) {
      throw new Error(`${descriptor.id} bootstrap key must be under source/fonts/`);
    }
  }
}

export function assertNoTrackedFontBinaries(repoRoot) {
  let output;
  try {
    output = execFileSync('git', ['ls-files', '-z'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (error) {
    throw new Error(
      `could not inspect tracked files; Git is required for the binary gate: ${error.message}`,
    );
  }
  const tracked = output.split('\0').filter(Boolean);
  const violations = tracked.filter(
    (file) => FORBIDDEN_BINARY.test(file) && !file.startsWith('fixtures/'),
  );
  if (violations.length) {
    throw new Error(`font/archive binaries must not be tracked: ${violations.join(', ')}`);
  }
  return tracked;
}

export async function validateRepository(
  repoRoot,
  { checkGit = true, allVersions = true } = {},
) {
  const all = allVersions
    ? await loadAllDescriptors(repoRoot)
    : await loadCurrentDescriptors(repoRoot);
  for (const item of all) {
    assertNoMachinePaths(item.descriptor, item.relative);
    assertPolicy(item.descriptor);
    await loadAndVerifyLicenses(repoRoot, item.descriptor);
  }
  const current = await loadCurrentDescriptors(repoRoot);
  const bootstrapPlan = bootstrapSourcePlan(current);
  const core = current.filter((item) => item.descriptor.role === 'core-cjk');
  const fixed = current.filter((item) => item.descriptor.role === 'fixed');
  if (core.length === 0) throw new Error('catalog must contain at least one core-cjk family');
  if (checkGit) assertNoTrackedFontBinaries(repoRoot);
  return {
    repositoryRoot: path.resolve(repoRoot),
    descriptors: all.length,
    currentFamilies: current.length,
    coreFamilies: core.map((item) => item.descriptor.id),
    fixedFamilies: fixed.map((item) => item.descriptor.id),
    bootstrapOnlySources: bootstrapPlan.selected.length,
  };
}
