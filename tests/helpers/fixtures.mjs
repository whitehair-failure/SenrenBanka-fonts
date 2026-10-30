import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
export const fixtureRoot = path.join(repoRoot, 'fixtures');
export const fixtureFonts = path.join(fixtureRoot, 'fonts');
export const fixtureLicense = path.join(fixtureRoot, 'licenses', 'LICENSE.txt');

export function hash(data) {
  return createHash('sha256').update(data).digest('hex');
}

function descriptorBase(id, familyName, role) {
  const ttf = fs.readFileSync(path.join(fixtureFonts, 'fixture-sans.ttf'));
  const woff2 = fs.readFileSync(path.join(fixtureFonts, 'fixture-sans.woff2'));
  const license = fs.readFileSync(fixtureLicense);
  const sourceName = role === 'core-cjk' ? 'fixture-sans.ttf' : 'fixture-sans.woff2';
  const sourceData = role === 'core-cjk' ? ttf : woff2;
  return {
    schemaVersion: 1,
    id,
    familyName,
    sourceFamilyName: 'Fixture Sans',
    role,
    version: '1.0.0',
    source: {
      project: 'Fixture Sans test project',
      version: '1.0.0',
      url: 'https://example.com/fixture-sans',
      retrievedAt: '2026-10-30',
      files: [
        {
          fileName: sourceName,
          size: sourceData.length,
          sha256: hash(sourceData),
          bootstrapKey: `source/fonts/${sourceName}`,
        },
      ],
    },
    license: {
      spdx: 'OFL-1.1',
      approvedForRedistribution: true,
      reviewedAt: '2026-10-30',
      reviewedBy: 'Fixture maintainer',
      evidenceUrl: 'https://example.com/fixture-license',
      files: [{ name: 'LICENSE.txt', sha256: hash(license) }],
      reservedFontNames: [],
      rfn: {
        status: 'not-applicable',
        basis: 'Fixture license declares no Reserved Font Name.',
      },
    },
    output:
      role === 'core-cjk'
        ? {
            type: 'core-cjk',
            sourceFile: sourceName,
            weight: '400',
            style: 'normal',
            display: 'swap',
            chunkSize: 512,
            languageAreas: true,
            fontFeature: true,
          }
        : {
            type: 'fixed',
            variants: [
              {
                sourceFile: sourceName,
                file: sourceName,
                weight: '400',
                style: 'normal',
                display: 'swap',
              },
            ],
          },
    cssVariable: role === 'core-cjk' ? '--font-fixture-core' : '--font-fixture',
    fallbacks: ['sans-serif'],
    provenance: {
      retrievedAt: '2026-10-30',
      processing: 'Fixture is copied by the production pipeline.',
      notes: 'Synthetic test input.',
    },
  };
}

export function makeFixedDescriptor(overrides = {}) {
  return {
    ...descriptorBase(overrides.id ?? 'fixture-fixed', overrides.familyName ?? 'Fixture Sans', 'fixed'),
    ...overrides,
  };
}

export function makeCoreDescriptor(overrides = {}) {
  return {
    ...descriptorBase(overrides.id ?? 'fixture-core', overrides.familyName ?? 'Fixture Sans', 'core-cjk'),
    ...overrides,
  };
}

export async function createFixtureRepo(descriptors = []) {
  await fs.promises.mkdir(path.join(repoRoot, '.cache'), { recursive: true });
  const root = await fs.promises.mkdtemp(path.join(repoRoot, '.cache', 'fixture-repo-'));
  const bootstrap = path.join(root, 'bootstrap');
  await fs.promises.mkdir(path.join(bootstrap, 'source', 'fonts'), { recursive: true });
  for (const item of descriptors) {
    const descriptor = item?.descriptor ?? item;
    for (const source of descriptor.source.files) {
      await fs.promises.mkdir(
        path.dirname(path.join(bootstrap, ...source.bootstrapKey.split('/'))),
        { recursive: true },
      );
      const fixtureSource = source.fileName.endsWith('.woff2')
        ? path.join(fixtureFonts, 'fixture-sans.woff2')
        : path.join(fixtureFonts, 'fixture-sans.ttf');
      await fs.promises.copyFile(
        fixtureSource,
        path.join(bootstrap, ...source.bootstrapKey.split('/')),
      );
    }
  }
  for (const descriptor of descriptors) {
    const licenseDir = path.join(root, 'licenses', descriptor.id);
    await fs.promises.mkdir(licenseDir, { recursive: true });
    await fs.promises.copyFile(fixtureLicense, path.join(licenseDir, 'LICENSE.txt'));
  }
  return { root, bootstrap };
}
