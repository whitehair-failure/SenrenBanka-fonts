#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRepository } from './lib/validate.mjs';
import { schemas } from './lib/schema.mjs';
import { stableStringify } from './lib/json.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

async function main() {
  const result = await validateRepository(repoRoot);
  for (const [fileName, schema] of Object.entries(schemas)) {
    const filePath = path.join(repoRoot, 'schemas', fileName);
    let actual;
    try {
      actual = await fs.promises.readFile(filePath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error(`missing generated schema ${fileName}`);
      throw error;
    }
    if (actual !== stableStringify(schema)) {
      throw new Error(`schemas/${fileName} is stale; run npm run schemas:generate`);
    }
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`catalog validation failed: ${error.message}\n`);
  process.exitCode = 1;
});
