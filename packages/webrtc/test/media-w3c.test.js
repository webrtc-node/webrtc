"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");
const {
  MediaStream,
  MediaStreamTrack,
  MediaStreamTrackEvent,
  RTCPeerConnection,
  RTCDtlsTransport,
  RTCIceTransport,
  RTCRtpReceiver,
  RTCRtpSender,
  RTCRtpTransceiver,
  RTCTrackEvent,
  nonstandard,
} = require("..");

function track(kind = "audio") {
  return nonstandard.createMediaStreamTrack({ kind, label: `encoded ${kind}` });
}

test("media event constructors expose WebIDL arity and required dictionaries", () => {
  assert.equal(MediaStreamTrackEvent.length, 2);
  assert.equal(RTCTrackEvent.length, 2);
  assert.throws(() => new MediaStreamTrackEvent("addtrack"), TypeError);
  assert.throws(() => new MediaStreamTrackEvent("addtrack", null), TypeError);
  assert.throws(() => new RTCTrackEvent("track"), TypeError);
  assert.throws(() => new RTCTrackEvent("track", null), TypeError);
});

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

test("MediaStream copies track sets and reports track and active state changes", () => {
  const audio = track();
  const original = new MediaStream([audio]);
  const copy = new MediaStream(original);
  assert.notEqual(copy.id, original.id);
  assert.deepEqual(copy.getTracks(), [audio]);

  const stream = new MediaStream();
  const events = [];
  stream.addEventListener("active", () => events.push("active"));
  stream.addEventListener("addtrack", (event) => {
    assert.ok(event instanceof MediaStreamTrackEvent);
    assert.equal(event.track, audio);
    events.push("addtrack");
  });
  stream.addEventListener("inactive", () => events.push("inactive"));
  stream.addTrack(audio);
  assert.equal(stream.active, true);
  audio.stop();
  assert.equal(stream.active, false);
  assert.deepEqual(events, ["active", "addtrack", "inactive"]);

  let removedTrack = null;
  stream.addEventListener("removetrack", (event) => {
    removedTrack = event.track;
  });
  stream.removeTrack(audio);
  assert.equal(removedTrack, audio);
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

test("RTP endpoints expose the shared bundled DTLS and ICE transport", async () => {
  const offerer = new RTCPeerConnection();
  const answerer = new RTCPeerConnection();
  try {
    const transceiver = offerer.addTransceiver(track(), { direction: "sendonly" });
    offerer.createDataChannel("bundled");
    assert.equal(transceiver.sender.transport, null);
    await negotiate(offerer, answerer);

    const senderTransport = transceiver.sender.transport;
    const receiverTransport = answerer.getReceivers()[0].transport;
    assert.ok(senderTransport instanceof RTCDtlsTransport);
    assert.ok(senderTransport.iceTransport instanceof RTCIceTransport);
    assert.equal(senderTransport, offerer.sctp.transport);
    assert.equal(receiverTransport, answerer.sctp.transport);
    assert.notEqual(senderTransport.state, "new");

    const closed = waitFor(senderTransport, "statechange");
    offerer.close();
    await closed;
    assert.equal(senderTransport.state, "closed");
    assert.equal(senderTransport.iceTransport.state, "closed");
  } finally {
    offerer.close();
    answerer.close();
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

test("removeTrack negotiates inactive when neither endpoint can send", async () => {
  const peer = new RTCPeerConnection();
  const remote = new RTCPeerConnection();
  try {
    const localTrack = track();
    const transceiver = peer.addTransceiver(localTrack);
    await negotiate(peer, remote);
    assert.equal(transceiver.currentDirection, "sendonly");
    peer.removeTrack(transceiver.sender);
    await negotiate(peer, remote);
    assert.equal(transceiver.direction, "recvonly");
    assert.equal(transceiver.currentDirection, "inactive");
  } finally {
    peer.close();
    remote.close();
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

test("setStreams renegotiates only when the stream identity set changes", async () => {
  const peer = new RTCPeerConnection();
  const remote = new RTCPeerConnection();
  try {
    const initialNegotiation = new Promise((resolve) =>
      peer.addEventListener("negotiationneeded", resolve, { once: true }),
    );
    const transceiver = peer.addTransceiver("audio");
    const first = new MediaStream();
    const second = new MediaStream();
    await initialNegotiation;
    await negotiate(peer, remote);

    const changed = new Promise((resolve) =>
      peer.addEventListener("negotiationneeded", resolve, { once: true }),
    );
    transceiver.sender.setStreams(first, second);
    await changed;
    await negotiate(peer, remote);

    let duplicateEvent = false;
    peer.addEventListener("negotiationneeded", () => {
      duplicateEvent = true;
    });
    transceiver.sender.setStreams(second, first, second);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(duplicateEvent, false);

    peer.close();
    assert.throws(() => transceiver.sender.setStreams(first), { name: "InvalidStateError" });
  } finally {
    peer.close();
    remote.close();
  }
});

test("media changes after a local offer renegotiate when signaling becomes stable", async () => {
  const peer = new RTCPeerConnection();
  const remote = new RTCPeerConnection();
  try {
    const initialNegotiation = new Promise((resolve) =>
      peer.addEventListener("negotiationneeded", resolve, { once: true }),
    );
    const transceiver = peer.addTransceiver("audio");
    await initialNegotiation;
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    await remote.setRemoteDescription(offer);
    transceiver.sender.setStreams(new MediaStream());
    const renegotiation = new Promise((resolve) =>
      peer.addEventListener("negotiationneeded", resolve, { once: true }),
    );
    const answer = await remote.createAnswer();
    await remote.setLocalDescription(answer);
    await peer.setRemoteDescription(answer);
    await renegotiation;
  } finally {
    peer.close();
    remote.close();
  }
});

test("setStreams updates remote stream membership while preserving track identity", async () => {
  const peer = new RTCPeerConnection();
  const remote = new RTCPeerConnection();
  try {
    const localTrack = track();
    const first = new MediaStream([localTrack]);
    const second = new MediaStream([localTrack]);
    const sender = peer.addTrack(localTrack, first);
    const initialTrackEvent = waitFor(remote, "track");
    await negotiate(peer, remote);
    const initial = await initialTrackEvent;
    assert.deepEqual(
      initial.streams.map((stream) => stream.id),
      [first.id],
    );

    sender.setStreams(second);
    const updatedTrackEvent = waitFor(remote, "track");
    await negotiate(peer, remote);
    const updated = await updatedTrackEvent;
    assert.equal(updated.track, initial.track);
    assert.deepEqual(
      updated.streams.map((stream) => stream.id),
      [second.id],
    );
    assert.deepEqual(initial.streams[0].getTracks(), []);
    assert.deepEqual(updated.streams[0].getTracks(), [updated.track]);
  } finally {
    peer.close();
    remote.close();
  }
});

test("addTrack reuses a same-kind transceiver while a remote offer is pending", async () => {
  const offerer = new RTCPeerConnection();
  const answerer = new RTCPeerConnection();
  try {
    offerer.addTransceiver("audio");
    const offer = await offerer.createOffer();
    const applying = answerer.setRemoteDescription(offer);
    const sender = answerer.addTrack(track());
    await applying;
    assert.equal(answerer.getTransceivers().length, 1);
    assert.equal(answerer.getTransceivers()[0].sender, sender);
    assert.notEqual(answerer.getTransceivers()[0].mid, null);
    assert.equal(answerer.getTransceivers()[0].currentDirection, null);
    await answerer.setRemoteDescription({ type: "rollback" });
    assert.equal(answerer.getTransceivers().length, 1);
    assert.equal(answerer.getTransceivers()[0].sender, sender);
    assert.equal(answerer.getTransceivers()[0].mid, null);
    assert.equal(sender.track.readyState, "live");
  } finally {
    offerer.close();
    answerer.close();
  }
});

async function negotiate(offerer, answerer) {
  await offerer.setLocalDescription(await offerer.createOffer());
  await answerer.setRemoteDescription(offerer.localDescription);
  await answerer.setLocalDescription(await answerer.createAnswer());
  await offerer.setRemoteDescription(answerer.localDescription);
}

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

test("negotiated direction and stopping follow answer state", async () => {
  const offerer = new RTCPeerConnection();
  const answerer = new RTCPeerConnection();
  try {
    const transceiver = offerer.addTransceiver(track("video"), { direction: "sendonly" });
    await negotiate(offerer, answerer);
    assert.equal(transceiver.currentDirection, "sendonly");
    assert.ok(transceiver.sender.transport instanceof RTCDtlsTransport);
    assert.equal(offerer.sctp, null);
    const remoteTransceiver = answerer.getTransceivers()[0];
    assert.equal(remoteTransceiver.currentDirection, "recvonly");
    assert.ok(remoteTransceiver.receiver.transport instanceof RTCDtlsTransport);
    assert.equal(answerer.sctp, null);
    const receiverClone = remoteTransceiver.receiver.track.clone();
    transceiver.stop();
    assert.equal(transceiver.stopping, true);
    assert.equal(transceiver.stopped, false);
    await negotiate(offerer, answerer);
    assert.equal(transceiver.stopping, false);
    assert.equal(transceiver.stopped, true);
    assert.equal(transceiver.currentDirection, "stopped");
    assert.equal(transceiver.mid, null);
    assert.deepEqual(offerer.getTransceivers(), []);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(remoteTransceiver.receiver.track.readyState, "ended");
    assert.equal(receiverClone.readyState, "ended");
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
