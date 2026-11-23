"use strict";

const assert = require("node:assert/strict");
const { setTimeout: delay } = require("node:timers/promises");
const test = require("node:test");
const { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate } = require("..");

function peers(t) {
  const offerer = new RTCPeerConnection();
  const answerer = new RTCPeerConnection();
  t.after(() => {
    offerer.close();
    answerer.close();
  });
  return [offerer, answerer];
}

function waitFor(target, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      target.removeEventListener(type, onEvent);
      reject(new Error(`Timed out waiting for ${type}`));
    }, 5000);
    function onEvent(event) {
      clearTimeout(timer);
      target.removeEventListener(type, onEvent);
      resolve(event);
    }
    target.addEventListener(type, onEvent);
  });
}

test("SCTP limits wait for the paired peer to apply its remote description", async (t) => {
  const [offerer, answerer] = peers(t);
  offerer.createDataChannel("early-ice");
  await offerer.setLocalDescription();
  await answerer.setRemoteDescription(offerer.localDescription);
  await answerer.setLocalDescription();
  assert.equal(answerer._pairedPeer, offerer);
  assert.equal(offerer.remoteDescription, null);

  // ICE can become usable before both JavaScript description operations finish.
  answerer._iceConnectionState = "connected";
  answerer._sctpConnectedTransitionReady = true;
  answerer._updateSctpTransport();
  assert.equal(answerer.sctp.state, "connecting");
  assert.equal(answerer.sctp.maxChannels, null);
});

test("pipelined offer, answer, and description operations negotiate a usable data channel", async (t) => {
  const [offerer, answerer] = peers(t);
  const local = offerer.createDataChannel("pipeline");
  const incoming = waitFor(answerer, "datachannel");
  await Promise.all([offerer.createOffer(), offerer.setLocalDescription({ type: "offer" })]);
  const order = [];
  const record = (name, promise) =>
    promise.then((value) => {
      order.push(name);
      return value;
    });
  const [, answer] = await Promise.all([
    record("remote", answerer.setRemoteDescription(offerer.localDescription)),
    record("answer", answerer.createAnswer()),
    record("local", answerer.setLocalDescription({ type: "answer" })),
  ]);
  assert.equal(answer.type, "answer");
  assert.deepEqual(order, ["remote", "answer", "local"]);
  assert.equal(answerer.signalingState, "stable");
  await offerer.setRemoteDescription(answerer.localDescription);
  const { channel: remote } = await incoming;
  if (local.readyState !== "open") await waitFor(local, "open");
  if (remote.readyState !== "open") await waitFor(remote, "open");
  const message = waitFor(remote, "message");
  local.send("pipelined negotiation works");
  assert.equal((await message).data, "pipelined negotiation works");
});

test("local descriptions dispatch their state changes before late native notifications", async (t) => {
  const [offerer, answerer] = peers(t);
  offerer.createDataChannel("signaling-event");
  for (const peer of [offerer, answerer]) {
    const handle = peer._handleNativeEvent.bind(peer);
    peer._handleNativeEvent = (event) => {
      if (event.type !== "signalingstatechange") handle(event);
    };
  }

  const offerStates = [];
  offerer.addEventListener("signalingstatechange", () => {
    offerStates.push([offerer.signalingState, offerer.pendingLocalDescription?.type]);
  });
  await offerer.setLocalDescription(await offerer.createOffer());
  assert.deepEqual(offerStates, [["have-local-offer", "offer"]]);

  await answerer.setRemoteDescription(offerer.localDescription);
  const answerStates = [];
  answerer.addEventListener("signalingstatechange", () => {
    answerStates.push([answerer.signalingState, answerer.currentLocalDescription?.type]);
  });
  const answer = await answerer.createAnswer();
  await answerer.setLocalDescription(answer);
  assert.deepEqual(answerStates, [["stable", "answer"]]);

  await offerer.setRemoteDescription(answerer.localDescription);
  const notify = RTCPeerConnection.prototype._handleNativeEvent;
  notify.call(offerer, { type: "signalingstatechange", state: "have-local-offer" });
  notify.call(offerer, { type: "signalingstatechange", state: "stable" });
  notify.call(answerer, { type: "signalingstatechange", state: "stable" });
  assert.deepEqual(offerStates, [
    ["have-local-offer", "offer"],
    ["stable", undefined],
  ]);
  assert.deepEqual(answerStates, [["stable", "answer"]]);
});

