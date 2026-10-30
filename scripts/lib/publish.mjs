import fs from 'node:fs';
import path from 'node:path';
import { catalogReleaseTag, familyReleaseTag } from './manifest.mjs';
import { sha256File } from './hash.mjs';

function ghFailureIsMissing(result, notFoundText) {
  if (result.status === 0) return false;
  const text = `${result.stderr ?? ''}\n${result.stdout ?? ''}`;
  return /HTTP 404|Not Found|release not found/i.test(text) || text.includes(notFoundText);
}

function releaseNotes(catalogVersion, files) {
  return [
    `SenrenBanka font artifacts (catalog v${catalogVersion}).`,
    '',
    'This release is immutable. Verify downloads against SHA-256 before use.',
    '',
    ...files.map((file) => `- ${path.basename(file)}`),
  ].join('\n');
}

function parseGhJson(result, label) {
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

async function verifyExistingRelease(release, viewResult) {
  if (viewResult.status !== 0) {
    throw new Error(`tag exists but release is missing: ${release.tag}`);
  }
  const view = parseGhJson(viewResult, `release ${release.tag}`);
  if (view.tagName !== release.tag) {
    throw new Error(`gh returned the wrong release for ${release.tag}`);
  }
  if (view.isDraft !== false) {
    throw new Error(`existing release ${release.tag} is not published`);
  }
  const assets = Array.isArray(view.assets) ? view.assets : [];
  const expected = new Map(
    await Promise.all(
      release.files.map(async (file) => {
        const fileName = path.basename(file);
        return [
          fileName,
          { fileName, size: fs.statSync(file).size, sha256: await sha256File(file) },
        ];
      }),
    ),
  );
  const actual = new Map();
  for (const asset of assets) {
    if (typeof asset.name !== 'string' || actual.has(asset.name)) {
      throw new Error(`release ${release.tag} contains duplicate or invalid assets`);
    }
    actual.set(asset.name, asset);
  }
  const missing = [...expected.keys()].filter((name) => !actual.has(name));
  const extra = [...actual.keys()].filter((name) => !expected.has(name));
  if (missing.length || extra.length) {
    throw new Error(
      `release ${release.tag} asset set mismatch${
        missing.length ? `; missing: ${missing.join(', ')}` : ''
      }${extra.length ? `; extra: ${extra.join(', ')}` : ''}`,
    );
  }
  for (const [name, wanted] of expected) {
    const asset = actual.get(name);
    const digest = normalizeDigest(asset.digest);
    if (Number(asset.size) !== wanted.size || digest !== wanted.sha256) {
      throw new Error(
        `existing release ${release.tag} asset ${name} does not match catalog bytes`,
      );
    }
  }
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

  const releases = [];
  const catalogFiles = [
    path.join(dir, 'catalog.json'),
    path.join(dir, 'catalog.json.sha256'),
    path.join(dir, 'SHA256SUMS'),
  ];
  for (const id of Object.keys(catalog.families).sort()) {
    const family = catalog.families[id];
    const tag = familyReleaseTag(id, family.version);
    const files = [
      path.join(dir, family.package.fileName),
      path.join(dir, `${family.package.fileName}.sha256`),
      path.join(dir, family.source.fileName),
      path.join(dir, `${family.source.fileName}.sha256`),
    ];
    releases.push({ tag, files, title: `${family.package.fileName}`, existing: false });
  }
  const catalogTag = catalogReleaseTag(catalogVersion);
  releases.push({
    tag: catalogTag,
    files: catalogFiles,
    title: `Font catalog v${catalogVersion}`,
    existing: false,
  });

  const calls = [];
  const record = async (command, args, options = {}) => {
    const call = { command, args, ...options };
    calls.push(call);
    if (dryRun) return { status: 0, stdout: '', stderr: '' };
    return run(call);
  };

  log(`preflight immutable-release setting for ${repo}`);
  const immutable = await record('gh', [
    'api',
    `repos/${repo}/immutable-releases`,
    '--jq',
    '.enabled',
  ]);
  if (!dryRun && immutable.stdout.trim() !== 'true') {
    throw new Error('GitHub Immutable Releases must be enabled before publishing');
  }

  const catalogRelease = releases.at(-1);
  for (const release of releases) {
    log(`preflight ${release.tag}`);
    const tagResult = await record('gh', [
      'api',
      `repos/${repo}/git/ref/tags/${encodeURIComponent(release.tag)}`,
    ]);
    if (dryRun) continue;
    if (tagResult.status === 0) {
      if (release === catalogRelease) {
        throw new Error(`tag already exists and will not be overwritten: ${release.tag}`);
      }
      const releaseResult = await record('gh', [
        'release',
        'view',
        release.tag,
        '--repo',
        repo,
        '--json',
        'tagName,isDraft,assets',
      ]);
      await verifyExistingRelease(release, releaseResult);
      release.existing = true;
      continue;
    }
    if (!ghFailureIsMissing(tagResult, 'Not Found')) {
      throw new Error(`could not determine tag state for ${release.tag}`);
    }
    const releaseResult = await record('gh', [
      'release',
      'view',
      release.tag,
      '--repo',
      repo,
      '--json',
      'tagName',
    ]);
    if (releaseResult.status === 0) {
      throw new Error(`release already exists: ${release.tag}`);
    }
    if (!ghFailureIsMissing(releaseResult, 'release not found')) {
      throw new Error(`could not determine release state for ${release.tag}`);
    }
  }

  const cleanupDraft = async (tag) => {
    let view;
    try {
      view = await record('gh', [
        'release',
        'view',
        tag,
        '--repo',
        repo,
        '--json',
        'isDraft',
      ]);
    } catch {
      return;
    }
    if (view.status !== 0) return;
    let metadata;
    try {
      metadata = JSON.parse(view.stdout);
    } catch {
      return;
    }
    if (metadata.isDraft !== true) return;
    await record('gh', [
      'release',
      'delete',
      tag,
      '--repo',
      repo,
      '--yes',
      '--cleanup-tag',
    ]).catch(() => {});
  };

  const attempted = [];
  const published = new Set();
  try {
    for (const release of releases.slice(0, -1).filter((item) => !item.existing)) {
      log(`create draft ${release.tag}`);
      attempted.push(release.tag);
      const result = await record('gh', [
        'release',
        'create',
        release.tag,
        '--repo',
        repo,
        '--draft',
        '--target',
        targetSha,
        '--title',
        release.title,
        '--notes',
        releaseNotes(catalogVersion, release.files),
        ...release.files,
      ]);
      if (!dryRun && result.status !== 0) {
        throw new Error(`failed to create draft release ${release.tag}`);
      }
    }

    log(`create draft ${catalogRelease.tag}`);
    attempted.push(catalogRelease.tag);
    const catalogResult = await record('gh', [
      'release',
      'create',
      catalogRelease.tag,
      '--repo',
      repo,
      '--draft',
      '--target',
      targetSha,
      '--title',
      catalogRelease.title,
      '--notes',
      releaseNotes(catalogVersion, catalogRelease.files),
      ...catalogRelease.files,
    ]);
    if (!dryRun && catalogResult.status !== 0) {
      throw new Error(`failed to create draft release ${catalogRelease.tag}`);
    }

    // Publish families first. The catalog is the atomic visibility point: it
    // must never point at a family release that is still private.
    for (const release of releases.filter((item) => !item.existing)) {
      log(`publish ${release.tag}`);
      const result = await record('gh', [
        'release',
        'edit',
        release.tag,
        '--repo',
        repo,
        '--draft=false',
      ]);
      if (!dryRun && result.status !== 0) {
        throw new Error(`failed to publish ${release.tag}`);
      }
      published.add(release.tag);
    }
  } catch (error) {
    if (!dryRun) {
      for (const tag of [...new Set(attempted)].reverse()) {
        if (!published.has(tag)) await cleanupDraft(tag);
      }
    }
    throw error;
  }

  return {
    dryRun,
    releases: releases.map((release) => release.tag),
    calls,
  };
}
