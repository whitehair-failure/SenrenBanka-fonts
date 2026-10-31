# Adding A Font

The pipeline is data-driven. Adding a family must not require a new download,
split, package, catalog, or verification script.

## 1. Choose The Output Mode

- `fixed`: publish existing WOFF2 variants byte-for-byte. Suitable for small
  Latin/display/technical families.
- `core-cjk`: use an uncompressed TTF/OTF source and create full, lazy-loadable
  WOFF2 shards with `cn-font-split`.

Do not use a WOFF2 source for `core-cjk`. Upstream versions and licenses must be
fixed before adding a descriptor.

## 2. Add License Evidence

1. Put the complete upstream license text at `licenses/<id>/LICENSE.txt`.
2. Record its lowercase SHA-256 in the descriptor.
3. Confirm website embedding and redistribution are permitted.
4. Read every Reserved Font Name (RFN) in the copyright notice.
5. If this pipeline modifies an RFN font, either provide explicit upstream
   permission or configure a rename that removes every reserved name.

Do not infer approval from a font name, a store label, or `fsType`. See
[LICENSING.md](LICENSING.md).

## 3. Add The Descriptor

Create `catalog/families/<id>/<version>.json`. Existing versions are immutable:
do not edit a released descriptor in place. Add a new semantic version file and
leave the old file available for rebuilding old artifacts.

Minimum structure:

```json
{
  "schemaVersion": 1,
  "id": "example-font",
  "familyName": "Example Font",
  "sourceFamilyName": "Example Font",
  "role": "fixed",
  "version": "1.0.0",
  "source": {
    "project": "Example Font",
    "version": "1.0",
    "url": "https://example.com/example-font",
    "retrievedAt": "2026-10-30",
    "files": [
      {
        "fileName": "example-font-400.woff2",
        "size": 12345,
        "sha256": "<sha256>",
        "bootstrapKey": "source/fonts/example-font-400.woff2",
        "download": {
          "url": "https://example.com/example-font-400.woff2",
          "sha256": "<sha256>"
        }
      }
    ]
  },
  "output": {
    "type": "fixed",
    "variants": [
      {
        "sourceFile": "example-font-400.woff2",
        "file": "example-font-400.woff2",
        "weight": "400",
        "style": "normal",
        "display": "swap"
      }
    ]
  }
}
```

The complete required fields are defined by `schemas/family.schema.json`. The
Zod parser is canonical; regenerate published schemas after an intentional
contract change:

```bash
npm run schemas:generate
```

## 4. Provide The Source

Prefer a pinned HTTPS URL with SHA-256. If a ZIP/TAR archive contains the source,
set `download.archiveMember` to the exact safe relative path. If no direct URL
exists during the initial migration, provide the file through `bootstrapKey`
inside a controlled bootstrap directory.

Source archives produced by a release can be used as the next bootstrap input:
their `source/fonts/*` paths match descriptor `bootstrapKey` values.

## 5. Verify

```bash
npm run catalog:validate
npm test
node scripts/build-family.mjs --id example-font --bootstrap-dir .cache/bootstrap
```

Then run a full catalog build twice and compare. New source fonts, generated
WOFF2, ZIPs, or tar packages must not appear in `git status`.

## Core CJK Notes

`core-cjk` descriptors use:

- `chunkSize: 71680`
- `languageAreas: true`
- `fontFeature: true`
- one uncompressed TTF/OTF source

The splitter runs a planning pass and then a normalized explicit-subset pass.
The published CSS ranges are disjoint and their union covers the source cmap.
Unicode noncharacters used internally by the splitter as CMap sentinels are not
published. Some upstream paired punctuation glyphs may remain as inert cmap
aliases in adjacent shards; browser selection remains disjoint through
`unicode-range`. This behavior is covered by the fixture regression tests.

## Script Routing

Core families may declare `scripts`:

- `["cjk"]` (default when omitted) for Han/Kana core families.
- `["hangul"]` for Korean core families.

The site uses this field to generate Hangul-only content subsets and
`unicode-range` rules. It is a routing declaration, not a full coverage claim;
actual coverage is verified from the source cmap.

## Deterministic Subset Fallback

`output.subsetStrategy: "subset-font"` makes the builder skip the
`cn-font-split` final shard pass and build deterministic shards directly from
sorted source code points with `subset-font@2.9.0`. Use it only when the
splitter's final shards are unstable for a font; the published ranges remain
disjoint and cover the source cmap. `noto-sans-mono-cjk-kr` currently uses it.
