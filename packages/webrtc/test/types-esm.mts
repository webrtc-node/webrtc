import webrtc, { nonstandard, RTCPeerConnection, type RTCStatsReport } from "@webrtc-node/webrtc";

const namedPeer = new RTCPeerConnection();
const defaultPeer = new webrtc.RTCPeerConnection();
const constructorIdentity: typeof RTCPeerConnection = webrtc.RTCPeerConnection;
const source = new nonstandard.EncodedMediaSource({
  kind: "video",
  codec: { mimeType: "video/VP8", payloadType: 96 },
});

async function inspectDefaultExport(): Promise<RTCStatsReport> {
  return defaultPeer.getStats();
}

void constructorIdentity;
void inspectDefaultExport();
source.close();
namedPeer.close();
defaultPeer.close();
