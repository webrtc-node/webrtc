# @webrtc-node/media

Encoded RTP and RTCP tracks for `@webrtc-node/webrtc` peer connections.

```js
const { MediaSession } = require("@webrtc-node/media");
const { RTCPeerConnection } = require("@webrtc-node/webrtc");

const peer = new RTCPeerConnection();
const media = new MediaSession(peer);
const video = media.addTrack({
  kind: "video",
  mid: "video",
  direction: "sendonly",
  codec: { mimeType: "video/VP8", payloadType: 96 },
  ssrc: 42,
});

video.send(rtpPacket);
```

The package is for applications that already encode, packetize, and time RTP media. It negotiates
audio and video m-lines, transports complete RTP/RTCP packets through DTLS-SRTP, and emits received
packets as `message` events.

It does not capture devices, encode/decode media, generate RTP headers, implement browser
`MediaStreamTrack`, or expose transceivers and RTP sender/receiver objects. Packet validity,
sequence numbers, timestamps, SSRC consistency, pacing, and codec compatibility are application
responsibilities.

Incoming packets are dispatched to JavaScript in event-loop batches. When more than 1024 track
packets are pending because JavaScript is not consuming events, newer packets are dropped to keep
native callback memory bounded.

Create matching tracks on both peers before applying session descriptions. A sender's `sendonly`
track should use the same mid, codec, and payload type as the receiver's `recvonly` track. Supported
audio codecs are Opus, PCMA, PCMU, G722, and AAC; supported video codecs are H264, H265, VP8, VP9,
and AV1.
