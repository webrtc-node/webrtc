"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const packageRoot = path.resolve(__dirname, "..");
function verifyCleanup(extraSource) {
  const script = `
  const { RTCPeerConnection } = require("@webrtc-node/webrtc");
  const { EncodedMediaSource } = require(${JSON.stringify(packageRoot)});
  const peer = new RTCPeerConnection();
  const source = new EncodedMediaSource({
    kind: "video",
    codec: { mimeType: "video/VP8", payloadType: 96 },
    ssrc: 42,
  });
  peer.addTrack(source.track);
  peer.createOffer();
  ${extraSource}
`;
  const child = spawnSync(process.execPath, ["-e", script], {
    cwd: packageRoot,
    encoding: "utf8",
    timeout: 10000,
    windowsHide: true,
  });

  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr);
}

verifyCleanup("");
verifyCleanup("peer.close();");
verifyCleanup("peer.close(); process.exit(0);");
console.log("Media environment cleanup verified");
