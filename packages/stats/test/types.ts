import { clear, delta, StatsSampler, snapshot } from "@webrtc-node/stats";
import { RTCPeerConnection } from "@webrtc-node/webrtc";

const peer = new RTCPeerConnection();
const first = snapshot(peer);
const second = snapshot(peer);
const change = delta(first, second);
change.sendBitrate.toFixed();
clear(peer);
new StatsSampler(peer, { interval: 100 }).start(({ current }) => current.bytesSent).stop();
