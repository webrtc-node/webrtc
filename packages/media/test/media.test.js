"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { RTCPeerConnection } = require("@webrtc-node/webrtc");
const { EncodedTrack, MediaSession } = require("..");

function waitFor(target, type, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      target.removeEventListener(type, onEvent);
      reject(new Error(`Timed out waiting for ${type}`));
    }, timeout);
    function onEvent(event) {
      clearTimeout(timer);
      target.removeEventListener(type, onEvent);
      resolve(event);
    }
    target.addEventListener(type, onEvent);
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

function rtpPacket() {
  return Uint8Array.from([0x80, 96, 0, 1, 0, 0, 0, 1, 0, 0, 0, 42, 1, 2, 3, 4]);
}

test("MediaSession creates an encoded video track that participates in SDP", async () => {
  const peer = new RTCPeerConnection();
  const session = new MediaSession(peer);
  try {
    const track = session.addTrack({
      kind: "video",
      mid: "camera",
      direction: "sendonly",
      codec: { mimeType: "video/VP8", payloadType: 96 },
      ssrc: 42,
    });
    assert.ok(track instanceof EncodedTrack);
    assert.equal(track.mid, "camera");
    assert.equal(track.readyState, "connecting");
    assert.deepEqual(session.getTracks(), [track]);
    const offer = await peer.createOffer();
    assert.match(offer.sdp, /m=video 9 UDP\/TLS\/RTP\/SAVPF 96/);
    assert.match(offer.sdp, /a=mid:camera/);
    assert.match(offer.sdp, /a=rtpmap:96 VP8\/90000/i);
  } finally {
    session.close();
    peer.close();
  }
});

test("MediaSession validates codecs, payload types, mids, and duplicates", () => {
  const peer = new RTCPeerConnection();
  const session = new MediaSession(peer);
  try {
    assert.throws(() => session.addTrack({ kind: "text" }), /kind/);
    assert.throws(
      () =>
        session.addTrack({
          kind: "audio",
          mid: "audio",
          codec: { mimeType: "video/VP8", payloadType: 96 },
        }),
      /codec/,
    );
    session.addTrack({
      kind: "audio",
      mid: "audio",
      codec: { mimeType: "audio/opus", payloadType: 111 },
    });
    assert.throws(
      () =>
        session.addTrack({
          kind: "audio",
          mid: "audio",
          codec: { mimeType: "audio/opus", payloadType: 111 },
        }),
      /exists/,
    );
  } finally {
    session.close();
    peer.close();
  }
});

test("encoded tracks exchange RTP through DTLS-SRTP", async () => {
  const offerer = new RTCPeerConnection();
  const answerer = new RTCPeerConnection();
  const outgoing = new MediaSession(offerer);
  const incoming = new MediaSession(answerer);
  try {
    const sender = outgoing.addTrack({
      kind: "video",
      mid: "video",
      direction: "sendonly",
      codec: { mimeType: "video/VP8", payloadType: 96 },
      ssrc: 42,
    });
    const receiver = incoming.addTrack({
      kind: "video",
      mid: "video",
      direction: "recvonly",
      codec: { mimeType: "video/VP8", payloadType: 96 },
    });
    const senderOpen = waitFor(sender, "open");
    const receiverOpen = waitFor(receiver, "open");
    await negotiate(offerer, answerer);
    await Promise.all([senderOpen, receiverOpen]);

    const received = waitFor(receiver, "message");
    const packet = rtpPacket();
    assert.equal(sender.send(packet), true);
    const event = await received;
    assert.deepEqual(new Uint8Array(event.data), packet);
  } finally {
    outgoing.close();
    incoming.close();
    offerer.close();
    answerer.close();
  }
});
