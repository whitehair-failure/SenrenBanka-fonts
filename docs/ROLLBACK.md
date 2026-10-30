# Rollback

Releases and tags are immutable. Never overwrite an existing family package,
source archive, catalog, tag, or release asset.

## Before A Release Exists

Delete the local ignored `artifacts/` and `artifacts-repro/` directories, fix the
input or toolchain, and rebuild.

## Publish Failed With Drafts

Do not delete the Draft Releases or their partial assets. Fix the input or
toolchain, rebuild and re-verify the complete artifact set, then run the same
catalog version again. The publisher reuses each Draft, verifies matching
assets, uploads only missing assets, and publishes only after every Draft is
complete.

If a verified family was already published before a later step failed, the next
run reuses it after byte-for-byte remote verification. The catalog remains a
Draft until every referenced release is complete.

## Family Release Is Bad

1. Do not edit or replace the published family release.
2. Fix the descriptor/source as a new family version.
3. Publish the new family release.
4. Publish a new catalog version that points to it.

Consumers that pin the old catalog stay reproducible; consumers that update see
the corrected family.

## Catalog Release Is Bad

1. Stop using the bad catalog version.
2. Publish a new catalog version with corrected pointers.
3. Record the reason in the consuming application's release notes.

An already-published immutable catalog remains downloadable for audit and
rollback to the last known-good version.

## Bootstrap Release Is Bad

Do not overwrite `bootstrap-v<version>`. Generate a corrected descriptor
version, publish a new bootstrap release, and reference its URL and SHA-256 in
the next catalog workflow run.

## Toolchain Regression

Revert the tool commit and rebuild the old descriptor. Old descriptor versions
must remain in the repository. If a tool upgrade changes archive bytes, bump the
family version rather than republishing the old tag.
