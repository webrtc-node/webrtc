# @webrtc-node/stats

Sampling utilities for the standard `RTCStatsReport` returned by `@webrtc-node/webrtc`.

```js
const { RTCStatsSampler } = require("@webrtc-node/stats");

const report = await peer.getStats();
for (const stat of report.values()) console.log(stat);

const sampler = new RTCStatsSampler(peer, { interval: 1000 });
sampler.start(({ report, delta }) => console.log(report, delta));
```

Normal statistics access is `RTCPeerConnection.getStats()`, `RTCRtpSender.getStats()`, or
`RTCRtpReceiver.getStats()` from `@webrtc-node/webrtc`. This package only schedules sampling and
computes non-negative numeric deltas for entries that retain the same standardized ID and type.
Only cumulative counters are subtracted; identifiers such as SSRC, stream ID, and data-channel ID
are never reported as deltas. A sampler stops after a sampling or callback failure and invokes the
optional `onError` handler. Without a handler it emits an `RTCStatsSamplerError` process warning.

It does not invent unavailable metrics. Current core reports contain reliable encoded RTP packet
and byte counters after RTP flow, aggregate transport byte counters supplied by libdatachannel,
and standard data-channel payload and lifecycle counters maintained at the WebRTC facade's exact
send, receive, open, and close transitions. Codec processing, jitter, loss, bandwidth estimation,
media-source, playout, and remote RTP reports are omitted until the backend can supply them
reliably.
