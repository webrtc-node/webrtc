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
- `docs/`: public design/conformance docs plus internal planning and evidence
  notes. Keep scratch analysis, verification logs, and maintainer-only context
  here instead of the repository root.
- `libdatachannel/` and `wpt/`: ignored local external checkouts. Treat them as
  caches; do not commit them or edit vendored code.

## Public Repository Hygiene

Keep top-level files project-facing and concise. `README.md` should explain what
the package is, how to build it, how to run the example, and where to find
documentation. Avoid putting agent plans, temporary CI commentary, private-repo
notes, or local troubleshooting transcripts in the README or CONTRIBUTING file.

Internal working notes belong in `AGENTS.md` or `docs/`:

- Phase 0 and design analysis: `docs/phase0-analysis.md`
- conformance evidence and local audit notes: `docs/verification-audit.md`
- maintainer-only release/repository steps: `docs/maintainer-checklist.md`
- intentional standards divergences: `docs/divergences.md`

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

Common validation path:

```sh
npm run check
npm run native:check
npm run build
npm test
npm run api:check
npm run types:check
npm run pack:check
npm run wpt:selection:check
npm run wpt:smoke
npm run wpt:smoke:check
```

Full conformance validation is intentionally separate from ordinary push/PR CI:

```sh
npm run wpt:test
npm run wpt:check:strict
npm run ci:evidence
```

Create a WPT report with:

```sh
npm run wpt:report -- --output wpt-report.md
```

For targeted WPT debugging, pass a file or `file#subtest` selector to
`npm run wpt:test`.

After downloading CI artifacts into `ci-artifacts/`, run
`npm run ci:evidence:check` to verify the Linux/macOS/Windows Node 20/22/24
matrix evidence. The Conformance workflow also runs this as the final
`Verify CI evidence` job.

## Change Discipline

Before changing WebRTC semantics, read the relevant WPT test and nearby facade
code. Add or update local `node:test` coverage for regressions, run the smallest
relevant WPT target, then run the selected WPT suite before claiming conformance.

When changing public API, update `lib/index.js`, `index.d.ts`,
`scripts/check-api-surface.js` if needed, local tests, and the WPT manifest or
docs when conformance status changes.

## Security and Release Automation

Keep the independent CodeQL workflow enabled for JavaScript/TypeScript and the
manually built C++ addon. Run it on pull requests, pushes to `main`, and a
schedule with only `contents: read` and `security-events: write` permissions.
Treat unresolved new high or critical alerts as release blockers.

Protect `main` and require the stable `CI required` gate plus both CodeQL
language checks. Publish npm releases only after the version tag's strict
Conformance workflow succeeds. Keep npm trusted publishing on GitHub OIDC with
provenance; never add a long-lived npm publishing token.

Keep private vulnerability reporting and Dependabot enabled. Release prebuild
downloads must reject corrupt, malformed, or wrong-platform artifacts.

Work on focused branches, use Conventional Commit messages, and open pull
requests as drafts unless explicitly requested otherwise. Do not commit
directly to `main`, merge with failing required checks, or publish versions,
tags, releases, or replacement assets without explicit maintainer approval.

## Style and Artifacts

Use the existing JavaScript style: CommonJS modules, two-space indentation,
camelCase members, WebRTC constructor names matching the W3C API, and concise
comments only where they clarify non-obvious behavior. Biome owns JavaScript,
TypeScript, and JSON formatting/linting; run `npm run format` for mechanical
formatting changes.

Keep generated artifacts out of commits: `build/`, `node_modules/`,
`libdatachannel/`, `prebuild-artifacts/`, `wpt/`, `wpt-results.json`,
`wpt-report.md`, `wpt-manifest.txt`, `ci-evidence.json`, `ci-artifacts/`,
logs, coverage output, and package tarballs.
