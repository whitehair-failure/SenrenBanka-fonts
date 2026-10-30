import fs from 'node:fs';
import path from 'node:path';
import { readTar } from './archive.mjs';
import {
  generateFontCss,
  codePointsInIntervals,
  inspectFont,
  intervalsOverlap,
  intervalContains,
  parseUnicodeRanges,
  validateFontMetadata,
} from './font.mjs';
import { sha256, verifySha256 } from './hash.mjs';
import { parseJson, stableStringify } from './json.mjs';
import {
  expectedFamilyPaths,
  expectedSourcePaths,
  sourceArchiveFileName,
  familyReleaseTag,
  TOOL_VERSIONS,
} from './manifest.mjs';
import {
  parseCatalog,
  parseFamilyManifest,
  parseSourceManifest,
} from './schema.mjs';

function entriesToMap(entries, label) {
  const map = new Map();
  for (const entry of entries) {
    if (map.has(entry.path)) throw new Error(`${label} contains duplicate ${entry.path}`);
    map.set(entry.path, entry.data);
  }
  return map;
}

function assertSameSet(actual, expected, label) {
  const missing = [...expected].filter((item) => !actual.has(item));
  const extra = [...actual].filter((item) => !expected.has(item));
  if (missing.length || extra.length) {
    throw new Error(
      `${label} file set mismatch${missing.length ? `; missing: ${missing.join(', ')}` : ''}${
        extra.length ? `; extra: ${extra.join(', ')}` : ''
      }`,
    );
  }
}

function mergeIntervals(intervals) {
  const sorted = [...intervals].sort((left, right) => left.min - right.min || left.max - right.max);
  const merged = [];
  for (const interval of sorted) {
    const previous = merged.at(-1);
    if (!previous || interval.min > previous.max + 1) {
      merged.push({ ...interval });
    } else {
      previous.max = Math.max(previous.max, interval.max);
    }
  }
  return merged;
}

function verifyCanonicalJson(bytes, value, label) {
  const text = Buffer.isBuffer(bytes) ? bytes.toString('utf8') : bytes;
  const parsed = parseJson(text, label);
  const canonical = stableStringify(parsed);
  if (canonical !== text) throw new Error(`${label} is not in canonical JSON form`);
  return value ?? parsed;
}

function assertDescriptorManifestCompatibility(manifest, descriptor) {
  const fields = [
    ['id', descriptor.id],
    ['familyName', descriptor.familyName],
    ['sourceFamilyName', descriptor.sourceFamilyName],
    ['role', descriptor.role],
    ['version', descriptor.version],
    ['cssVariable', descriptor.cssVariable],
  ];
  for (const [field, expected] of fields) {
    if (manifest[field] !== expected) {
      throw new Error(
        `family manifest ${field} mismatch: expected ${expected}, got ${manifest[field]}`,
      );
    }
  }
  if (JSON.stringify(manifest.fallbacks) !== JSON.stringify(descriptor.fallbacks)) {
    throw new Error('family manifest fallbacks do not match descriptor');
  }
  if (JSON.stringify(manifest.buildTools) !== JSON.stringify(TOOL_VERSIONS)) {
    throw new Error('family manifest build tool versions are not pinned correctly');
  }
  if (manifest.license.spdx !== descriptor.license.spdx) {
    throw new Error('family manifest SPDX identifier does not match descriptor');
  }
  for (const field of [
    'approvedForRedistribution',
    'reviewedAt',
    'reviewedBy',
    'evidenceUrl',
  ]) {
    if (manifest.license[field] !== descriptor.license[field]) {
      throw new Error(`family manifest license ${field} does not match descriptor`);
    }
  }
  if (
    JSON.stringify(manifest.license.reservedFontNames) !==
    JSON.stringify(descriptor.license.reservedFontNames)
  ) {
    throw new Error('family manifest reserved font names do not match descriptor');
  }
  if (stableStringify(manifest.license.rfn) !== stableStringify(descriptor.license.rfn)) {
    throw new Error('family manifest RFN metadata does not match descriptor');
  }
  if (manifest.source.archiveFileName !== sourceArchiveFileName(descriptor.id, descriptor.version)) {
    throw new Error('family manifest source archive name does not match descriptor');
  }
  const expectedLicense = descriptor.license.files
    .map((file) => `licenses/${file.name}`)
    .sort();
  const actualLicense = manifest.license.files.map((file) => file.file).sort();
  if (JSON.stringify(actualLicense) !== JSON.stringify(expectedLicense)) {
    throw new Error('family manifest license file list does not match descriptor');
  }
}

