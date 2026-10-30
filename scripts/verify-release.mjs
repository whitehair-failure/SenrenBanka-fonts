#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { loadCurrentDescriptors } from './lib/descriptors.mjs';
import { compareCatalogDirectories, verifyCatalogDirectory } from './lib/verify.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

async function main() {
  const { values } = parseArgs({
    options: {
      dir: { type: 'string', default: 'artifacts' },
      'compare-dir': { type: 'string' },
      'catalog-version': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    process.stdout.write(
      'Usage: node scripts/verify-release.mjs [--dir artifacts] [--compare-dir artifacts-repro]\n',
    );
    return;
  }
  const dir = path.resolve(values.dir);
  const descriptors = await loadCurrentDescriptors(repoRoot);
  const catalog = await verifyCatalogDirectory({ dir, descriptors });
  if (values['catalog-version'] && catalog.catalogVersion !== values['catalog-version']) {
    throw new Error(
      `catalog version mismatch: expected ${values['catalog-version']}, got ${catalog.catalogVersion}`,
    );
  }
  if (values['compare-dir']) {
    await compareCatalogDirectories(dir, path.resolve(values['compare-dir']));
  }
  const packageJson = JSON.parse(
    await fs.promises.readFile(path.join(repoRoot, 'package.json'), 'utf8'),
  );
  process.stdout.write(
    `${JSON.stringify(
      {
        verified: true,
        directory: dir,
        catalogVersion: catalog.catalogVersion,
        packageVersion: packageJson.version,
        families: Object.keys(catalog.families).length,
        reproducible: Boolean(values['compare-dir']),
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`release verification failed: ${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
