import fs from 'node:fs';
import path from 'node:path';
import { buildFamily } from './build-family.mjs';
import { bootstrapSourcePlan, buildBootstrapBundle } from './bootstrap.mjs';
import { assertSha256, sha256, sidecarContent } from './hash.mjs';
import { compareText, stableStringify } from './json.mjs';
import { assertReplaceableDirectory } from './paths.mjs';
import {
  bootstrapArchiveFileName,
  catalogReleaseTag,
  familyReleaseTag,
} from './manifest.mjs';
import { parseCatalog } from './schema.mjs';

export const DEFAULT_BASE_URL =
  'https://github.com/whitehair-failure/SenrenBanka-fonts/releases/download';

export function guardOutputDirectory(outDir, repoRoot) {
  return assertReplaceableDirectory(outDir, {
    protectedRoot: repoRoot,
    label: 'catalog output directory',
  });
}

async function writeArtifact(directory, fileName, data) {
  await fs.promises.writeFile(path.join(directory, fileName), data);
}

export async function buildCatalog({
  repoRoot,
  descriptors,
  outDir,
  catalogVersion,
  baseUrl = DEFAULT_BASE_URL,
  bootstrapDir,
  fetchImpl,
  cacheDir,
  splitter,
  expectedBootstrapSha256,
  onProgress = () => {},
}) {
  const output = guardOutputDirectory(outDir, repoRoot);
  const temporary = `${output}.partial-${process.pid}`;
  await fs.promises.rm(temporary, { recursive: true, force: true });
  await fs.promises.mkdir(temporary, { recursive: true });

  const families = {};
  const summary = [];
  let bootstrap = null;
  if (expectedBootstrapSha256) {
    assertSha256(expectedBootstrapSha256, 'expected bootstrap sha256');
    if (!bootstrapDir) {
      throw new Error('expected bootstrap SHA-256 requires --bootstrap-dir');
    }
  }
  try {
    const bootstrapPlan = bootstrapSourcePlan(descriptors);
    if (bootstrapDir && bootstrapPlan.selected.length > 0) {
      onProgress({ phase: 'bootstrap', files: bootstrapPlan.selected.length });
      const bundle = await buildBootstrapBundle({
        bootstrapDir,
        descriptors,
      });
      if (expectedBootstrapSha256 && bundle.sha256 !== expectedBootstrapSha256) {
        throw new Error(
          `bootstrap bundle SHA-256 mismatch: expected ${expectedBootstrapSha256}, got ${bundle.sha256}`,
        );
      }
      const fileName = bootstrapArchiveFileName(catalogVersion);
      await writeArtifact(temporary, fileName, bundle.data);
      await writeArtifact(
        temporary,
        `${fileName}.sha256`,
        sidecarContent(bundle.sha256, fileName),
      );
      bootstrap = {
        fileName,
        sha256: bundle.sha256,
        size: bundle.size,
        files: bundle.included.length,
      };
      onProgress({
        phase: 'bootstrap-built',
        files: bundle.included.length,
        sha256: bundle.sha256,
      });
    }
    for (const item of descriptors) {
      const { descriptor } = item;
      onProgress({ phase: 'start', id: descriptor.id, role: descriptor.role });
      const result = await buildFamily({
        repoRoot,
        descriptor,
        bootstrapDir,
        fetchImpl,
        cacheDir,
        splitter,
      });
      await writeArtifact(temporary, result.packageFileName, result.packageData);
      await writeArtifact(temporary, result.sourceFileName, result.sourceData);
      await writeArtifact(
        temporary,
        `${result.packageFileName}.sha256`,
        sidecarContent(result.packageSha256, result.packageFileName),
      );
      await writeArtifact(
        temporary,
        `${result.sourceFileName}.sha256`,
        sidecarContent(result.sourceSha256, result.sourceFileName),
      );
      const releaseTag = familyReleaseTag(descriptor.id, descriptor.version);
      families[descriptor.id] = {
        version: descriptor.version,
        role: descriptor.role,
        package: {
          releaseTag,
          fileName: result.packageFileName,
          sha256: result.packageSha256,
          size: result.packageData.length,
        },
        source: {
          releaseTag,
          fileName: result.sourceFileName,
          sha256: result.sourceSha256,
          size: result.sourceData.length,
        },
      };
      summary.push({
        id: descriptor.id,
        role: descriptor.role,
        variants: result.manifest.variants.length,
        packageFileName: result.packageFileName,
        packageSha256: result.packageSha256,
        packageSize: result.packageData.length,
        sourceFileName: result.sourceFileName,
        sourceSha256: result.sourceSha256,
        sourceSize: result.sourceData.length,
      });
      onProgress({
        phase: 'built',
        id: descriptor.id,
        variants: result.manifest.variants.length,
        packageSha256: result.packageSha256,
        sourceSha256: result.sourceSha256,
      });
    }

    const sortedFamilies = {};
    for (const id of Object.keys(families).sort()) sortedFamilies[id] = families[id];
    const catalog = parseCatalog({
      schemaVersion: 1,
      catalogVersion,
      baseUrl,
      families: sortedFamilies,
    });
    const catalogData = Buffer.from(stableStringify(catalog));
    const catalogSha256 = sha256(catalogData);
    await writeArtifact(temporary, 'catalog.json', catalogData);
    await writeArtifact(
      temporary,
      'catalog.json.sha256',
      sidecarContent(catalogSha256, 'catalog.json'),
    );

    const payload = [
      ['catalog.json', catalogSha256],
      ...(bootstrap ? [[bootstrap.fileName, bootstrap.sha256]] : []),
      ...summary.flatMap((item) => [
        [item.packageFileName, item.packageSha256],
        [item.sourceFileName, item.sourceSha256],
      ]),
    ].sort((left, right) => compareText(left[0], right[0]));
    const checksums = `${payload.map(([name, hash]) => `${hash}  ${name}`).join('\n')}\n`;
    await writeArtifact(temporary, 'SHA256SUMS', checksums);

    if (fs.existsSync(output)) await fs.promises.rm(output, { recursive: true, force: true });
    await fs.promises.rename(temporary, output);
    return {
      output,
      catalogPath: path.join(output, 'catalog.json'),
      catalogReleaseTag: catalogReleaseTag(catalogVersion),
      catalog,
      catalogSha256,
      catalogSize: catalogData.length,
      bootstrap,
      summary,
    };
  } catch (error) {
    await fs.promises.rm(temporary, { recursive: true, force: true });
    throw error;
  }
}
