"use strict";

// Streams 64 MiB through a data channel without unbounded buffering. The sender
// pauses when bufferedAmount passes a high-water mark and resumes on
// bufferedamountlow, the same pattern browsers use.
//
//   node examples/backpressure.js

const { RTCPeerConnection } = require("..");

const TOTAL_BYTES = 64 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
const HIGH_WATER = 4 * 1024 * 1024;
const LOW_WATER = 1024 * 1024;

async function main() {
  const sender = new RTCPeerConnection();
  const receiver = new RTCPeerConnection();
  sender.addEventListener("icecandidate", ({ candidate }) => {
    if (candidate) receiver.addIceCandidate(candidate);
  });
  receiver.addEventListener("icecandidate", ({ candidate }) => {
    if (candidate) sender.addIceCandidate(candidate);
  });

  const started = performance.now();
  let received = 0;
  receiver.addEventListener("datachannel", ({ channel }) => {
    channel.binaryType = "arraybuffer";
    channel.addEventListener("message", ({ data }) => {
      received += data.byteLength;
      if (received === TOTAL_BYTES) {
        const seconds = (performance.now() - started) / 1000;
        console.log(`received ${TOTAL_BYTES / 1048576} MiB in ${seconds.toFixed(2)} s`);
        sender.close();
        receiver.close();
      }
    });
  });

  const channel = sender.createDataChannel("file");
  channel.bufferedAmountLowThreshold = LOW_WATER;
  channel.addEventListener("open", async () => {
    const chunk = new Uint8Array(CHUNK_BYTES);
    for (let sent = 0; sent < TOTAL_BYTES; sent += CHUNK_BYTES) {
      if (channel.bufferedAmount > HIGH_WATER) {
        await new Promise((resolve) =>
          channel.addEventListener("bufferedamountlow", resolve, { once: true }),
        );
      }
      channel.send(chunk);
    }
  });

  await sender.setLocalDescription();
  await receiver.setRemoteDescription(sender.localDescription);
  await receiver.setLocalDescription();
  await sender.setRemoteDescription(receiver.localDescription);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
