# Changelog

Notable changes to `@webrtc-node/webrtc`. Each release links to its GitHub
release notes, which include the validation evidence for that version. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.3.0] - 2026-11-24

### Changed

- Prebuilt binaries ship as per-platform npm packages, such as
  `@webrtc-node/webrtc-linux-x64-glibc`, installed as optional dependencies.
  The package no longer has an install script or downloads from GitHub, so it
  installs where package managers block install scripts or GitHub is
  unreachable.
- `detect-libc` is the only runtime dependency; an install pulls 3 packages
  instead of 41.
- To use a binary you built yourself, set `WEBRTC_NODE_NATIVE_PATH`;
  `npm install --build-from-source` no longer applies.
- The implementation is written in strict TypeScript and published as
  compiled JavaScript under `dist/` instead of `lib/`. The package entry points
  are unchanged; `index.d.ts` is checked against the implementation at build
  time.

### Added

- A Linux arm64 musl prebuild, so every supported target has a binary.
- TypeScript: `addEventListener()` on peer connections and data channels types
  the event for each known event name.

### Fixed

- `RTCPeerConnection.close()` no longer fires `connectionstatechange` or
  `iceconnectionstatechange`, as the W3C specification requires.
- A remote peer closing the connection is reported as `failed` and
  `disconnected` instead of the local-only `closed` state.
- `bufferedamountlow` fires as soon as the native send backlog drains instead
  of up to a polling interval later.
- Several peer connections flooding sends at once no longer fail with
  `Native send queue is full`; each data channel has its own bounded backlog.
- The same-process pairing registry stays bounded for peers that renegotiate
  repeatedly.
- `createDataChannel()` and `setLocalDescription()` convert their arguments as
  WebIDL requires: dictionary members are read once in order, `null` numeric
  members such as `maxRetransmits: null` mean `0` rather than unset, and labels
  and protocols become well-formed strings.
- `setLocalDescription({})` and `{ type: "pranswer" }` without SDP use the
  current last-created offer or answer, and a cached offer created before the
  first data channel is replaced by one with a data section.
- `new RTCDataChannel()` throws `TypeError`, since only peer connections create
  data channels.
- Closing a peer connection or data channel discards messages and native
  events still queued for it.

### Performance

- Native sends drain each data channel's backlog in bounded turns instead of
  one queued job per message, and received messages cross into JavaScript as
  compact batches. Small-message throughput rises about 10% with about 12% less
  CPU per message and a third less receiver event-loop time.
- Peer connections created without certificates take one pre-generated on a
  background thread, halving the JavaScript-thread cost of creating a
  connection.
- Peer teardown reuses worker threads instead of starting one per closed
  connection, halving the JavaScript time to close many connections.

## [0.2.6] - 2026-11-20

### Added

- `WEBRTC_NODE_LIBDATACHANNEL_THREAD_LIMIT` caps libdatachannel's shared worker
  pool; automatic sizing applies when it is unset.
- `npm run benchmark:cpu` compares configurations across separate processes.

## [0.2.5] - 2026-11-19

### Fixed

- A data-channel burst followed by `RTCPeerConnection.close()` in the same turn
  is no longer dropped; admitted sends get up to 50 ms to reach SCTP.
- `signalingstatechange` fires from the committed local-description operation
  before its promise resolves.
- Messages already queued for JavaScript are delivered before a remote channel
  error or close.
- Rolled-back offers stay cleared when a late native notification arrives.

0.2.4 was tagged but not published.

## [0.2.3] - 2026-11-19

### Changed

- Native sends run on a per-environment worker with owned payload copies, FIFO
  send and close ordering, and bounded admission.
- Signaling and ICE operations are serialized with argument snapshots.

### Fixed

- Native resource lifetime during close, garbage collection, failed
  construction, and Worker termination.
- Configuration iterable conversion, binary buffer handling, listener dispatch,
  and candidate validation, including control-character injection.

### Added

- Node.js 26 in CI and conformance.

## [0.2.2] - 2026-10-11

### Added

- Linux ARM64 glibc prebuilds.

### Changed

- libdatachannel pinned to v0.24.6, with DTLS startup, TURN deadlock, and ICE
  option parsing fixes.

### Fixed

- Windows ARM64 DTLS crashes.
- Debian Bullseye dependency downloads, keeping the glibc 2.31 baseline.

## [0.2.1] - 2026-06-28

### Fixed

- An unclosed `RTCPeerConnection` with a data channel no longer keeps the
  process alive.
- Late native `datachannel` callbacks after `close()` are dropped.

## [0.2.0] - 2026-06-16

### Added

- The typed `nonstandard` namespace: ICE UDP mux listener, pre-construction
  peer configuration, explicit local ICE credentials, remote fingerprint access,
  and PEM certificate import. See [docs/nonstandard.md](docs/nonstandard.md).

## [0.1.7] - 2026-06-14

### Fixed

- FIFO message delivery when a native batch arrives while older messages are
  queued for dispatch.
- Windows host-runtime compatibility, including Bun.

## [0.1.6] - 2026-06-12

### Changed

- Prebuilds are verified with SHA-256 checksums and target checks before an
  atomic install.

## [0.1.3] - 2026-06-09

### Fixed

- Use libdatachannel's default MTU.

## [0.1.2] - 2026-06-09

### Fixed

- `RTCIceServer.username` and `credential` are forwarded, so authenticated TURN
  servers work.

## [0.1.0] - 2026-06-01

First stable release, with native message batching, reduced copies on the
binary path, and the selected WPT profile as the conformance target.

[0.3.0]: https://github.com/webrtc-node/webrtc/releases/tag/v0.3.0
[0.2.6]: https://github.com/webrtc-node/webrtc/releases/tag/v0.2.6
[0.2.5]: https://github.com/webrtc-node/webrtc/releases/tag/v0.2.5
[0.2.3]: https://github.com/webrtc-node/webrtc/releases/tag/v0.2.3
[0.2.2]: https://github.com/webrtc-node/webrtc/releases/tag/v0.2.2
[0.2.1]: https://github.com/webrtc-node/webrtc/releases/tag/v0.2.1
[0.2.0]: https://github.com/webrtc-node/webrtc/releases/tag/v0.2.0
[0.1.7]: https://github.com/webrtc-node/webrtc/releases/tag/v0.1.7
[0.1.6]: https://github.com/webrtc-node/webrtc/releases/tag/v0.1.6
[0.1.3]: https://github.com/webrtc-node/webrtc/releases/tag/v0.1.3
[0.1.2]: https://github.com/webrtc-node/webrtc/releases/tag/v0.1.2
[0.1.0]: https://github.com/webrtc-node/webrtc/releases/tag/v0.1.0
