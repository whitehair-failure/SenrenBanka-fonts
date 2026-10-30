#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { verifyBootstrapBundleBuffer } from './lib/bootstrap.mjs';
import { loadCurrentDescriptors } from './lib/descriptors.mjs';
import { assertSha256 } from './lib/hash.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

async function main() {
  const { values } = parseArgs({
    options: {
      bundle: { type: 'string' },
      sha256: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    process.stdout.write(
      'Usage: node scripts/verify-bootstrap.mjs --bundle <zip> [--sha256 <digest>]\n',
    );
    return;
  }
  if (!values.bundle) throw new Error('--bundle is required');
  if (values.sha256) assertSha256(values.sha256, 'bootstrap bundle sha256');
  const bundlePath = path.resolve(values.bundle);
  const data = await fs.promises.readFile(bundlePath);
  const descriptors = await loadCurrentDescriptors(repoRoot);
  const result = await verifyBootstrapBundleBuffer(data, descriptors, {
    expectedSha256: values.sha256,
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        verified: true,
        bundle: path.relative(repoRoot, bundlePath).split(path.sep).join('/'),
        sha256: result.sha256,
        size: result.size,
        files: result.files,
        excludedCount: result.excludedCount,
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`bootstrap verification failed: ${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
