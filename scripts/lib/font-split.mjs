import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fontSplit as defaultFontSplit } from 'cn-font-split';
import {
  formatUnicodeRanges,
  inspectFont,
  intervalContains,
  intervalsFromCodePoints,
  isUnicodeNoncharacter,
  parseCssFontFaces,
  parseUnicodeRanges,
  validateFontMetadata,
} from './font.mjs';
import { assertSafeFileName } from './paths.mjs';
import { compareText } from './json.mjs';

async function emptyDirectory(directory) {
  await fs.promises.rm(directory, { recursive: true, force: true });
  await fs.promises.mkdir(directory, { recursive: true });
}

async function runSplitter(splitter, config, directory) {
  await emptyDirectory(directory);
  await splitter(config(directory));
  const generated = (await fs.promises.readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
  if (!generated.includes('font.css')) {
    throw new Error('cn-font-split did not generate font.css');
  }
  const faces = parseCssFontFaces(
    await fs.promises.readFile(path.join(directory, 'font.css'), 'utf8'),
    'cn-font-split CSS',
  );
  const faceFiles = faces.map((face) => assertSafeFileName(face.file, 'shard file'));
  if (new Set(faceFiles).size !== faceFiles.length) {
    throw new Error('cn-font-split CSS references a shard more than once');
  }
  const generatedFonts = generated.filter((name) => name.endsWith('.woff2')).sort();
  if (
    generatedFonts.length !== faceFiles.length ||
    generatedFonts.some((name) => !faceFiles.includes(name))
  ) {
    throw new Error('cn-font-split CSS and generated WOFF2 set do not match');
  }
  if (generatedFonts.length === 0) throw new Error('cn-font-split generated no WOFF2 shards');
  return { generated, faces };
}

function baseConfig({ input, outDir, descriptor, chunkSize, subsets }) {
  return {
    input,
    outDir,
    ...(subsets ? { subsets } : {}),
    chunkSize,
    chunkSizeTolerance: 1024,
    languageAreas: !subsets,
    fontFeature: true,
    reduceMins: !subsets,
    autoSubset: !subsets,
    subsetRemainChars: !subsets,
    testHtml: false,
    reporter: false,
    silent: true,
    renameOutputFont: '[hash:6].[ext]',
    css: {
      fontFamily: descriptor.familyName,
      fontWeight: descriptor.output.weight,
      fontStyle: descriptor.output.style,
      fontDisplay: descriptor.output.display,
      localFamily: [],
      commentBase: false,
      commentNameTable: false,
      commentUnicodes: false,
      compress: false,
      fileName: 'font.css',
    },
  };
}

function visibleCharacterSet(font) {
  return new Set([...font.characterSet].filter((codePoint) => !isUnicodeNoncharacter(codePoint)));
}

/**
 * The first pass obtains cn-font-split's language-aware grouping. The second
 * pass supplies explicit disjoint subsets, removing the tool's U+FFFF cmap
 * sentinel and paired-punctuation duplication from the browser-facing mapping.
 */
export async function splitCjkFont({
  input,
  descriptor,
  sourceCoverage,
  expectedFamilyName,
  chunkSize = descriptor.output.chunkSize,
  splitter = defaultFontSplit,
}) {
  if (descriptor.output.type !== 'core-cjk') {
    throw new Error('splitCjkFont requires a core-cjk descriptor');
  }
  sourceCoverage = new Set(
    [...sourceCoverage].filter((codePoint) => !isUnicodeNoncharacter(codePoint)),
  );
  const temporaryRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'senrenbanka-split-'));
  const planningDir = path.join(temporaryRoot, 'planning');
  const finalDir = path.join(temporaryRoot, 'final');
  try {
    const planning = await runSplitter(
      splitter,
      (outDir) => baseConfig({ input, outDir, descriptor, chunkSize }),
      planningDir,
    );
    const planned = [];
    for (const face of planning.faces) {
      const fileName = assertSafeFileName(face.file, 'planning shard file');
      const data = await fs.promises.readFile(path.join(planningDir, fileName));
      const inspection = inspectFont(data, `planning shard ${fileName}`);
      validateFontMetadata(
        inspection,
        {
          familyName: expectedFamilyName,
          style: descriptor.output.style,
          weight: descriptor.output.weight,
          stretch: undefined,
        },
        `planning shard ${fileName}`,
      );
      planned.push({
        file: fileName,
        declared: parseUnicodeRanges(face.unicodeRange),
        characters: visibleCharacterSet(inspection),
      });
    }
    planned.sort((left, right) => compareText(left.file, right.file));

    const available = new Map();
    for (const shard of planned) {
      for (const codePoint of shard.characters) {
        if (!sourceCoverage.has(codePoint)) {
          throw new Error(
            `cn-font-split introduced U+${codePoint.toString(16).toUpperCase()} not present in the source`,
          );
        }
        const candidates = available.get(codePoint) ?? [];
        candidates.push(shard);
        available.set(codePoint, candidates);
      }
    }
    for (const codePoint of sourceCoverage) {
      if (!available.has(codePoint)) {
        throw new Error(
          `cn-font-split omitted source character U+${codePoint.toString(16).toUpperCase()}`,
        );
      }
    }

    const groups = new Map(planned.map((shard) => [shard.file, []]));
    for (const codePoint of [...sourceCoverage].sort((left, right) => left - right)) {
      const candidates = available.get(codePoint);
      const declaredOwner = candidates.find((shard) =>
        intervalContains(shard.declared, codePoint),
      );
      const owner =
        declaredOwner ?? [...candidates].sort((a, b) => compareText(a.file, b.file))[0];
      groups.get(owner.file).push(codePoint);
    }
    const subsets = planned.map((shard) => groups.get(shard.file));
    if (subsets.some((subset) => subset.length === 0)) {
      throw new Error('cn-font-split produced an empty shard after normalization');
    }

    const final = await runSplitter(
      splitter,
      (outDir) =>
        baseConfig({
          input,
          outDir,
          descriptor,
          chunkSize,
          subsets,
        }),
      finalDir,
    );
    const finalShards = [];
    for (const face of final.faces) {
      const fileName = assertSafeFileName(face.file, 'final shard file');
      const data = await fs.promises.readFile(path.join(finalDir, fileName));
      const inspection = inspectFont(data, `final shard ${fileName}`);
      const metadata = validateFontMetadata(
        inspection,
        {
          familyName: expectedFamilyName,
          style: descriptor.output.style,
          weight: descriptor.output.weight,
          stretch: undefined,
        },
        `final shard ${fileName}`,
      );
      finalShards.push({
        fileName,
        data,
        metadata,
        characters: visibleCharacterSet(inspection),
      });
    }
    for (const shard of finalShards) {
      for (const codePoint of shard.characters) {
        if (!sourceCoverage.has(codePoint)) {
          throw new Error(
            `final shard ${shard.fileName} contains U+${codePoint
              .toString(16)
              .toUpperCase()} not present in the source`,
          );
        }
      }
    }

    const remainingGroups = new Map(
      subsets.map((subset) => [subset.join(','), subset]),
    );
    const assignments = new Map();
    for (const shard of finalShards) {
      const signature = [...shard.characters].sort((left, right) => left - right).join(',');
      if (!remainingGroups.has(signature)) continue;
      assignments.set(shard.fileName, remainingGroups.get(signature));
      remainingGroups.delete(signature);
    }

    // cn-font-split preserves some paired punctuation in both CMaps. Assign
    // that browser-inert duplicate to the exact planned subset and keep the
    // published unicode-range disjoint.
    for (const shard of finalShards.filter((item) => !assignments.has(item.fileName))) {
      const candidates = [...remainingGroups.entries()]
        .map(([signature, group]) => ({
          signature,
          group,
          extras: [...shard.characters].filter((codePoint) => !group.includes(codePoint)),
          missing: group.filter((codePoint) => !shard.characters.has(codePoint)),
        }))
        .filter((item) => item.missing.length === 0 && item.extras.length <= 2)
        .sort((left, right) => left.extras.length - right.extras.length);
      if (candidates.length !== 1) {
        throw new Error(
          `final shard ${shard.fileName} does not map to exactly one explicit subset`,
        );
      }
      assignments.set(shard.fileName, candidates[0].group);
      remainingGroups.delete(candidates[0].signature);
    }
    if (remainingGroups.size !== 0) {
      throw new Error('final cn-font-split output is missing a normalized shard');
    }

    const variants = [];
    const covered = new Set();
    for (const shard of finalShards) {
      const group = assignments.get(shard.fileName);
      for (const codePoint of group) {
        if (!shard.characters.has(codePoint)) {
          throw new Error(`final shard ${shard.fileName} is missing an explicit subset glyph`);
        }
        covered.add(codePoint);
      }
      variants.push({
        file: `fonts/${shard.fileName}`,
        sourceName: shard.fileName,
        data: shard.data,
        weight: descriptor.output.weight,
        style: descriptor.output.style,
        display: descriptor.output.display,
        unicodeRange: formatUnicodeRanges(intervalsFromCodePoints(group)),
        cmapAliases: [...shard.characters]
          .filter((codePoint) => !group.includes(codePoint))
          .sort((left, right) => left - right),
        font: shard.metadata,
      });
    }
    for (const codePoint of sourceCoverage) {
      if (!covered.has(codePoint)) {
        throw new Error(
          `final shards do not cover source U+${codePoint.toString(16).toUpperCase()}`,
        );
      }
    }
    variants.sort((left, right) => compareText(left.file, right.file));
    return { variants, generatedFiles: final.generated };
  } finally {
    await fs.promises.rm(temporaryRoot, { recursive: true, force: true });
  }
}
