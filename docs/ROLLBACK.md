# Rollback

Releases and tags are immutable. Never overwrite an existing family package,
source archive, catalog, tag, or release asset.

## Before A Release Exists

Delete the local ignored `artifacts/` and `artifacts-repro/` directories, fix the
input or toolchain, and rebuild.

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

## Toolchain Regression

Revert the tool commit and rebuild the old descriptor. Old descriptor versions
must remain in the repository. If a tool upgrade changes archive bytes, bump the
family version rather than republishing the old tag.
