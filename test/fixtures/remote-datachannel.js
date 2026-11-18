"use strict";

const { Worker, isMainThread, parentPort, workerData } = require("node:worker_threads");
const { RTCPeerConnection, nonstandard } = require("../..");

function waitFor(target, type, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      target.removeEventListener(type, listener);
      reject(new Error(`Timed out waiting for ${type}`));
    }, timeout);
    function listener(event) {
      clearTimeout(timer);
      target.removeEventListener(type, listener);
      resolve(event);
    }
    target.addEventListener(type, listener);
  });
}

async function gatherDescription(peer) {
  await peer.setLocalDescription();
  while (peer.iceGatheringState !== "complete") await waitFor(peer, "icegatheringstatechange");
  return peer.localDescription.toJSON();
}

async function connectRemotePeer(options = {}) {
  const worker = new Worker(__filename, { workerData: { remoteDataChannel: true, ...options } });
  const peerConnection = new RTCPeerConnection();
  if (options.maxMessageSize) {
    nonstandard.configurePeerConnection(peerConnection, { maxMessageSize: options.maxMessageSize });
  }
  const channel = peerConnection.createDataChannel("remote-receiver", options.channelInit);
  const pending = new Map();
  let nextId = 0;
  let failure;
  let closing = false;
  function fail(error) {
    failure = error;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  }
  worker.on("error", fail);
  worker.on("exit", (code) => {
    if (!closing) fail(new Error(`Remote peer exited with status ${code}`));
  });
  worker.on("message", ({ id, value, error }) => {
    const request = pending.get(id);
    if (!request) return;
    pending.delete(id);
    if (error) request.reject(new Error(error));
    else request.resolve(value);
  });
  function request(command, parameters = {}) {
    if (failure) return Promise.reject(failure);
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Remote peer timed out during ${command}`));
      }, 15000);
      pending.set(id, {
        resolve(value) {
          clearTimeout(timer);
          resolve(value);
        },
        reject(error) {
          clearTimeout(timer);
          reject(error);
        },
      });
      worker.postMessage({ id, command, ...parameters });
    });
  }
  async function close() {
    closing = true;
    peerConnection.close();
    fail(new Error("Remote peer was closed"));
    await worker.terminate();
  }
  try {
    const description = await gatherDescription(peerConnection);
    const answer = await request("answer", { description });
    await peerConnection.setRemoteDescription(answer);
    if (channel.readyState !== "open") await waitFor(channel, "open");
    return { peerConnection, channel, request, close };
  } catch (error) {
    await close();
    throw error;
  }
}

if (!isMainThread && workerData?.remoteDataChannel) {
  const peer = new RTCPeerConnection();
  if (workerData.maxMessageSize) {
    nonstandard.configurePeerConnection(peer, { maxMessageSize: workerData.maxMessageSize });
  }
  const waiters = [];
  const messages = [];
  let count = 0;
  let bytes = 0;
  let binaryCount = 0;
  function snapshot() {
    return { count, bytes, messages };
  }
  peer.ondatachannel = ({ channel }) => {
    channel.binaryType = "arraybuffer";
    channel.onmessage = ({ data }) => {
      if (typeof data === "string") {
        bytes += Buffer.byteLength(data);
        if (workerData.record) messages.push(data);
      } else {
        bytes += data.byteLength;
        if (workerData.verifySequence && new DataView(data).getUint32(0, true) !== binaryCount) {
          throw new Error(`Received binary message out of order at ${binaryCount}`);
        }
        binaryCount++;
        if (workerData.record) messages.push(Array.from(new Uint8Array(data)));
      }
      count++;
      for (let index = waiters.length - 1; index >= 0; index--) {
        if (count < waiters[index].count) continue;
        parentPort.postMessage({ id: waiters[index].id, value: snapshot() });
        waiters.splice(index, 1);
      }
    };
  };
  parentPort.on("message", async ({ id, command, description, count: targetCount }) => {
    try {
      if (command === "answer") {
        await peer.setRemoteDescription(description);
        parentPort.postMessage({ id, value: await gatherDescription(peer) });
      } else if (command === "received") {
        if (count >= targetCount) parentPort.postMessage({ id, value: snapshot() });
        else waiters.push({ id, count: targetCount });
      } else {
        throw new Error(`Unknown remote peer command: ${command}`);
      }
    } catch (error) {
      parentPort.postMessage({ id, error: error.stack || String(error) });
    }
  });
}

module.exports = { connectRemotePeer };
