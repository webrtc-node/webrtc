# Contributing

Thanks for improving `@mertushka/webrtc-node`. This project targets
browser-compatible `RTCPeerConnection` and `RTCDataChannel` behavior for
Node.js, with selected WPT coverage as the compatibility contract.

## Development Setup

```sh
npm ci
npm run native:check
npm run build
```

See [docs/development.md](docs/development.md) for platform notes and targeted
WPT usage.

## Validation

Run checks that match the risk of the change. For documentation-only changes,
`npm run check` is usually enough.

For runtime, native, public API, package, or test changes, use the common local
path:

```sh
npm run check
npm run native:check
npm run build
npm test
npm run api:check
npm run types:check
npm run wpt:selection:check
```

Run Chrome E2E for browser interoperability, signaling, ICE, buffering,
message, or close-propagation changes:

```sh
npm run e2e:chrome
```

Run WPT smoke for WebRTC facade or WPT harness changes:

```sh
npm run wpt:selection:check
npm run wpt:smoke
npm run wpt:smoke:check
```

Run the full selected WPT suite before claiming conformance changes or after
public WebRTC behavior changes:

```sh
npm run wpt:test
npm run wpt:check:strict
```

For targeted debugging, pass either a WPT file or a `file#subtest` selector to
`npm run wpt:test` before running the full selected suite.

## Pull Requests

- Keep changes scoped to one behavior or API area.
- Run `npm run format` for Biome-managed files before pushing.
- Update `index.d.ts` when runtime exports or public types change.
- Update `wpt-manifest.json` and docs when conformance status changes.
- Add or update `test/*.test.js` coverage for regressions.
- Document intentional WebRTC divergences in `docs/divergences.md`.

The package scope is `RTCPeerConnection` plus `RTCDataChannel`. Do not add
media tracks, transceivers, RTP sender/receiver APIs, stats, DTMF, or browser
device APIs.
