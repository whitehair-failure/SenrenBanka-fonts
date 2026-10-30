#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stableStringify } from './lib/json.mjs';
import { schemas } from './lib/schema.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const schemaDir = path.join(repoRoot, 'schemas');
await fs.promises.mkdir(schemaDir, { recursive: true });
for (const [fileName, schema] of Object.entries(schemas)) {
  await fs.promises.writeFile(path.join(schemaDir, fileName), stableStringify(schema));
  process.stdout.write(`wrote schemas/${fileName}\n`);
}
