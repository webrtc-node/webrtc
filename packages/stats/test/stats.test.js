"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { RTCPeerConnection } = require("@webrtc-node/webrtc");
const { StatsSampler, clear, delta, snapshot } = require("..");

function waitFor(target, type, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), timeout);
    target.addEventListener(
      type,
      (event) => {
        clearTimeout(timer);
        resolve(event);
      },
      { once: true },
    );
  });
}

async function negotiate(offerer, answerer) {
  const offererCandidates = [];
  const answererCandidates = [];
  offerer.onicecandidate = (event) => {
    if (!event.candidate) return;
    if (answerer.remoteDescription) answerer.addIceCandidate(event.candidate).catch(() => {});
    else offererCandidates.push(event.candidate);
  };
  answerer.onicecandidate = (event) => {
    if (!event.candidate) return;
    if (offerer.remoteDescription) offerer.addIceCandidate(event.candidate).catch(() => {});
    else answererCandidates.push(event.candidate);
  };
  await offerer.setLocalDescription(await offerer.createOffer());
  await answerer.setRemoteDescription(offerer.localDescription);
  for (const candidate of offererCandidates.splice(0)) await answerer.addIceCandidate(candidate);
  await answerer.setLocalDescription(await answerer.createAnswer());
  await offerer.setRemoteDescription(answerer.localDescription);
  for (const candidate of answererCandidates.splice(0)) await offerer.addIceCandidate(candidate);
}

test("snapshot returns immutable transport counters", () => {
  const peer = new RTCPeerConnection();
  try {
    const stats = snapshot(peer);
    assert.equal(stats.type, "transport");
    assert.equal(stats.bytesSent, 0);
    assert.equal(stats.bytesReceived, 0);
    assert.equal(stats.roundTripTime, null);
    assert.equal(Object.isFrozen(stats), true);
    clear(peer);
  } finally {
    peer.close();
  }
});

test("delta computes non-negative rates and rejects invalid time order", () => {
  const first = { timestamp: 1000, bytesSent: 10, bytesReceived: 20 };
  const second = { timestamp: 2000, bytesSent: 110, bytesReceived: 220 };
  assert.deepEqual(delta(first, second), {
    timestamp: 2000,
    elapsedMs: 1000,
    bytesSent: 100,
    bytesReceived: 200,
    sendBitrate: 800,
    receiveBitrate: 1600,
  });
  assert.throws(() => delta(second, first), RangeError);
  assert.throws(() => delta({ ...first, bytesSent: Number.NaN }, second), /previous.bytesSent/);
});

test("StatsSampler validates lifecycle", () => {
  const peer = new RTCPeerConnection();
  try {
    const sampler = new StatsSampler(peer, { interval: 10 });
    assert.equal(sampler.sample().delta, null);
    sampler.start(() => {});
    assert.throws(() => sampler.start(() => {}), /already running/);
    sampler.stop();
  } finally {
    peer.close();
  }
});

test("APIs reject foreign peer connection values", () => {
  assert.throws(() => snapshot({}), TypeError);
  assert.throws(() => new StatsSampler({}), TypeError);
});

test("snapshot reports connected SCTP traffic and endpoint context", async () => {
  const offerer = new RTCPeerConnection();
  const answerer = new RTCPeerConnection();
  try {
    const incoming = waitFor(answerer, "datachannel");
    const outgoingChannel = offerer.createDataChannel("stats");
    await negotiate(offerer, answerer);
    const incomingChannel = (await incoming).channel;
    if (outgoingChannel.readyState !== "open") await waitFor(outgoingChannel, "open");
    const message = waitFor(incomingChannel, "message");
    outgoingChannel.send("stats payload");
    await message;

    const current = snapshot(offerer);
    assert.ok(current.bytesSent > 0);
    assert.ok(current.localAddress);
    assert.ok(current.remoteAddress);
    assert.ok(current.localCandidate);
    assert.ok(current.remoteCandidate);
    assert.equal(current.connectionState, "connected");
  } finally {
    offerer.close();
    answerer.close();
  }
});