test("parameterless local descriptions choose their type after preceding queued operations", async (t) => {
  for (const nativeBacked of [false, true]) {
    const [offerer, answerer] = peers(t);
    if (nativeBacked) offerer.createDataChannel("implicit");
    const offer = await offerer.createOffer();
    await Promise.all([answerer.setRemoteDescription(offer), answerer.setLocalDescription()]);
    assert.equal(answerer.signalingState, "stable");
    assert.equal(answerer.localDescription.type, "answer");
    await Promise.all([
      answerer.setRemoteDescription(offer),
      answerer.setLocalDescription(),
      answerer.setLocalDescription(),
    ]);
    assert.equal(answerer.currentLocalDescription.type, "answer");
    assert.equal(answerer.pendingLocalDescription.type, "offer");
    assert.equal(answerer.signalingState, "have-local-offer");
  }
});

test("queued state validation observes rollback and earlier rejected operations", async (t) => {
  const [offerer, answerer] = peers(t);
  const offer = await offerer.createOffer();
  await answerer.setRemoteDescription(offer);
  const [rollback, reoffer] = await Promise.allSettled([
    answerer.setRemoteDescription({ type: "rollback" }),
    answerer.createOffer(),
  ]);
  assert.equal(rollback.status, "fulfilled");
  assert.equal(reoffer.status, "fulfilled");
  assert.equal(reoffer.value.type, "offer");
  const results = await Promise.allSettled([
    answerer.setRemoteDescription({ type: "offer", sdp: "invalid" }),
    answerer.createAnswer(),
    answerer.setRemoteDescription(offer),
    answerer.createAnswer(),
  ]);
  assert.deepEqual(
    results.map(({ status }) => status),
    ["rejected", "rejected", "fulfilled", "fulfilled"],
  );
  assert.equal(results[0].reason.name, "OperationError");
  assert.equal(results[1].reason.name, "InvalidStateError");
  assert.equal(results[3].value.type, "answer");
});

test("createAnswer rejects in stable after an answer has been applied", async (t) => {
  const [offerer, answerer] = peers(t);
  await answerer.setRemoteDescription(await offerer.createOffer());
  await answerer.setLocalDescription();
  assert.notEqual(answerer.remoteDescription, null);
  await assert.rejects(answerer.createAnswer(), { name: "InvalidStateError" });
});

test("parameterless local descriptions finalize a provisional answer", async (t) => {
  const [offerer, answerer] = peers(t);
  await answerer.setRemoteDescription(await offerer.createOffer());
  const answer = await answerer.createAnswer();
  await answerer.setLocalDescription({ ...answer, type: "pranswer" });
  assert.equal(answerer.signalingState, "have-local-pranswer");
  await answerer.setLocalDescription();
  assert.equal(answerer.localDescription.type, "answer");
  assert.equal(answerer.signalingState, "stable");
});

test("end-of-candidates waits for queued remote descriptions and remains ordered with local descriptions", async (t) => {
  const [offerer, answerer] = peers(t);
  offerer.createDataChannel("candidates");
  const offer = await offerer.createOffer();
  const order = [];
  const record = (name, promise) => promise.then(() => order.push(name));
  await Promise.all([
    record("remote", answerer.setRemoteDescription(offer)),
    record("null", answerer.addIceCandidate(null)),
    record("undefined", answerer.addIceCandidate()),
    record("empty", answerer.addIceCandidate({})),
    record("local", answerer.setLocalDescription()),
  ]);
  assert.deepEqual(order, ["remote", "null", "undefined", "empty", "local"]);
  assert.match(answerer.remoteDescription.sdp, /a=end-of-candidates/);
  assert.equal(answerer.signalingState, "stable");
});

