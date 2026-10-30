# License And RFN Review

Automation enforces an approval that a human must have made. It does not infer
whether a font is redistributable.

## Approval Gate

A descriptor is buildable only when all of the following are true:

- `license.approvedForRedistribution` is `true`;
- `license.reviewedAt`, `reviewedBy`, and `evidenceUrl` are present;
- at least one complete license file is present and its SHA-256 matches;
- the declared SPDX identifier matches the reviewed text;
- every declared Reserved Font Name appears in the license evidence.

Supported SPDX identifiers are `OFL-1.1`, `Apache-2.0`, and `CC0-1.0`. Add a new
identifier only with parser, test, and documentation changes.

## Reserved Font Names

Supported strategies:

| Status | Use |
|---|---|
| `not-applicable` | The reviewed copyright notice declares no RFN |
| `unmodified-distribution` | Fixed mode copies source bytes without modification |
| `permission-granted` | Upstream explicitly permits the planned modification |
| `renamed` | Core output renames every primary user-facing name before splitting |

`permission-granted` requires both a permission text and an evidence URL. The
permission text must be an exact excerpt of the reviewed license text (after
whitespace normalization) and must mention every declared RFN.

`renamed` requires `output.rename.to`. The replacement is checked against all
reserved names before and after binary name-table rewriting. A CSS-only alias is
not sufficient. Rename currently supports TrueType TTF sources only; CFF/OTF
renaming fails closed because CFF name strings are not rewritten by the tool.

## Web Subsets

Subsetting, format conversion, and WOFF2 generation can count as modification.
Check the exact upstream OFL. Some projects add explicit web-font permission
(LXGW WenKai GB is recorded this way); most do not.

Every generated family package contains the complete license files under
`licenses/`. Source archives duplicate them under `source/licenses/`.

## Changes

License review is versioned with the descriptor. A changed upstream license, a
new font file, or a changed RFN requires a new family version and a new review.
