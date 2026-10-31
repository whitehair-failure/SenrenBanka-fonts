# SenrenBanka Fonts

Versioned, deterministic font packages for [SenrenBanka](https://github.com/whitehair-failure/SenrenBanka).
The repository contains descriptors, license evidence, schemas, and the build/release
toolchain. Source fonts and generated font packages are deliberately excluded from Git.

## Catalog v1

- 26 local-provider families from SenrenBanka.
- 9 full core families:
  - 3 CJK families: `zhuque-fangsong`, `lxgw-wenkai`, `ark-pixel-12px`.
  - 6 Korean families: `gothic-a1`, `gowun-batang`, `galmuri11`,
    `noto-sans-mono-cjk-kr`, `dongle`, `poor-story`.
- 17 fixed WOFF2 families preserved as declared variants.
- The 6 Fontsource npm-provider families are not mirrored.
- Core families declare `scripts` (`["cjk"]` or `["hangul"]`); the site uses
  this to route Hangul-only content subsets and `unicode-range`.
- `output.subsetStrategy: "subset-font"` opts a family into deterministic
  code-point chunking with `subset-font` when `cn-font-split` final shards are
  unstable. It is currently used by `noto-sans-mono-cjk-kr`.

### Korean core families

The six Korean families are OFL-1.1 with no Reserved Font Name. They are
published as `core-cjk` families with `scripts: ["hangul"]`; the site subsets
them to Hangul-only WOFF2 files and scopes them with `unicode-range`.

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

npm run bootstrap:build -- \
  --bootstrap-dir .cache/bootstrap \
  --out bootstrap-sources-v1.1.0.zip
npm run bootstrap:verify -- \
  --bundle bootstrap-sources-v1.1.0.zip \
  --sha256 "<published-bootstrap-sha256>"

node scripts/build-catalog.mjs \
  --out artifacts \
  --catalog-version 1.1.0 \
  --bootstrap-dir .cache/bootstrap \
  --bootstrap-sha256 "<published-bootstrap-sha256>"

npm run release:verify -- --dir artifacts --catalog-version 1.1.0
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
node scripts/build-catalog.mjs --out artifacts-repro --catalog-version 1.1.0 --bootstrap-dir .cache/bootstrap --bootstrap-sha256 "<published-bootstrap-sha256>"
npm run release:verify -- --dir artifacts --compare-dir artifacts-repro --catalog-version 1.1.0
```

The generated catalog is intentionally not committed. It contains release hashes
that only exist after a build.

## Commands

| Command | Purpose |
|---|---|
| `npm test` | Schema, archive, bootstrap, source, split, package, catalog, and publish tests |
| `npm run catalog:validate` | Descriptor/license policy, generated schemas, and Git hygiene |
| `npm run bootstrap:build -- --bootstrap-dir <dir> --out <zip>` | Generate a deterministic descriptor-verified bootstrap ZIP |
| `npm run bootstrap:verify -- --bundle <zip> [--sha256 <digest>]` | Verify exact bootstrap members, hashes, paths, and metadata |
| `npm run bootstrap:prepare -- --url <url> --sha256 <sha> --out <dir>` | Verify and safely unpack a published bootstrap ZIP |
| `node scripts/build-family.mjs --id <id> --bootstrap-dir <dir>` | Build one family |
| `node scripts/build-catalog.mjs --out artifacts` | Build the complete catalog |
| `npm run release:verify -- --dir artifacts` | Recompute and verify every package pointer |
| `npm run release:publish -- --dir artifacts --catalog-version <v> --target-sha <sha>` | Create or reuse Draft releases, verify them remotely, then publish bootstrap/family releases and the catalog last |

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

The bootstrap archive contains only descriptor sources without public URLs:

```text
bootstrap-sources-v<catalogVersion>.zip
source/fonts/<fileName>
```

It is generated deterministically and included in the catalog artifact set. See
[docs/BOOTSTRAP.md](docs/BOOTSTRAP.md).

## Release URLs

Consumers compose downloads from:

```text
https://github.com/whitehair-failure/SenrenBanka-fonts/releases/download/<releaseTag>/<fileName>
```

- Family tag: `font-<id>-v<version>`
- Bootstrap tag: `bootstrap-v<catalogVersion>`
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
