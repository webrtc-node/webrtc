# Releasing

Stable releases use matching `package.json`, lockfile, and `v<version>` tags.
Choose the next unused patch version for compatible fixes and additional
prebuild targets. Check npm versions and distribution tags and GitHub tags and
releases before preparing it. Published versions and released tags are immutable.

Prepare a focused release pull request with the version bump and release notes.
Describe new platform support and make clear that its prebuilds require the new
package version. Validate the final commit with ordinary CI and a manual
`Release` workflow dispatch against that commit's branch.

Manual `Release` dispatch builds and tests all seven supported prebuild targets,
checks installation from the unpublished archives, checks ARM64 musl source
fallback, and aggregates the archives and checksums with `npm run prebuild:check`.
It does not upload release assets or publish npm. Linux builds use fresh Debian
Bullseye or Alpine containers; the glibc prebuilds retain the glibc 2.31 baseline.

After all validation passes, merge the preparation, ensure the merged commit
matches the validated tree, and create the matching tag and GitHub release.
Publishing the GitHub release starts the publishing workflow once. It rebuilds
and validates the artifacts, uploads them without overwriting existing assets,
then publishes npm through trusted publishing with provenance. Stable releases
use `latest`; prereleases use `next`. The `npm` GitHub environment and the npm
trusted publisher must permit `.github/workflows/release.yml` in this repository.

The workflow refuses an existing npm version or any existing release assets.
If publication fails partway, inspect npm and the release assets before choosing
a recovery action. Do not blindly rerun publication, delete published versions,
move released tags, or overwrite validated assets.

`Published Install` runs after a successful publication and can also be
dispatched with an exact package version. It installs with source fallback
disabled on all seven targets, checks CommonJS and ESM loading, and exchanges a
data-channel message. Confirm the exact npm version, `latest`, all fourteen
release assets, their checksums, and this workflow before reporting success.
