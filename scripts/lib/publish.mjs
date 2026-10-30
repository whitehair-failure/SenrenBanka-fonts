import fs from 'node:fs';
import path from 'node:path';
import {
  bootstrapArchiveFileName,
  bootstrapReleaseTag,
  catalogReleaseTag,
  familyReleaseTag,
} from './manifest.mjs';
import { sha256File } from './hash.mjs';

function ghFailureIsMissing(result) {
  if (result.status === 0) return false;
  const text = `${result.stderr ?? ''}\n${result.stdout ?? ''}`;
  return /HTTP 404|Not Found|release not found/i.test(text);
}

function releaseNotes(catalogVersion, assets) {
  return [
    `SenrenBanka font artifacts (catalog v${catalogVersion}).`,
    '',
    'This release is immutable. Verify downloads against SHA-256 before use.',
    '',
    ...assets.map((asset) => `- ${asset.fileName}`),
  ].join('\n');
}

function parseGhJson(result, label) {
  if (result.status !== 0) {
    throw new Error(`could not read ${label} from GitHub`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`could not parse ${label} from gh output`);
  }
}

function normalizeDigest(value) {
  if (typeof value !== 'string') return null;
  const match = /^(?:sha256:)?([a-f0-9]{64})$/i.exec(value);
  return match ? match[1].toLowerCase() : null;
}

