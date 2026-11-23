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

The native dependency is released libdatachannel v0.24.6
(`6b1e2e620f1e37f0eafeee702eaea0043cb305fd`). The CMake pin and
`wpt-manifest.json` dependency metadata must stay in sync. Dependency upgrades
must pass the packed-source build on the oldest supported Linux toolchain as
well as the native runtime checks.

`npm test` also builds and runs the small native send-queue test executable.
These C++ tests cover queue saturation and teardown with a blocked worker; the
Node tests separately exercise payload conversion and real transport delivery.

If a local `libdatachannel/` checkout exists, CMake verifies it against the
pinned commit. Otherwise it fetches the pinned upstream commit with
`FetchContent`.

Windows CI and release builds use pinned vcpkg dependencies. The ARM64 static
triplet builds OpenSSL C code with `/Od` to avoid an access violation during
DTLS handshakes with optimized MSVC builds. OpenSSL assembly implementations,
static linkage, and optimization of the addon and libdatachannel are retained.
This trades OpenSSL C-code performance for working connections; removing the
workaround requires validating an optimized build with a data-channel exchange.

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

Use focused WPT targets and the smoke subset locally. Full selected WPT runs
belong in GitHub Actions; run them locally only when explicitly requested. Use
the Conformance workflow's strict results before claiming full selected-suite
conformance.

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
manual dispatch, a weekly schedule, and version tags. Each OS/Node job runs three
deterministic weighted WPT shards concurrently, preserving file-level execution
where tests share setup, then merges them into one strict 620-subtest result
artifact.

For a runner-specific failure, the same workflow accepts a `selector` containing
a file or `file#subtest`. Focused mode uses the selected runner and Node version,
can repeat the target up to 100 times, and stops on the first failure. It disables
worker retries and cleanup delays to exercise teardown races and uploads each
attempt's result plus the native addon (with Windows debug symbols). Leaving
`selector` empty runs the full matrix with its normal cleanup delays.

By default, WPT is fetched into the ignored `wpt/` cache. Set `WPT_DIR` to use a
different pinned checkout.

For focused debugging:

```sh
npm run wpt:test -- webrtc/RTCDataChannel-close.html
npm run wpt:test -- "webrtc/RTCDataChannel-send.html#Sending in ondatachannel should work"
```

Bare file targets use all selected query variants and their include/exclude
rules. Add `?rest` or `?interop-2026` to select one variant. A `file#subtest`
selector runs one exact WPT subtest.

## Send-burst latency

From a source checkout, measure public `send()` burst duration and time to yield
the event loop with:

```sh
npm run benchmark:send -- --peers=4 --messages=1000 --size=256 --rounds=8
```

The receiver for each peer runs in a separate Node Worker, so messages travel
through the native transport. The benchmark checks binary sequence numbers,
waits for every receiver after each burst, and reports send-loop, event-loop
yield, and end-to-end delivery timings. It measures local loopback behavior;
use representative peer counts, payload sizes, and network paths for production
capacity decisions. Timing values are informational rather than CI thresholds.

## Comparison with node-datachannel

`npm run benchmark:compare` drives one data channel through the W3C API, so the
same code runs against this package or node-datachannel's polyfill. The sender
and receiver run in separate Node processes.

```sh
npm run benchmark:compare -- --library=webrtc-node --scenario=rate
npm install --no-save node-datachannel
npm run benchmark:compare -- --library=node-datachannel --scenario=rate
```

Scenarios are `rate` (64-byte binary messages), `text` (64-character strings),
`bulk` (64 KiB messages), and `pingpong` (one message in flight). Pass
`--messages` and `--size` to change the defaults. Each run prints one JSON line
with throughput, CPU per message, event-loop utilization, and receiver peak RSS,
or round-trip percentiles for `pingpong`. Alternate the libraries across several
runs on a quiet machine before comparing.

## CPU and connection lifecycle

Run the CPU benchmark from a source checkout with a built native addon.

```sh
npm run benchmark:cpu -- --peers=16 --direction=both --rounds=40 --messages=64 --idle-ms=18000
```

The offerer and answerer run in separate Node processes. The report includes
CPU time per process during setup, idle, traffic, and close calls. It also
reports CPU per delivered message and p95 burst delivery time, including
the IPC acknowledgment. Endpoint exit time captures cleanup after IPC
disconnect.

Use `--direction=send` or `--direction=receive` to select one-way traffic
relative to the offerer. Use `--pace-ms=16` with `--messages=1` for paced
traffic. On builds with [native worker pool limits](nonstandard.md#native-worker-pool-limit),
pass `--offerer-thread-limit` or `--answerer-thread-limit` to tune one endpoint
at a time. Pass `--package=<directory>` to compare built checkouts or installed
packages.

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

## Native Binaries

The package has no install script. Each prebuilt target is published as its
own package, such as `@webrtc-node/webrtc-linux-x64-glibc`, whose `os`, `cpu`,
and `libc` fields let the package manager install only the matching binary.
The release workflow adds these packages to the main package as exact-version
optional dependencies when it publishes, so a checkout's `package.json` does
not list them. The targets are defined in `lib/native-target.js`.

The loader uses the first binary it finds:

1. `WEBRTC_NODE_NATIVE_PATH`, an absolute path to a `webrtc_node.node` file.
2. A local build in `build/Release` or `build/Debug`.
3. The platform package for the current target. Its version must match the
   main package.

For a platform without a prebuilt binary, build from a source checkout with
`npm ci` and `npm run build`, then point `WEBRTC_NODE_NATIVE_PATH` at
`build/Release/webrtc_node.node`.

To check a release locally, package a built addon with
`npm run prebuild:package`, then run
`npm exec -c "node scripts/validate-prebuild-install.js"`. It builds the
platform package, installs it with the main package from local tarballs with
lifecycle scripts disabled, and loads the addon through CommonJS and ESM.

## Package Artifact

CI has a Linux `Package artifact` job that packs the npm source package,
extracts it in a clean directory, installs dependencies, builds the native
addon, and requires the package. This guards against missing files in
`package.json#files`.
