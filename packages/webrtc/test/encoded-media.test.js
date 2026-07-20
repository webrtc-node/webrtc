"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  MediaStream,
  MediaStreamTrack,
  nonstandard,
  RTCPeerConnection,
  RTCRtpSender,
} = require("..");
const { EncodedMediaSink, EncodedMediaSource } = nonstandard;

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

function rtpPacketWithMid(mid, sequenceNumber = 1, payloadType = 96, ssrc = 42) {
  const midBytes = Buffer.from(mid, "utf8");
  if (midBytes.length < 1 || midBytes.length > 16)
    throw new RangeError("mid must fit one-byte RTP");
  const base = rtpPacket(sequenceNumber, payloadType, ssrc);
  const extensionSize = Math.ceil((1 + midBytes.length) / 4) * 4;
  const packet = new Uint8Array(16 + extensionSize + base.length - 12);
  packet.set(base.subarray(0, 12));
  packet[0] |= 0x10;
  const view = new DataView(packet.buffer);
  view.setUint16(12, 0xbede);
  view.setUint16(14, extensionSize / 4);
  packet[16] = 0x10 | (midBytes.length - 1);
  packet.set(midBytes, 17);
  packet.set(base.subarray(12), 16 + extensionSize);
  return packet;
}

function audioRtpPacketWithSources({
  sequenceNumber,
  rtpTimestamp,
  ssrc,
  csrcs,
  ssrcAudioLevel,
  csrcAudioLevels,
}) {
  if (csrcs.length !== csrcAudioLevels.length || csrcs.length > 15) {
    throw new RangeError("CSRC identifiers and audio levels must have matching RTP lengths");
  }
  const extensionData = [0x20, ssrcAudioLevel & 0x7f];
  if (csrcAudioLevels.length > 0) {
    extensionData.push(0x30 | (csrcAudioLevels.length - 1), ...csrcAudioLevels);
  }
  const paddedExtensionLength = Math.ceil(extensionData.length / 4) * 4;
  const rtpHeaderLength = 12 + csrcs.length * 4;
  const packet = new Uint8Array(rtpHeaderLength + 4 + paddedExtensionLength + 1);
  const view = new DataView(packet.buffer);
  packet[0] = 0x90 | csrcs.length;
  packet[1] = 111;
  view.setUint16(2, sequenceNumber);
  view.setUint32(4, rtpTimestamp);
  view.setUint32(8, ssrc);
  for (let index = 0; index < csrcs.length; index += 1) {
    view.setUint32(12 + index * 4, csrcs[index]);
  }
  view.setUint16(rtpHeaderLength, 0xbede);
  view.setUint16(rtpHeaderLength + 2, paddedExtensionLength / 4);
  packet.set(extensionData, rtpHeaderLength + 4);
  return packet;
}

