#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { buildFamily } from './lib/build-family.mjs';
import { exitAfterResult } from './lib/cli.mjs';
import { loadAllDescriptors, loadCurrentDescriptors } from './lib/descriptors.mjs';
import { sidecarContent } from './lib/hash.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

async function main() {
  const { values } = parseArgs({
    options: {
      id: { type: 'string' },
      version: { type: 'string' },
      out: { type: 'string', default: 'artifacts-family' },
      'bootstrap-dir': { type: 'string' },
      'cache-dir': { type: 'string', default: path.join(repoRoot, '.cache', 'downloads') },
    },
  });
  if (!values.id) throw new Error('--id is required');
  const descriptors = values.version
    ? await loadAllDescriptors(repoRoot)
    : await loadCurrentDescriptors(repoRoot);
  const item = descriptors.find(
    (candidate) =>
      candidate.descriptor.id === values.id &&
      (!values.version || candidate.descriptor.version === values.version),
  );
  if (!item) throw new Error(`descriptor not found for ${values.id}@${values.version ?? 'current'}`);
  const result = await buildFamily({
    repoRoot,
    descriptor: item.descriptor,
    bootstrapDir: values['bootstrap-dir']
      ? path.resolve(values['bootstrap-dir'])
      : undefined,
    cacheDir: path.resolve(values['cache-dir']),
  });
  const outDir = path.resolve(values.out);
  await fs.promises.mkdir(outDir, { recursive: true });
  await fs.promises.writeFile(path.join(outDir, result.packageFileName), result.packageData);
  await fs.promises.writeFile(path.join(outDir, result.sourceFileName), result.sourceData);
  await fs.promises.writeFile(
    path.join(outDir, `${result.packageFileName}.sha256`),
    sidecarContent(result.packageSha256, result.packageFileName),
  );
  await fs.promises.writeFile(
    path.join(outDir, `${result.sourceFileName}.sha256`),
    sidecarContent(result.sourceSha256, result.sourceFileName),
  );
  await exitAfterResult(
    `${JSON.stringify(
      {
        id: result.descriptor.id,
        version: result.descriptor.version,
        variants: result.manifest.variants.length,
        outputDir: outDir,
        package: {
          fileName: result.packageFileName,
          sha256: result.packageSha256,
          size: result.packageData.length,
        },
        source: {
          fileName: result.sourceFileName,
          sha256: result.sourceSha256,
          size: result.sourceData.length,
        },
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error) => {
  void exitAfterResult('', {
    code: 1,
    stderrText: `family build failed: ${error.stack ?? error.message}\n`,
  });
});
