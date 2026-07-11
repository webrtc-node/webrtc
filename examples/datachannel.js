"use strict";

const { RTCPeerConnection } = require("@webrtc-node/webrtc");

async function main() {
  const pc1 = new RTCPeerConnection();
  const pc2 = new RTCPeerConnection();
  let timeout;

  const cleanup = () => {
    if (timeout) clearTimeout(timeout);
    pc1.close();
    pc2.close();
  };

  pc1.addEventListener("icecandidate", ({ candidate }) => {
    if (candidate) pc2.addIceCandidate(candidate).catch(console.error);
  });
  pc2.addEventListener("icecandidate", ({ candidate }) => {
    if (candidate) pc1.addIceCandidate(candidate).catch(console.error);
  });

  pc2.addEventListener("datachannel", ({ channel }) => {
    channel.addEventListener("message", ({ data }) => {
      console.log(`pc2 received: ${data}`);
      channel.send(`echo: ${data}`);
    });
  });

  const channel = pc1.createDataChannel("chat");
  channel.addEventListener("open", () => {
    channel.send("hello from Node");
  });
  channel.addEventListener("message", ({ data }) => {
    console.log(`pc1 received: ${data}`);
    cleanup();
  });

  const offer = await pc1.createOffer();
  await pc1.setLocalDescription(offer);
  await pc2.setRemoteDescription(pc1.localDescription);

  const answer = await pc2.createAnswer();
  await pc2.setLocalDescription(answer);
  await pc1.setRemoteDescription(pc2.localDescription);

  timeout = setTimeout(() => {
    cleanup();
    process.exitCode = 1;
    console.error("Timed out waiting for data-channel echo");
  }, 10000).unref();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
