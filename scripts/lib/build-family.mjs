import {
  inspectFont,
  parseUnicodeRanges,
  renameSfntFont,
  validateFontMetadata,
} from './font.mjs';
import { splitCjkFont } from './font-split.mjs';
import { sha256 } from './hash.mjs';
import { loadAndVerifyLicenses } from './license.mjs';
import {
  buildFamilyManifest,
  buildSourceManifest,
  createFamilyArchiveEntries,
  createSourceArchiveEntries,
  familyArchiveFileName,
  sourceArchiveFileName,
} from './manifest.mjs';
import { createDeterministicTarGz } from './archive.mjs';
import { resolveFamilySources } from './source.mjs';
import { generateFontCss } from './font.mjs';
import { compareText } from './json.mjs';

function sortedSourceFiles(descriptor, resolved) {
  return descriptor.source.files
    .map((file) => {
      const source = resolved.get(file.fileName);
      return {
        fileName: file.fileName,
        data: source.data,
        sha256: sha256(source.data),
        size: source.data.length,
        origin: source.origin,
      };
    })
    .sort((left, right) => compareText(left.fileName, right.fileName));
}

function validateFixedFonts(descriptor, resolved) {
  const variantsBySource = new Map();
  for (const variant of descriptor.output.variants) {
    const variants = variantsBySource.get(variant.sourceFile) ?? [];
    variants.push(variant);
    variantsBySource.set(variant.sourceFile, variants);
  }
  for (const sourceFile of descriptor.source.files) {
    if (!variantsBySource.has(sourceFile.fileName)) {
      throw new Error(`${descriptor.id} declares unused source file ${sourceFile.fileName}`);
    }
  }

  const output = [];
  for (const variant of descriptor.output.variants) {
    const source = resolved.get(variant.sourceFile);
    const inspection = inspectFont(
      source.data,
      `${descriptor.id} source ${variant.sourceFile}`,
    );
    const metadata = validateFontMetadata(
      inspection,
      {
        familyName: descriptor.sourceFamilyName,
        style: variant.style,
        weight: variant.weight,
        stretch: variant.stretch,
      },
      `${descriptor.id} variant ${variant.file}`,
      { requireWoff2: true },
    );
    const unicodeRange = variant.unicodeRange
      ? parseUnicodeRanges(variant.unicodeRange)
      : undefined;
    output.push({
      ...variant,
      file: `fonts/${variant.file}`,
      sourceName: variant.file,
      data: source.data,
      metadata,
      unicodeRange: unicodeRange ? variant.unicodeRange : undefined,
    });
  }
  return output;
}

function maybeRenameCoreSource(descriptor, data) {
  if (descriptor.license.rfn.status !== 'renamed') {
    if (descriptor.output.rename) {
      throw new Error(`${descriptor.id} has output.rename but RFN status is not renamed`);
    }
    return { data, expectedFamilyName: descriptor.sourceFamilyName };
  }
  if (!descriptor.output.rename) {
    throw new Error(`${descriptor.id} requires an RFN rename but none is configured`);
  }
  return {
    data: renameSfntFont(data, {
      reservedNames: descriptor.license.reservedFontNames,
      replacement: descriptor.output.rename.to,
    }),
    expectedFamilyName: descriptor.output.rename.to,
  };
}

export async function buildFamily({
  repoRoot,
  descriptor,
  bootstrapDir,
  fetchImpl,
  cacheDir,
  splitter,
}) {
  const licenses = (await loadAndVerifyLicenses(repoRoot, descriptor)).sort((left, right) =>
    compareText(left.name, right.name),
  );
  const resolved = await resolveFamilySources(descriptor, {
    bootstrapDir,
    fetchImpl,
    cacheDir,
  });
  const sourceFiles = sortedSourceFiles(descriptor, resolved);

  let variants;
  if (descriptor.output.type === 'fixed') {
    variants = validateFixedFonts(descriptor, resolved).map((variant) => ({
      file: variant.file,
      data: variant.data,
      weight: variant.weight,
      style: variant.style,
      stretch: variant.stretch,
      display: variant.display,
      unicodeRange: variant.unicodeRange,
      features: variant.features,
      variationSettings: variant.variationSettings,
      font: variant.metadata,
    }));
  } else {
    const sourceFile = descriptor.source.files.find(
      (file) => file.fileName === descriptor.output.sourceFile,
    );
    if (!sourceFile) throw new Error(`${descriptor.id} core source is not declared`);
    const original = resolved.get(sourceFile.fileName).data;
    const renamed = maybeRenameCoreSource(descriptor, original);
    const inspection = inspectFont(renamed.data, `${descriptor.id} core source`);
    validateFontMetadata(
      inspection,
      {
        familyName: renamed.expectedFamilyName,
        style: descriptor.output.style,
        weight: descriptor.output.weight,
        stretch: undefined,
      },
      `${descriptor.id} core source`,
      { requireWoff2: false },
    );
    const split = await splitCjkFont({
      input: renamed.data,
      descriptor,
      sourceCoverage: inspection.characterSet,
      expectedFamilyName: renamed.expectedFamilyName,
      splitter,
    });
    variants = split.variants;
  }

  const manifest = buildFamilyManifest({
    descriptor,
    licenses,
    variants,
    sourceFiles,
  });
  const sourceManifest = buildSourceManifest({
    descriptor,
    licenses,
    sourceFiles,
  });
  const fontCss = generateFontCss({
    familyName: descriptor.familyName,
    variants,
  });
  const packageEntries = createFamilyArchiveEntries(
    manifest,
    fontCss,
    variants,
    licenses,
  );
  const sourceEntries = createSourceArchiveEntries(
    sourceManifest,
    sourceFiles,
    licenses,
  );
  const packageData = createDeterministicTarGz(packageEntries);
  const sourceData = createDeterministicTarGz(sourceEntries);
  return {
    descriptor,
    manifest,
    sourceManifest,
    fontCss,
    packageData,
    sourceData,
    packageFileName: familyArchiveFileName(descriptor.id, descriptor.version),
    sourceFileName: sourceArchiveFileName(descriptor.id, descriptor.version),
    packageSha256: sha256(packageData),
    sourceSha256: sha256(sourceData),
  };
}
