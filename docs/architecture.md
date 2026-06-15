# Architecture

The package is intentionally split between a thin native layer and a
browser-compatible JavaScript facade.

## Native Addon

`src/native/addon.cc` owns `libdatachannel` handles and exposes a small
Node-API surface to JavaScript. It must remain ABI-stable and must not use
direct V8 or NAN APIs.

Native callbacks never call JavaScript directly from `libdatachannel` callback
threads. They dispatch back to Node through a thread-safe function.

The native ICE UDP mux wrapper follows the same rule and unregisters its
callback before releasing the dispatcher. Environment cleanup closes remaining
listeners before libdatachannel global cleanup.

## JavaScript Facade

`lib/index.js` implements the W3C-facing behavior:

- WebIDL-style conversions
- DOM-style `EventTarget` behavior
- promise timing and operations-chain behavior
- WebRTC state mapping
- `DOMException`-style errors
- data-channel message, open, close, and buffered amount semantics

Keep browser-compatible behavior in JavaScript unless native behavior is
required for correctness.

The typed `nonstandard` namespace is the boundary for the small set of
libdatachannel-specific operations required by WebRTC Direct. It does not
change the standard facade and does not expose the complete native API.

## Type Declarations

`index.d.ts` describes the public API. Any runtime API change must update the
declarations and `scripts/check-api-surface.js` as needed.

## Scope Boundary

The public scope is `RTCPeerConnection` plus `RTCDataChannel` for the WebRTC
data-channel profile. Media tracks, transceivers, RTP sender/receiver APIs,
stats, DTMF, and capture devices are not implemented.
