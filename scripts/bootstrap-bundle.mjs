#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { buildBootstrapBundle } from './lib/bootstrap.mjs';
import { sidecarContent } from './lib/hash.mjs';
import { loadCurrentDescriptors } from './lib/descriptors.mjs';
import { validateRepository } from './lib/validate.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

function help() {
  return [
    'Usage: node scripts/bootstrap-bundle.mjs [options]',
    '',
    'Options:',
    '  --bootstrap-dir <dir>  Controlled source directory',
    '  --out <file>           Output ZIP (default: artifacts/bootstrap-sources.zip)',
  ].join('\n');
}

async function main() {
  const { values } = parseArgs({
    options: {
      'bootstrap-dir': { type: 'string' },
      out: { type: 'string', default: 'artifacts/bootstrap-sources.zip' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    process.stdout.write(`${help()}\n`);
    return;
  }
  if (!values['bootstrap-dir']) throw new Error('--bootstrap-dir is required');
  await validateRepository(repoRoot, { checkGit: true, allVersions: true });
  const descriptors = await loadCurrentDescriptors(repoRoot);
  const out = path.resolve(values.out);
  const outDir = path.dirname(out);
  await fs.promises.mkdir(outDir, { recursive: true });
  const targets = [out, `${out}.sha256`];
  for (const target of targets) {
    try {
      const stat = await fs.promises.lstat(target);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error(`bootstrap output must be a regular file: ${target}`);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const temporary = `${out}.partial-${process.pid}`;
  const temporarySidecar = `${out}.sha256.partial-${process.pid}`;
  let zipCommitted = false;
  let fullyCommitted = false;
  try {
    const result = await buildBootstrapBundle({
      bootstrapDir: path.resolve(values['bootstrap-dir']),
      descriptors,
    });
    await fs.promises.writeFile(temporary, result.data);
    await fs.promises.writeFile(
      temporarySidecar,
      sidecarContent(result.sha256, path.basename(out)),
    );
    for (const target of targets) await fs.promises.rm(target, { force: true });
    await fs.promises.rename(temporary, out);
    zipCommitted = true;
    await fs.promises.rename(temporarySidecar, `${out}.sha256`);
    fullyCommitted = true;
    process.stdout.write(
      `${JSON.stringify(
        {
          output: path.relative(repoRoot, out).split(path.sep).join('/'),
          sha256: result.sha256,
          size: result.size,
          included: result.included,
          excluded: result.excluded,
        },
        null,
        2,
      )}\n`,
    );
  } catch (error) {
    await fs.promises.rm(temporary, { force: true });
    await fs.promises.rm(temporarySidecar, { force: true });
    if (zipCommitted && !fullyCommitted) await fs.promises.rm(out, { force: true });
    throw error;
  }
}

main().catch((error) => {
  process.stderr.write(`bootstrap bundle failed: ${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
