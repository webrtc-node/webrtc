"use strict";

// Two peers in separate processes, as in a real deployment. The parent process
// creates the offer; a forked child answers. Descriptions and ICE candidates
// travel over the IPC channel, which stands in for your signaling server.
//
//   node examples/two-processes.js

const { fork } = require("node:child_process");
const { RTCPeerConnection } = require("..");

function connect(peer, signaling) {
  peer.addEventListener("icecandidate", ({ candidate }) => {
    if (candidate) signaling.send({ candidate: candidate.toJSON() });
  });
  signaling.on("message", async ({ description, candidate }) => {
    if (description) {
      await peer.setRemoteDescription(description);
      if (description.type === "offer") {
        await peer.setLocalDescription();
        signaling.send({ description: peer.localDescription.toJSON() });
      }
    } else if (candidate) {
      await peer.addIceCandidate(candidate);
    }
  });
}

if (process.argv[2] === "answerer") {
  const peer = new RTCPeerConnection();
  connect(peer, process);
  peer.addEventListener("datachannel", ({ channel }) => {
    channel.addEventListener("message", ({ data }) => channel.send(`echo: ${data}`));
  });
  process.on("disconnect", () => peer.close());
} else {
  const child = fork(__filename, ["answerer"]);
  const peer = new RTCPeerConnection();
  connect(peer, child);

  const channel = peer.createDataChannel("chat");
  channel.addEventListener("open", () => channel.send("hello from the parent process"));
  channel.addEventListener("message", ({ data }) => {
    console.log(`received: ${data}`);
    peer.close();
    child.disconnect();
  });

  peer
    .setLocalDescription()
    .then(() => child.send({ description: peer.localDescription.toJSON() }))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
