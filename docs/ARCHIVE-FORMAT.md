# Archive Format

Family and source archives are deterministic USTAR files compressed with gzip
level 9.

- entry paths are safe POSIX relative paths;
- entries are sorted by path using locale-independent code-point ordering;
- mode is `0644`, uid/gid are `0`, mtime is `0`;
- names are unique on case-insensitive filesystems after Unicode NFC normalization;
- only regular files are allowed;
- duplicate entries, symlinks, hardlinks, `.`/`..`, absolute paths, backslashes,
  and undeclared entries are rejected;
- gzip mtime is `0`, XFL is `2`, and OS is `255` (unknown) on every platform;
- JSON uses sorted keys with two-space indentation and a trailing newline.

## Family Package

```text
manifest.json
font.css
fonts/<variant>.woff2
licenses/<license-file>
```

`manifest.json` records:

- family/id/version/role and source family name;
- pinned tool versions;
- source archive file name and source file hashes;
- complete license metadata and RFN strategy;
- each variant's file, hash, size, CSS properties, font metadata, coverage, and
  any explicit inert `cmapAliases`;

`font.css` is generated from the manifest and must match it exactly.

## Source Archive

```text
source-manifest.json
source/fonts/<source-file>
source/licenses/<license-file>
```

The source archive contains the exact input bytes for the descriptor. For a
normal build it is also the authoritative offline rebuild input for that family
version.

## Bootstrap ZIP

The first-release bootstrap archive is a deterministic stored ZIP:

```text
source/fonts/<fileName>
```

It contains only descriptor source files without a public download URL. Entries
are sorted, have fixed 1980-01-01 timestamps, mode `0644`, no extra fields, and
no directory/link entries. The verifier requires an exact member set, descriptor
size and SHA-256, safe paths, case-insensitive uniqueness, and bounded expansion.

## Verification

`verifyFamilyPackageBuffer` and `verifySourceArchiveBuffer`:

- parse tar headers themselves;
- enforce normalized metadata;
- reject extra/missing files and duplicate paths;
- recompute every SHA-256 and size;
- verify font format, family, weight, style, stretch, variation axes, and
  coverage;
- require every cmap entry outside a shard's `unicode-range` to be declared in
  `cmapAliases`; the initial CJK split has six paired-glyph aliases across two
  families, and none are used by CSS selection;
- cross-check family and source manifests.
