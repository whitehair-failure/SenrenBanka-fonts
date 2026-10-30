#!/usr/bin/env node
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { loadCurrentDescriptors } from './lib/descriptors.mjs';
import { verifyCatalogDirectory } from './lib/verify.mjs';
import { publishCatalog } from './lib/publish.mjs';
import { validateRepository } from './lib/validate.mjs';
import { exitAfterResult } from './lib/cli.mjs';

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

async function runCommand({ command, args }) {
  try {
    const result = await execFileAsync(command, args, {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    return { status: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      status: typeof error.code === 'number' ? error.code : 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? error.message,
    };
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      dir: { type: 'string', default: 'artifacts' },
      'catalog-version': { type: 'string' },
      repo: {
        type: 'string',
        default: process.env.GITHUB_REPOSITORY ?? 'whitehair-failure/SenrenBanka-fonts',
      },
      'target-sha': {
        type: 'string',
        default: process.env.GITHUB_SHA,
      },
      'dry-run': { type: 'boolean', default: false },
      'immutable-releases-confirmed': {
        type: 'boolean',
        default: process.env.IMMUTABLE_RELEASES_CONFIRMED === 'true',
      },
    },
  });
  if (!values['catalog-version']) throw new Error('--catalog-version is required');
  if (!values['target-sha']) throw new Error('--target-sha or GITHUB_SHA is required');
  const dir = path.resolve(values.dir);
  const descriptors = await loadCurrentDescriptors(repoRoot);
  await validateRepository(repoRoot, { checkGit: true, allVersions: true });
  const catalog = await verifyCatalogDirectory({ dir, descriptors });

  const result = await publishCatalog({
    dir,
    repo: values.repo,
    catalogVersion: values['catalog-version'],
    targetSha: values['target-sha'],
    catalog,
    run: runCommand,
    dryRun: values['dry-run'],
    immutableReleasesConfirmed: values['immutable-releases-confirmed'],
    log(message) {
      process.stderr.write(`[publish] ${message}\n`);
    },
  });
  await exitAfterResult(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  void exitAfterResult('', {
    code: 1,
    stderrText: `publish failed: ${error.stack ?? error.message}\n`,
  });
});
