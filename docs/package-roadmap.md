# Package Boundaries and Roadmap

`@webrtc-node/webrtc` is the consumer-facing Node.js WebRTC runtime. Package
boundaries follow independent product and lifecycle ownership, not W3C domain
names. A standard media or statistics API does not move out of core merely
because it concerns media or stats.

## Current Decision

The intentional workspace contains one public package:

| Package | Decision | Reason |
| --- | --- | --- |
| `@webrtc-node/webrtc` | Retain | Owns the native backend and the complete applicable W3C object model. |
| `@webrtc-node/media` | Fold into core and remove | Its two encoded RTP/RTCP adapters share core track/native ownership, save no runtime dependency, and previously depended on an undocumented source-object contract. |
| `@webrtc-node/stats` | Remove | Its sampler and delta helper were small generic utilities over public `getStats()` results, not an independent WebRTC implementation or substantial diagnostics product. |

The former media adapter remains available as
`nonstandard.EncodedMediaSource` and `nonstandard.EncodedMediaSink` from
`@webrtc-node/webrtc`. These Node-specific adapters produce and consume
standard `MediaStreamTrack` values; they do not replace the W3C media object
model. Authoritative stats production, `getStats()`, and `RTCStatsReport` remain
in core. Generic polling and differencing are application concerns unless a
future diagnostics package has a broader independently maintainable purpose.

## Decision Criteria

`@webrtc-node/webrtc` is the only current package that satisfies all package
criteria:

- It has a distinct consumer purpose: a complete applicable W3C WebRTC runtime
  for Node.js.
- It owns the native addon, prebuild installation, JavaScript state machine,
  TypeScript declarations, WPT contract, and standardized statistics.
- Its package identity and release lifecycle already exist independently.
- Consumers know to install it for peer connections, data channels, media/RTP,
  transports, and stats.

The encoded packet adapter is real and optional, but a separate package did not
reduce dependencies: libdatachannel media support and the addon were already in
core. Its source attachment, replacement, clone, stop, callback, and teardown
behavior are the same lifecycle as `MediaStreamTrack` and `RTCRtpSender`.
Consolidation removes a cross-package private contract and keeps that state under
one owner. The broad `media` name also implied capture, devices, codecs, or
rendering that the adapter intentionally does not provide.

The former stats package used only public core APIs, which was good isolation,
but it was not substantial enough to justify the broad `stats` name or a second
release lifecycle. It owned no authoritative measurements, exporters, storage,
aggregation model, or diagnostics protocol. Removing it avoids implying that
ordinary W3C stats access requires another install.

## Core Ownership

`@webrtc-node/webrtc` owns:

- `RTCPeerConnection`, signaling, ICE, DTLS, SCTP, and data channels;
- `MediaStream`, `MediaStreamTrack`, RTP senders/receivers/transceivers, and
  negotiation lifecycle;
- transport objects, certificates, `getStats()`, `RTCStatsReport`, and every
  standardized dictionary backed by reliable data;
- the native addon, libdatachannel integration, prebuilds, and install fallback;
- Node-specific encoded RTP/RTCP source and sink adapters in the typed
  `nonstandard` namespace.

Browser capture, device selection, rendering, media elements, capture UI,
encoding, decoding, RTP packet construction, and pacing remain intentional
non-goals.

## Rejected Alternatives

- **Retain `@webrtc-node/media`.** Rejected because separation preserved no
  dependency boundary and made one native track lifecycle span two packages.
- **Rename it to `@webrtc-node/encoded-media`.** More accurate, but still only a
  thin wrapper over core-owned source state. A rename would add migration and
  release cost without creating independent ownership.
- **Retain or rename `@webrtc-node/stats`.** Rejected until there is a substantial
  diagnostics product using only public APIs, such as exporters, aggregation,
  persistence, or an observability integration with its own compatibility
  contract.
- **Create `@webrtc-node/native` or `@webrtc-node/test-utils`.** Rejected because
  there is no duplicated native consumer or independently reusable test surface
  that outweighs another package boundary.

## Future Package Rule

A new public package requires all of the following before it enters the
workspace:

- a real optional capability and an accurate, narrow name;
- an explicit stable integration contract using public APIs;
- meaningful dependency or complexity isolation;
- enough implementation, tests, and documentation to maintain independently;
- independent versioning, packaging, release, and published-install validation;
- no local-path dependency and no placeholder API.

If those conditions are not met, code stays in core, remains repository-internal,
or is not added. The package decision can be revisited when implementation facts
change; the old three-package target shape is not a compatibility requirement.

## Promotion Rule

The workspace is not ready merely because one package remains. Promotion still
requires applicable W3C behavior, focused local and strict remote WPT, native
ownership and teardown safety, reliable backend-supported stats, publish-safe
contents, prebuild validation, and CI/release compatibility. See
[Experimental Workspace Migration](workspace-migration.md) and
[libdatachannel Upstream Candidates](libdatachannel-upstream-candidates.md).
