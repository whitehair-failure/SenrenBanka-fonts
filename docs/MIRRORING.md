# Mirroring

A mirror only needs to reproduce the release asset path layout:

```text
<baseUrl>/<releaseTag>/<fileName>
```

`catalog.json` records the canonical GitHub `baseUrl`. A mirror can rewrite only
that value; hashes and relative tag/file names must not change.

## Required Files

For each family:

- family `.tar.gz` and `.sha256`;
- source `.tar.gz` and `.sha256`.

For the catalog:

- `catalog.json`;
- `catalog.json.sha256`;
- `SHA256SUMS`.

## Verification

Download the catalog, verify it against `catalog.json.sha256`, then verify every
family pointer and sidecar. `npm run release:verify -- --dir <mirror-dir>` is the
reference verifier.

The source archives are not needed by web clients, but they are required to keep
the release reproducible and auditable.
