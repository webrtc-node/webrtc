"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");
const {
  MediaStream,
  MediaStreamTrack,
  RTCPeerConnection,
  RTCRtpReceiver,
  RTCRtpSender,
  RTCRtpTransceiver,
  nonstandard,
} = require("..");

function track(kind = "audio") {
  return nonstandard.createMediaStreamTrack({ kind, label: `encoded ${kind}` });
}

test("MediaStream maintains track identity and clones tracks", () => {
  const audio = track();
  const video = track("video");
  const stream = new MediaStream([audio]);
  assert.equal(stream.active, true);
  assert.deepEqual(stream.getAudioTracks(), [audio]);
  assert.equal(stream.getTrackById(audio.id), audio);
  stream.addTrack(audio);
  stream.addTrack(video);
  assert.deepEqual(stream.getTracks(), [audio, video]);
  stream.removeTrack(audio);
  assert.deepEqual(stream.getTracks(), [video]);
  const clone = stream.clone();
  assert.notEqual(clone.id, stream.id);
  assert.equal(clone.getVideoTracks()[0].kind, "video");
  assert.notEqual(clone.getVideoTracks()[0], video);
});

test("MediaStreamTrack has source-independent clone and stop state", () => {
  const original = track("video");
  assert.ok(original instanceof MediaStreamTrack);
  const clone = original.clone();
  original.stop();
  assert.equal(original.readyState, "ended");
  assert.equal(clone.readyState, "live");
});

test("addTransceiver exposes standard sender receiver and direction state", () => {
  const peer = new RTCPeerConnection();
  try {
    const transceiver = peer.addTransceiver("audio", { direction: "recvonly" });
    assert.ok(transceiver instanceof RTCRtpTransceiver);
    assert.ok(transceiver.sender instanceof RTCRtpSender);
    assert.ok(transceiver.receiver instanceof RTCRtpReceiver);
    assert.equal(transceiver.mid, null);
    assert.equal(transceiver.sender.track, null);
    assert.equal(transceiver.receiver.track.kind, "audio");
    assert.equal(transceiver.receiver.track.muted, true);
    assert.equal(transceiver.direction, "recvonly");
    assert.equal(transceiver.currentDirection, null);
    assert.deepEqual(peer.getTransceivers(), [transceiver]);
    assert.deepEqual(peer.getSenders(), [transceiver.sender]);
    assert.deepEqual(peer.getReceivers(), [transceiver.receiver]);
  } finally {
    peer.close();
  }
});

test("addTrack reuses eligible sender and removeTrack updates direction", () => {
  const peer = new RTCPeerConnection();
  try {
    const transceiver = peer.addTransceiver("audio", { direction: "recvonly" });
    const audio = track();
    const stream = new MediaStream([audio]);
    const sender = peer.addTrack(audio, stream);
    assert.equal(sender, transceiver.sender);
    assert.equal(sender.track, audio);
    assert.equal(transceiver.direction, "sendrecv");
    assert.throws(() => peer.addTrack(audio), { name: "InvalidAccessError" });
    peer.removeTrack(sender);
    assert.equal(sender.track, null);
    assert.equal(transceiver.direction, "recvonly");
  } finally {
    peer.close();
  }
});

test("removeTrack validates sender ownership and closed state", () => {
  const owner = new RTCPeerConnection();
  const other = new RTCPeerConnection();
  const sender = owner.addTrack(track());
  try {
    assert.throws(() => other.removeTrack(sender), { name: "InvalidAccessError" });
    assert.throws(() => other.removeTrack({}), TypeError);
    other.close();
    assert.throws(() => other.removeTrack(sender), { name: "InvalidStateError" });
  } finally {
    owner.close();
    other.close();
  }
});

test("media changes queue negotiationneeded", async () => {
  const peer = new RTCPeerConnection();
  try {
    const event = new Promise((resolve) => peer.addEventListener("negotiationneeded", resolve));
    peer.addTrack(track("video"));
    assert.equal((await event).type, "negotiationneeded");
  } finally {
    peer.close();
  }
});

async function negotiate(offerer, answerer) {
  await offerer.setLocalDescription(await offerer.createOffer());
  await answerer.setRemoteDescription(offerer.localDescription);
  await answerer.setLocalDescription(await answerer.createAnswer());
  await offerer.setRemoteDescription(answerer.localDescription);
}

test("negotiated direction and stopping follow answer state", async () => {
  const offerer = new RTCPeerConnection();
  const answerer = new RTCPeerConnection();
  try {
    const transceiver = offerer.addTransceiver(track("video"), { direction: "sendonly" });
    await negotiate(offerer, answerer);
    assert.equal(transceiver.currentDirection, "sendonly");
    assert.equal(answerer.getTransceivers()[0].currentDirection, "recvonly");
    transceiver.stop();
    assert.equal(transceiver.stopping, true);
    assert.equal(transceiver.stopped, false);
    await negotiate(offerer, answerer);
    assert.equal(transceiver.stopping, false);
    assert.equal(transceiver.stopped, true);
    assert.equal(transceiver.currentDirection, null);
    assert.deepEqual(offerer.getTransceivers(), []);
  } finally {
    offerer.close();
    answerer.close();
  }
});

test("getStats exposes peer connection stats and validates track selectors", async () => {
  const peer = new RTCPeerConnection();
  try {
    const report = await peer.getStats();
    assert.equal(report.get("peer-connection").type, "peer-connection");
    await assert.rejects(peer.getStats(track()), { name: "InvalidAccessError" });
    const receiverTrack = peer.addTransceiver("audio").receiver.track;
    peer.addTransceiver(receiverTrack);
    await assert.rejects(peer.getStats(receiverTrack), { name: "InvalidAccessError" });
  } finally {
    peer.close();
  }
});

test("closing an answerer with an unapplied media answer is safe", () => {
  const packageRoot = path.resolve(__dirname, "..");
  const script = `
    const { RTCPeerConnection } = require(${JSON.stringify(packageRoot)});
    (async () => {
      const offerer = new RTCPeerConnection();
      offerer.addTransceiver("audio", { direction: "recvonly" });
      const offer = await offerer.createOffer();
      await offerer.setLocalDescription(offer);
      const answerer = new RTCPeerConnection();
      await answerer.setRemoteDescription(offer);
      await answerer.createAnswer();
      answerer.close();
      offerer.close();
    })().catch((error) => { console.error(error); process.exitCode = 1; });
  `;
  const child = spawnSync(process.execPath, ["-e", script], {
    encoding: "utf8",
    timeout: 10000,
    windowsHide: true,
  });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr);
});
