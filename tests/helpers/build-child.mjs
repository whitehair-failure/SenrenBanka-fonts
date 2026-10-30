import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { buildFamily } from '../../scripts/lib/build-family.mjs';
import { makeCoreDescriptor, makeFixedDescriptor } from './fixtures.mjs';

const { values } = parseArgs({
  options: {
    kind: { type: 'string' },
    root: { type: 'string' },
    out: { type: 'string' },
  },
});
try {
  const descriptor =
    values.kind === 'core'
      ? makeCoreDescriptor()
      : makeFixedDescriptor();
  const result = await buildFamily({
    repoRoot: path.resolve(values.root),
    descriptor,
    bootstrapDir: path.join(path.resolve(values.root), 'bootstrap'),
  });
  const out = path.resolve(values.out);
  await fs.promises.mkdir(out, { recursive: true });
  await fs.promises.writeFile(path.join(out, result.packageFileName), result.packageData);
  await fs.promises.writeFile(path.join(out, result.sourceFileName), result.sourceData);
  await fs.promises.writeFile(
    path.join(out, 'result.json'),
    `${JSON.stringify({
      packageFileName: result.packageFileName,
      sourceFileName: result.sourceFileName,
      packageSha256: result.packageSha256,
      sourceSha256: result.sourceSha256,
      variants: result.manifest.variants.length,
    })}\n`,
  );
  process.exit(0);
} catch (error) {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exit(1);
}
