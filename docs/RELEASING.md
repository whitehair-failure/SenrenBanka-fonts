# Releasing

## Prerequisites

1. Merge the verified descriptor/toolchain commit.
2. Publish or otherwise host a descriptor-verified bootstrap bundle if any
   source has no direct HTTPS download. No machine-local path is used.
3. Keep `catalogVersion` distinct when publishing a new catalog snapshot.

Repository administrators may enable **Immutable Releases** in GitHub settings,
but the publish script does not query that repository-level setting. Publishing
uses only the workflow's built-in `GITHUB_TOKEN` with `contents: write`; it does
not require a personal access token or an administrator credential.

## Publish Transaction

For each expected release, the script lists releases through the GitHub API
(including Drafts visible to the write-enabled token) and indexes them by tag:

1. Missing release: reject an existing Git tag without a Release; otherwise
   create an empty Draft with the verified target commit.
2. Existing Draft: reuse it, reject any extra or byte-conflicting asset, and
   upload only expected assets that are absent.
3. Existing published Release: reuse it only when the tag, published state,
   exact asset set, sizes, and SHA-256 digests all match.

After all uploads, the script fetches every Draft again and verifies its
`tagName`, draft state, exact asset set, sizes, and SHA-256 digests. No release
is published until every Draft passes. It then publishes in
`bootstrap-v<version>` → `font-<id>-v<version>` → `catalog-v<version>` order.

Drafts and published release assets are never deleted or overwritten. If an
upload, verification, or publish step fails, Drafts remain in place. Re-running
the same catalog version reuses the Drafts, skips matching assets, uploads only
missing assets, and publishes the verified set again. A failure never produces
an incomplete published Release; because the catalog is last, consumers never
see a catalog that references an unpublished family/bootstrap.

## Build And Verify

```bash
npm ci
npm test
npm run catalog:validate
npm run bootstrap:build -- --bootstrap-dir .cache/bootstrap --out artifacts/bootstrap-sources-v1.0.0.zip
npm run bootstrap:verify -- --bundle artifacts/bootstrap-sources-v1.0.0.zip --sha256 "$(awk '{print $1}' artifacts/bootstrap-sources-v1.0.0.zip.sha256)"
node scripts/build-catalog.mjs --out artifacts --catalog-version 1.0.0 --bootstrap-dir .cache/bootstrap --bootstrap-sha256 "$(awk '{print $1}' artifacts/bootstrap-sources-v1.0.0.zip.sha256)"
npm run release:verify -- --dir artifacts --catalog-version 1.0.0
node scripts/build-catalog.mjs --out artifacts-repro --catalog-version 1.0.0 --bootstrap-dir .cache/bootstrap --bootstrap-sha256 "$(awk '{print $1}' artifacts/bootstrap-sources-v1.0.0.zip.sha256)"
npm run release:verify -- --dir artifacts --compare-dir artifacts-repro --catalog-version 1.0.0
node scripts/publish.mjs --dir artifacts --catalog-version 1.0.0 --target-sha "$(git rev-parse HEAD)" --dry-run
```

All local verification, including the two-build hash comparison, happens
before any release mutation. The workflow uploads the verified artifact set
before the publish job starts.

## GitHub Actions

Run **Build and publish font catalog** with:

- `catalogVersion`
- optional `bootstrapSourceUrl` and `bootstrapSourceSha256`
- `dryRun: true` first
- `dryRun: false` only after reviewing the plan

The workflow:

1. runs tests and descriptor policy checks;
2. verifies the supplied bootstrap bundle and reproduces it from extracted input;
3. builds and verifies twice;
4. uploads the artifact set, including the bootstrap bundle;
5. re-verifies the downloaded artifact in the write-enabled publish job;
6. creates or reuses empty Drafts for the bootstrap, every family, and the catalog;
7. uploads only missing assets and verifies every Draft through the GitHub API;
8. publishes `bootstrap-v<version>`, then family releases, then
   `catalog-v<version>` last.

The catalog is the consumer-visible transaction boundary. If publishing fails
after some family releases are public, the previous catalog remains in place;
new catalog bytes are never published before all referenced family assets exist.

## Tags And Assets

Family release:

- `font-<id>-v<familyVersion>`
- `<id>-v<familyVersion>.tar.gz`
- `<id>-v<familyVersion>.tar.gz.sha256`
- `<id>-v<familyVersion>-source.tar.gz`
- `<id>-v<familyVersion>-source.tar.gz.sha256`

Bootstrap release:

- `bootstrap-v<catalogVersion>`
- `bootstrap-sources-v<catalogVersion>.zip`
- `bootstrap-sources-v<catalogVersion>.zip.sha256`

Catalog release:

- `catalog-v<catalogVersion>`
- `catalog.json`
- `catalog.json.sha256`
- `SHA256SUMS`
- `bootstrap-sources-v<catalogVersion>.zip` and `.sha256` when bootstrap-only
  sources exist

An existing release is reused only after its published assets are verified
byte-for-byte against the expected files. This applies to bootstrap, family, and
catalog releases, making a fully published catalog rerun a read-only
verification. Assets are never overwritten with `--clobber`. Any missing,
extra, or conflicting asset fails closed. Fix changed families by increasing
their family version, then publish a new catalog version.