function rtcpReceiverReport(ssrc = 42) {
  return Uint8Array.from([
    0x80,
    201,
    0,
    1,
    ssrc >> 24,
    (ssrc >> 16) & 0xff,
    (ssrc >> 8) & 0xff,
    ssrc & 0xff,
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
    const packetBytes = new Uint8Array(packet.data);
    assert.equal(packetBytes[0], 0x80);

    const synchronizationSources = receiver.getSynchronizationSources();
    assert.equal(synchronizationSources.length, 1);
    assert.equal(synchronizationSources[0].source, 43);
    assert.equal(typeof synchronizationSources[0].timestamp, "number");
    assert.ok(synchronizationSources[0].rtpTimestamp > 0);
    assert.equal("audioLevel" in synchronizationSources[0], false);
    assert.deepEqual(receiver.getContributingSources(), []);

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

test("receiver reports negotiated synchronization and contributing RTP sources", async () => {
  const offerer = new RTCPeerConnection();
  const answerer = new RTCPeerConnection();
  const source = new EncodedMediaSource({
    kind: "audio",
    codec: { mimeType: "audio/opus", payloadType: 111 },
    ssrc: 0x10203040,
  });
  let sink;
  try {
    const remoteTrack = waitFor(answerer, "track");
    offerer.addTrack(source.track);
    await negotiate(offerer, answerer);
    const { receiver, track } = await remoteTrack;
    sink = new EncodedMediaSink(track);
    assert.deepEqual(receiver.getSynchronizationSources(), []);
    assert.deepEqual(receiver.getContributingSources(), []);
    assert.match(
      answerer.localDescription.sdp,
      /^a=extmap:2 urn:ietf:params:rtp-hdrext:ssrc-audio-level$/m,
    );
    assert.match(
      answerer.localDescription.sdp,
      /^a=extmap:3 urn:ietf:params:rtp-hdrext:csrc-audio-level$/m,
    );

    const opened = source.readyState === "open" ? null : waitFor(source, "open");
    if (opened) await opened;
    const packet = audioRtpPacketWithSources({
      sequenceNumber: 1,
      rtpTimestamp: 9000,
      ssrc: 0x10203040,
      csrcs: [0x11223344, 0x55667788],
      ssrcAudioLevel: 20,
      csrcAudioLevels: [40, 127],
    });
    const earliestTimestamp = performance.timeOrigin + performance.now();
    const packetEvent = waitFor(sink, "packet");
    assert.equal(source.send(packet), true);
    await packetEvent;
    const latestTimestamp = performance.timeOrigin + performance.now();

    const synchronizationSources = receiver.getSynchronizationSources();
    assert.equal(synchronizationSources.length, 1);
    assert.equal(synchronizationSources[0].source, 0x10203040);
    assert.equal(synchronizationSources[0].rtpTimestamp, 9000);
    assert.equal(synchronizationSources[0].audioLevel, 0.1);
    assert.ok(synchronizationSources[0].timestamp >= earliestTimestamp);
    assert.ok(synchronizationSources[0].timestamp <= latestTimestamp);

    const contributingSources = receiver.getContributingSources();
    assert.deepEqual(
      contributingSources.map(({ source: identifier, rtpTimestamp, audioLevel }) => ({
        source: identifier,
        rtpTimestamp,
        audioLevel,
      })),
      [
        { source: 0x11223344, rtpTimestamp: 9000, audioLevel: 0.01 },
        { source: 0x55667788, rtpTimestamp: 9000, audioLevel: 0 },
      ],
    );

    synchronizationSources[0].source = 0;
    contributingSources.length = 0;
    assert.equal(receiver.getSynchronizationSources()[0].source, 0x10203040);
    assert.equal(receiver.getContributingSources().length, 2);

    const beforeOutOfOrder = receiver.getSynchronizationSources()[0];
    const outOfOrderPacket = audioRtpPacketWithSources({
      sequenceNumber: 2,
      rtpTimestamp: 8000,
      ssrc: 0x10203040,
      csrcs: [0x11223344, 0x55667788],
      ssrcAudioLevel: 10,
      csrcAudioLevels: [10, 10],
    });
    const outOfOrderEvent = waitFor(sink, "packet");
    assert.equal(source.send(outOfOrderPacket), true);
    await outOfOrderEvent;
    assert.deepEqual(receiver.getSynchronizationSources()[0], beforeOutOfOrder);

    const beforeRtcp = receiver.getSynchronizationSources()[0];
    const rtcpEvent = waitFor(sink, "packet");
    assert.equal(source.send(rtcpReceiverReport(0x10203040)), true);
    await rtcpEvent;
    assert.deepEqual(receiver.getSynchronizationSources()[0], beforeRtcp);
  } finally {
    sink?.close();
    source.close();
    offerer.close();
    answerer.close();
  }
});

test("negotiated MID RTP header extensions pass through unchanged", async () => {
  const offerer = new RTCPeerConnection();
  const answerer = new RTCPeerConnection();
  const source = new EncodedMediaSource({
    kind: "video",
    codec: { mimeType: "video/VP8", payloadType: 96 },
    ssrc: 46,
  });
  let sink;
  try {
    const remoteTrack = waitFor(answerer, "track");
    const transceiver = offerer.addTransceiver(source.track, { direction: "sendonly" });
    await negotiate(offerer, answerer);
    sink = new EncodedMediaSink((await remoteTrack).track);
    assert.match(offerer.localDescription.sdp, /^a=extmap:1 urn:ietf:params:rtp-hdrext:sdes:mid$/m);
    assert.deepEqual(transceiver.sender.getParameters().headerExtensions, [
      {
        uri: "urn:ietf:params:rtp-hdrext:sdes:mid",
        id: 1,
        encrypted: false,
      },
    ]);

    const opened = source.readyState === "open" ? null : waitFor(source, "open");
    if (opened) await opened;
    const packet = rtpPacketWithMid(transceiver.mid, 1, 96, 46);
    const packetEvent = waitFor(sink, "packet");
    assert.equal(source.send(packet), true);
    assert.deepEqual(new Uint8Array((await packetEvent).data), packet);
  } finally {
    sink?.close();
    source.close();
    offerer.close();
    answerer.close();
  }
});

test("RTCRtpSender active parameters suppress and resume encoded RTP", async () => {
  const offerer = new RTCPeerConnection();
  const answerer = new RTCPeerConnection();
  const source = new EncodedMediaSource({
    kind: "audio",
    codec: { mimeType: "audio/opus", payloadType: 111 },
    ssrc: 44,
  });
  let sink;
  try {
    const sender = offerer.addTransceiver(source.track, {
      sendEncodings: [{ active: false }],
    }).sender;
    const remoteTrack = waitFor(answerer, "track");
    await negotiate(offerer, answerer);
    sink = new EncodedMediaSink((await remoteTrack).track);

    assert.equal(source.send(rtpPacket(1, 111, 44)), false);
    assert.equal(
      [...(await sender.getStats()).values()].find((entry) => entry.type === "outbound-rtp")
        ?.packetsSent,
      0,
    );

    const controlEvent = waitFor(sink, "packet");
    let controlDelivered = false;
    controlEvent.then(() => {
      controlDelivered = true;
    });
    for (let attempt = 0; attempt < 200 && !controlDelivered; attempt += 1) {
      try {
        source.send(rtcpReceiverReport(44));
      } catch (error) {
        if (!/Track is not open/.test(error.message)) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(new Uint8Array((await controlEvent).data)[1], 201);

    const enabled = sender.getParameters();
    enabled.encodings[0].active = true;
    await sender.setParameters(enabled);
    const packetEvent = waitFor(sink, "packet");
    let delivered = false;
    packetEvent.then(() => {
      delivered = true;
    });
    for (let sequenceNumber = 2; sequenceNumber <= 200 && !delivered; sequenceNumber += 1) {
      try {
        source.send(rtpPacket(sequenceNumber, 111, 44));
      } catch (error) {
        if (!/Track is not open/.test(error.message)) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await packetEvent;

    const disabled = sender.getParameters();
    disabled.encodings[0].active = false;
    await sender.setParameters(disabled);
    assert.equal(source.send(rtpPacket(201, 111, 44)), false);
    const outbound = [...(await sender.getStats()).values()].find(
      (entry) => entry.type === "outbound-rtp",
    );
    assert.ok(outbound.packetsSent > 0);
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

test("one encoded source fans RTP out to senders on multiple peer connections", async () => {
  const offererA = new RTCPeerConnection();
  const answererA = new RTCPeerConnection();
  const offererB = new RTCPeerConnection();
  const answererB = new RTCPeerConnection();
  const source = new EncodedMediaSource({
    kind: "video",
    codec: { mimeType: "video/VP8", payloadType: 96 },
    ssrc: 45,
  });
  let sinkA;
  let sinkB;
  try {
    const remoteTrackA = waitFor(answererA, "track");
    offererA.addTrack(source.track);
    await negotiate(offererA, answererA);
    sinkA = new EncodedMediaSink((await remoteTrackA).track);

    const remoteTrackB = waitFor(answererB, "track");
    offererB.addTrack(source.track);
    await negotiate(offererB, answererB);
    sinkB = new EncodedMediaSink((await remoteTrackB).track);

    let receivedA = false;
    let receivedB = false;
    const packetA = waitFor(sinkA, "packet").then((event) => {
      receivedA = true;
      return event;
    });
    const packetB = waitFor(sinkB, "packet").then((event) => {
      receivedB = true;
      return event;
    });
    for (let sequenceNumber = 1; sequenceNumber <= 200; sequenceNumber += 1) {
      source.send(rtpPacket(sequenceNumber, 96, 45));
      if (receivedA && receivedB) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const [receivedPacketA, receivedPacketB] = await Promise.all([packetA, packetB]);
    assert.equal(new Uint8Array(receivedPacketA.data)[1], 96);
    assert.equal(new Uint8Array(receivedPacketB.data)[1], 96);

    offererA.close();
    answererA.close();
    assert.notEqual(source.readyState, "closed");

    const remainingPacket = waitFor(sinkB, "packet");
    let remainingReceived = false;
    remainingPacket.then(
      () => {
        remainingReceived = true;
      },
      () => {},
    );
    for (let sequenceNumber = 201; sequenceNumber <= 400; sequenceNumber += 1) {
      assert.equal(source.send(rtpPacket(sequenceNumber, 96, 45)), true);
      if (remainingReceived) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(new Uint8Array((await remainingPacket).data)[1], 96);
  } finally {
    sinkA?.close();
    sinkB?.close();
    source.close();
    offererA.close();
    answererA.close();
    offererB.close();
    answererB.close();
  }
});

test("encoded source remains usable until its last track clone ends", async () => {
  const source = new EncodedMediaSource({
    kind: "audio",
    codec: { mimeType: "audio/opus", payloadType: 111 },
  });
  const peer = new RTCPeerConnection();
  let closeEvents = 0;
  source.addEventListener("close", () => {
    closeEvents += 1;
  });
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
    source.close();
    assert.equal(closeEvents, 1);
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

test("encoded RTP flows on a second transceiver added during initial transport setup", async () => {
  const offerer = new RTCPeerConnection();
  const answerer = new RTCPeerConnection();
  const source = new EncodedMediaSource({
    kind: "video",
    codec: { mimeType: "video/VP8", payloadType: 96 },
    ssrc: 42,
  });
  try {
    offerer.onicecandidate = ({ candidate }) =>
      candidate && answerer.addIceCandidate(candidate).catch(() => {});
    answerer.onicecandidate = ({ candidate }) =>
      candidate && offerer.addIceCandidate(candidate).catch(() => {});

    offerer.addTransceiver("video", { direction: "recvonly" });
    await offerer.setLocalDescription();
    await answerer.setRemoteDescription(offerer.localDescription);
    answerer.getTransceivers()[0].direction = "inactive";
    await answerer.setLocalDescription();
    await offerer.setRemoteDescription(answerer.localDescription);

    offerer.addTransceiver("video", { direction: "recvonly" });
    await offerer.setLocalDescription();
    await answerer.setRemoteDescription(offerer.localDescription);
    const sendTransceiver = answerer.getTransceivers()[1];
    sendTransceiver.direction = "sendonly";
    await sendTransceiver.sender.replaceTrack(source.track);
    await answerer.setLocalDescription();
    assert.equal(answerer.localDescription.sdp.match(/^a=ssrc:/gm)?.length, 1);
    assert.match(answerer.localDescription.sdp, /^a=ssrc:42 cname:/m);
    await offerer.setRemoteDescription(answerer.localDescription);

    const opened = source.readyState === "open" ? null : waitFor(source, "open");
    if (opened) await opened;
    for (let sequenceNumber = 1; sequenceNumber <= 12; sequenceNumber += 1) {
      assert.equal(source.send(rtpPacket(sequenceNumber)), true);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const receiver = offerer.getTransceivers()[1].receiver;
    let inbound;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      inbound = [...(await receiver.getStats()).values()].find(
        (entry) => entry.type === "inbound-rtp",
      );
      if (inbound?.packetsReceived >= 12) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(inbound?.packetsReceived, 12);
  } finally {
    source.close();
    offerer.close();
    answerer.close();
  }
});
