import test from 'node:test';
import assert from 'node:assert/strict';
import {
  catalogSchema,
  parseCatalog,
  parseFamilyDescriptor,
} from '../scripts/lib/schema.mjs';
import { makeCoreDescriptor, makeFixedDescriptor } from './helpers/fixtures.mjs';

test('valid fixed and core descriptors pass schema validation', () => {
  assert.equal(parseFamilyDescriptor(makeFixedDescriptor()).role, 'fixed');
  assert.equal(parseFamilyDescriptor(makeCoreDescriptor()).role, 'core-cjk');
});

test('schema rejects missing fields, unknown roles, and invalid semver', () => {
  const missing = makeFixedDescriptor();
  delete missing.schemaVersion;
  assert.throws(() => parseFamilyDescriptor(missing), /schemaVersion/);

  const role = makeFixedDescriptor();
  role.role = 'mystery';
  assert.throws(() => parseFamilyDescriptor(role), /role/);

  const semver = makeFixedDescriptor();
  semver.version = '1.0';
  assert.throws(() => parseFamilyDescriptor(semver), /semantic version/);
});

test('license gate requires explicit manual approval', () => {
  const descriptor = makeFixedDescriptor();
  descriptor.license.approvedForRedistribution = false;
  assert.throws(() => parseFamilyDescriptor(descriptor), /approvedForRedistribution/);
});

test('RFN-bearing modified output fails unless permission or rename is explicit', () => {
  const descriptor = makeCoreDescriptor();
  descriptor.license.reservedFontNames = ['Fixture'];
  descriptor.license.rfn = {
    status: 'unmodified-distribution',
    basis: 'Only valid for byte-preserving fixed output.',
  };
  assert.throws(() => parseFamilyDescriptor(descriptor), /RFN permission or a rename/);

  descriptor.license.rfn = {
    status: 'renamed',
    basis: 'Explicit rename.',
  };
  descriptor.output.rename = { to: 'Fixture Sans' };
  assert.throws(() => parseFamilyDescriptor(descriptor), /still contains reserved name/);
  descriptor.output.rename.to = 'Derived Sans';
  assert.equal(parseFamilyDescriptor(descriptor).license.rfn.status, 'renamed');
});

test('catalog schema rejects inconsistent release tags and file names', () => {
  const descriptor = makeFixedDescriptor();
  const asset = {
    releaseTag: 'font-fixture-fixed-v1.0.0',
    fileName: 'fixture-fixed-v1.0.0.tar.gz',
    sha256: 'a'.repeat(64),
    size: 1,
  };
  const base = {
    schemaVersion: 1,
    catalogVersion: '1.0.0',
    baseUrl: 'https://example.com/releases/download',
    families: {
      'fixture-fixed': {
        version: '1.0.0',
        role: descriptor.role,
        package: { ...asset },
        source: {
          ...asset,
          fileName: 'fixture-fixed-v1.0.0-source.tar.gz',
        },
      },
    },
  };
  assert.equal(parseCatalog(base).families['fixture-fixed'].version, '1.0.0');

  const wrongTag = structuredClone(base);
  wrongTag.families['fixture-fixed'].package.releaseTag = 'font-wrong-v1.0.0';
  assert.throws(() => parseCatalog(wrongTag), /release tag/);

  const wrongUrl = structuredClone(base);
  wrongUrl.baseUrl = 'http://example.com/releases/download';
  assert.throws(() => catalogSchema.parse(wrongUrl), /HTTPS/);
});
