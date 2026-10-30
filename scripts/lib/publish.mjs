import path from 'node:path';
import { catalogReleaseTag, familyReleaseTag } from './manifest.mjs';

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
    releases.push({ tag, files, title: `${family.package.fileName}` });
  }
  const catalogTag = catalogReleaseTag(catalogVersion);
  releases.push({
    tag: catalogTag,
    files: catalogFiles,
    title: `Font catalog v${catalogVersion}`,
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

  for (const release of releases) {
    log(`preflight ${release.tag}`);
    const tagResult = await record('gh', [
      'api',
      `repos/${repo}/git/ref/tags/${encodeURIComponent(release.tag)}`,
    ]);
    if (!dryRun && tagResult.status === 0) {
      throw new Error(`tag already exists and will not be overwritten: ${release.tag}`);
    }
    if (!dryRun && !ghFailureIsMissing(tagResult, 'Not Found')) {
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
    if (!dryRun && releaseResult.status === 0) {
      throw new Error(`release already exists: ${release.tag}`);
    }
    if (!dryRun && !ghFailureIsMissing(releaseResult, 'release not found')) {
      throw new Error(`could not determine release state for ${release.tag}`);
    }
  }

  const created = [];
  const published = new Set();
  try {
    for (const release of releases.slice(0, -1)) {
      log(`create draft ${release.tag}`);
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
      created.push(release.tag);
    }

    const catalogRelease = releases.at(-1);
    log(`create draft ${catalogRelease.tag}`);
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
    created.push(catalogRelease.tag);

    // Publish families first. The catalog is the atomic visibility point: it
    // must never point at a family release that is still private.
    for (const release of releases) {
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
      for (const tag of created.reverse().filter((tag) => !published.has(tag))) {
        await record('gh', [
          'release',
          'delete',
          tag,
          '--repo',
          repo,
          '--yes',
          '--cleanup-tag',
        ]).catch(() => {});
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
