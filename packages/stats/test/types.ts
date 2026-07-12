import { diffStatsReports, RTCStatsSampler } from "@webrtc-node/stats";
import { RTCPeerConnection } from "@webrtc-node/webrtc";

const peer = new RTCPeerConnection();
const sampler = new RTCStatsSampler(peer, { interval: 100 });
async function inspect() {
  const first = await peer.getStats();
  const second = await peer.getStats();
  diffStatsReports(first, second).get("transport-0");
  sampler
    .start(({ report }) => {
      report.size;
    })
    .stop();
}
void inspect();
