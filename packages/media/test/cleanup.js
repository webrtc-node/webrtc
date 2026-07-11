"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const packageRoot = path.resolve(__dirname, "..");
function verifyCleanup(extraSource) {
  const script = `
  const { RTCPeerConnection } = require("@webrtc-node/webrtc");
  const { MediaSession } = require(${JSON.stringify(packageRoot)});
  const peer = new RTCPeerConnection();
  new MediaSession(peer).addTrack({
    kind: "video",
    mid: "video",
    codec: { mimeType: "video/VP8", payloadType: 96 },
    ssrc: 42,
  });
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
console.log("Media environment cleanup verified");
