import { diffStatsReports, RTCStatsSampler } from "@webrtc-node/stats";
import type { RTCDataChannelStats, RTCTransportStats } from "@webrtc-node/webrtc";
import { RTCPeerConnection } from "@webrtc-node/webrtc";

const peer = new RTCPeerConnection();
const sampler = new RTCStatsSampler(peer, { interval: 100 });
async function inspect() {
  const first = await peer.getStats();
  const second = await peer.getStats();
  for (const entry of second.values()) {
    if (entry.type === "data-channel") {
      const dataChannel: RTCDataChannelStats = entry;
      dataChannel.messagesSent;
    } else if (entry.type === "transport") {
      const transport: RTCTransportStats = entry;
      transport.dtlsState;
    }
  }
  diffStatsReports(first, second).get("transport-0");
  sampler
    .start(({ report }) => {
      report.size;
    })
    .stop();
}
void inspect();
