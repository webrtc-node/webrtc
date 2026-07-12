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

It does not invent unavailable metrics. Current core reports contain reliable encoded RTP packet
and byte counters after RTP flow, plus aggregate transport byte counters supplied by
libdatachannel. Codec processing, jitter, loss, bandwidth estimation, media-source, playout, and
remote RTP reports are omitted until the backend can supply them reliably.