test("all end-of-candidates forms reject without a remote description", async (t) => {
  const [peer] = peers(t);
  for (const candidate of [null, undefined, {}]) {
    await assert.rejects(peer.addIceCandidate(candidate), { name: "InvalidStateError" });
  }
  await assert.rejects(peer.addIceCandidate(), { name: "InvalidStateError" });
});

test("same-process ICE candidates respect operation order and drain without deadlocking", async (t) => {
  const [offerer, answerer] = peers(t);
  offerer.createDataChannel("local-candidates");
  const candidateEvent = waitFor(offerer, "icecandidate");
  await offerer.setLocalDescription();
  const { candidate } = await candidateEvent;
  assert.ok(candidate);
  const order = [];
  const record = (name, promise) => promise.then(() => order.push(name));
  await Promise.all([
    record("early", answerer.addIceCandidate(candidate)),
    record("remote", answerer.setRemoteDescription(offerer.localDescription)),
    record("local", answerer.setLocalDescription()),
    record("late", answerer.addIceCandidate(candidate)),
  ]);
  assert.deepEqual(order, ["early", "remote", "local", "late"]);
  assert.equal(answerer.signalingState, "stable");
  assert.ok(answerer.remoteDescription.sdp.includes(candidate.candidate));
});

test("closing from a signaling callback leaves active and queued promises pending", async (t) => {
  for (const nativeBacked of [false, true]) {
    const [offerer, peer] = peers(t);
    if (nativeBacked) offerer.createDataChannel("closing");
    const offer = await offerer.createOffer();
    let closed;
    const closedEvent = new Promise((resolve) => {
      closed = resolve;
    });
    peer.addEventListener("signalingstatechange", () => {
      if (peer.signalingState === "closed") return;
      peer.close();
      closed();
    });
    const settled = [];
    for (const promise of [
      peer.setRemoteDescription(offer),
      peer.createAnswer(),
      peer.setLocalDescription(),
    ]) {
      promise.then(
        () => settled.push("fulfilled"),
        () => settled.push("rejected"),
      );
    }
    await closedEvent;
    await delay(30);
    assert.deepEqual(settled, []);
    assert.equal(peer.signalingState, "closed");
    assert.equal(peer._operationsPending, 0);
  }
  const [closedDuringConversion] = peers(t);
  const converted = closedDuringConversion.createOffer({
    get iceRestart() {
      closedDuringConversion.close();
      return false;
    },
  });
  await assert.rejects(converted, { name: "InvalidStateError" });
});

test("queued descriptions use the argument snapshot taken when the method is called", async (t) => {
  const [offerer, answerer] = peers(t);
  const offer = await offerer.createOffer();
  for (const mutable of [{ ...offer }, new RTCSessionDescription(offer)]) {
    const pending = answerer.setRemoteDescription(mutable);
    mutable.type = "rollback";
    mutable.sdp = "invalid";
    await pending;
    assert.equal(answerer.remoteDescription.type, "offer");
    assert.equal(answerer.remoteDescription.sdp, offer.sdp);
  }
});

