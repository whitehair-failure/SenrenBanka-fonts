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

The URL and SHA-256 are required together. `prepare-bootstrap.mjs` checks the
bundle checksum and rejects traversal, duplicate members, symlinks, and oversized
expanded contents before extracting.

The first v1.0.0 release needs a bootstrap bundle for fixed WOFF2 files that do
not yet have a direct public source URL. Later releases can use the source
archives from an earlier family release: extract them and pass the containing
directory as `--bootstrap-dir`.

## Offline Build

```bash
node scripts/build-catalog.mjs \
  --out artifacts \
  --catalog-version 1.0.0 \
  --bootstrap-dir .cache/bootstrap
```

Bootstrap use does not weaken verification: the declared SHA-256 and size are
checked before any file enters a package.
