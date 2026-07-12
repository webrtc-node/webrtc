# @webrtc-node/media

Optional encoded RTP packet I/O for standard `MediaStreamTrack` values from
`@webrtc-node/webrtc`.

```js
const { EncodedMediaSource } = require("@webrtc-node/media");
const { RTCPeerConnection } = require("@webrtc-node/webrtc");

const peer = new RTCPeerConnection();
const source = new EncodedMediaSource({
  kind: "video",
  codec: { mimeType: "video/VP8", payloadType: 96 },
  ssrc: 42,
});
peer.addTrack(source.track);
source.send(rtpPacket);
```

Normal negotiation uses `RTCPeerConnection.addTrack()`, RTP sender/receiver/transceiver objects,
and `track` events from `@webrtc-node/webrtc`. `EncodedMediaSource` is only an application-supplied
packet source. `EncodedMediaSink` can subscribe to complete RTP/RTCP packets from a received
`MediaStreamTrack`.

The package does not capture devices, encode or decode media, render media, generate RTP headers,
or pace packets. Packet validity, sequence numbers, timestamps, SSRC consistency, pacing, and codec
compatibility remain application responsibilities. Supported audio codecs are Opus, PCMA, PCMU,
G722, and AAC; supported video codecs are H264, H265, VP8, VP9, and AV1.

Incoming packets are dispatched on the Node event loop. The native queue drops packets above its
documented 1024-packet pending limit to keep callback memory bounded.

Cloned tracks share the encoded source as W3C tracks share a media source. Stopping one track does
not close the source while another clone remains live. Closing `EncodedMediaSource` explicitly
ends every live clone and prevents further sends. The peer connection retains ownership of the
native media track until peer teardown.