test("queued and buffered ICE candidates snapshot mutable candidate objects", async (t) => {
  const [offerer, answerer] = peers(t);
  offerer.createDataChannel("candidate-snapshot");
  const offer = await offerer.createOffer();
  const candidate = new RTCIceCandidate({ candidate: "", sdpMLineIndex: 0 });
  const pending = [answerer.setRemoteDescription(offer), answerer.addIceCandidate(candidate)];
  candidate.candidate = "invalid";
  candidate.sdpMLineIndex = 99;
  await Promise.all(pending);
  assert.match(answerer.remoteDescription.sdp, /a=end-of-candidates/);

  const [localOfferer, localAnswerer] = peers(t);
  const local = localOfferer.createDataChannel("local-candidate-snapshot");
  const incoming = waitFor(localAnswerer, "datachannel");
  const gathered = waitFor(localOfferer, "icecandidate");
  await localOfferer.setLocalDescription();
  const { candidate: localCandidate } = await gathered;
  const expected = localCandidate.candidate;
  const buffered = localAnswerer.addIceCandidate(localCandidate);
  localCandidate.candidate = "invalid";
  await buffered;
  const withoutCandidates = localOfferer.localDescription.toJSON();
  withoutCandidates.sdp = withoutCandidates.sdp.replace(
    /^a=(?:candidate:.*|end-of-candidates)\r?\n/gm,
    "",
  );
  await localAnswerer.setRemoteDescription(withoutCandidates);
  await localAnswerer.setLocalDescription();
  assert.ok(localAnswerer.remoteDescription.sdp.includes(expected));
  while (localAnswerer.iceGatheringState !== "complete")
    await waitFor(localAnswerer, "icegatheringstatechange");
  await localOfferer.setRemoteDescription(localAnswerer.localDescription);
  const { channel: remote } = await incoming;
  if (local.readyState !== "open") await waitFor(local, "open");
  if (remote.readyState !== "open") await waitFor(remote, "open");
  const message = waitFor(remote, "message");
  local.send("buffered candidate reached native transport");
  assert.equal((await message).data, "buffered candidate reached native transport");
});

test("repeated renegotiation keeps the same-process pairing registry bounded", async (t) => {
  const [offerer, answerer] = peers(t);
  offerer.onicecandidate = ({ candidate }) => {
    if (candidate) answerer.addIceCandidate(candidate).catch(() => {});
  };
  answerer.onicecandidate = ({ candidate }) => {
    if (candidate) offerer.addIceCandidate(candidate).catch(() => {});
  };
  const channel = offerer.createDataChannel("renegotiated");
  const remoteChannel = new Promise((resolve) => {
    answerer.ondatachannel = ({ channel: incoming }) => resolve(incoming);
  });
  async function negotiate() {
    await offerer.setLocalDescription(await offerer.createOffer());
    await answerer.setRemoteDescription(offerer.localDescription);
    await answerer.setLocalDescription(await answerer.createAnswer());
    await offerer.setRemoteDescription(answerer.localDescription);
  }
  await negotiate();
  const incoming = await remoteChannel;
  for (let round = 0; round < 12; round++) {
    offerer.restartIce();
    await negotiate();
  }
  assert.ok(offerer._localDescriptionPairingKeys.size <= 4);
  assert.ok(answerer._localDescriptionPairingKeys.size <= 4);
  assert.equal(offerer._pairedPeer, answerer);
  if (channel.readyState !== "open") {
    await new Promise((resolve) => channel.addEventListener("open", resolve, { once: true }));
  }
  const received = new Promise((resolve) => {
    incoming.onmessage = ({ data }) => resolve(data);
  });
  channel.send("after renegotiation");
  assert.equal(await received, "after renegotiation");
});

test("peer connections without configured certificates each use their own certificate", async (t) => {
  const connections = Array.from({ length: 12 }, () => new RTCPeerConnection());
  t.after(() => {
    for (const pc of connections) pc.close();
  });
  const fingerprints = [];
  for (const pc of connections) {
    pc.createDataChannel("certificate");
    const offer = await pc.createOffer();
    const fingerprint = /^a=fingerprint:sha-256 ([^\r\n]+)$/im.exec(offer.sdp);
    assert.ok(fingerprint, "offer carries a SHA-256 fingerprint");
    fingerprints.push(fingerprint[1]);
  }
  assert.equal(new Set(fingerprints).size, connections.length);
});
