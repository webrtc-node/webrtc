<h1 align="center">webrtc-node</h1>

<p align="center">
  <a href="https://github.com/mertushka/webrtc-node/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/mertushka/webrtc-node/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://www.npmjs.com/package/@mertushka/webrtc-node"><img alt="npm" src="https://img.shields.io/npm/v/@mertushka/webrtc-node"></a>
  <img alt="Node.js" src="https://img.shields.io/badge/node-%3E%3D20-339933">
  <img alt="API" src="https://img.shields.io/badge/API-W3C--style-0a7">
  <img alt="Data Channels" src="https://img.shields.io/badge/scope-data%20channels-4c1">
  <img alt="TypeScript" src="https://img.shields.io/badge/types-TypeScript-3178c6">
  <img alt="WPT" src="https://img.shields.io/badge/WPT-620%20selected%20subtests-4c1">
  <img alt="Native API" src="https://img.shields.io/badge/native-Node--API-blue">
  <img alt="License" src="https://img.shields.io/badge/license-MPL--2.0-orange">
</p>

<p align="center">
  WebRTC data channels for Node.js, backed by
  <a href="https://github.com/paullouisageneau/libdatachannel">libdatachannel</a>
  and validated with 620 selected Web Platform Tests subtests.
</p>

```sh
npm install @mertushka/webrtc-node
```

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

## Supported Platforms

Node.js 20 or newer is required. The npm package downloads a matching Node-API
prebuild when available, verifies its SHA-256 digest and target, then falls back
to a `cmake-js` source build.

| OS | Prebuild targets | Node 20 | Node 22 | Node 24 |
| --- | --- | --- | --- | --- |
| Linux | x64 glibc, x64 musl | ✅ | ✅ | ✅ |
| macOS | x64, arm64 | ✅ | ✅ | ✅ |
| Windows | x64, arm64 | ✅ | ✅ | ✅ |

Source builds require CMake, a C++17 compiler, and OpenSSL development
libraries.

## Performance Snapshot

Local benchmark snapshots show this package ahead on binary throughput and
object operation rates. Benchmarks are environment-sensitive; treat them as
directional rather than a substitute for testing your workload.

| Metric | `webrtc-node` | `node-datachannel` | `@roamhq/wrtc` |
| --- | ---: | ---: | ---: |
| Linux binary 8 KiB x1000 | 39.9 MB/s | 30.4 MB/s | 27.4 MB/s |
| Linux construct+close PC | 53k ops/s | 3.2k ops/s | 200 ops/s |
| Linux negotiated DC create+close | 2.2k ops/s | 974 ops/s | 173 ops/s |

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Public
API changes should update runtime code, TypeScript declarations, tests, and WPT
documentation together.

## License

Mozilla Public License 2.0. See [LICENSE](LICENSE).