export function verifyFamilyPackageBuffer(buffer, descriptor) {
  const entries = readTar(buffer, {
    strictDeterministic: true,
    requireGzip: true,
    label: `${descriptor.id} family package`,
  });
  const map = entriesToMap(entries, `${descriptor.id} family package`);
  if (!map.has('manifest.json')) throw new Error('family package is missing manifest.json');
  const manifest = parseFamilyManifest(
    verifyCanonicalJson(map.get('manifest.json'), null, 'family manifest.json'),
    `${descriptor.id} family manifest`,
  );
  assertDescriptorManifestCompatibility(manifest, descriptor);
  assertSameSet(
    new Set(map.keys()),
    expectedFamilyPaths(manifest),
    `${descriptor.id} family package`,
  );

  for (const file of manifest.license.files) {
    const data = map.get(file.file);
    verifySha256(data, file.sha256, `${descriptor.id} ${file.file}`);
    if (data.length !== file.size) throw new Error(`${file.file} size mismatch`);
  }
  for (const declared of descriptor.license.files) {
    const actualFile = `licenses/${declared.name}`;
    const data = map.get(actualFile);
    if (!data) throw new Error(`family package is missing ${actualFile}`);
    verifySha256(data, declared.sha256, `${descriptor.id} ${actualFile}`);
  }
  if (manifest.license.files.length !== descriptor.license.files.length) {
    throw new Error('family manifest license count does not match descriptor');
  }

  const covers = [];
  for (const variant of manifest.variants) {
    const data = map.get(variant.file);
    if (!data) throw new Error(`family package is missing ${variant.file}`);
    verifySha256(data, variant.sha256, `${descriptor.id} ${variant.file}`);
    if (data.length !== variant.size) throw new Error(`${variant.file} size mismatch`);
    const inspection = inspectFont(data, `${descriptor.id} ${variant.file}`);
    const expectedFamilyName =
      descriptor.license.rfn.status === 'renamed'
        ? descriptor.output.rename.to
        : descriptor.sourceFamilyName;
    if (variant.font.familyName !== expectedFamilyName) {
      throw new Error(
        `${variant.file} family name is ${variant.font.familyName}, expected ${expectedFamilyName}`,
      );
    }
    validateFontMetadata(
      inspection,
      {
        familyName: variant.font.familyName,
        style: variant.style,
        weight: variant.weight,
        stretch: variant.stretch,
      },
      `${descriptor.id} ${variant.file}`,
      { requireWoff2: true },
    );
    if (stableStringify(inspection.metadata) !== stableStringify(variant.font)) {
      throw new Error(`${variant.file} font metadata does not match the manifest`);
    }
    if (variant.unicodeRange && descriptor.role === 'core-cjk') {
      const intervals = parseUnicodeRanges(variant.unicodeRange);
      for (const codePoint of codePointsInIntervals(intervals)) {
        if (!inspection.characterSet.has(codePoint)) {
          throw new Error(`${variant.file} is missing a declared unicode-range glyph`);
        }
      }
      const actualAliases = [...inspection.characterSet]
        .filter((codePoint) => !intervalContains(intervals, codePoint))
        .sort((left, right) => left - right);
      const declaredAliases = [...(variant.cmapAliases ?? [])].sort(
        (left, right) => left - right,
      );
      if (JSON.stringify(actualAliases) !== JSON.stringify(declaredAliases)) {
        throw new Error(
          `${variant.file} cmap aliases do not match the manifest`,
        );
      }
      covers.push({ file: variant.file, intervals });
    } else if (descriptor.role === 'core-cjk') {
      throw new Error(`core-cjk shard ${variant.file} is missing unicode-range`);
    }
  }
  if (descriptor.role === 'core-cjk') {
    for (let left = 0; left < covers.length; left += 1) {
      for (let right = left + 1; right < covers.length; right += 1) {
        for (const a of covers[left].intervals) {
          for (const b of covers[right].intervals) {
            if (intervalsOverlap(a, b)) {
              throw new Error(
                `unicode-range overlap between ${covers[left].file} and ${covers[right].file}`,
              );
            }
          }
        }
      }
    }
  }

  const css = map.get('font.css').toString('utf8');
  const expectedCss = generateFontCss({
    familyName: manifest.familyName,
    variants: manifest.variants.map((variant) => ({
      ...variant,
      file: variant.file,
    })),
  });
  if (css !== expectedCss) throw new Error('font.css is not canonical or does not match manifest');
  return { manifest, entries: map };
}

