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

See [docs/development.md](docs/development.md) for platform notes, Docker
commands, and targeted WPT usage.

## Required Checks

Before opening a pull request, run:

```sh
npm run check
npm test
npm run api:check
npm run types:check
npm run pack:check
npm run wpt:selection:check
```

Run the selected WPT suite for WebRTC behavior changes:

```sh
npm run wpt:test
npm run wpt:check:strict
```

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
