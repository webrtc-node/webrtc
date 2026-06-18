# Nonstandard libdatachannel Extensions

The `nonstandard` namespace exposes a small, typed set of libdatachannel
capabilities for advanced integrations. These APIs are
implementation-specific, may change between minor releases, and are not part of
this package's W3C compatibility claims.

## UDP mux

```js
const { nonstandard } = require("@mertushka/webrtc-node");

const listener = new nonstandard.IceUdpMuxListener(9090, "0.0.0.0");
listener.onUnhandledStunRequest(({ ufrag, localUfrag, host, port }) => {
  // Route the request to the application that owns ufrag.
});

listener.close(); // stop() is an equivalent, idempotent alias
```

Callbacks are delivered on the Node event loop. Closing or garbage-collecting
the listener unregisters the native callback, and queued callbacks are
discarded after close.

## Peer connection configuration

Call `configurePeerConnection()` before an operation such as
`createDataChannel()`, `createOffer()`, or `setRemoteDescription()` initializes
the native peer connection.

```js
const { RTCPeerConnection, nonstandard } = require("@mertushka/webrtc-node");

const pc = new RTCPeerConnection({ certificates: [certificate] });
nonstandard.configurePeerConnection(pc, {
  enableIceUdpMux: true,
  maxMessageSize: 262144,
});
```

When `enableIceUdpMux` is true and an `IceUdpMuxListener` is active, the native
peer connection is constrained to the listener's UDP port so libdatachannel
joins the same mux socket. Without an active listener, libdatachannel chooses a
port from its default ICE range.

`disableFingerprintVerification` defaults to `false`. Set it to `true` only for
a protocol that authenticates the remote certificate fingerprint through a
separate, verified identity mechanism. Disabling DTLS fingerprint verification
without that mechanism permits an active peer to present an unexpected
certificate.

Explicit local ICE credentials can be prepared before the first local
description:

```js
nonstandard.setLocalIceCredentials(pc, {
  iceUfrag: "applicationSelectedUfrag",
  icePwd: "applicationSelectedPassword123",
});

const offer = await pc.createOffer();
await pc.setLocalDescription(offer);
```

The credentials are passed through libdatachannel's `LocalDescriptionInit`.
libjuice requires at least 4 characters for `iceUfrag`, at least 22 characters
for `icePwd`, and accepts only ASCII letters, digits, `+`, and `/`.
`createOffer()` and `createAnswer()` remain browser-shaped: they do not expose a
local description or advance the facade's signaling state. The standard
`setLocalDescription()` call still performs those visible transitions.

After DTLS connects, `nonstandard.getRemoteFingerprint(pc)` returns the actual
remote certificate fingerprint observed by libdatachannel, or `null` if no
fingerprint is available yet.

## Certificate import

```js
const certificate = nonstandard.importCertificate({
  certificatePem,
  privateKeyPem,
  expires: Date.now() + 24 * 60 * 60 * 1000,
});

const pc = new RTCPeerConnection({ certificates: [certificate] });
```

The certificate and private key are parsed and checked for a matching public
key. `expires` is an optional absolute millisecond timestamp and is capped at
the certificate's X.509 expiration. Private key material is retained in
internal weak storage and is not exposed as an `RTCCertificate` property.
