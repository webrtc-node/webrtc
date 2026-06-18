# Repository Guidelines

## Conformance Target

This package exposes W3C-style `RTCPeerConnection` and `RTCDataChannel` APIs
for Node.js on top of `paullouisageneau/libdatachannel`. Treat the selected
web-platform-tests (WPT) suite as the compatibility contract. Prefer
browser-compatible JavaScript semantics over libdatachannel-specific behavior,
and document intentional divergences in `docs/divergences.md`.

The exposed project scope is peer connections and data channels. Do not add
media tracks, transceivers, RTP sender/receiver APIs, stats, DTMF, or browser
device APIs.

## Project Structure

- `lib/index.js`: public WebRTC facade, WebIDL-style conversions, event timing,
  DOMException-shaped errors, and peer/data-channel behavior.
- `src/native/addon.cc`: Node-API bridge to libdatachannel. Keep this ABI-stable
  and free of direct V8 or NAN APIs.
- `CMakeLists.txt`: native build and pinned libdatachannel integration.
- `index.d.ts`: public TypeScript declarations; keep runtime exports in sync.
- `examples/`: small runnable examples for public users.
- `test/*.test.js`: focused Node `node:test` coverage.
- `wpt-manifest.json`: selected WPT scope, expected failures, shims, and
  non-applicable browser/media cases.
- `scripts/`: build, API, native, WPT, and reporting checks.
- `docs/`: architecture, conformance, development, divergence, and nonstandard
  API documentation. Start with `docs/README.md` when looking for durable
  project context.
- `libdatachannel/` and `wpt/`: ignored local external checkouts. Treat them as
  caches; do not commit them or edit vendored code.

## Public Repository Hygiene

Keep top-level files project-facing and concise. `README.md` should explain what
the package is, how to build it, how to run the example, and where to find
documentation. Avoid putting agent plans, temporary CI commentary, private-repo
notes, or local troubleshooting transcripts in the README or CONTRIBUTING file.

Durable project context belongs in the appropriate `docs/` file:

- intentional standards divergences: `docs/divergences.md`

Do not commit scratch analysis, temporary CI commentary, private-repo notes, or
local troubleshooting transcripts.

## Native Safety Rules

Never call JavaScript directly from libdatachannel callback threads. Use
`Napi::ThreadSafeFunction` or an equivalent dispatcher back to the Node event
loop. Native lifetime must tolerate close/delete races, late callbacks, repeated
close calls, garbage collection, and failed construction without use-after-free
or double callback delivery.

Keep native code thin: own handles, translate configuration, and surface events.
Put W3C-facing behavior in `lib/index.js` unless native behavior is required for
correctness.

## Build and Test Commands

Install with the lockfile:

```sh
npm ci
```

Common validation path for runtime, native, public API, package, or test
changes:

```sh
npm run check
npm run native:check
npm run build
npm test
npm run api:check
npm run types:check
npm run wpt:selection:check
npm run wpt:smoke
npm run wpt:smoke:check
```

For documentation-only changes, `npm run check` is usually enough. For browser
interoperability, signaling, ICE, buffering, message, or close-propagation
changes, run `npm run e2e:chrome`. Match additional checks to the risk and
scope of the change.

Full conformance validation is intentionally separate from ordinary push/PR CI:

```sh
npm run wpt:test
npm run wpt:test:sharded
npm run wpt:check:strict
```

Create a WPT report with:

```sh
npm run wpt:report -- --output wpt-report.md
```

For targeted WPT debugging, pass a file or `file#subtest` selector to
`npm run wpt:test`.

For native transport and teardown diagnostics, set
`WEBRTC_NODE_LIBDATACHANNEL_LOG` to `error`, `warning`, `info`, `debug`, or
`verbose` before running focused tests. Logging is disabled by default.

## Change Discipline

Before changing WebRTC semantics, read the relevant WPT test and nearby facade
code. Add or update local `node:test` coverage for regressions, run the smallest
relevant WPT target, then run the selected WPT suite before claiming conformance.

When changing public API, update `lib/index.js`, `index.d.ts`,
`scripts/check-api-surface.js` if needed, local tests, and the WPT manifest or
docs when conformance status changes.

## Git Workflow

Work on focused branches and use Conventional Commit messages. Do not commit,
push, merge, tag, publish, or upload release assets unless the current task
explicitly asks for it.

## Style and Artifacts

Use the existing JavaScript style: CommonJS modules, two-space indentation,
camelCase members, WebRTC constructor names matching the W3C API, and concise
comments only where they clarify non-obvious behavior. Biome owns JavaScript,
TypeScript, and JSON formatting/linting; run `npm run format` for mechanical
formatting changes.

Keep generated artifacts out of commits: `build/`, `node_modules/`,
`libdatachannel/`, `prebuild-artifacts/`, `wpt/`, `wpt-results.json`,
`wpt-report.md`, `ci-artifacts/`, logs, coverage output, and package tarballs.
