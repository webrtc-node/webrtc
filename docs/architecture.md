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
- media stream, track, sender, receiver, and transceiver identity and lifecycle
- RTP capability, codec-preference negotiation, and parameter dictionary shaping
- negotiation-needed and `track` event task timing
- read-only `RTCStatsReport` filtering and standardized dictionary shaping

Keep browser-compatible behavior in JavaScript unless native behavior is
required for correctness.

The typed `nonstandard` namespace is the boundary for the small set of
libdatachannel-specific operations exposed for advanced integrations. It does
not change the standard facade and does not expose the complete native API.
Application-supplied encoded RTP/RTCP source and sink adapters live here so
their track, sender, callback, and teardown state stays under the same package
owner as the native backend.

## Type Declarations

`packages/webrtc/index.d.ts` describes the public API. Any runtime API change
must update the declarations and `packages/webrtc/scripts/check-api-surface.js`
as needed.

## Scope Boundary

The public scope includes peer connections, data channels, encoded media tracks,
RTP sender/receiver/transceiver objects, and standards-shaped statistics.
Capture devices, rendering, codec processing, RTP header generation, and DTMF
are not implemented.

`nonstandard.EncodedMediaSource` and `nonstandard.EncodedMediaSink` exchange
complete RTP/RTCP packets behind standard `MediaStreamTrack` values. Standard
stats access is `getStats()` on the peer connection or RTP endpoint; no
companion package is required for either workflow.
