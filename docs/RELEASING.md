# Releasing

## Prerequisites

1. Enable **Immutable Releases** in the GitHub repository settings.
2. Merge the verified descriptor/toolchain commit.
3. Prepare a bootstrap bundle if any source has no direct HTTPS download.
4. Keep `catalogVersion` distinct when publishing a new catalog snapshot.

The publish script checks the GitHub Immutable Releases API and refuses to run
when it is disabled.

## Build And Verify

```bash
npm ci
npm test
npm run catalog:validate
node scripts/build-catalog.mjs --out artifacts --catalog-version 1.0.0 --bootstrap-dir .cache/bootstrap
npm run release:verify -- --dir artifacts --catalog-version 1.0.0
node scripts/build-catalog.mjs --out artifacts-repro --catalog-version 1.0.0 --bootstrap-dir .cache/bootstrap
npm run release:verify -- --dir artifacts --compare-dir artifacts-repro --catalog-version 1.0.0
node scripts/publish.mjs --dir artifacts --catalog-version 1.0.0 --target-sha "$(git rev-parse HEAD)" --dry-run
```

All verification, including the two-build hash comparison, happens before any
release call. The workflow uploads the verified artifact set before the publish
job starts.

## GitHub Actions

Run **Build and publish font catalog** with:

- `catalogVersion`
- optional `bootstrapSourceUrl` and `bootstrapSourceSha256`
- `dryRun: true` first
- `dryRun: false` only after reviewing the plan

The workflow:

1. runs tests and descriptor policy checks;
2. builds and verifies twice;
3. uploads the artifact set;
4. re-verifies the downloaded artifact in the write-enabled publish job;
5. creates all family releases as drafts with their package/source checksums;
6. creates the catalog release draft;
7. publishes family releases first and `catalog-v<version>` last.

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

Catalog release:

- `catalog-v<catalogVersion>`
- `catalog.json`
- `catalog.json.sha256`
- `SHA256SUMS`

Existing tags or releases are a hard failure. Assets are never retried with
`--clobber`. Fix by increasing the family or catalog version.
