<h1 align="center">webrtc-node</h1>

<p align="center">
  WebRTC data channels for Node.js, with the browser API shape developers
  already know.
</p>

<p align="center">
  Backed by
  <a href="https://github.com/paullouisageneau/libdatachannel">libdatachannel</a>
  and validated with 620 selected Web Platform Tests subtests.
</p>

<p align="center">
  <a href="https://github.com/mertushka/webrtc-node/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/mertushka/webrtc-node/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://www.npmjs.com/package/@mertushka/webrtc-node"><img alt="npm" src="https://img.shields.io/npm/v/@mertushka/webrtc-node"></a>
  <img alt="Node.js" src="https://img.shields.io/badge/node-%3E%3D20-339933">
  <img alt="WPT" src="https://img.shields.io/badge/WPT-620%20selected%20subtests-4c1">
  <img alt="Native API" src="https://img.shields.io/badge/native-Node--API-blue">
  <img alt="License" src="https://img.shields.io/badge/license-MPL--2.0-orange">
</p>

`webrtc-node` provides W3C-style `RTCPeerConnection` and
`RTCDataChannel` APIs for Node.js. It focuses on data channels, uses
`libdatachannel` for transport, and ships through ABI-stable Node-API native
bindings.

```sh
npm install @mertushka/webrtc-node
```

## Highlights

- **Browser-compatible surface:** W3C-style `RTCPeerConnection`,
  `RTCDataChannel`, session descriptions, ICE candidates, DOM-style events, and
  WebRTC-shaped errors.
- **Conformance-led development:** 620 selected WPT subtests cover the supported
  data-channel profile across Linux, macOS, and Windows.
- **Small native core:** ICE, DTLS, SCTP, and data-channel transport come from
  pinned `libdatachannel`, exposed through an ABI-stable Node-API addon.
- **Ready for TypeScript:** declarations are included and checked with the
  runtime API surface.
- **Focused by design:** data channels first; no media tracks, transceivers,
  stats, DTMF, or browser device APIs.

## Performance Snapshot

Local benchmark snapshots show this package ahead on binary throughput and
object operation rates. Benchmarks are environment-sensitive; treat them as
directional rather than a substitute for testing your workload.

| Metric | `webrtc-node` | `node-datachannel` | `@roamhq/wrtc` |
| --- | ---: | ---: | ---: |
| Linux binary 8 KiB x1000 | 39.9 MB/s | 30.4 MB/s | 27.4 MB/s |
| Linux construct+close PC | 53k ops/s | 3.2k ops/s | 200 ops/s |
| Linux negotiated DC create+close | 2.2k ops/s | 974 ops/s | 173 ops/s |

## Usage

```js
const { RTCPeerConnection } = require("@mertushka/webrtc-node");

const pc = new RTCPeerConnection({ iceServers: [] });
const channel = pc.createDataChannel("events");

channel.addEventListener("open", () => {
  channel.send("hello from Node");
});

channel.addEventListener("message", (event) => {
  console.log(event.data);
});
```

See [examples/datachannel.js](examples/datachannel.js) for a complete local
offer/answer exchange.

## Installation Details

The npm package downloads the matching Node-API prebuilt binary when available,
then falls back to a `cmake-js` source build. Published prebuild targets are
Linux x64 glibc, Linux x64 musl, macOS x64, macOS arm64, and Windows x64.

Source builds require Node.js 20 or newer, CMake, a C++17 compiler, and OpenSSL
development libraries.

Run the example from a checkout:

```sh
npm run example:datachannel
```

## Conformance

The compatibility target is the selected WPT suite tracked in
[wpt-manifest.json](wpt-manifest.json). The current selected suite contains
**620 expected-passing subtests** across the Node 20, 22, and 24 CI matrix on
Linux, macOS, and Windows.

| Area | Coverage |
| --- | --- |
| PeerConnection | construction, descriptions, ICE candidates, signaling/ICE/connection state, close |
| DataChannel | id, label, readyState, ordered, negotiated, protocol, binaryType, send, message, open, close, error |
| Events and errors | DOM-style events, `RTCDataChannelEvent`, ICE events, DOMException-shaped failures |
| Excluded by design | media tracks, transceivers, RTP sender/receiver APIs, stats, DTMF, browser devices |

Intentional WebRTC divergences are documented in
[docs/divergences.md](docs/divergences.md).

This is not a claim of full browser WebRTC compliance. It is a documented
data-channel profile with WPT evidence.

## Development

Common local checks:

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

Run selected WPT tests:

```sh
npm run wpt:ensure
npm run wpt:test
npm run wpt:check:strict
```

GitHub Actions runs the fast build/unit matrix plus WPT smoke on ordinary pushes
and pull requests. The full selected WPT matrix lives in the separate
`Conformance` workflow for manual, scheduled, and version-tagged release checks.

Use `npm run format` to apply Biome formatting before opening a pull request.
`npm run pack:check` verifies the npm source artifact.

More details:

- [docs/development.md](docs/development.md)
- [docs/conformance.md](docs/conformance.md)
- [docs/architecture.md](docs/architecture.md)

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Public
API changes should update runtime code, TypeScript declarations, tests, and WPT
documentation together.

## License

Mozilla Public License 2.0. See [LICENSE](LICENSE).
