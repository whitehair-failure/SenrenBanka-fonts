# SenrenBanka Fonts

Versioned, deterministic font packages for [SenrenBanka](https://github.com/whitehair-failure/SenrenBanka).
The repository contains descriptors, license evidence, schemas, and the build/release
toolchain. Source fonts and generated font packages are deliberately excluded from Git.

## Catalog v1

- 20 local-provider families from SenrenBanka.
- 3 full CJK families built with `cn-font-split@7.4.3`:
  `zhuque-fangsong`, `lxgw-wenkai`, and `ark-pixel-12px`.
- 17 fixed WOFF2 families preserved as declared variants.
- The 6 Fontsource npm-provider families are not mirrored.

Every build emits one family package and one source archive per family, plus
`catalog.json`, checksum sidecars, and `SHA256SUMS`. Archives are deterministic:
files are sorted, tar metadata is normalized, and gzip mtime is zero.

## Requirements

- Node.js 22.12 or newer (CI uses Node 24)
- npm
- A controlled bootstrap directory for initial fixed WOFF2 inputs

## Local Workflow

```bash
npm ci
npm test
npm run catalog:validate

node scripts/build-catalog.mjs \
  --out artifacts \
  --catalog-version 1.0.0 \
  --bootstrap-dir .cache/bootstrap

npm run release:verify -- --dir artifacts --catalog-version 1.0.0
```

The bootstrap directory uses published source-archive paths:

```text
.cache/bootstrap/
└─ source/
   └─ fonts/
      ├─ ZhuqueFangsong-Regular.ttf
      ├─ LXGWWenKaiGB-Medium.ttf
      ├─ ark-pixel-12px-monospaced-zh_hans.otf
      └─ <fixed-version>.woff2
```

For a reproducible release check, build twice and compare:

```bash
node scripts/build-catalog.mjs --out artifacts-repro --catalog-version 1.0.0 --bootstrap-dir .cache/bootstrap
npm run release:verify -- --dir artifacts --compare-dir artifacts-repro
```

The generated catalog is intentionally not committed. It contains release hashes
that only exist after a build.

## Commands

| Command | Purpose |
|---|---|
| `npm test` | Schema, archive, source, split, package, catalog, and publish tests |
| `npm run catalog:validate` | Descriptor/license policy, generated schemas, and Git hygiene |
| `node scripts/build-family.mjs --id <id> --bootstrap-dir <dir>` | Build one family |
| `node scripts/build-catalog.mjs --out artifacts` | Build the complete catalog |
| `npm run release:verify -- --dir artifacts` | Recompute and verify every package pointer |
| `npm run release:publish -- --dir artifacts --catalog-version <v> --target-sha <sha>` | Create immutable family releases, then the catalog release |
| `node scripts/prepare-bootstrap.mjs --url <url> --sha256 <sha> --out <dir>` | Safely unpack a controlled bootstrap ZIP |

## Package Contract

Family package:

```text
manifest.json
font.css
fonts/*.woff2
licenses/*
```

Source archive:

```text
source-manifest.json
source/fonts/*
source/licenses/*
```

The source archive, not the original local snapshot, is the authoritative rebuild
input for the same descriptor version. See [docs/ARCHIVE-FORMAT.md](docs/ARCHIVE-FORMAT.md).

## Release URLs

Consumers compose downloads from:

```text
https://github.com/whitehair-failure/SenrenBanka-fonts/releases/download/<releaseTag>/<fileName>
```

- Family tag: `font-<id>-v<version>`
- Catalog tag: `catalog-v<catalogVersion>`

## Documentation

- [Adding a font](docs/ADDING-A-FONT.md)
- [License and RFN review](docs/LICENSING.md)
- [Build inputs and bootstrap](docs/BOOTSTRAP.md)
- [Release process](docs/RELEASING.md)
- [Mirroring](docs/MIRRORING.md)
- [Rollback](docs/ROLLBACK.md)
- [Archive format](docs/ARCHIVE-FORMAT.md)

Tool code is MIT-licensed. Font files remain under the licenses bundled in their
family packages and source archives.
