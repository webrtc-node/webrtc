# Development

This project builds a Node-API addon and a W3C-style JavaScript facade. Use the
lockfile and keep generated artifacts out of commits.

## Setup

```sh
npm ci
npm run native:check
npm run build
```

`native:check` verifies the pinned `libdatachannel` commit, Node-API usage, and
thread-safe callback dispatch. The build uses `cmake-js` and links
`LibDataChannel::LibDataChannelStatic`.

If a local `libdatachannel/` checkout exists, CMake verifies it against the
pinned commit. Otherwise it fetches the pinned upstream commit with
`FetchContent`.

## Local Checks

```sh
npm run check
npm test
npm run api:check
npm run types:check
npm run pack:check
npm run e2e:chrome
npm run wpt:selection:check
npm run wpt:smoke
npm run wpt:smoke:check
```

Run the full selected WPT suite before claiming conformance changes:

```sh
npm run wpt:ensure
npm run wpt:test
npm run wpt:check:strict
npm run wpt:report -- --output wpt-report.md
```

The default `CI` workflow keeps pull requests fast by always running the
Quality job, then classifying changed files into native, package-artifact, WPT,
and Chrome E2E buckets. Native changes run the OS/Node matrix with unit tests. Runtime,
native, package, or Chrome E2E changes run the strict Chrome interoperability
suite on Ubuntu Node 24. Native or WPT changes run a small WPT smoke subset on
Ubuntu Node 24. Native or package artifact changes run a clean packed-source
build check.

The current classifier treats these paths as native-relevant: `lib/`, `src/`,
`test/`, `CMakeLists.txt`, package files, `index.d.ts`,
`scripts/check-api-surface.js`, and `scripts/check-native-integration.js`.
Package-artifact paths include package files, `CMakeLists.txt`, `lib/`, `src/`,
`scripts/check-package-artifact.js`, `scripts/install-native.js`, and the
prebuild packaging, validation, and integrity scripts. WPT paths include
`wpt-manifest.json` and the WPT/reporting/evidence scripts. Workflow or action
changes run all four buckets. Documentation and agent-note changes normally run
only the Quality job.

`CI required` is the stable branch-protection check. It succeeds only when the
applicable conditional jobs passed or were intentionally skipped. CodeQL runs
independently on pull requests, pushes to `main`, and a weekly schedule.
JavaScript/TypeScript analysis is buildless; C++ analysis manually builds the
native addon so the database includes the real Node-API compilation. The C++
job warm-builds fetched dependencies before CodeQL initialization, then
rebuilds the first-party addon sources under tracing. Findings in ignored
libdatachannel or usrsctp build trees are upstream concerns rather than
repository-owned code.

Two JavaScript alerts are intentionally classified as test-harness-only:

- `test/turn.test.js` implements the legacy MD5 and SHA-1 TURN long-term
  credential calculation required to validate native credential forwarding.
- `scripts/run-wpt-subset.js` extracts scripts from the pinned local WPT
  checkout; its regular expression is not used to sanitize or render untrusted
  HTML.

## Chrome Interoperability

WPT remains the JavaScript compatibility contract. The Chrome E2E suite checks
wire interoperability with a real browser:

```sh
npm run build
npm run e2e:chrome
```

Google Chrome must be installed. Set `CHROME_PATH` when it is not in a standard
platform location. The suite has no retries and covers both offerer directions,
negotiated and in-band channels, reliability options, text/binary/Blob payloads,
message-size limits, buffering, close propagation, candidate-by-candidate
trickle ICE, repeated connections, and ICE restart behavior. Scenarios run in
fresh processes so unrelated tests do not share libdatachannel's process-global
transport state. One lifetime scenario deliberately cycles negotiated,
partial-reliability, buffered, and ordinary channels in the same process.

The full selected WPT matrix is in the `Conformance` workflow, which runs on
manual dispatch, weekly schedule, and version tags.

By default, WPT is fetched into the ignored `wpt/` cache. Set `WPT_DIR` to use a
different pinned checkout.

For focused debugging:

```sh
npm run wpt:test -- webrtc/RTCDataChannel-close.html
npm run wpt:test -- "webrtc/RTCDataChannel-send.html#Sending in ondatachannel should work"
```

Bare file targets use manifest include/exclude rules. A `file#subtest` selector
runs one exact WPT subtest.

## Formatting and Linting

Biome is used for JavaScript, TypeScript, and JSON formatting/linting:

```sh
npm run check
npm run lint
npm run format:check
npm run format
```

`npm run check` is the Biome gate used by GitHub Actions. The full Quality job
also runs `npm run types:check` and `npm run pack:check`. WPT selection checks
run after the native addon is built because the WPT harness loads the public
WebRTC facade. `pack:check` validates the npm source artifact contents. Use
`npm run format` before sending a pull request.

## Package Artifact

