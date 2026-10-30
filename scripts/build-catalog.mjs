#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { buildCatalog, DEFAULT_BASE_URL } from './lib/catalog.mjs';
import { exitAfterResult } from './lib/cli.mjs';
import { loadCurrentDescriptors } from './lib/descriptors.mjs';
import { validateRepository } from './lib/validate.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

function help() {
  return [
    'Usage: node scripts/build-catalog.mjs [options]',
    '',
    'Options:',
    '  --out <dir>               Output directory (default: artifacts)',
    '  --catalog-version <semver> Catalog version (default: package version)',
    '  --base-url <https url>     Release download base URL',
    '  --bootstrap-dir <dir>     Controlled source input directory',
    '  --bootstrap-sha256 <sha>  Required SHA-256 for the reproduced bootstrap ZIP',
    '  --cache-dir <dir>         Download cache (default: .cache/downloads)',
  ].join('\n');
}

async function main() {
  const { values } = parseArgs({
    options: {
      out: { type: 'string', default: 'artifacts' },
      'catalog-version': { type: 'string' },
      'base-url': { type: 'string', default: DEFAULT_BASE_URL },
      'bootstrap-dir': { type: 'string' },
      'bootstrap-sha256': { type: 'string' },
      'cache-dir': { type: 'string', default: path.join(repoRoot, '.cache', 'downloads') },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    process.stdout.write(`${help()}\n`);
    return;
  }
  const packageJson = JSON.parse(
    await fs.promises.readFile(path.join(repoRoot, 'package.json'), 'utf8'),
  );
  const catalogVersion = values['catalog-version'] ?? packageJson.version;
  await validateRepository(repoRoot, { checkGit: true, allVersions: true });
  const descriptors = await loadCurrentDescriptors(repoRoot);
  const result = await buildCatalog({
    repoRoot,
    descriptors,
    outDir: path.resolve(values.out),
    catalogVersion,
    baseUrl: values['base-url'],
    bootstrapDir: values['bootstrap-dir']
      ? path.resolve(values['bootstrap-dir'])
      : undefined,
    expectedBootstrapSha256: values['bootstrap-sha256'],
    cacheDir: path.resolve(values['cache-dir']),
    onProgress(event) {
      if (event.phase === 'start') {
        process.stderr.write(`[build] ${event.id} (${event.role})...\n`);
      } else if (event.phase === 'bootstrap') {
        process.stderr.write(`[build] bootstrap: ${event.files} source file(s)...\n`);
      } else if (event.phase === 'bootstrap-built') {
        process.stderr.write(
          `[build] bootstrap: ${event.files} source file(s), sha256 ${event.sha256}\n`,
        );
      } else {
        process.stderr.write(
          `[build] ${event.id}: ${event.variants} variant(s), package ${event.packageSha256}\n`,
        );
      }
    },
  });
  await exitAfterResult(
    `${JSON.stringify(
      {
        catalogPath: path.relative(repoRoot, result.catalogPath).split(path.sep).join('/'),
        catalogReleaseTag: result.catalogReleaseTag,
        catalogSha256: result.catalogSha256,
        catalogSize: result.catalogSize,
        bootstrap: result.bootstrap,
        families: result.summary,
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error) => {
  void exitAfterResult('', {
    code: 1,
    stderrText: `catalog build failed: ${error.stack ?? error.message}\n`,
  });
});
