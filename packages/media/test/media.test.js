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

function rtpPacket(sequenceNumber = 1, payloadType = 96, ssrc = 42) {
  return Uint8Array.from([
    0x80,
    payloadType,
    sequenceNumber >> 8,
    sequenceNumber & 0xff,
    0,
    0,
    0,
    sequenceNumber,
    ssrc >> 24,
    (ssrc >> 16) & 0xff,
    (ssrc >> 8) & 0xff,
    ssrc & 0xff,
    1,
    2,
    3,
    4,
  ]);
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

test("answerer-supplied encoded RTP reaches the offerer receiver", async () => {
  const offerer = new RTCPeerConnection();
  const answerer = new RTCPeerConnection();
  const source = new EncodedMediaSource({
    kind: "audio",
    codec: { mimeType: "audio/opus", payloadType: 111 },
    ssrc: 43,
  });
  let sink;
  try {
    const { receiver } = offerer.addTransceiver("audio");
    answerer.addTrack(source.track);
    offerer.onicecandidate = ({ candidate }) =>
      candidate && answerer.addIceCandidate(candidate).catch(() => {});
    answerer.onicecandidate = ({ candidate }) =>
      candidate && offerer.addIceCandidate(candidate).catch(() => {});
    const unmuted = waitFor(receiver.track, "unmute");

    await negotiate(offerer, answerer);
    sink = new EncodedMediaSink(receiver.track);
    const packetEvent = waitFor(sink, "packet");
    const received = Promise.all([unmuted, packetEvent]);
    let delivered = false;
    received.then(() => {
      delivered = true;
    });
    for (let sequenceNumber = 1; sequenceNumber <= 200 && !delivered; sequenceNumber += 1) {
      try {
        source.send(rtpPacket(sequenceNumber, 111, 43));
      } catch (error) {
        if (!/Track is not open/.test(error.message)) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const [, packet] = await received;
    assert.equal(new Uint8Array(packet.data)[0], 0x80);

    const inbound = [...(await receiver.getStats()).values()].find(
      (entry) => entry.type === "inbound-rtp",
    );
    assert.ok(inbound);
    assert.ok(inbound.packetsReceived > 0);
  } finally {
    sink?.close();
    source.close();
    offerer.close();
    answerer.close();
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

test("encoded source remains usable until its last track clone ends", async () => {
  const source = new EncodedMediaSource({
    kind: "audio",
    codec: { mimeType: "audio/opus", payloadType: 111 },
  });
  const peer = new RTCPeerConnection();
  try {
    const clone = source.track.clone();
    source.track.stop();
    assert.equal(source.track.readyState, "ended");
    assert.equal(clone.readyState, "live");
    assert.notEqual(source.readyState, "closed");

    peer.addTrack(clone);
    await peer.createOffer();
    assert.notEqual(source.readyState, "closed");
    const ended = waitFor(clone, "ended");
    source.close();
    await ended;
    assert.equal(clone.readyState, "ended");
    assert.equal(source.readyState, "closed");
  } finally {
    source.close();
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
    const sender = offerer.addTrack(source.track, sourceStream, secondaryStream);
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
    assert.equal(trackDispatched, true);
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
    const senderStats = [...(await sender.getStats()).values()];
    const receiverStats = [...(await receiver.getStats()).values()];
    assert.deepEqual(
      outbound.filter((entry) => entry.type.endsWith("-rtp")).map((entry) => entry.type),
      ["outbound-rtp"],
    );
    const outboundRtp = outbound.find((entry) => entry.type === "outbound-rtp");
    assert.equal(outboundRtp.packetsSent, 1);
    assert.equal(outboundRtp.transportId, "transport-0");
    const outboundCodec = outbound.find((entry) => entry.id === outboundRtp.codecId);
    assert.equal(outboundCodec.type, "codec");
    assert.equal(outboundCodec.mimeType, "video/VP8");
    assert.equal(outboundCodec.clockRate, 90000);
    assert.deepEqual(
      senderStats.filter((entry) => entry.type.endsWith("-rtp")).map((entry) => entry.type),
      ["outbound-rtp"],
    );
    assert.equal(senderStats.find((entry) => entry.type === "outbound-rtp").packetsSent, 1);
    assert.ok(senderStats.some((entry) => entry.type === "candidate-pair"));
    const senderTransport = senderStats.find((entry) => entry.type === "transport");
    assert.equal(
      senderStats.find((entry) => entry.id === senderTransport.localCertificateId).type,
      "certificate",
    );
    assert.equal(
      senderStats.find((entry) => entry.id === senderTransport.remoteCertificateId).type,
      "certificate",
    );
    assert.deepEqual(
      inbound.filter((entry) => entry.type.endsWith("-rtp")).map((entry) => entry.type),
      ["inbound-rtp"],
    );
    const inboundRtp = inbound.find((entry) => entry.type === "inbound-rtp");
    assert.equal(inboundRtp.packetsReceived, 1);
    assert.equal(inboundRtp.transportId, "transport-0");
    assert.equal(inboundRtp.trackIdentifier, track.id);
    const inboundCodec = inbound.find((entry) => entry.id === inboundRtp.codecId);
    assert.equal(inboundCodec.type, "codec");
    assert.equal(inboundCodec.mimeType, "video/VP8");
    assert.deepEqual(
      receiverStats.filter((entry) => entry.type.endsWith("-rtp")).map((entry) => entry.type),
      ["inbound-rtp"],
    );
    assert.equal(receiverStats.find((entry) => entry.type === "inbound-rtp").packetsReceived, 1);
    assert.ok(receiverStats.some((entry) => entry.type === "candidate-pair"));
    const receiverTransport = receiverStats.find((entry) => entry.type === "transport");
    assert.equal(
      receiverStats.find((entry) => entry.id === receiverTransport.localCertificateId).type,
      "certificate",
    );
    assert.equal(
      receiverStats.find((entry) => entry.id === receiverTransport.remoteCertificateId).type,
      "certificate",
    );

    const reassociatedStream = new MediaStream([source.track]);
    sender.setStreams(reassociatedStream);
    const reassociatedTrackEvent = waitFor(answerer, "track");
    await negotiate(offerer, answerer);
    const reassociated = await reassociatedTrackEvent;
    assert.equal(reassociated.track, track);
    assert.deepEqual(
      reassociated.streams.map((stream) => stream.id),
      [reassociatedStream.id],
    );
    const packetAfterRenegotiation = waitFor(sink, "packet");
    const secondPacket = rtpPacket(2);
    assert.equal(source.send(secondPacket), true);
    assert.deepEqual(new Uint8Array((await packetAfterRenegotiation).data), secondPacket);

    const senderStatsBeforeStop = sender.getStats();
    const receiverStatsBeforeStop = receiver.getStats();
    offerer.getTransceivers()[0].stop();
    transceiver.stop();
    assert.equal(
      [...(await senderStatsBeforeStop).values()].some((entry) => entry.type === "outbound-rtp"),
      true,
    );
    assert.equal(
      [...(await receiverStatsBeforeStop).values()].some((entry) => entry.type === "inbound-rtp"),
      true,
    );
    assert.equal(
      [...(await sender.getStats()).values()].some((entry) => entry.type === "outbound-rtp"),
      false,
    );
    answerer.close();
    assert.equal(
      [...(await receiver.getStats()).values()].some((entry) => entry.type === "inbound-rtp"),
      false,
    );
  } finally {
    sink?.close();
    source.close();
    offerer.close();
    answerer.close();
  }
});
