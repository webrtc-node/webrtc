# @webrtc-node/stats

Transport statistics for `@webrtc-node/webrtc` peer connections.

```js
const { RTCPeerConnection } = require("@webrtc-node/webrtc");
const { StatsSampler, snapshot } = require("@webrtc-node/stats");

const peer = new RTCPeerConnection();
console.log(snapshot(peer));

const sampler = new StatsSampler(peer, { interval: 1000 });
sampler.start(({ current, delta }) => console.log(current, delta));
```

The package reports SCTP transport byte counters, RTT, endpoints, selected ICE candidates, and
connection state. Snapshots are immutable and `StatsSampler` derives interval bitrates.

This is not an implementation of the browser `RTCPeerConnection.getStats()` object graph. It does
not synthesize codec, RTP, media-source, certificate, or per-data-channel statistics that
libdatachannel does not expose. Counters are process-local and reset when the native peer is
destroyed or `clear()` is called.