export function verifySourceArchiveBuffer(buffer, descriptor) {
  const entries = readTar(buffer, {
    strictDeterministic: true,
    requireGzip: true,
    label: `${descriptor.id} source package`,
  });
  const map = entriesToMap(entries, `${descriptor.id} source package`);
  if (!map.has('source-manifest.json')) {
    throw new Error('source archive is missing source-manifest.json');
  }
  const manifest = parseSourceManifest(
    verifyCanonicalJson(
      map.get('source-manifest.json'),
      null,
      'source manifest.json',
    ),
    `${descriptor.id} source manifest`,
  );
  if (manifest.id !== descriptor.id || manifest.version !== descriptor.version) {
    throw new Error('source manifest id/version does not match descriptor');
  }
  if (manifest.upstream.project !== descriptor.source.project) {
    throw new Error('source manifest upstream project does not match descriptor');
  }
  if (manifest.upstream.url !== descriptor.source.url) {
    throw new Error('source manifest upstream URL does not match descriptor');
  }
  if (
    manifest.upstream.version !== descriptor.source.version ||
    manifest.upstream.retrievedAt !== descriptor.source.retrievedAt ||
    manifest.upstream.revision !== descriptor.source.revision
  ) {
    throw new Error('source manifest upstream metadata does not match descriptor');
  }
  assertSameSet(
    new Set(map.keys()),
    expectedSourcePaths(manifest),
    `${descriptor.id} source package`,
  );
  const sourceManifestPaths = new Set(manifest.files.map((file) => file.file));
  if (sourceManifestPaths.size !== manifest.files.length) {
    throw new Error(`${descriptor.id} source manifest repeats a source file`);
  }
  const licenseManifestPaths = new Set(manifest.licenses.map((file) => file.file));
  if (licenseManifestPaths.size !== manifest.licenses.length) {
    throw new Error(`${descriptor.id} source manifest repeats a license file`);
  }
  for (const file of [...manifest.files, ...manifest.licenses]) {
    const data = map.get(file.file);
    verifySha256(data, file.sha256, `${descriptor.id} ${file.file}`);
    if (data.length !== file.size) throw new Error(`${file.file} size mismatch`);
  }
  const descriptorSources = new Map(
    descriptor.source.files.map((file) => [`source/fonts/${file.fileName}`, file]),
  );
  for (const file of manifest.files) {
    const expected = descriptorSources.get(file.file);
    if (!expected) throw new Error(`source archive contains undeclared file ${file.file}`);
    if (file.sha256 !== expected.sha256 || file.size !== expected.size) {
      throw new Error(`source archive ${file.file} does not match descriptor`);
    }
  }
  for (const filePath of descriptorSources.keys()) {
    if (!sourceManifestPaths.has(filePath)) {
      throw new Error(`source archive is missing a descriptor source file: ${filePath}`);
    }
  }
  const descriptorLicenses = new Map(
    descriptor.license.files.map((file) => [
      `source/licenses/${file.name}`,
      file.sha256,
    ]),
  );
  for (const file of manifest.licenses) {
    if (descriptorLicenses.get(file.file) !== file.sha256) {
      throw new Error(`source archive license ${file.file} does not match descriptor`);
    }
  }
  for (const filePath of descriptorLicenses.keys()) {
    if (!licenseManifestPaths.has(filePath)) {
      throw new Error(`source archive is missing a descriptor license file: ${filePath}`);
    }
  }
  return { manifest, entries: map };
}

