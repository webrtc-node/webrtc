"use strict";

const path = require("node:path");
const { createRequire } = require("node:module");

const requireInstalled = createRequire(path.join(process.cwd(), "package.json"));
const { EncodedMediaSource } = requireInstalled("@webrtc-node/media");
const { RTCStatsSampler } = requireInstalled("@webrtc-node/stats");
const { RTCPeerConnection } = requireInstalled("@webrtc-node/webrtc");

async function main() {
  const peer = new RTCPeerConnection();
  const source = new EncodedMediaSource({
    kind: "video",
    codec: { mimeType: "video/VP8", payloadType: 96 },
  });
  try {
    const sender = peer.addTrack(source.track);
    if (sender.track !== source.track) throw new Error("packed media track identity mismatch");
    const { report } = await new RTCStatsSampler(peer).sample();
    if (!report.has("peer-connection")) {
      throw new Error("packed stats report is missing peer-connection stats");
    }
    console.log("Workspace packages loaded and interoperated");
  } finally {
    source.close();
    peer.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
