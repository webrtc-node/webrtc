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
npm run wpt:selection:check
```

Run the full selected WPT suite before claiming conformance changes:

```sh
npm run wpt:ensure
npm run wpt:test
npm run wpt:check:strict
npm run wpt:report -- --output wpt-report.md
```

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
also runs `npm run types:check` and `npm run pack:check`. `pack:check`
validates the npm source artifact contents. Use `npm run format` before sending
a pull request.

## Package Artifact

CI has a Linux `Package artifact` job that packs the npm source package,
extracts it in a clean directory, installs dependencies, builds the native
addon, and requires the package. This guards against missing files in
`package.json#files` before npm publication.

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
