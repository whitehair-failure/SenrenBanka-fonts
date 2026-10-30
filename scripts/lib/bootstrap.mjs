import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_ARCHIVE_LIMITS } from './archive.mjs';
import { sha256, verifySha256 } from './hash.mjs';
import { compareText } from './json.mjs';
import {
  assertSafeFileName,
  assertSafeRelativePath,
} from './paths.mjs';
import { createDeterministicZip, readZipEntries } from './zip.mjs';

function descriptorValue(item) {
  return item?.descriptor ?? item;
}

function portablePath(value) {
  return value.normalize('NFC').toLowerCase();
}

export function bootstrapSourcePlan(descriptors) {
  if (!Array.isArray(descriptors) || descriptors.length === 0) {
    throw new Error('bootstrap source plan requires at least one descriptor');
  }
  const declared = new Map();
  const portable = new Map();
  const selected = [];
  for (const item of descriptors) {
    const descriptor = descriptorValue(item);
    for (const sourceFile of descriptor.source.files) {
      const fileName = assertSafeFileName(sourceFile.fileName, 'bootstrap source file name');
      const canonical = `source/fonts/${fileName}`;
      if (sourceFile.bootstrapKey !== canonical) {
        throw new Error(
          `${descriptor.id} bootstrap key must be the canonical path ${canonical}`,
        );
      }
      if (declared.has(canonical)) {
        throw new Error(`bootstrap source path is declared more than once: ${canonical}`);
      }
      const portableKey = portablePath(canonical);
      const collision = portable.get(portableKey);
      if (collision) {
        throw new Error(
          `bootstrap source paths collide on a case-insensitive filesystem: ${collision}, ${canonical}`,
        );
      }
      const record = {
        descriptorId: descriptor.id,
        path: canonical,
        fileName,
        size: sourceFile.size,
        sha256: sourceFile.sha256,
        hasDownload: Boolean(sourceFile.download),
      };
      declared.set(canonical, record);
      portable.set(portableKey, canonical);
      if (!record.hasDownload) selected.push(record);
    }
  }
  selected.sort((left, right) => compareText(left.path, right.path));
  return { declared, selected };
}

async function scanBootstrapDirectory(bootstrapDir, declared) {
  const root = path.resolve(bootstrapDir);
  let rootStat;
  try {
    rootStat = await fs.promises.lstat(root);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`bootstrap directory does not exist: ${bootstrapDir}`);
    }
    throw error;
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error('bootstrap directory must be a regular directory');
  }

  const files = new Map();
  const portableSeen = new Map();
  const visit = async (directory, relativeDirectory = '') => {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      const relative = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      assertSafeRelativePath(relative, 'bootstrap input path');
      const fullPath = path.join(directory, entry.name);
      const stat = await fs.promises.lstat(fullPath);
      if (stat.isSymbolicLink()) {
        throw new Error(`bootstrap input must not be a symlink: ${relative}`);
      }
      if (stat.isDirectory()) {
        if (declared.has(relative)) {
          throw new Error(`bootstrap input is a directory, not a file: ${relative}`);
        }
        await visit(fullPath, relative);
        continue;
      }
      if (!stat.isFile()) {
        throw new Error(`bootstrap input must be a regular file: ${relative}`);
      }
      if (!declared.has(relative)) {
        throw new Error(`bootstrap directory contains an undeclared file: ${relative}`);
      }
      const portable = portablePath(relative);
      const collision = portableSeen.get(portable);
      if (collision) {
        throw new Error(
          `bootstrap inputs collide on a case-insensitive filesystem: ${collision}, ${relative}`,
        );
      }
      portableSeen.set(portable, relative);
      files.set(relative, { fullPath, size: stat.size });
    }
  };
  await visit(root);
  return files;
}

export async function collectBootstrapEntries({ bootstrapDir, descriptors }) {
  const plan = bootstrapSourcePlan(descriptors);
  if (plan.selected.length === 0) {
    throw new Error('no descriptor source files require bootstrap input');
  }
  const files = await scanBootstrapDirectory(bootstrapDir, plan.declared);
  const entries = [];
  const included = [];
  for (const source of plan.selected) {
    const actual = files.get(source.path);
    if (!actual) throw new Error(`missing bootstrap input: ${source.path}`);
    if (actual.size !== source.size) {
      throw new Error(
        `bootstrap input size mismatch for ${source.path}: expected ${source.size}, got ${actual.size}`,
      );
    }
    const data = await fs.promises.readFile(actual.fullPath);
    verifySha256(data, source.sha256, `bootstrap input ${source.path}`);
    entries.push({ path: source.path, data });
    included.push({
      path: source.path,
      size: data.length,
      sha256: source.sha256,
      descriptorId: source.descriptorId,
    });
  }
  const excluded = [...plan.declared.values()]
    .filter((source) => source.hasDownload && files.has(source.path))
    .map((source) => source.path)
    .sort(compareText);
  return {
    entries,
    included,
    excluded,
    declaredCount: plan.declared.size,
  };
}

export async function buildBootstrapBundle({ bootstrapDir, descriptors }) {
  const collected = await collectBootstrapEntries({ bootstrapDir, descriptors });
  const data = createDeterministicZip(collected.entries);
  const verification = await verifyBootstrapBundleBuffer(data, descriptors);
  return {
    data,
    sha256: sha256(data),
    size: data.length,
    included: collected.included,
    excluded: collected.excluded,
    declaredCount: collected.declaredCount,
    verification,
  };
}

export async function verifyBootstrapBundleBuffer(
  buffer,
  descriptors,
  {
    limits = DEFAULT_ARCHIVE_LIMITS,
    label = 'bootstrap bundle',
    expectedSha256,
  } = {},
) {
  if (expectedSha256) verifySha256(buffer, expectedSha256, label);
  const plan = bootstrapSourcePlan(descriptors);
  if (plan.selected.length === 0) {
    throw new Error('descriptors do not declare any bootstrap-only sources');
  }
  const entries = await readZipEntries(buffer, {
    limits,
    label,
    strictDeterministic: true,
  });
  const actual = new Map();
  for (const entry of entries) {
    if (actual.has(entry.path)) {
      throw new Error(`${label} contains a duplicate member: ${entry.path}`);
    }
    actual.set(entry.path, entry.data);
  }
  const expected = new Set(plan.selected.map((source) => source.path));
  const missing = [...expected].filter((item) => !actual.has(item));
  const extra = [...actual.keys()].filter((item) => !expected.has(item));
  if (missing.length || extra.length) {
    throw new Error(
      `${label} member set mismatch${missing.length ? `; missing: ${missing.join(', ')}` : ''}${
        extra.length ? `; extra: ${extra.join(', ')}` : ''
      }`,
    );
  }
  for (const source of plan.selected) {
    const data = actual.get(source.path);
    if (data.length !== source.size) {
      throw new Error(`${label} ${source.path} size mismatch`);
    }
    verifySha256(data, source.sha256, `${label} ${source.path}`);
  }
  return {
    sha256: sha256(buffer),
    size: buffer.length,
    files: plan.selected.map((source) => ({
      path: source.path,
      size: source.size,
      sha256: source.sha256,
      descriptorId: source.descriptorId,
    })),
    excludedCount: plan.declared.size - plan.selected.length,
  };
}
