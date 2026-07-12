"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  MediaStream,
  MediaStreamTrack,
  RTCPeerConnection,
  RTCRtpSender,
} = require("@webrtc-node/webrtc");
const { EncodedMediaSink, EncodedMediaSource } = require("..");

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
  offerer.onicecandidate = ({ candidate }) =>
    candidate && answerer.addIceCandidate(candidate).catch(() => {});
  answerer.onicecandidate = ({ candidate }) =>
    candidate && offerer.addIceCandidate(candidate).catch(() => {});
  await offerer.setLocalDescription(await offerer.createOffer());
  await answerer.setRemoteDescription(offerer.localDescription);
  await answerer.setLocalDescription(await answerer.createAnswer());
  await offerer.setRemoteDescription(answerer.localDescription);
}

function rtpPacket() {
  return Uint8Array.from([0x80, 96, 0, 1, 0, 0, 0, 1, 0, 0, 0, 42, 1, 2, 3, 4]);
}

test("EncodedMediaSource provides a standard MediaStreamTrack", async () => {
  const peer = new RTCPeerConnection();
  const source = new EncodedMediaSource({
    kind: "video",
    codec: { mimeType: "video/VP8", payloadType: 96 },
    ssrc: 42,
  });
  try {
    assert.ok(source.track instanceof MediaStreamTrack);
    const sender = peer.addTrack(source.track);
    assert.ok(sender instanceof RTCRtpSender);
    const offer = await peer.createOffer();
    assert.match(offer.sdp, /m=video 9 UDP\/TLS\/RTP\/SAVPF 96/);
    assert.match(offer.sdp, /a=rtpmap:96 VP8\/90000/i);
  } finally {
    source.close();
    peer.close();
  }
});

test("encoded source validation rejects unsupported configurations", () => {
  assert.throws(() => new EncodedMediaSource({ kind: "text" }), /kind/);
  assert.throws(
    () =>
      new EncodedMediaSource({
        kind: "audio",
        codec: { mimeType: "video/VP8", payloadType: 96 },
      }),
    /codec/,
  );
  assert.throws(
    () =>
      new EncodedMediaSource({
        kind: "audio",
        codec: { mimeType: "audio/opus", payloadType: 128 },
      }),
    /payloadType/,
  );
});

test("replaceTrack transfers native encoded source ownership", async () => {
  const peer = new RTCPeerConnection();
  const first = new EncodedMediaSource({
    kind: "video",
    codec: { mimeType: "video/VP8", payloadType: 96 },
  });
  const replacement = new EncodedMediaSource({
    kind: "video",
    codec: { mimeType: "video/VP8", payloadType: 96 },
  });
  const incompatible = new EncodedMediaSource({
    kind: "video",
    codec: { mimeType: "video/H264", payloadType: 102 },
  });
  try {
    const sender = peer.addTrack(first.track);
    await peer.createOffer();
    await sender.replaceTrack(replacement.track);
    assert.equal(sender.track, replacement.track);
    assert.throws(() => first.send(rtpPacket()), { name: "InvalidStateError" });
    await assert.rejects(sender.replaceTrack(incompatible.track), {
      name: "InvalidModificationError",
    });
    assert.equal(sender.track, replacement.track);
  } finally {
    first.close();
    replacement.close();
    incompatible.close();
    peer.close();
  }
});

test("standard track event exposes encoded RTP through an optional sink", async () => {
  const offerer = new RTCPeerConnection();
  const answerer = new RTCPeerConnection();
  const source = new EncodedMediaSource({
    kind: "video",
    codec: { mimeType: "video/VP8", payloadType: 96 },
    ssrc: 42,
  });
  let sink;
  try {
    const sourceStream = new MediaStream([source.track]);
    const secondaryStream = new MediaStream([source.track]);
    offerer.addTrack(source.track, sourceStream, secondaryStream);
    offerer.onicecandidate = ({ candidate }) =>
      candidate && answerer.addIceCandidate(candidate).catch(() => {});
    answerer.onicecandidate = ({ candidate }) =>
      candidate && offerer.addIceCandidate(candidate).catch(() => {});
    let trackDispatched = false;
    answerer.addEventListener("track", () => {
      trackDispatched = true;
    });
    const trackEvent = waitFor(answerer, "track");
    const sourceOpen = waitFor(source, "open");
    await offerer.setLocalDescription(await offerer.createOffer());
    await answerer.setRemoteDescription(offerer.localDescription);
    assert.equal(trackDispatched, false);
    await answerer.setLocalDescription(await answerer.createAnswer());
    await offerer.setRemoteDescription(answerer.localDescription);
    const { track, receiver, streams, transceiver } = await trackEvent;
    assert.ok(track instanceof MediaStreamTrack);
    assert.equal(track.id, source.track.id);
    assert.equal(receiver.track, track);
    assert.equal(transceiver.receiver, receiver);
    assert.equal(transceiver.currentDirection, "recvonly");
    assert.deepEqual(
      streams.map((stream) => stream.id),
      [sourceStream.id, secondaryStream.id],
    );
    for (const stream of streams) assert.deepEqual(stream.getTracks(), [track]);
    sink = new EncodedMediaSink(track);
    await sourceOpen;
    const packetEvent = waitFor(sink, "packet");
    assert.equal(source.send(rtpPacket()), true);
    assert.deepEqual(new Uint8Array((await packetEvent).data), rtpPacket());
    const outbound = [...(await offerer.getStats(source.track)).values()];
    const inbound = [...(await answerer.getStats(track)).values()];
    assert.deepEqual(
      outbound.map((entry) => entry.type),
      ["outbound-rtp"],
    );
    assert.equal(outbound[0].packetsSent, 1);
    assert.deepEqual(
      inbound.map((entry) => entry.type),
      ["inbound-rtp"],
    );
    assert.equal(inbound[0].packetsReceived, 1);
  } finally {
    sink?.close();
    source.close();
    offerer.close();
    answerer.close();
  }
});