function decodeRelease(result, label) {
  const raw = parseGhJson(result, label);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${label} returned an invalid release object`);
  }
  if (!Number.isSafeInteger(raw.id)) {
    throw new Error(`${label} returned an invalid release id`);
  }
  if (typeof raw.tag_name !== 'string' || raw.tag_name.length === 0) {
    throw new Error(`${label} returned an invalid tag name`);
  }
  if (typeof raw.draft !== 'boolean') {
    throw new Error(`${label} returned an invalid draft state`);
  }
  if (!Array.isArray(raw.assets)) {
    throw new Error(`${label} returned an invalid asset list`);
  }

  const assets = raw.assets.map((asset, index) => {
    if (asset === null || typeof asset !== 'object' || Array.isArray(asset)) {
      throw new Error(`${label} returned invalid asset metadata at index ${index}`);
    }
    if (typeof asset.name !== 'string' || asset.name.length === 0) {
      throw new Error(`${label} returned an asset without a valid name`);
    }
    if (!Number.isSafeInteger(asset.size) || asset.size < 0) {
      throw new Error(`${label} returned an invalid size for asset ${asset.name}`);
    }
    return {
      name: asset.name,
      size: asset.size,
      digest: normalizeDigest(asset.digest),
    };
  });

  return {
    id: raw.id,
    tagName: raw.tag_name,
    isDraft: raw.draft,
    assets,
  };
}

function assetsByName(release) {
  const assets = new Map();
  for (const asset of release.assets) {
    if (assets.has(asset.name)) {
      throw new Error(`release ${release.tagName} contains duplicate asset ${asset.name}`);
    }
    assets.set(asset.name, asset);
  }
  return assets;
}

function assertAssetMatches(release, actual, expected) {
  if (actual.size !== expected.size || actual.digest !== expected.sha256) {
    throw new Error(
      `release ${release.tagName} asset ${expected.fileName} conflicts with local bytes`,
    );
  }
}

function inspectDraft(release, spec) {
  if (release.tagName !== spec.tag) {
    throw new Error(`GitHub returned the wrong release for ${spec.tag}`);
  }
  if (!release.isDraft) {
    throw new Error(`expected draft release ${spec.tag}, but it is already published`);
  }

  const expected = new Map(spec.assets.map((asset) => [asset.fileName, asset]));
  const actual = assetsByName(release);
  const extra = [...actual.keys()].filter((name) => !expected.has(name));
  if (extra.length) {
    throw new Error(`draft release ${spec.tag} contains unexpected assets: ${extra.join(', ')}`);
  }
  for (const [name, remoteAsset] of actual) {
    assertAssetMatches(release, remoteAsset, expected.get(name));
  }

  return spec.assets
    .filter((asset) => !actual.has(asset.fileName))
    .map((asset) => asset.fileName);
}

function verifyRelease(release, spec, expectedDraft) {
  if (release.tagName !== spec.tag) {
    throw new Error(`GitHub returned the wrong release for ${spec.tag}`);
  }
  if (release.isDraft !== expectedDraft) {
    throw new Error(
      `release ${spec.tag} has draft=${release.isDraft}; expected draft=${expectedDraft}`,
    );
  }

  const expected = new Map(spec.assets.map((asset) => [asset.fileName, asset]));
  const actual = assetsByName(release);
  const missing = [...expected.keys()].filter((name) => !actual.has(name));
  const extra = [...actual.keys()].filter((name) => !expected.has(name));
  if (missing.length || extra.length) {
    throw new Error(
      `release ${spec.tag} asset set mismatch${
        missing.length ? `; missing: ${missing.join(', ')}` : ''
      }${extra.length ? `; extra: ${extra.join(', ')}` : ''}`,
    );
  }
  for (const [name, wanted] of expected) {
    assertAssetMatches(release, actual.get(name), wanted);
  }
}

function assertEmptyDraft(release, spec) {
  if (release.tagName !== spec.tag) {
    throw new Error(`GitHub returned the wrong release for ${spec.tag}`);
  }
  if (!release.isDraft) {
    throw new Error(`new release ${spec.tag} was not created as a draft`);
  }
  if (release.assets.length !== 0) {
    throw new Error(`new draft release ${spec.tag} was not created empty`);
  }
}

async function describeAssets(files) {
  const assets = [];
  const seen = new Set();
  for (const file of files) {
    const fileName = path.basename(file);
    if (seen.has(fileName)) {
      throw new Error(`duplicate release asset file name: ${fileName}`);
    }
    let stat;
    try {
      stat = await fs.promises.lstat(file);
    } catch {
      throw new Error(`release asset is missing: ${file}`);
    }
    if (!stat.isFile()) {
      throw new Error(`release asset is not a regular file: ${file}`);
    }
    seen.add(fileName);
    assets.push({
      fileName,
      file,
      size: stat.size,
      sha256: await sha256File(file),
    });
  }
  return assets;
}

async function buildReleaseSpecs({ dir, catalog, catalogVersion }) {
  const specs = [];
  const catalogFiles = [
    path.join(dir, 'catalog.json'),
    path.join(dir, 'catalog.json.sha256'),
    path.join(dir, 'SHA256SUMS'),
  ];

  for (const id of Object.keys(catalog.families).sort()) {
    const family = catalog.families[id];
    specs.push({
      kind: 'family',
      tag: familyReleaseTag(id, family.version),
      title: family.package.fileName,
      files: [
        path.join(dir, family.package.fileName),
        path.join(dir, `${family.package.fileName}.sha256`),
        path.join(dir, family.source.fileName),
        path.join(dir, `${family.source.fileName}.sha256`),
      ],
    });
  }

  const bootstrapName = bootstrapArchiveFileName(catalogVersion);
  const bootstrapFiles = [
    path.join(dir, bootstrapName),
    path.join(dir, `${bootstrapName}.sha256`),
  ];
  const hasBootstrap = fs.existsSync(bootstrapFiles[0]);
  const hasBootstrapSidecar = fs.existsSync(bootstrapFiles[1]);
  if (hasBootstrap !== hasBootstrapSidecar) {
    throw new Error('bootstrap archive and checksum sidecar must be present together');
  }
  if (hasBootstrap) {
    specs.unshift({
      kind: 'bootstrap',
      tag: bootstrapReleaseTag(catalogVersion),
      title: `Bootstrap sources v${catalogVersion}`,
      files: bootstrapFiles,
    });
    catalogFiles.push(...bootstrapFiles);
  }

  specs.push({
    kind: 'catalog',
    tag: catalogReleaseTag(catalogVersion),
    title: `Font catalog v${catalogVersion}`,
    files: catalogFiles,
  });

  for (const spec of specs) {
    spec.assets = await describeAssets(spec.files);
    delete spec.files;
  }
  return specs;
}

function dryRunPlan(specs) {
  return specs.flatMap((spec) => [
    { action: 'ensure-empty-draft', tag: spec.tag },
    ...spec.assets.map((asset) => ({
      action: 'ensure-asset',
      tag: spec.tag,
      fileName: asset.fileName,
    })),
    { action: 'verify-draft', tag: spec.tag },
    { action: 'publish', tag: spec.tag },
  ]);
}

export async function publishCatalog({
  dir,
  repo,
  catalogVersion,
  targetSha,
  catalog,
  run,
  dryRun = false,
  log = () => {},
}) {
  if (!/^[^/]+\/[^/]+$/.test(repo)) throw new Error('repo must be owner/name');
  if (!/^[0-9a-f]{40}$/i.test(targetSha)) {
    throw new Error('target revision must be a full 40-character commit SHA');
  }
  if (catalog.catalogVersion !== catalogVersion) {
    throw new Error(
      `catalog version mismatch: expected ${catalogVersion}, got ${catalog.catalogVersion}`,
    );
  }

  const specs = await buildReleaseSpecs({ dir, catalog, catalogVersion });
  if (dryRun) {
    const plan = dryRunPlan(specs);
    return { dryRun: true, releases: specs.map((spec) => spec.tag), plan, calls: [] };
  }
  if (typeof run !== 'function') throw new Error('run must be a function');

  const calls = [];
  const record = async (command, args) => {
    const call = { command, args };
    calls.push(call);
    return run(call);
  };
  const releaseApi = (method, suffix) =>
    record('gh', ['api', '--method', method, `repos/${repo}/releases${suffix}`]);

  async function fetchRelease(tag) {
    const result = await releaseApi('GET', `/tags/${encodeURIComponent(tag)}`);
    if (result.status === 0) {
      return decodeRelease(result, `release ${tag}`);
    }
    if (ghFailureIsMissing(result)) return null;
    throw new Error(`could not determine remote state for ${tag}`);
  }

  async function createEmptyDraft(spec) {
    const notes = releaseNotes(catalogVersion, spec.assets);
    const result = await record('gh', [
      'api',
      '--method',
      'POST',
      `repos/${repo}/releases`,
      '-f',
      `tag_name=${spec.tag}`,
      '-f',
      `target_commitish=${targetSha}`,
      '-f',
      `name=${spec.title}`,
      '-f',
      `body=${notes}`,
      '-F',
      'draft=true',
    ]);
    if (result.status !== 0) {
      throw new Error(`failed to create empty draft release ${spec.tag}`);
    }
    const release = decodeRelease(result, `new release ${spec.tag}`);
    assertEmptyDraft(release, spec);
    return release;
  }

  async function uploadAsset(spec, asset) {
    const result = await record('gh', [
      'release',
      'upload',
      spec.tag,
      asset.file,
      '--repo',
      repo,
    ]);
    if (result.status !== 0) {
      throw new Error(`failed to upload ${asset.fileName} to draft ${spec.tag}`);
    }
  }

  async function publishDraft(spec, release) {
    const result = await record('gh', [
      'api',
      '--method',
      'PATCH',
      `repos/${repo}/releases/${release.id}`,
      '-F',
      'draft=false',
    ]);
    if (result.status !== 0) {
      throw new Error(`failed to publish ${spec.tag}`);
    }
    return result;
  }

  const pending = [];
  const reusedPublished = [];

  // Inspect every release before creating or uploading anything. A conflict in
  // any existing release therefore fails before this run mutates remote state.
  for (const spec of specs) {
    log(`inspect ${spec.tag}`);
    const release = await fetchRelease(spec.tag);
    if (release === null) {
      pending.push({ spec, release: null, missing: spec.assets.map((asset) => asset.fileName) });
    } else if (release.isDraft) {
      pending.push({ spec, release, missing: inspectDraft(release, spec) });
    } else {
      verifyRelease(release, spec, false);
      reusedPublished.push(spec.tag);
    }
  }

  for (const item of pending) {
    if (item.release !== null) continue;
    log(`create empty draft ${item.spec.tag}`);
    item.release = await createEmptyDraft(item.spec);
  }

  for (const item of pending) {
    const expected = new Map(item.spec.assets.map((asset) => [asset.fileName, asset]));
    for (const fileName of item.missing) {
      log(`upload ${fileName} to ${item.spec.tag}`);
      await uploadAsset(item.spec, expected.get(fileName));
    }
  }

  const verifiedDrafts = [];
  for (const item of pending) {
    log(`verify draft ${item.spec.tag}`);
    const release = await fetchRelease(item.spec.tag);
    if (release === null) {
      throw new Error(`draft release disappeared during publish: ${item.spec.tag}`);
    }
    verifyRelease(release, item.spec, true);
    verifiedDrafts.push({ spec: item.spec, release });
  }

  // No publish call may run until every draft above has the exact expected
  // metadata and assets. The catalog stays last, so consumers never observe a
  // catalog that points at an incomplete family/bootstrap release.
  const published = [];
  for (const item of verifiedDrafts) {
    log(`publish ${item.spec.tag}`);
    await publishDraft(item.spec, item.release);
    published.push(item.spec.tag);
  }

  return {
    dryRun: false,
    releases: specs.map((spec) => spec.tag),
    reusedPublished,
    published,
    calls,
  };
}
