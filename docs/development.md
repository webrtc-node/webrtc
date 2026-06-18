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

The workflow file owns the current path classifier. Check
`.github/workflows/ci.yml` before changing CI gating or assuming a path will
skip the heavier jobs.

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
manual dispatch and a weekly schedule. Each OS/Node job runs three
deterministic weighted WPT shards concurrently, preserving file-level execution
where tests share setup, then merges them into one strict 620-subtest result
artifact.

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
also runs `npm run types:check`. WPT selection checks run after the native addon
is built because the WPT harness loads the public WebRTC facade. Use
`npm run format` before sending a pull request.

## Package Artifact

CI has a Linux `Package artifact` job that packs the npm source package,
extracts it in a clean directory, installs dependencies, builds the native
addon, and requires the package. This guards against missing files in
`package.json#files`.

Use `WEBRTC_NODE_NATIVE_PATH=/absolute/path/to/webrtc_node.node` to test a
specific local native binary. Use `npm install --build-from-source` to force the
install script to compile with `cmake-js`.
