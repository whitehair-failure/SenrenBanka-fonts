# Releasing

## Prerequisites

1. Enable **Immutable Releases** in the GitHub repository settings.
2. Merge the verified descriptor/toolchain commit.
3. Publish or otherwise host a descriptor-verified bootstrap bundle if any
   source has no direct HTTPS download. No machine-local path is used.
4. Keep `catalogVersion` distinct when publishing a new catalog snapshot.

The publish script checks the GitHub Immutable Releases API and refuses to run
when it is disabled.

### Actions Token Confirmation

The admin-only GitHub Immutable Releases API may return `403` for the default
Actions `GITHUB_TOKEN`. An administrator must verify in repository settings that
**Immutable Releases** is enabled and then create the Actions repository
variable `IMMUTABLE_RELEASES_CONFIRMED` with the exact value `true`.

The workflow fails unless that variable is exactly `true`. It always attempts
the API check first:

- API `true` passes;
- API `false` fails and cannot be overridden;
- an inaccessible API fails unless the repository variable is exactly `true`.

For local publishing with user authentication, the API check normally succeeds
without the variable. If a locally authenticated token also lacks access, run:

```bash
IMMUTABLE_RELEASES_CONFIRMED=true npm run release:publish -- \
  --dir artifacts --catalog-version 1.0.0 --target-sha "$(git rev-parse HEAD)"
```

The equivalent explicit flag is `--immutable-releases-confirmed`.

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
2. verifies the supplied bootstrap bundle and reproduces it from extracted input;
3. builds and verifies twice;
4. uploads the artifact set, including the bootstrap bundle;
5. re-verifies the downloaded artifact in the write-enabled publish job;
6. creates bootstrap and family releases as drafts with checksums;
7. creates the catalog release draft, including the bootstrap bundle;
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

An existing catalog tag/release is a hard failure. An existing family tag is
reused only after its published assets are verified byte-for-byte against the
new catalog pointers. Assets are never overwritten with `--clobber`. Fix
changed families by increasing their family version.
