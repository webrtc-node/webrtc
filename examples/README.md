# Examples

Run any example from a source checkout after `npm ci` and `npm run build`, or
change `require("..")` to `require("@webrtc-node/webrtc")` in your own project.

| Example | Shows |
| --- | --- |
| [datachannel.js](datachannel.js) | Offer/answer and an echo between two peers in one process |
| [two-processes.js](two-processes.js) | Peers in separate processes with signaling over IPC, as in a real deployment |
| [backpressure.js](backpressure.js) | Streaming 64 MiB with `bufferedAmount` and `bufferedamountlow` flow control |

The peers connect over local network interfaces. To connect across networks,
pass STUN or TURN servers in `iceServers`:

```js
const peer = new RTCPeerConnection({
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
});
```
