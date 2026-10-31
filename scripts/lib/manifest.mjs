import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from './hash.mjs';
import { stableStringify } from './json.mjs';
import { assertSafeFileName } from './paths.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const packageJson = JSON.parse(
  await fs.promises.readFile(path.join(REPO_ROOT, 'package.json'), 'utf8'),
);

export const TOOL_VERSIONS = Object.freeze({
  cnFontSplit: packageJson.dependencies['cn-font-split'],
  fontkitten: packageJson.dependencies.fontkitten,
  schema: 1,
});

export function familyArchiveFileName(id, version) {
  return `${id}-v${version}.tar.gz`;
}

export function sourceArchiveFileName(id, version) {
  return `${id}-v${version}-source.tar.gz`;
}

export function bootstrapArchiveFileName(catalogVersion) {
  return `bootstrap-sources-v${catalogVersion}.zip`;
}

export function bootstrapReleaseTag(catalogVersion) {
  return `bootstrap-v${catalogVersion}`;
}

export function familyReleaseTag(id, version) {
  return `font-${id}-v${version}`;
}

export function catalogReleaseTag(catalogVersion) {
  return `catalog-v${catalogVersion}`;
}

export function buildFamilyManifest({
  descriptor,
  licenses,
  variants,
  sourceFiles,
}) {
  const sourceArchiveName = sourceArchiveFileName(descriptor.id, descriptor.version);
  const manifest = {
    schemaVersion: 1,
    kind: 'family',
    id: descriptor.id,
    familyName: descriptor.familyName,
    sourceFamilyName: descriptor.sourceFamilyName,
    role: descriptor.role,
    ...(descriptor.scripts ? { scripts: descriptor.scripts } : {}),
    version: descriptor.version,
    cssVariable: descriptor.cssVariable,
    fallbacks: descriptor.fallbacks,
    buildTools: TOOL_VERSIONS,
    source: {
      archiveFileName: sourceArchiveName,
      files: sourceFiles.map((file) => ({
        fileName: assertSafeFileName(file.fileName, 'source file name'),
        sha256: file.sha256,
        size: file.size,
      })),
    },
    license: {
      spdx: descriptor.license.spdx,
      approvedForRedistribution: descriptor.license.approvedForRedistribution,
      reviewedAt: descriptor.license.reviewedAt,
      reviewedBy: descriptor.license.reviewedBy,
      evidenceUrl: descriptor.license.evidenceUrl,
      files: licenses.map((file) => ({
        file: `licenses/${file.name}`,
        sha256: file.sha256,
        size: file.data.length,
      })),
      reservedFontNames: descriptor.license.reservedFontNames,
      rfn: descriptor.license.rfn,
    },
    css: 'font.css',
    variants: variants.map((variant) => ({
      file: variant.file,
      sha256: sha256(variant.data),
      size: variant.data.length,
      weight: variant.weight,
      style: variant.style,
      ...(variant.stretch ? { stretch: variant.stretch } : {}),
      display: variant.display,
      ...(variant.unicodeRange ? { unicodeRange: variant.unicodeRange } : {}),
      ...(variant.cmapAliases?.length ? { cmapAliases: variant.cmapAliases } : {}),
      ...(variant.features ? { features: variant.features } : {}),
      ...(variant.variationSettings
        ? { variationSettings: variant.variationSettings }
        : {}),
      font: variant.font,
    })),
  };
  return manifest;
}

export function buildSourceManifest({ descriptor, licenses, sourceFiles }) {
  return {
    schemaVersion: 1,
    kind: 'source',
    id: descriptor.id,
    version: descriptor.version,
    upstream: {
      project: descriptor.source.project,
      version: descriptor.source.version,
      url: descriptor.source.url,
      ...(descriptor.source.revision ? { revision: descriptor.source.revision } : {}),
      retrievedAt: descriptor.source.retrievedAt,
    },
    files: sourceFiles.map((file) => ({
      file: `source/fonts/${file.fileName}`,
      sha256: file.sha256,
      size: file.size,
    })),
    licenses: licenses.map((file) => ({
      file: `source/licenses/${file.name}`,
      sha256: file.sha256,
      size: file.data.length,
    })),
  };
}

export function createFamilyArchiveEntries(manifest, fontCss, variants, licenses) {
  const entries = [
    { path: 'manifest.json', data: stableStringify(manifest) },
    { path: 'font.css', data: fontCss },
  ];
  for (const variant of variants) {
    entries.push({ path: variant.file, data: variant.data });
  }
  for (const file of licenses) {
    entries.push({ path: `licenses/${file.name}`, data: file.data });
  }
  return entries;
}

export function createSourceArchiveEntries(sourceManifest, sourceFiles, licenses) {
  const entries = [
    { path: 'source-manifest.json', data: stableStringify(sourceManifest) },
  ];
  for (const file of sourceFiles) {
    entries.push({ path: `source/fonts/${file.fileName}`, data: file.data });
  }
  for (const file of licenses) {
    entries.push({ path: `source/licenses/${file.name}`, data: file.data });
  }
  return entries;
}

export function expectedFamilyPaths(manifest) {
  return new Set([
    'manifest.json',
    'font.css',
    ...manifest.variants.map((variant) => variant.file),
    ...manifest.license.files.map((file) => file.file),
  ]);
}

export function expectedSourcePaths(manifest) {
  return new Set([
    'source-manifest.json',
    ...manifest.files.map((file) => file.file),
    ...manifest.licenses.map((file) => file.file),
  ]);
}
