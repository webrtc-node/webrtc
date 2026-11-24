"use strict";

// A receiving peer in a worker thread that attaches its message consumer only
// after `consumerDelayMs`, so messages arrive before anyone listens.
const { parentPort, workerData } = require("node:worker_threads");
const { RTCPeerConnection } = require("../..");

const peer = new RTCPeerConnection();
const received = [];
peer.onicecandidate = ({ candidate }) => {
  if (candidate) parentPort.postMessage({ candidate: candidate.toJSON() });
};
peer.ondatachannel = ({ channel }) => {
  setTimeout(() => {
    channel.addEventListener("message", ({ data }) => {
      received.push(data);
      if (received.length === workerData.expected) {
        parentPort.postMessage({ received });
        peer.close();
      }
    });
  }, workerData.consumerDelayMs);
};
parentPort.on("message", async (message) => {
  if (message.offer) {
    await peer.setRemoteDescription(message.offer);
    await peer.setLocalDescription();
    parentPort.postMessage({ answer: peer.localDescription.toJSON() });
  } else if (message.candidate) {
    await peer.addIceCandidate(message.candidate).catch(() => {});
  } else if (message.close) {
    peer.close();
    parentPort.close();
  }
});