CI has a Linux `Package artifact` job that packs the npm source package,
extracts it in a clean directory, installs dependencies, builds the native
addon, and requires the package. This guards against missing files in
`package.json#files` before npm publication.

## Prebuilt Releases

The release workflow keeps `cmake-js` as the native build backend. Platform jobs
build `build/Release/webrtc_node.node`, then `npm run prebuild:package` creates
`prebuild-artifacts/webrtc-node-v<version>-napi-v8-<target>.tar.gz` and a
matching `.sha256` file. The npm publish job downloads those artifacts, verifies
the complete target set, checks every checksum, archive entry, and binary target,
uploads them to the GitHub Release, runs `pack:check`, and publishes the source
package. Prebuilds and generated checksums are not bundled inside the npm
tarball.

The release workflow also waits for the successful strict `Conformance` run
associated with the release tag. Prebuild jobs may run in parallel, but npm
publication cannot begin until the matching tag run is complete and green.

Publishing uses npm trusted publishing with GitHub Actions OIDC, not an
`NPM_TOKEN` secret. Configure the npm package trusted publisher for repository
`mertushka/webrtc-node`, workflow filename `release.yml`, and environment `npm`
if the GitHub release environment is kept.

The `Published Install` workflow runs after a successful `Release` workflow or
by manual dispatch. It installs the published npm package on Linux glibc, Linux
musl, macOS x64, macOS arm64, Windows x64, and Windows arm64, then verifies both
CommonJS and ESM imports. It sets `WEBRTC_NODE_PREBUILD_ONLY=1` so missing or
broken release assets fail instead of compiling from source.

The install script downloads the target archive and its sibling `.sha256`
release asset. It enforces download limits, verifies the SHA-256 digest, accepts
only a single regular `webrtc_node.node` archive entry, validates the binary
format and CPU architecture, distinguishes Linux glibc from musl, and installs
through a temporary path only after all checks pass.

Manual `workflow_dispatch` releases expect a GitHub Release named
`v<package.json version>` to already exist, because prebuilt archives are
uploaded as release assets before `npm publish` runs.

If a release asset needs to be rebuilt for an already-published npm version, run
the `Release` workflow manually with `publish_npm` disabled. The workflow still
builds and uploads prebuild assets with `--clobber`, but skips `npm publish`.

Supported release targets are:

- `linux-x64-glibc` built in a Debian Bullseye container for an older glibc
  baseline
- `linux-x64-musl`
- `darwin-x64`
- `darwin-arm64`
- `win32-x64`
- `win32-arm64`

Windows release builds use the pinned root `vcpkg.json` manifest with static
OpenSSL triplets. GitHub Actions builds and validates x64 on `windows-latest`
and ARM64 natively on `windows-11-arm`; Windows release archives therefore do
not bundle OpenSSL runtime DLLs.

Use `WEBRTC_NODE_NATIVE_PATH=/absolute/path/to/webrtc_node.node` to test a
specific local native binary. Use `npm install --build-from-source` to force the
install script to compile with `cmake-js`. Use `WEBRTC_NODE_PREBUILD_ONLY=1` in
release validation to fail rather than falling back to a source build.

## Docker Linux Slice

GitHub Actions is the authoritative conformance gate. The Docker helpers are
optional local reproducers for Linux CI behavior when a contributor has Docker
available.

On Linux or macOS:

```sh
bash scripts/run-docker-linux-ci.sh --node-image node:20-bookworm --artifacts-dir ci-artifacts/docker-linux-node20
bash scripts/run-docker-linux-ci.sh --node-image node:22-bookworm --artifacts-dir ci-artifacts/docker-linux-node22
bash scripts/run-docker-linux-ci.sh --node-image node:24-bookworm --artifacts-dir ci-artifacts/docker-linux-node24
```

On Windows with Docker Desktop:

```powershell
./scripts/run-docker-linux-ci.ps1 -NodeImage node:20-bookworm -ArtifactsDir ci-artifacts/docker-linux-node20
./scripts/run-docker-linux-ci.ps1 -NodeImage node:22-bookworm -ArtifactsDir ci-artifacts/docker-linux-node22
./scripts/run-docker-linux-ci.ps1 -NodeImage node:24-bookworm -ArtifactsDir ci-artifacts/docker-linux-node24
```

Target a single WPT case:

```sh
bash scripts/run-docker-linux-ci.sh \
  --node-image node:24-bookworm \
  --artifacts-dir ci-artifacts/docker-linux-node24-close \
  --wpt-selector "webrtc/RTCDataChannel-close.html#Repeated open/send/echo/close datachannel works"
```

```powershell
./scripts/run-docker-linux-ci.ps1 -NodeImage node:24-bookworm `
  -ArtifactsDir ci-artifacts/docker-linux-node24-close `
  -WptSelector "webrtc/RTCDataChannel-close.html#Repeated open/send/echo/close datachannel works"
```

The helper writes logs and WPT artifacts under the selected `ci-artifacts/`
directory.
