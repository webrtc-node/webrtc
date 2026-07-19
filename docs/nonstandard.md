# Nonstandard libdatachannel Extensions

The `nonstandard` namespace exposes a small, typed set of libdatachannel
capabilities for advanced integrations. These APIs are
implementation-specific, may change between minor releases, and are not part of
this package's W3C compatibility claims.

`getNativePeerConnection()` validates package identity and closed-peer state
before exposing a limited native track/transport surface. It is an advanced
escape hatch, not a cross-package integration contract.

## Encoded RTP and RTCP

Applications that already produce packetized media can create a standard track
without a browser capture source:

```js
const { nonstandard, RTCPeerConnection } = require("@webrtc-node/webrtc");

const pc = new RTCPeerConnection();
const source = new nonstandard.EncodedMediaSource({
  kind: "video",
  codec: { mimeType: "video/VP8", payloadType: 96 },
  ssrc: 42,
});

pc.addTrack(source.track);
source.send(rtpPacket);
```

`EncodedMediaSource.track` is a standard `MediaStreamTrack` accepted by
`addTrack()`, `addTransceiver()`, and `replaceTrack()`. An
`EncodedMediaSink` subscribes to complete RTP/RTCP packets from a received
standard track:

```js
pc.addEventListener("track", ({ track }) => {
  const sink = new nonstandard.EncodedMediaSink(track);
  sink.addEventListener("packet", ({ data }) => consumePacket(data));
});
```

The same source track may be attached to senders on multiple peer connections.
`source.send(packet)` fans one packet out to every attached, open sender and
returns `true` when at least one sender accepts it. It returns `false` while
attached senders are still connecting, cannot send in their negotiated
direction, or have their sole RTP encoding set to `active: false`; RTCP is not
suppressed by the encoding gate. Sending without any attached sender throws
`InvalidStateError`. `maxPacketSize` is the smallest limit across the attached
senders.

Removing, replacing, stopping, or closing one sender detaches only that native
transport binding. It does not close a source still used by another peer
connection. The encoded adapter does not pace, transcode, scale, generate key
frames, or implement multiple sending encodings.

The adapters do not capture devices, encode or decode media, render media,
generate RTP headers, or pace packets. Packet validity, sequence numbers,
timestamps, SSRC consistency, pacing, and codec compatibility are application
responsibilities. Supported audio codecs are Opus, PCMA, PCMU, G722, and AAC;
supported video codecs are H264, H265, VP8, VP9, and AV1.

The source's declared codec and payload type are fixed because packet bytes are
not rewritten. Offer or answer generation fails with `OperationError` when
codec preferences or a remote offer cannot preserve that mapping. A committed
answer's payload mappings are retained if that answerer later creates an offer.

Cloned tracks share their encoded source. Stopping one clone does not close the
source while another clone remains live; `source.close()` ends every live clone
and dispatches one `close` event.
Incoming packets are dispatched on the Node event loop, and the native pending
queue is bounded at 1024 packets.

## UDP mux

```js
const { nonstandard } = require("@webrtc-node/webrtc");

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
const { RTCPeerConnection, nonstandard } = require("@webrtc-node/webrtc");

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
