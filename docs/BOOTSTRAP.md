# Build Inputs And Bootstrap

Every input is identified by size and SHA-256. Builds may use:

1. A pinned HTTPS download (optionally an exact member of a ZIP/TAR archive).
2. A previously published source archive extracted as a bootstrap directory.
3. For initial migration only, a controlled bootstrap snapshot.

## Local Layout

`bootstrapKey` paths are the same paths used inside source archives:

```text
source/fonts/<file>
```

The descriptor still records upstream project, version/revision, retrieval date,
license evidence, and hashes. A local path is never stored in a descriptor or
manifest.

## Release Bootstrap Bundle

The release workflow accepts an optional HTTPS ZIP:

```text
source/fonts/<source-or-fixed-font>
```

The URL and SHA-256 are required together. `prepare-bootstrap.mjs` verifies the
bundle against the current descriptors before extracting it. It rejects missing
or extra members, wrong sizes or hashes, traversal, duplicate/case-colliding
paths, directory entries, symlinks, hardlinks, and oversized expansion.

### Generate The First-Release Bundle

The bundle generator reads descriptors and copies only source files without a
`download` URL. Files with a public URL may exist in the controlled directory,
but are excluded. The archive contains exactly the selected files at their
canonical `source/fonts/<fileName>` paths.

```bash
npm run bootstrap:build -- \
  --bootstrap-dir .cache/bootstrap \
  --out artifacts/bootstrap-sources-v1.0.0.zip

npm run bootstrap:verify -- \
  --bundle artifacts/bootstrap-sources-v1.0.0.zip \
  --sha256 "$(awk '{print $1}' artifacts/bootstrap-sources-v1.0.0.zip.sha256)"
```

The ZIP writer is deterministic:

- UTF-8 entry names, sorted by locale-independent code points;
- stored (uncompressed) members with stable CRC-32 values;
- fixed 1980-01-01 timestamps, mode `0644`, regular-file attributes;
- no extra fields, comments, directory entries, or links;
- identical bytes and SHA-256 over repeated runs.

The controlled directory is strict: every regular file must be a descriptor
declared source at its canonical path. Missing bootstrap-only files, undeclared
files, wrong hashes/sizes, non-regular entries, symlinks, and case collisions
fail before an archive is written.

The complete catalog build includes this bundle automatically when
`--bootstrap-dir` is supplied:

```text
bootstrap-sources-v<catalogVersion>.zip
bootstrap-sources-v<catalogVersion>.zip.sha256
```

The bundle is part of `SHA256SUMS`, verified by `release:verify`, and uploaded
with the catalog release. Its release URL and SHA-256 are published out of band
or in the catalog release notes for later workflows.

For the first catalog, publish the generated files as the immutable bootstrap
release before running the catalog workflow:

```text
Tag: bootstrap-v<catalogVersion>
bootstrap-sources-v<catalogVersion>.zip
bootstrap-sources-v<catalogVersion>.zip.sha256
```

Pass its HTTPS release URL as `bootstrapSourceUrl` and the sidecar digest as
`bootstrapSourceSha256`. The workflow rejects a bundle that differs from the
published digest or from the descriptor-derived member set.

The first v1.0.0 release needs a bootstrap bundle for fixed WOFF2 files that do
not yet have a direct public source URL. Later releases can use the source
archives from an earlier family release: copy their `source/fonts/` entries into
a clean controlled directory (without archive manifests or licenses) and pass
that directory as `--bootstrap-dir`.

The bootstrap release is a seed, not a permanent upstream. Once family source
archives exist for the descriptor versions, regenerate the working bootstrap
directory from those archives and verify that it reproduces the same bundle
SHA-256. Later catalogs must not depend on an unpublished local snapshot.

## Offline Build

```bash
node scripts/build-catalog.mjs \
  --out artifacts \
  --catalog-version 1.0.0 \
  --bootstrap-dir .cache/bootstrap \
  --bootstrap-sha256 "<published-bootstrap-sha256>"
```

Bootstrap use does not weaken verification: the declared SHA-256 and size are
checked before any file enters a package.
