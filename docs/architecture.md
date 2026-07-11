# Architecture

`@webrtc-node/webrtc` is intentionally split between a thin native layer and a
browser-compatible JavaScript facade.

## Native Addon

`packages/webrtc/src/native/addon.cc` owns `libdatachannel` handles and exposes a small
Node-API surface to JavaScript. It must remain ABI-stable and must not use
direct V8 or NAN APIs.

Native callbacks never call JavaScript directly from `libdatachannel` callback
threads. They dispatch back to Node through a thread-safe function.

The addon is built with libdatachannel media support and libSRTP. Encoded track
callbacks use the same dispatcher, batch packet delivery, and cap pending track
packets so a stalled JavaScript consumer cannot create an unbounded queue.

The native ICE UDP mux wrapper follows the same rule and unregisters its
callback before releasing the dispatcher. Environment cleanup closes remaining
listeners before libdatachannel global cleanup.

## JavaScript Facade

`packages/webrtc/lib/index.js` implements the W3C-facing behavior:

- WebIDL-style conversions
- DOM-style `EventTarget` behavior
- promise timing and operations-chain behavior
- WebRTC state mapping
- `DOMException`-style errors
- data-channel message, open, close, and buffered amount semantics

Keep browser-compatible behavior in JavaScript unless native behavior is
required for correctness.

The typed `nonstandard` namespace is the boundary for the small set of
libdatachannel-specific operations exposed for advanced integrations. It does
not change the standard facade and does not expose the complete native API.

## Type Declarations

`packages/webrtc/index.d.ts` describes the public API. Any runtime API change
must update the declarations and `packages/webrtc/scripts/check-api-surface.js`
as needed.

## Scope Boundary

The public scope is `RTCPeerConnection` plus `RTCDataChannel` for the WebRTC
data-channel profile. Media tracks, transceivers, RTP sender/receiver APIs,
stats, DTMF, and capture devices are not implemented.

`@webrtc-node/media` and `@webrtc-node/stats` are companion APIs rather than
members of this W3C-facing surface. They use the typed nonstandard native
capability to provide encoded RTP/RTCP transport and SCTP transport telemetry,
respectively. Their narrower contracts are documented in their package READMEs.
