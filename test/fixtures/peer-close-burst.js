"use strict";

const assert = require("node:assert/strict");
const { fork } = require("node:child_process");
const { once } = require("node:events");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

const PACKETS = 128;
const MARKER = PACKETS;

async function gather(peer) {
  await peer.setLocalDescription();
  while (peer.iceGatheringState !== "complete") await once(peer, "icegatheringstatechange");
  return peer.localDescription.toJSON();
}

async function receive(packagePath) {
  const { RTCPeerConnection } = require(packagePath);
  const peer = new RTCPeerConnection();
  const packets = [];
  let reported = false;
  let timer;
  function report(remoteClosed) {
    if (reported) return;
    reported = true;
    clearTimeout(timer);
    process.send({ packets, remoteClosed });
  }
  process.on("disconnect", () => {
    clearTimeout(timer);
    peer.close();
  });
  peer.ondatachannel = ({ channel }) => {
    channel.binaryType = "arraybuffer";
    channel.onmessage = ({ data }) => packets.push(new DataView(data).getUint32(0, true));
    channel.onclose = () => report(true);
  };
  const [offer] = await once(process, "message");
  await peer.setRemoteDescription(offer);
  process.send(await gather(peer));
  await once(process, "message");
  timer = setTimeout(() => report(false), 3000);
  process.send("ready");
}

async function runBurst(packagePath, close = "peer", packetBytes = 256) {
  const { RTCPeerConnection } = require(packagePath);
  const peer = new RTCPeerConnection();
  const channel = peer.createDataChannel("ordered");
  const receiver = fork(__filename, ["--receiver", packagePath], { windowsHide: true });
  const exited = once(receiver, "exit").then(([code, signal]) => ({ code, signal }));
  let timer;
  let closeStarted;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("Cross-process burst timed out")), 20000);
  });
  const waitForMessage = () =>
    Promise.race([
      once(receiver, "message").then(([value]) => value),
      exited.then(({ code, signal }) => {
        throw new Error(`Receiver exited during exchange (${code ?? signal})`);
      }),
      timeout,
    ]);
  let result;
  try {
    receiver.send(await gather(peer));
    const answer = await waitForMessage();
    await peer.setRemoteDescription(answer);
    if (channel.readyState !== "open") await Promise.race([once(channel, "open"), timeout]);
    const ready = waitForMessage();
    receiver.send("start");
    assert.equal(await ready, "ready");

    const report = waitForMessage();
    let accepted = 0;
    const rejections = [];
    const payload = Buffer.alloc(packetBytes, 0x5a);
    for (let index = 0; index <= MARKER; index++) {
      payload.writeUInt32LE(index);
      try {
        channel.send(payload);
        accepted++;
      } catch (error) {
        rejections.push({ index, name: error.name, message: error.message });
      }
    }
    closeStarted = performance.now();
    (close === "peer" ? peer : channel).close();
    const closeCallMs = performance.now() - closeStarted;
    const immediateState = {
      peer: peer.connectionState,
      signaling: peer.signalingState,
      channel: channel.readyState,
    };
    const { packets, remoteClosed } = await report;
    result = {
      close,
      accepted,
      rejections,
      packets,
      marker: packets.includes(MARKER),
      ordered: packets.every((id, index) => index === 0 || packets[index - 1] < id),
      remoteClosed,
      closeCallMs,
      remoteReportMs: performance.now() - closeStarted,
      immediateState,
    };
  } finally {
    clearTimeout(timer);
    peer.close();
    if (receiver.connected) receiver.disconnect();
    const kill = setTimeout(() => receiver.kill(), 5000);
    try {
      const { code, signal } = await exited;
      assert.deepEqual({ code, signal }, { code: 0, signal: null });
    } finally {
      clearTimeout(kill);
    }
  }
  return { ...result, receiverExitMs: performance.now() - closeStarted };
}

if (require.main === module) {
  const [, , target, argument, size] = process.argv;
  const operation =
    target === "--receiver"
      ? receive(argument)
      : (async () => {
          const packagePath = path.resolve(target);
          for (let repeat = 0; repeat < Number(argument || 3); repeat++) {
            for (const close of ["peer", "channel"]) {
              const result = await runBurst(packagePath, close, Number(size || 256));
              console.log(JSON.stringify(result));
              await delay(20);
            }
          }
        })();
  operation.catch((error) => {
    console.error(error);
    process.exitCode = 1;
    if (process.connected) process.disconnect();
  });
}

module.exports = { runBurst, PACKETS, MARKER };