export function verifyFamilyPair(packageBuffer, sourceBuffer, descriptor) {
  const family = verifyFamilyPackageBuffer(packageBuffer, descriptor);
  const source = verifySourceArchiveBuffer(sourceBuffer, descriptor);
  const manifestSource = new Map(
    family.manifest.source.files.map((file) => [
      file.fileName,
      { sha256: file.sha256, size: file.size },
    ]),
  );
  for (const file of source.manifest.files) {
    const name = file.file.slice('source/fonts/'.length);
    const expected = manifestSource.get(name);
    if (!expected || expected.sha256 !== file.sha256 || expected.size !== file.size) {
      throw new Error(`family manifest source pointer mismatch for ${name}`);
    }
  }
  if (manifestSource.size !== source.manifest.files.length) {
    throw new Error('family manifest declares a source file absent from source archive');
  }
  if (descriptor.role === 'core-cjk') {
    if (descriptor.output.type !== 'core-cjk') {
      throw new Error(`${descriptor.id} has inconsistent core-cjk output metadata`);
    }
    const sourcePath = `source/fonts/${descriptor.output.sourceFile}`;
    const sourceEntry = source.entries.get(sourcePath);
    if (!sourceEntry) throw new Error(`source archive is missing core font ${sourcePath}`);
    const sourceInspection = inspectFont(
      sourceEntry,
      `${descriptor.id} source coverage`,
    );
    const ranges = mergeIntervals(
      family.manifest.variants.flatMap((variant) =>
        parseUnicodeRanges(variant.unicodeRange),
      ),
    );
    const missing = [...sourceInspection.characterSet].filter(
      (codePoint) => !intervalContains(ranges, codePoint),
    );
    if (missing.length > 0) {
      throw new Error(
        `core shards do not cover source character U+${missing[0]
          .toString(16)
          .toUpperCase()}`,
      );
    }
    for (const variant of family.manifest.variants) {
      const shardData = family.entries.get(variant.file);
      const shardInspection = inspectFont(
        shardData,
        `${descriptor.id} ${variant.file} source coverage`,
      );
      for (const codePoint of shardInspection.characterSet) {
        if (!sourceInspection.characterSet.has(codePoint)) {
          throw new Error(
            `${variant.file} contains U+${codePoint
              .toString(16)
              .toUpperCase()} not present in the source`,
          );
        }
      }
    }
  }
  return { family, source };
}

function parseChecksums(text) {
  const map = new Map();
  for (const line of text.trim().split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    if (!match) throw new Error(`SHA256SUMS has an invalid line: ${line}`);
    if (map.has(match[2])) throw new Error(`SHA256SUMS repeats ${match[2]}`);
    map.set(match[2], match[1]);
  }
  return map;
}

