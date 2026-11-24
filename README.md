# @webrtc-node/webrtc

[![CI](https://github.com/webrtc-node/webrtc/actions/workflows/ci.yml/badge.svg)](https://github.com/webrtc-node/webrtc/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@webrtc-node/webrtc)](https://www.npmjs.com/package/@webrtc-node/webrtc)
[![npm downloads](https://img.shields.io/npm/dm/@webrtc-node/webrtc)](https://www.npmjs.com/package/@webrtc-node/webrtc)
[![License: MPL-2.0](https://img.shields.io/badge/license-MPL--2.0-blue)](LICENSE)

WebRTC data channels for Node.js with the same `RTCPeerConnection` and
`RTCDataChannel` API as browsers. Built on
[libdatachannel](https://github.com/paullouisageneau/libdatachannel), shipped
as a Node-API addon with prebuilt binaries, and validated against 620 selected
[Web Platform Tests](https://web-platform-tests.org/) subtests on Linux, macOS,
and Windows.

```sh
npm install @webrtc-node/webrtc
```

## Quick start

```js
const { RTCPeerConnection } = require("@webrtc-node/webrtc");

const alice = new RTCPeerConnection();
const bob = new RTCPeerConnection();

// Exchange ICE candidates. In a real app these go through your signaling server.
alice.onicecandidate = ({ candidate }) => candidate && bob.addIceCandidate(candidate);
bob.onicecandidate = ({ candidate }) => candidate && alice.addIceCandidate(candidate);

bob.ondatachannel = ({ channel }) => {
  channel.onmessage = ({ data }) => {
    console.log(`bob received: ${data}`);
    alice.close();
    bob.close();
  };
};

const channel = alice.createDataChannel("chat");
channel.onopen = () => channel.send("hello from Node.js");

(async () => {
  await alice.setLocalDescription();
  await bob.setRemoteDescription(alice.localDescription);
  await bob.setLocalDescription();
  await alice.setRemoteDescription(bob.localDescription);
})();
```

More in [examples/](examples/): peers in separate processes, and streaming with
backpressure.

## Features

- **Browser-compatible API.** Code written against browser `RTCPeerConnection`
  and `RTCDataChannel` runs unchanged, including events, `bufferedAmount`, and
  DOMException errors. Interoperability with Chrome is tested in CI.
- **Event loop stays free.** SCTP, DTLS, and socket work runs on native threads,
  so heavy sending does not block your application.
- **Installs without scripts.** Prebuilt binaries for eight targets ship as
  per-platform npm packages, so installation works where package managers
  block install scripts. ESM, CommonJS, and TypeScript declarations are
  included.
- **Focused extensions** for servers, such as ICE UDP multiplexing on one port
  and PEM certificate import, in a separate
  [`nonstandard`](docs/nonstandard.md) namespace.

The scope is peer connections and data channels. Media tracks, transceivers,
and statistics are not supported.

## Supported platforms

Node.js 20 or newer.

| OS      | Prebuilt targets                             | Node.js        |
| ------- | -------------------------------------------- | -------------- |
| Linux   | x64 glibc, x64 musl, arm64 glibc, arm64 musl | 20, 22, 24, 26 |
| macOS   | x64, arm64                                   | 20, 22, 24, 26 |
| Windows | x64, arm64                                   | 20, 22, 24, 26 |

The package manager installs the matching binary as an optional dependency,
such as `@webrtc-node/webrtc-linux-x64-glibc`, and no install script runs.
For other platforms, build from source as described in
[docs/development.md](docs/development.md#native-binaries).

## Performance

Compared with [node-datachannel](https://github.com/murat-dogan/node-datachannel),
sending between two Node.js processes on one Windows desktop:

|                            | `@webrtc-node/webrtc` | `node-datachannel` |
| -------------------------- | --------------------: | -----------------: |
| Small messages per second  |                44,200 |             40,500 |
| CPU per small message sent |                 45 µs |              51 µs |
| Sender's main thread busy  |                    4% |               100% |
| Large transfers            |              65 MiB/s |           65 MiB/s |
| Round-trip time            |               0.13 ms |            0.12 ms |
| CPU per round trip         |                128 µs |             100 µs |

To run the comparison yourself:

```sh
npm run benchmark:compare -- --library=webrtc-node --scenario=rate
npm install --no-save node-datachannel
npm run benchmark:compare -- --library=node-datachannel --scenario=rate
```

Scenarios are `rate`, `text`, `bulk`, and `pingpong`. Results depend on the
machine and workload.

## Documentation

- [Architecture](docs/architecture.md): native threading, send backlog, and
  event dispatch
- [Conformance](docs/conformance.md): the selected WPT suite and how it runs
- [Divergences](docs/divergences.md): where behavior intentionally differs
  from browsers
- [Nonstandard extensions](docs/nonstandard.md): libdatachannel-specific APIs
- [Development](docs/development.md): building, testing, and benchmarking
- [Changelog](CHANGELOG.md)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Report security issues privately as
described in [SECURITY.md](SECURITY.md).

## License

[Mozilla Public License 2.0](LICENSE).
