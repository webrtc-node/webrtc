"use strict";

const path = require("node:path");
const { createRequire } = require("node:module");

const requireInstalled = createRequire(path.join(process.cwd(), "package.json"));
const { nonstandard, RTCPeerConnection } = requireInstalled("@webrtc-node/webrtc");
const { EncodedMediaSource } = nonstandard;

async function main() {
  const peer = new RTCPeerConnection();
  const source = new EncodedMediaSource({
    kind: "video",
    codec: { mimeType: "video/VP8", payloadType: 96 },
  });
  try {
    const sender = peer.addTrack(source.track);
    if (sender.track !== source.track) throw new Error("packed encoded track identity mismatch");
    const report = await peer.getStats();
    if (!report.has("peer-connection")) {
      throw new Error("packed core report is missing peer-connection stats");
    }
    console.log("Packed @webrtc-node/webrtc loaded encoded media and standard stats");
  } finally {
    source.close();
    peer.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
