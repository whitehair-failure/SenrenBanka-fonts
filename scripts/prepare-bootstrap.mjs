#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { extractZipAll } from './lib/archive.mjs';
import { verifySha256 } from './lib/hash.mjs';
import { downloadBytes, assertHttpsUrl } from './lib/source.mjs';
import { assertReplaceableDirectory } from './lib/paths.mjs';

async function main() {
  const { values } = parseArgs({
    options: {
      url: { type: 'string' },
      bundle: { type: 'string' },
      sha256: { type: 'string' },
      out: { type: 'string', default: '.cache/bootstrap' },
    },
  });
  if (!values.sha256) throw new Error('--sha256 is required');
  if (!values.url && !values.bundle) throw new Error('--url or --bundle is required');
  let data;
  if (values.bundle) {
    data = await fs.promises.readFile(path.resolve(values.bundle));
  } else {
    assertHttpsUrl(values.url, 'bootstrap bundle URL');
    data = await downloadBytes(values.url);
  }
  verifySha256(data, values.sha256, 'bootstrap bundle');
  const out = assertReplaceableDirectory(values.out, {
    label: 'bootstrap output directory',
  });
  await extractZipAll(data, out, { label: 'bootstrap bundle' });
  process.stdout.write(`${JSON.stringify({ extractedTo: out, sha256: values.sha256 })}\n`);
}

main().catch((error) => {
  process.stderr.write(`bootstrap preparation failed: ${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
