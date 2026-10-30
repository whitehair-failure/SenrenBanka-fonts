import fs from 'node:fs';
import path from 'node:path';
import { compareText, parseJson } from './json.mjs';
import { parseFamilyDescriptor } from './schema.mjs';

export function compareVersions(left, right) {
  const split = (value) => {
    const withoutBuild = value.split('+')[0];
    const dash = withoutBuild.indexOf('-');
    const main = dash === -1 ? withoutBuild : withoutBuild.slice(0, dash);
    const prerelease = dash === -1 ? '' : withoutBuild.slice(dash + 1);
    return {
      main: main.split('.').map(Number),
      prerelease: prerelease ? prerelease.split('.') : [],
    };
  };
  const a = split(left);
  const b = split(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.main[index] !== b.main[index]) return a.main[index] - b.main[index];
  }
  if (a.prerelease.length === 0 && b.prerelease.length > 0) return 1;
  if (b.prerelease.length === 0 && a.prerelease.length > 0) return -1;
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return Number(leftPart) - Number(rightPart);
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

async function walkJsonFiles(directory) {
  const files = [];
  const visit = async (current) => {
    let entries;
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries.sort((a, b) => compareText(a.name, b.name))) {
      const fullPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`descriptor tree must not contain symlinks: ${fullPath}`);
      }
      if (entry.isDirectory()) await visit(fullPath);
      else if (entry.isFile() && entry.name.endsWith('.json')) files.push(fullPath);
    }
  };
  await visit(directory);
  return files;
}

export async function loadAllDescriptors(repoRoot) {
  const root = path.join(repoRoot, 'catalog', 'families');
  const descriptors = [];
  for (const filePath of await walkJsonFiles(root)) {
    const relative = path.relative(repoRoot, filePath).split(path.sep).join('/');
    const descriptor = parseFamilyDescriptor(
      parseJson(await fs.promises.readFile(filePath, 'utf8'), relative),
      relative,
    );
    const expected = `catalog/families/${descriptor.id}/${descriptor.version}.json`;
    if (relative !== expected) {
      throw new Error(`descriptor path ${relative} must be ${expected}`);
    }
    descriptors.push({ descriptor, filePath, relative });
  }
  if (descriptors.length === 0) throw new Error('no family descriptors found');

  const keys = new Set();
  for (const { descriptor } of descriptors) {
    const key = `${descriptor.id}@${descriptor.version}`;
    if (keys.has(key)) throw new Error(`duplicate descriptor ${key}`);
    keys.add(key);
  }
  descriptors.sort(
    (left, right) =>
      compareText(left.descriptor.id, right.descriptor.id) ||
      compareVersions(left.descriptor.version, right.descriptor.version),
  );
  return descriptors;
}

export function selectCurrentDescriptors(descriptors) {
  const current = new Map();
  for (const item of descriptors) {
    const previous = current.get(item.descriptor.id);
    if (!previous || compareVersions(item.descriptor.version, previous.descriptor.version) > 0) {
      current.set(item.descriptor.id, item);
    }
  }
  return [...current.values()].sort((a, b) =>
    compareText(a.descriptor.id, b.descriptor.id),
  );
}

export async function loadCurrentDescriptors(repoRoot) {
  return selectCurrentDescriptors(await loadAllDescriptors(repoRoot));
}

export function serializeDescriptor(descriptor) {
  return `${JSON.stringify(descriptor, null, 2)}\n`;
}
