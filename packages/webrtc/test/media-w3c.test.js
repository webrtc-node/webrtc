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

const audioHeaderExtensionUris = [
  "urn:ietf:params:rtp-hdrext:sdes:mid",
  "urn:ietf:params:rtp-hdrext:ssrc-audio-level",
  "urn:ietf:params:rtp-hdrext:csrc-audio-level",
];

function expectedAudioHeaderExtensionParameters() {
  return audioHeaderExtensionUris.map((uri, index) => ({
    uri,
    id: index + 1,
    encrypted: false,
  }));
}

function track(kind = "audio") {
  const codec =
    kind === "audio"
      ? { mimeType: "audio/opus", payloadType: 111 }
      : { mimeType: "video/VP8", payloadType: 96 };
  return new nonstandard.EncodedMediaSource({ kind, codec, label: `encoded ${kind}` }).track;
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

test("MediaStream copies track sets without events for script track mutations", () => {
  const audio = track();
  const original = new MediaStream([audio]);
  const copy = new MediaStream(original);
  assert.notEqual(copy.id, original.id);
  assert.deepEqual(copy.getTracks(), [audio]);

  const stream = new MediaStream();
  const events = [];
  stream.addEventListener("active", () => events.push("active"));
  stream.addEventListener("addtrack", (event) => {
    events.push(event.type);
  });
  stream.addEventListener("inactive", () => events.push("inactive"));
  stream.addTrack(audio);
  assert.equal(stream.active, true);
  audio.stop();
  assert.equal(stream.active, false);
  assert.deepEqual(events, ["active", "inactive"]);

  let removedTrack = false;
  stream.addEventListener("removetrack", (event) => {
    removedTrack = event.track === audio;
  });
  stream.removeTrack(audio);
  assert.equal(removedTrack, false);
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

test("addTransceiver reports its single pre-encoded RTP encoding envelope", () => {
  const peer = new RTCPeerConnection();
  try {
    const transceiver = peer.addTransceiver("video", {
      sendEncodings: [
        { rid: "low", active: false },
        { rid: "high", active: true },
      ],
    });
    assert.deepEqual(transceiver.sender.getParameters().encodings, [
      { active: false, scaleResolutionDownBy: 1 },
    ]);
    assert.throws(() => peer.addTransceiver("audio", { sendEncodings: [{ maxBitrate: 64_000 }] }), {
      name: "NotSupportedError",
    });
    assert.throws(
      () => peer.addTransceiver("video", { sendEncodings: [{ scaleResolutionDownBy: 2 }] }),
      { name: "NotSupportedError" },
    );
  } finally {
    peer.close();
  }
});

test("RTP capabilities report fresh packet-transport codec dictionaries", () => {
  assert.equal(RTCRtpSender.getCapabilities.length, 1);
  assert.equal(RTCRtpReceiver.getCapabilities.length, 1);
  assert.equal(RTCRtpSender.getCapabilities("dummy"), null);
  assert.equal(RTCRtpReceiver.getCapabilities("dummy"), null);

  for (const endpointClass of [RTCRtpSender, RTCRtpReceiver]) {
    const audio = endpointClass.getCapabilities("audio");
    const video = endpointClass.getCapabilities("video");
    assert.deepEqual(
      audio.codecs.map((codec) => codec.mimeType),
      ["audio/opus", "audio/PCMA", "audio/PCMU", "audio/G722", "audio/AAC"],
    );
    assert.deepEqual(
      video.codecs.map((codec) => codec.mimeType),
      [
        "video/H264",
        "video/H265",
        "video/VP8",
        "video/VP9",
        "video/AV1",
        "video/rtx",
        "video/red",
        "video/ulpfec",
      ],
    );
    assert.deepEqual(
      audio.headerExtensions,
      audioHeaderExtensionUris.map((uri) => ({ uri })),
    );
    audio.codecs[0].mimeType = "modified";
    audio.headerExtensions[0].uri = "modified";
    assert.equal(endpointClass.getCapabilities("audio").codecs[0].mimeType, "audio/opus");
    assert.equal(
      endpointClass.getCapabilities("audio").headerExtensions[0].uri,
      "urn:ietf:params:rtp-hdrext:sdes:mid",
    );
  }
});

test("reported RTP codecs materialize matching native media descriptions", async () => {
  for (const kind of ["audio", "video"]) {
    for (const codec of RTCRtpSender.getCapabilities(kind).codecs.filter(
      (entry) => !["video/rtx", "video/red", "video/ulpfec"].includes(entry.mimeType),
    )) {
      const peer = new RTCPeerConnection();
      const source = new nonstandard.EncodedMediaSource({
        kind,
        codec: { mimeType: codec.mimeType, payloadType: 96 },
      });
      try {
        peer.addTrack(source.track);
        const offer = await peer.createOffer();
        const encodingName = codec.mimeType.slice(codec.mimeType.indexOf("/") + 1);
        const channels = codec.channels === undefined ? "" : `/${codec.channels}`;
        assert.match(
          offer.sdp,
          new RegExp(`^a=rtpmap:96 ${encodingName}/${codec.clockRate}${channels}$`, "mi"),
        );
      } finally {
        source.close();
        peer.close();
      }
    }
  }
});

test("video offers associate negotiated RTX and expose removable FEC formats", async () => {
  const peer = new RTCPeerConnection();
  try {
    peer.addTransceiver("video");
    const offer = await peer.createOffer();
    const section = offer.sdp.split(/(?=^m=)/m).find((entry) => /^m=video\b/m.test(entry));
    const names = codecNames(offer);
    assert.ok(names.includes("rtx"));
    assert.ok(names.includes("red"));
    assert.ok(names.includes("ulpfec"));
    const rtxMappings = [...section.matchAll(/^a=fmtp:(\d+) apt=(\d+)$/gm)];
    assert.equal(rtxMappings.length, 5);
    for (const match of rtxMappings) {
      assert.match(section, new RegExp(`^a=rtpmap:${match[1]} rtx/90000$`, "mi"));
      assert.match(section, new RegExp(`^a=rtpmap:${match[2]} (?!rtx/)[^/]+/90000$`, "mi"));
    }
  } finally {
    peer.close();
  }
});

function codecNames(description) {
  const section = description.sdp
    .split(/(?=^m=)/m)
    .find((entry) => /^m=(?:audio|video)\b/m.test(entry));
  const payloadTypes = section
    .match(/^m=\S+\s+\d+\s+\S+\s+(.+)$/m)[1]
    .trim()
    .split(/\s+/);
  return payloadTypes.map((payloadType) => {
    const match = new RegExp(`^a=rtpmap:${payloadType} ([^/]+)/`, "mi").exec(section);
    return match?.[1];
  });
}

function remapVideoPayloadType(description, from, to) {
  const sdp = description.sdp
    .split("\r\n")
    .map((line) => {
      if (line.startsWith("m=video ")) {
        const fields = line.split(" ");
        return fields
          .map((field, index) => (index >= 3 && field === String(from) ? to : field))
          .join(" ");
      }
      return line.replace(
        new RegExp(`^(a=(?:rtpmap|rtcp-fb|fmtp):)${from}(?=\\s)`),
        (_match, prefix) => `${prefix}${to}`,
      );
    })
    .join("\r\n");
  return { type: description.type, sdp };
}

test("codec preferences validate, persist, and update native offer order", async () => {
  const peer = new RTCPeerConnection();
  try {
    const transceiver = peer.addTransceiver("video");
    assert.equal(transceiver.setCodecPreferences.length, 1);
    const capabilities = RTCRtpReceiver.getCapabilities("video").codecs;
    const vp8 = capabilities.find((codec) => codec.mimeType === "video/VP8");
    const h264 = capabilities.find((codec) => codec.mimeType === "video/H264");

    transceiver.setCodecPreferences([vp8, vp8, h264]);
    const preferred = await peer.createOffer();
    assert.deepEqual(codecNames(preferred), ["VP8", "H264"]);
    await peer.setLocalDescription(preferred);
    await peer.setLocalDescription({ type: "rollback" });
    assert.deepEqual(codecNames(await peer.createOffer()), ["VP8", "H264"]);

    assert.throws(() => transceiver.setCodecPreferences([{ ...vp8, clockRate: 45_000 }]), {
      name: "InvalidModificationError",
    });
    assert.throws(
      () => transceiver.setCodecPreferences([{ mimeType: "video/rtx", clockRate: 90_000 }]),
      { name: "InvalidModificationError" },
    );

    transceiver.setCodecPreferences([]);
    assert.equal(codecNames(await peer.createOffer())[0], "H264");
  } finally {
    peer.close();
  }
});

test("explicit local offers retain their generated codec mapping", async () => {
  const peer = new RTCPeerConnection();
  try {
    const transceiver = peer.addTransceiver("video");
    const capabilities = RTCRtpReceiver.getCapabilities("video").codecs;
    const vp8 = capabilities.find((codec) => codec.mimeType === "video/VP8");
    const h264 = capabilities.find((codec) => codec.mimeType === "video/H264");
    transceiver.setCodecPreferences([vp8, h264]);
    const offer = await peer.createOffer();

    transceiver.setCodecPreferences([h264]);
    await peer.setLocalDescription(offer);
    assert.deepEqual(codecNames(peer.localDescription), ["VP8", "H264"]);
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.deepEqual(codecNames(peer.localDescription), ["VP8", "H264"]);

    await peer.setLocalDescription({ type: "rollback" });
    assert.deepEqual(codecNames(await peer.createOffer()), ["H264"]);
  } finally {
    peer.close();
  }
});

test("answer codec preferences intersect the offer in answerer order", async () => {
  const offerer = new RTCPeerConnection();
  const answerer = new RTCPeerConnection();
  try {
    const offererTransceiver = offerer.addTransceiver("video");
    const capabilities = RTCRtpReceiver.getCapabilities("video").codecs;
    const vp8 = capabilities.find((codec) => codec.mimeType === "video/VP8");
    const h264 = capabilities.find((codec) => codec.mimeType === "video/H264");
    const av1 = capabilities.find((codec) => codec.mimeType === "video/AV1");
    offererTransceiver.setCodecPreferences([vp8, av1]);
    await offerer.setLocalDescription(await offerer.createOffer());
    await answerer.setRemoteDescription(offerer.localDescription);

    const answererTransceiver = answerer.getTransceivers()[0];
    answererTransceiver.setCodecPreferences([h264, av1, vp8]);
    const answer = await answerer.createAnswer();
    assert.deepEqual(codecNames(answer), ["AV1", "VP8"]);
    answererTransceiver.setCodecPreferences([vp8]);
    await answerer.setLocalDescription(answer);
    assert.deepEqual(codecNames(answerer.localDescription), ["AV1", "VP8"]);
    await offerer.setRemoteDescription(answerer.localDescription);
    assert.deepEqual(
      answererTransceiver.receiver
        .getParameters()
        .codecs.map((codec) => codec.mimeType.slice("video/".length)),
      ["AV1", "VP8"],
    );
  } finally {
    offerer.close();
    answerer.close();
  }
});

test("encoded sources reject codec preferences that exclude their packet codec", async () => {
  const peer = new RTCPeerConnection();
  const source = new nonstandard.EncodedMediaSource({
    kind: "video",
    codec: { mimeType: "video/VP8", payloadType: 96 },
  });
  try {
    const transceiver = peer.addTransceiver(source.track);
    const h264 = RTCRtpSender.getCapabilities("video").codecs.find(
      (codec) => codec.mimeType === "video/H264",
    );
    transceiver.setCodecPreferences([h264]);
    await assert.rejects(peer.createOffer(), { name: "OperationError" });
  } finally {
    source.close();
    peer.close();
  }
});

test("encoded answer sources reject conflicting offered payload mappings", async () => {
  const offerer = new RTCPeerConnection();
  const answerer = new RTCPeerConnection();
  const source = new nonstandard.EncodedMediaSource({
    kind: "video",
    codec: { mimeType: "video/VP8", payloadType: 96 },
  });
  try {
    const transceiver = offerer.addTransceiver("video", { direction: "recvonly" });
    const vp8 = RTCRtpSender.getCapabilities("video").codecs.find(
      (codec) => codec.mimeType === "video/VP8",
    );
    transceiver.setCodecPreferences([vp8]);
    const offer = remapVideoPayloadType(await offerer.createOffer(), 96, 120);

    answerer.addTrack(source.track);
    await answerer.setRemoteDescription(offer);
    await assert.rejects(answerer.createAnswer(), { name: "OperationError" });
  } finally {
    source.close();
    offerer.close();
    answerer.close();
  }
});

test("answerers preserve offered payload mappings when they later create offers", async () => {
  const offerer = new RTCPeerConnection();
  const answerer = new RTCPeerConnection();
  try {
    const transceiver = offerer.addTransceiver("video", { direction: "recvonly" });
    const vp8 = RTCRtpSender.getCapabilities("video").codecs.find(
      (codec) => codec.mimeType === "video/VP8",
    );
    transceiver.setCodecPreferences([vp8]);
    const offer = remapVideoPayloadType(await offerer.createOffer(), 96, 120);

    await answerer.setRemoteDescription(offer);
    await answerer.setLocalDescription(await answerer.createAnswer());
    assert.match(answerer.localDescription.sdp, /^a=rtpmap:120 VP8\/90000$/im);
    const reoffer = await answerer.createOffer();
    assert.match(reoffer.sdp, /^a=rtpmap:120 VP8\/90000$/im);
    assert.doesNotMatch(reoffer.sdp, /^a=rtpmap:96 VP8\/90000$/im);
  } finally {
    offerer.close();
    answerer.close();
  }
});

test("receiver parameters populate from the committed answer", async () => {
  const offerer = new RTCPeerConnection();
  const answerer = new RTCPeerConnection();
  try {
    const offererReceiver = offerer.addTransceiver("audio").receiver;
    assert.deepEqual(offererReceiver.getParameters(), {
      headerExtensions: [],
      rtcp: { reducedSize: false },
      codecs: [],
    });

    await offerer.setLocalDescription(await offerer.createOffer());
    await answerer.setRemoteDescription(offerer.localDescription);
    const answererReceiver = answerer.getReceivers()[0];
    assert.deepEqual(answererReceiver.getParameters().codecs, []);
    assert.deepEqual(answererReceiver.getParameters().headerExtensions, []);

    await answerer.setLocalDescription(await answerer.createAnswer());
    const answererParameters = answererReceiver.getParameters();
    assert.equal(answererParameters.codecs[0].mimeType, "audio/opus");
    assert.deepEqual(answererParameters.headerExtensions, expectedAudioHeaderExtensionParameters());
    assert.deepEqual(answererParameters.rtcp, { reducedSize: false });
    assert.equal(answererParameters.transactionId, undefined);
    assert.equal(answererParameters.encodings, undefined);

    await offerer.setRemoteDescription(answerer.localDescription);
    const offererParameters = offererReceiver.getParameters();
    assert.equal(offererParameters.codecs[0].mimeType, "audio/opus");
    assert.deepEqual(offererParameters.headerExtensions, answererParameters.headerExtensions);

    answererParameters.codecs[0].mimeType = "modified";
    answererParameters.headerExtensions[0].uri = "modified";
    assert.equal(answererReceiver.getParameters().codecs[0].mimeType, "audio/opus");
    assert.equal(
      answererReceiver.getParameters().headerExtensions[0].uri,
      "urn:ietf:params:rtp-hdrext:sdes:mid",
    );
  } finally {
    offerer.close();
    answerer.close();
  }
});

test("closing a peer moves transceivers to their terminal state", () => {
  const peer = new RTCPeerConnection();
  const transceiver = peer.addTransceiver("audio");
  peer.close();
  assert.equal(transceiver.stopped, true);
  assert.equal(transceiver.stopping, false);
  assert.equal(transceiver.currentDirection, "stopped");
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

test("setStreams associates trackless senders with remote streams", async () => {
  const offerer = new RTCPeerConnection();
  const answerer = new RTCPeerConnection();
  try {
    const transceiver = offerer.addTransceiver("audio");
    const initialTrackEvent = waitFor(answerer, "track");
    await negotiate(offerer, answerer);
    const initial = await initialTrackEvent;
    assert.deepEqual(initial.streams, []);

    const first = new MediaStream();
    const second = new MediaStream();
    const updatedTrackEvent = waitFor(answerer, "track");
    transceiver.sender.setStreams(first, second);
    await negotiate(offerer, answerer);
    const updated = await updatedTrackEvent;
    assert.equal(updated.track, initial.track);
    assert.deepEqual(
      updated.streams.map((stream) => stream.id),
      [first.id, second.id],
    );
  } finally {
    offerer.close();
    answerer.close();
  }
});

test("setStreams applies when a trackless transceiver becomes active", async () => {
  const offerer = new RTCPeerConnection();
  const answerer = new RTCPeerConnection();
  try {
    const transceiver = offerer.addTransceiver("audio", { direction: "inactive" });
    await negotiate(offerer, answerer);

    const first = new MediaStream();
    const second = new MediaStream();
    const trackEvent = waitFor(answerer, "track");
    transceiver.direction = "sendrecv";
    transceiver.sender.setStreams(first, second);
    await negotiate(offerer, answerer);
    assert.deepEqual(
      (await trackEvent).streams.map((stream) => stream.id),
      [first.id, second.id],
    );
  } finally {
    offerer.close();
    answerer.close();
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
    let removedTrack = null;
    initial.streams[0].addEventListener("removetrack", (event) => {
      removedTrack = event.track;
    });

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
    assert.equal(removedTrack, updated.track);
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

test("remote offers do not associate addTransceiver-created transceivers", async () => {
  const offerer = new RTCPeerConnection();
  const answerer = new RTCPeerConnection();
  try {
    offerer.addTransceiver("audio");
    offerer.addTransceiver("video");
    await offerer.setLocalDescription(await offerer.createOffer());

    const explicit = answerer.addTransceiver("video");
    const negotiationNeeded = new Promise((resolve) =>
      answerer.addEventListener("negotiationneeded", resolve, { once: true }),
    );
    await Promise.all([
      answerer.setRemoteDescription(offerer.localDescription),
      answerer.setLocalDescription(),
    ]);
    await negotiationNeeded;

    assert.equal(explicit.mid, null);
    assert.equal(explicit.currentDirection, null);
    assert.equal(answerer.getTransceivers().length, 3);
    assert.deepEqual(
      answerer
        .getTransceivers()
        .slice(1)
        .map((transceiver) => [transceiver.receiver.track.kind, transceiver.mid]),
      [
        ["audio", "media-0"],
        ["video", "media-1"],
      ],
    );
    assert.equal((answerer.localDescription.sdp.match(/^m=/gm) || []).length, 2);
  } finally {
    offerer.close();
    answerer.close();
  }
});

test("remote offer track events complete in media-section order", async () => {
  const offerer = new RTCPeerConnection();
  const answerer = new RTCPeerConnection();
  try {
    for (const kind of ["audio", "video", "video", "audio"]) {
      offerer.addTransceiver(kind);
    }
    const kinds = [];
    answerer.addEventListener("track", (event) => kinds.push(event.track.kind));

    await answerer.setRemoteDescription(await offerer.createOffer());

    assert.deepEqual(kinds, ["audio", "video", "video", "audio"]);
    assert.equal(answerer.getTransceivers().length, 4);
  } finally {
    offerer.close();
    answerer.close();
  }
});

test("track events follow receiving transitions on existing media sections", async () => {
  const first = new RTCPeerConnection();
  const second = new RTCPeerConnection();
  try {
    const local = first.addTransceiver(track(), { direction: "sendrecv" });
    await first.setLocalDescription(await first.createOffer());
    await second.setRemoteDescription(first.localDescription);
    second.addTrack(track());

    const answerTrack = waitFor(first, "track");
    await second.setLocalDescription(await second.createAnswer());
    await first.setRemoteDescription(second.localDescription);
    assert.equal((await answerTrack).transceiver, local);

    local.direction = "inactive";
    await negotiate(first, second);
    local.direction = "sendrecv";
    const resumedTrack = waitFor(second, "track");
    await negotiate(first, second);
    assert.equal((await resumedTrack).transceiver, second.getTransceivers()[0]);
  } finally {
    first.close();
    second.close();
  }
});

test("sender parameters preserve encodings and expose negotiated SDP facts", async () => {
  const offerer = new RTCPeerConnection();
  const answerer = new RTCPeerConnection();
  try {
    const sender = offerer.addTransceiver(track(), {
      sendEncodings: [{ rid: "primary", active: false }],
    }).sender;
    const initial = sender.getParameters();
    assert.deepEqual(initial.encodings, [{ active: false }]);
    assert.deepEqual(initial.codecs, []);
    assert.deepEqual(initial.headerExtensions, []);
    initial.encodings[0].active = true;
    assert.equal(sender.getParameters().encodings[0].active, false);

    await negotiate(offerer, answerer);
    const negotiated = sender.getParameters();
    assert.ok(negotiated.codecs.length > 0);
    assert.match(negotiated.codecs[0].mimeType, /^audio\//);
    assert.deepEqual(negotiated.headerExtensions, expectedAudioHeaderExtensionParameters());
    assert.equal(negotiated.transactionId, sender.getParameters().transactionId);
    assert.equal(typeof negotiated.rtcp.cname, "string");
    assert.ok(negotiated.rtcp.cname.length > 0);
    await waitForWebRtcTask();
    assert.notEqual(negotiated.transactionId, sender.getParameters().transactionId);
  } finally {
    offerer.close();
    answerer.close();
  }
});

test("sender parameter transactions validate task lifetime and immutable fields", async () => {
  const peer = new RTCPeerConnection();
  try {
    const sender = peer.addTransceiver("audio").sender;
    const first = sender.getParameters();
    const second = sender.getParameters();
    assert.notEqual(first, second);
    assert.equal(first.transactionId, second.transactionId);
    first.encodings[0].active = false;
    assert.equal(second.encodings[0].active, true);
    await undefined;
    assert.equal(first.transactionId, sender.getParameters().transactionId);

    await waitForWebRtcTask();
    await assert.rejects(sender.setParameters(first), { name: "InvalidStateError" });

    const modified = sender.getParameters();
    modified.rtcp.cname = `${modified.rtcp.cname}-modified`;
    await assert.rejects(sender.setParameters(modified), { name: "InvalidModificationError" });

    const unsupported = sender.getParameters();
    unsupported.encodings[0].maxBitrate = 64_000;
    await assert.rejects(sender.setParameters(unsupported), { name: "OperationError" });
  } finally {
    peer.close();
  }
});

test("sender parameter transactions expire before a later WebRTC task", async () => {
  const peer = new RTCPeerConnection();
  const taskPeer = new RTCPeerConnection();
  try {
    const sender = peer.addTransceiver("audio").sender;
    const parameters = sender.getParameters();
    const firstUpdate = sender.setParameters(parameters);
    const negotiationNeeded = waitFor(taskPeer, "negotiationneeded");
    taskPeer.addTransceiver("audio");

    await negotiationNeeded;
    await firstUpdate;
    await assert.rejects(sender.setParameters(parameters), { name: "InvalidStateError" });
  } finally {
    peer.close();
    taskPeer.close();
  }
});

test("sender parameters use the peer CNAME written to local SDP", async () => {
  const peer = new RTCPeerConnection();
  try {
    const audioSender = peer.addTransceiver(track("audio")).sender;
    const videoSender = peer.addTransceiver(track("video")).sender;
    const cname = audioSender.getParameters().rtcp.cname;
    assert.equal(videoSender.getParameters().rtcp.cname, cname);
    const offer = await peer.createOffer();
    const advertisedCnames = [...offer.sdp.matchAll(/^a=ssrc:\d+ cname:(\S+)$/gm)].map((match) =>
      match[1].replace(/\r$/, ""),
    );
    assert.ok(advertisedCnames.length >= 2);
    assert.deepEqual(new Set(advertisedCnames), new Set([cname]));
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

async function waitForWebRtcTask() {
  const peer = new RTCPeerConnection();
  try {
    const negotiationNeeded = waitFor(peer, "negotiationneeded");
    peer.addTransceiver("audio");
    await negotiationNeeded;
  } finally {
    peer.close();
  }
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
    assert.equal(remoteTransceiver.stopping, false);
    assert.equal(remoteTransceiver.stopped, true);
    assert.equal(remoteTransceiver.currentDirection, "stopped");
    assert.deepEqual(answerer.getTransceivers(), []);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(remoteTransceiver.receiver.track.readyState, "ended");
    assert.equal(receiverClone.readyState, "ended");
  } finally {
    offerer.close();
    answerer.close();
  }
});

test("locally stopped transceivers disassociate only after answer application", async () => {
  for (const kind of ["audio", "video"]) {
    const offerer = new RTCPeerConnection();
    const answerer = new RTCPeerConnection();
    try {
      const transceiver = offerer.addTransceiver(kind);
      await negotiate(offerer, answerer);
      const associatedMid = transceiver.mid;
      assert.notEqual(associatedMid, null);

      transceiver.stop();
      await offerer.setLocalDescription();
      assert.equal(transceiver.stopping, true);
      assert.equal(transceiver.stopped, false);
      assert.equal(transceiver.mid, associatedMid);

      await answerer.setRemoteDescription(offerer.localDescription);
      await answerer.setLocalDescription();
      await offerer.setRemoteDescription(answerer.localDescription);
      assert.equal(transceiver.stopping, false);
      assert.equal(transceiver.stopped, true);
      assert.equal(transceiver.currentDirection, "stopped");
      assert.equal(transceiver.mid, null);
    } finally {
      offerer.close();
      answerer.close();
    }
  }
});

test("local offer MID assignment rolls back only the current negotiation round", async () => {
  const offerer = new RTCPeerConnection();
  const answerer = new RTCPeerConnection();
  try {
    const first = offerer.addTransceiver("audio");
    const initialOffer = await offerer.createOffer();
    assert.equal(first.mid, null);
    await offerer.setLocalDescription(initialOffer);
    assert.notEqual(first.mid, null);
    await answerer.setRemoteDescription(offerer.localDescription);
    await answerer.setLocalDescription(await answerer.createAnswer());
    await offerer.setRemoteDescription(answerer.localDescription);
    const committedMid = first.mid;

    const second = offerer.addTransceiver("video");
    const nextOffer = await offerer.createOffer();
    assert.equal(second.mid, null);
    await offerer.setLocalDescription(nextOffer);
    assert.notEqual(second.mid, null);
    await offerer.setLocalDescription({ type: "rollback" });
    assert.equal(first.mid, committedMid);
    assert.equal(second.mid, null);
  } finally {
    offerer.close();
    answerer.close();
  }
});

test("remote answer rejection leaves a non-stopping transceiver inactive", async () => {
  const offerer = new RTCPeerConnection();
  const answerer = new RTCPeerConnection();
  try {
    const offered = offerer.addTransceiver("audio");
    await offerer.setLocalDescription(await offerer.createOffer());
    await answerer.setRemoteDescription(offerer.localDescription);
    answerer.getTransceivers()[0].stop();
    await answerer.setLocalDescription(await answerer.createAnswer());
    await offerer.setRemoteDescription(answerer.localDescription);

    assert.equal(offered.stopped, false);
    assert.equal(offered.stopping, false);
    assert.equal(offered.currentDirection, "inactive");
    assert.deepEqual(offerer.getTransceivers(), [offered]);
  } finally {
    offerer.close();
    answerer.close();
  }
});

test("rejected remote media sections remain available for m-line recycling", async () => {
  const peer = new RTCPeerConnection();
  let trackEvents = 0;
  const rejectedVideoOffer = {
    type: "offer",
    sdp: [
      "v=0",
      "o=- 0 3 IN IP4 127.0.0.1",
      "s=-",
      "t=0 0",
      "a=fingerprint:sha-256 A7:24:72:CA:6E:02:55:39:BA:66:DF:6E:CC:4C:D8:B0:1A:BF:1A:56:65:7D:F4:03:AD:7E:77:43:2A:29:EC:93",
      "m=video 0 UDP/TLS/RTP/SAVPF 100",
      "c=IN IP4 0.0.0.0",
      "a=rtcp-mux",
      "a=sendonly",
      "a=mid:video",
      "a=rtpmap:100 VP8/90000",
      "a=setup:actpass",
      "a=ice-ufrag:ETEn",
      "a=ice-pwd:OtSK0WpNtpUjkY4+86js7Z/l",
      "",
    ].join("\r\n"),
  };
  try {
    peer.ontrack = () => {
      trackEvents += 1;
    };
    await peer.setRemoteDescription(rejectedVideoOffer);
    assert.equal(peer.getTransceivers().length, 1);
    assert.equal(trackEvents, 0);
    await peer.setLocalDescription();
    assert.deepEqual(peer.getTransceivers(), []);

    const preserved = await peer.createOffer();
    assert.equal((preserved.sdp.match(/^m=/gm) || []).length, 1);
    assert.match(preserved.sdp, /^m=video 0 /m);

    peer.addTransceiver("audio");
    const recycled = await peer.createOffer();
    assert.equal((recycled.sdp.match(/^m=/gm) || []).length, 1);
    assert.match(recycled.sdp, /^m=audio (?!0 )/m);
  } finally {
    peer.close();
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