export async function verifyCatalogDirectory({ dir, descriptors }) {
  const catalogPath = path.join(dir, 'catalog.json');
  const catalogBytes = await fs.promises.readFile(catalogPath);
  const catalog = parseCatalog(
    verifyCanonicalJson(catalogBytes, null, 'catalog.json'),
    'catalog.json',
  );
  const expectedIds = descriptors.map((item) => item.descriptor.id).sort();
  const actualIds = Object.keys(catalog.families).sort();
  if (JSON.stringify(expectedIds) !== JSON.stringify(actualIds)) {
    throw new Error(
      `catalog family set mismatch: expected ${expectedIds.join(', ')}, got ${actualIds.join(', ')}`,
    );
  }

  const expectedFiles = new Set(['catalog.json', 'catalog.json.sha256', 'SHA256SUMS']);
  const payloadChecksums = new Map([['catalog.json', sha256(catalogBytes)]]);
  for (const item of descriptors) {
    const { descriptor } = item;
    const family = catalog.families[descriptor.id];
    if (!family) throw new Error(`catalog is missing ${descriptor.id}`);
    if (family.version !== descriptor.version || family.role !== descriptor.role) {
      throw new Error(`catalog pointer drift for ${descriptor.id}`);
    }
    if (family.package.releaseTag !== familyReleaseTag(descriptor.id, descriptor.version)) {
      throw new Error(`invalid package release tag for ${descriptor.id}`);
    }
    for (const asset of [family.package, family.source]) {
      const filePath = path.join(dir, asset.fileName);
      let data;
      try {
        data = await fs.promises.readFile(filePath);
      } catch (error) {
        if (error.code === 'ENOENT') {
          throw new Error(`catalog references missing asset ${asset.fileName}`);
        }
        throw error;
      }
      if (data.length !== asset.size) throw new Error(`${asset.fileName} size mismatch`);
      verifySha256(data, asset.sha256, asset.fileName);
      payloadChecksums.set(asset.fileName, asset.sha256);
      expectedFiles.add(asset.fileName);
      expectedFiles.add(`${asset.fileName}.sha256`);
      const sidecar = await fs.promises.readFile(`${filePath}.sha256`, 'utf8');
      const sidecarMatch = /^([a-f0-9]{64})  (.+)\n$/.exec(sidecar);
      if (!sidecarMatch || sidecarMatch[1] !== asset.sha256 || sidecarMatch[2] !== asset.fileName) {
        throw new Error(`${asset.fileName}.sha256 is invalid`);
      }
    }
    const packagePath = path.join(dir, family.package.fileName);
    const sourcePath = path.join(dir, family.source.fileName);
    verifyFamilyPair(
      await fs.promises.readFile(packagePath),
      await fs.promises.readFile(sourcePath),
      descriptor,
    );
  }

  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  const nonFile = entries.find((entry) => !entry.isFile());
  if (nonFile) {
    throw new Error(`release directory contains a non-regular entry: ${nonFile.name}`);
  }
  const actualFiles = new Set(entries.map((entry) => entry.name));
  assertSameSet(actualFiles, expectedFiles, 'release directory');

  const catalogSidecar = await fs.promises.readFile(
    path.join(dir, 'catalog.json.sha256'),
    'utf8',
  );
  const catalogMatch = /^([a-f0-9]{64})  catalog\.json\n$/.exec(catalogSidecar);
  if (!catalogMatch || catalogMatch[1] !== payloadChecksums.get('catalog.json')) {
    throw new Error('catalog.json.sha256 is invalid');
  }
  const checksums = parseChecksums(
    await fs.promises.readFile(path.join(dir, 'SHA256SUMS'), 'utf8'),
  );
  assertSameSet(new Set(checksums.keys()), new Set(payloadChecksums.keys()), 'SHA256SUMS');
  for (const [fileName, expected] of payloadChecksums) {
    if (checksums.get(fileName) !== expected) {
      throw new Error(`SHA256SUMS mismatch for ${fileName}`);
    }
  }
  return catalog;
}

export async function compareCatalogDirectories(left, right) {
  const readFiles = async (directory) => {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    const nonFile = entries.find((entry) => !entry.isFile());
    if (nonFile) {
      throw new Error(`reproducibility directory contains a non-regular entry: ${nonFile.name}`);
    }
    return entries.map((entry) => entry.name).sort();
  };
  const leftFiles = await readFiles(left);
  const rightFiles = await readFiles(right);
  if (JSON.stringify(leftFiles) !== JSON.stringify(rightFiles)) {
    throw new Error('reproducibility check found a different artifact set');
  }
  for (const fileName of leftFiles) {
    const leftData = await fs.promises.readFile(path.join(left, fileName));
    const rightData = await fs.promises.readFile(path.join(right, fileName));
    if (!leftData.equals(rightData)) {
      throw new Error(`reproducibility check found different bytes for ${fileName}`);
    }
  }
}
