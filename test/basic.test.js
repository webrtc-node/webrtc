const assert = require("node:assert/strict");
const test = require("node:test");
const {
  RTCPeerConnection,
  RTCDtlsTransport,
  RTCIceTransport,
  RTCSctpTransport,
  RTCCertificate,
  RTCDataChannelEvent,
  RTCIceCandidate,
  RTCIceCandidatePair,
  RTCSessionDescription,
  RTCPeerConnectionIceErrorEvent,
} = require("..");

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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForOpen(channel) {
  return channel.readyState === "open" ? Promise.resolve() : waitFor(channel, "open");
}

async function waitForState(target, state) {
  while (target.state !== state) await waitFor(target, "statechange");
}

async function waitForSctpConnected(...peerConnections) {
  await Promise.all(
    peerConnections.map(async (peerConnection) => {
      while (peerConnection.sctp?.state !== "connected") {
        await waitFor(peerConnection.sctp, "statechange");
      }
    }),
  );
}

async function waitForIceGatheringComplete(peerConnection) {
  while (peerConnection.iceGatheringState !== "complete") {
    await waitFor(peerConnection, "icegatheringstatechange");
  }
}

function candidateTransportEndpoint(candidate) {
  return {
    component: candidate.component,
    protocol: candidate.protocol,
    port: candidate.port,
  };
}

function collectMessages(channel, count, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const messages = [];
    const timer = setTimeout(() => {
      channel.removeEventListener("message", onMessage);
      reject(new Error(`Timed out waiting for ${count} messages`));
    }, timeout);
    function onMessage(event) {
      messages.push(event.data);
      if (messages.length === count) {
        clearTimeout(timer);
        channel.removeEventListener("message", onMessage);
        resolve(messages);
      }
    }
    channel.addEventListener("message", onMessage);
  });
}

async function addIceCandidateBestEffort(peerConnection, candidate) {
  try {
    await peerConnection.addIceCandidate(candidate);
  } catch {
    // ICE restart can leave older gathered candidates in flight. Unit helpers
    // mirror browser-style candidate exchange and keep those races non-fatal.
  }
}

function exchangeIceCandidates(offerer, answerer) {
  offerer.addEventListener("icecandidate", (event) => {
    if (event.candidate && answerer.signalingState !== "closed") {
      addIceCandidateBestEffort(answerer, event.candidate);
    }
  });

  answerer.addEventListener("icecandidate", (event) => {
    if (event.candidate && offerer.signalingState !== "closed") {
      addIceCandidateBestEffort(offerer, event.candidate);
    }
  });
}

async function exchangeSessionDescriptions(offerer, answerer) {
  const offer = await offerer.createOffer();
  await offerer.setLocalDescription(offer);
  await answerer.setRemoteDescription(offerer.localDescription);

  const answer = await answerer.createAnswer();
  await answerer.setLocalDescription(answer);
  await offerer.setRemoteDescription(answerer.localDescription);
}

async function exchangeOfferAnswer(offerer, answerer) {
  const offererCandidates = [];
  const answererCandidates = [];

  offerer.onicecandidate = (event) => {
    if (!event.candidate) return;
    if (answerer.remoteDescription) {
      addIceCandidateBestEffort(answerer, event.candidate);
    } else {
      offererCandidates.push(event.candidate);
    }
  };

  answerer.onicecandidate = (event) => {
    if (!event.candidate) return;
    if (offerer.remoteDescription) {
      addIceCandidateBestEffort(offerer, event.candidate);
    } else {
      answererCandidates.push(event.candidate);
    }
  };

  const offer = await offerer.createOffer();
  await offerer.setLocalDescription(offer);
  await answerer.setRemoteDescription(offerer.localDescription);
  for (const candidate of offererCandidates.splice(0)) {
    await addIceCandidateBestEffort(answerer, candidate);
  }

  const answer = await answerer.createAnswer();
  await answerer.setLocalDescription(answer);
  await offerer.setRemoteDescription(answerer.localDescription);
  for (const candidate of answererCandidates.splice(0)) {
    await addIceCandidateBestEffort(offerer, candidate);
  }
}

function closeAll(...peers) {
  for (const peer of peers) {
    try {
      peer?.close();
    } catch {
      // Tests should not leak native peers when an earlier assertion fails.
    }
  }
}

async function closeAllAndWait(...peers) {
  closeAll(...peers);
  await delay(process.platform === "win32" ? 100 : 50);
}

test("RTCSessionDescription and RTCIceCandidate expose WebRTC-shaped JSON", () => {
  const description = new RTCSessionDescription({ type: "offer", sdp: "v=0\r\n" });
  assert.deepEqual(description.toJSON(), { type: "offer", sdp: "v=0\r\n" });

  const candidate = new RTCIceCandidate({
    candidate: "candidate:1 1 UDP 1 127.0.0.1 9 typ host",
    sdpMid: "0",
  });
  assert.equal(candidate.candidate.includes("candidate:1"), true);
  assert.equal(candidate.sdpMid, "0");
});

test("createDataChannel exposes core W3C attributes before negotiation", () => {
  const pc = new RTCPeerConnection();
  const dc = pc.createDataChannel("chat", {
    ordered: false,
    maxRetransmits: 3,
    protocol: "test-protocol",
  });

  assert.equal(dc.label, "chat");
  assert.equal(dc.ordered, false);
  assert.equal(dc.maxRetransmits, 3);
  assert.equal(dc.protocol, "test-protocol");
  assert.equal(dc.negotiated, false);
  assert.equal(dc.readyState, "connecting");
  assert.equal(dc.binaryType, "arraybuffer");
  assert.equal(dc.bufferedAmount, 0);
  assert.equal(dc.id, null);
  pc.close();
});

test("RTCDataChannel bufferedAmountLowThreshold uses unsigned long conversion", () => {
  const pc = new RTCPeerConnection();
  const dc = pc.createDataChannel("threshold");

  dc.bufferedAmountLowThreshold = 5.9;
  assert.equal(dc.bufferedAmountLowThreshold, 5);
  dc.bufferedAmountLowThreshold = -1;
  assert.equal(dc.bufferedAmountLowThreshold, 4294967295);
  dc.bufferedAmountLowThreshold = 4294967296;
  assert.equal(dc.bufferedAmountLowThreshold, 0);
  dc.bufferedAmountLowThreshold = 4294967297;
  assert.equal(dc.bufferedAmountLowThreshold, 1);
  dc.bufferedAmountLowThreshold = Number.NaN;
  assert.equal(dc.bufferedAmountLowThreshold, 0);

  assert.throws(() => {
    dc.bufferedAmountLowThreshold = 1n;
  }, TypeError);
  assert.throws(() => {
    dc.bufferedAmountLowThreshold = Symbol("threshold");
  }, TypeError);

  pc.close();
});

test("RTCDataChannelEvent requires and exposes a channel", () => {
  const pc = new RTCPeerConnection();
  const dc = pc.createDataChannel("events");
  const event = new RTCDataChannelEvent("datachannel", { channel: dc });
  assert.equal(event.channel, dc);
  assert.throws(() => new RTCDataChannelEvent("datachannel", {}), TypeError);
  pc.close();
});

test("RTCPeerConnectionIceErrorEvent exposes ICE error details", () => {
  const event = new RTCPeerConnectionIceErrorEvent("icecandidateerror", {
    address: "192.0.2.1",
    port: 3478,
    url: "turn:turn.example.org",
    errorCode: 701,
    errorText: "server unreachable",
  });

  assert.equal(event.type, "icecandidateerror");
  assert.equal(event.address, "192.0.2.1");
  assert.equal(event.port, 3478);
  assert.equal(event.url, "turn:turn.example.org");
  assert.equal(event.errorCode, 701);
  assert.equal(event.errorText, "server unreachable");
});

test("RTCPeerConnection exposes the icecandidateerror handler attribute", () => {
  const pc = new RTCPeerConnection();
  let received = null;

  assert.equal(pc.onicecandidateerror, null);
  pc.onicecandidateerror = (event) => {
    received = event;
  };
  pc.dispatchEvent(
    new RTCPeerConnectionIceErrorEvent("icecandidateerror", {
      errorCode: 701,
      errorText: "server unreachable",
    }),
  );

  assert.equal(received instanceof RTCPeerConnectionIceErrorEvent, true);
  assert.equal(received.errorCode, 701);
  pc.close();
});

test("generateCertificate returns a native-backed RTCCertificate", async (t) => {
  const certificate = await RTCPeerConnection.generateCertificate({
    name: "ECDSA",
    namedCurve: "P-256",
  });
  const fingerprints = certificate.getFingerprints();

  assert.equal(certificate instanceof RTCCertificate, true);
  assert.equal(certificate.expires > Date.now(), true);
  assert.equal(fingerprints.length >= 1, true);
  assert.match(fingerprints[0].value, /^([0-9a-f]{2}:)+[0-9a-f]{2}$/);

  const pc = new RTCPeerConnection({ certificates: [certificate] });
  t.after(() => closeAllAndWait(pc));
  pc.createDataChannel("cert");
  const offer = await pc.createOffer();
  assert.match(
    offer.sdp,
    new RegExp(`a=fingerprint:${fingerprints[0].algorithm} ${fingerprints[0].value.toUpperCase()}`),
  );
  pc.close();
});

test("createDataChannel rejects duplicate negotiated ids until the channel closes", async (t) => {
  const pc = new RTCPeerConnection();
  t.after(() => closeAllAndWait(pc));
  const first = pc.createDataChannel("first", { negotiated: true, id: 7 });

  assert.throws(
    () => pc.createDataChannel("duplicate", { negotiated: true, id: 7 }),
    (error) => error.name === "OperationError",
  );

  const closed = waitFor(first, "close");
  first.close();
  await closed;

  const reused = pc.createDataChannel("reused", { negotiated: true, id: 7 });
  assert.equal(reused.id, 7);
  pc.close();
});

test("createDataChannel preserves W3C high negotiated id construction", () => {
  const pc = new RTCPeerConnection();
  const channel = pc.createDataChannel("high-id", { negotiated: true, id: 65534 });

  assert.equal(channel.id, 65534);
  assert.equal(channel.negotiated, true);
  assert.equal(channel.readyState, "connecting");
  assert.throws(
    () => pc.createDataChannel("duplicate-high-id", { negotiated: true, id: 65534 }),
    (error) => error.name === "OperationError",
  );

  pc.close();
});

test("restartIce renegotiates without closing data channels", async (t) => {
  const offerer = new RTCPeerConnection();
  const answerer = new RTCPeerConnection();
  t.after(() => closeAllAndWait(offerer, answerer));
  const local = offerer.createDataChannel("restart");
  const remotePromise = waitFor(answerer, "datachannel");
  exchangeIceCandidates(offerer, answerer);

  await exchangeSessionDescriptions(offerer, answerer);
  const remote = (await remotePromise).channel;
  await waitForOpen(local);
  await waitForOpen(remote);

  offerer.restartIce();
  await exchangeSessionDescriptions(offerer, answerer);

  assert.notEqual(local.readyState, "closed");
  assert.notEqual(remote.readyState, "closed");

  offerer.close();
  answerer.close();
});

test("restartIce has no effect after close", () => {
  const pc = new RTCPeerConnection();
  pc.close();
  assert.doesNotThrow(() => pc.restartIce());
});

test("transport facades are created by RTCPeerConnection, not public constructors", () => {
  assert.throws(() => new RTCIceTransport(), TypeError);
  assert.throws(() => new RTCDtlsTransport(), TypeError);
  assert.throws(() => new RTCSctpTransport(), TypeError);
});

test("data-channel DTLS transport is new before remote description", async (t) => {
  const pc = new RTCPeerConnection();
  t.after(() => closeAllAndWait(pc));
  pc.createDataChannel("dtls-state");

  await pc.setLocalDescription();

  assert.equal(pc.sctp instanceof RTCSctpTransport, true);
  assert.equal(pc.sctp.state, "connecting");
  assert.equal(pc.sctp.transport.state, "new");
  assert.deepEqual(pc.sctp.transport.getRemoteCertificates(), []);

  pc.close();
});

test("data-channel negotiation exposes an SCTP transport facade", async (t) => {
  const offerer = new RTCPeerConnection();
  const answerer = new RTCPeerConnection();
  t.after(() => closeAllAndWait(offerer, answerer));
  offerer.createDataChannel("sctp");

  assert.equal(offerer.sctp, null);
  await exchangeOfferAnswer(offerer, answerer);

  assert.equal(offerer.sctp instanceof RTCSctpTransport, true);
  assert.equal(answerer.sctp instanceof RTCSctpTransport, true);
  assert.equal(offerer.sctp.transport instanceof RTCDtlsTransport, true);
  assert.equal(answerer.sctp.transport instanceof RTCDtlsTransport, true);
  assert.equal(offerer.sctp.transport.iceTransport instanceof RTCIceTransport, true);
  assert.equal(answerer.sctp.transport.iceTransport instanceof RTCIceTransport, true);
  assert.equal(offerer.sctp.transport.iceTransport.role, "controlling");
  assert.equal(answerer.sctp.transport.iceTransport.role, "controlled");
  await Promise.all([
    waitForState(offerer.sctp, "connected"),
    waitForState(answerer.sctp, "connected"),
  ]);
  assert.equal(offerer.sctp.state, "connected");
  assert.equal(answerer.sctp.state, "connected");
  assert.equal(typeof offerer.sctp.maxMessageSize, "number");
  assert.equal(typeof answerer.sctp.maxMessageSize, "number");

  offerer.close();
  assert.equal(offerer.sctp.state, "closed");
  answerer.close();
});

test("connected data-channel ICE transport does not remain new while candidates exist", async (t) => {
  const offerer = new RTCPeerConnection();
  const answerer = new RTCPeerConnection();
  t.after(() => closeAllAndWait(offerer, answerer));
  const local = offerer.createDataChannel("ice-gathering");
  const remotePromise = waitFor(answerer, "datachannel");

  await exchangeOfferAnswer(offerer, answerer);
  const remote = (await remotePromise).channel;
  await waitForOpen(local);
  await waitForOpen(remote);

  const allowedStates = new Set(["gathering", "complete"]);
  assert.equal(allowedStates.has(offerer.sctp.transport.iceTransport.gatheringState), true);
  assert.equal(allowedStates.has(answerer.sctp.transport.iceTransport.gatheringState), true);

  offerer.close();
  answerer.close();
});

test("connected data-channel ICE transports expose candidate pairs and complete gathering state", async (t) => {
  const offerer = new RTCPeerConnection();
  const answerer = new RTCPeerConnection();
  t.after(() => closeAllAndWait(offerer, answerer));
  const local = offerer.createDataChannel("ice-transport");
  const remotePromise = waitFor(answerer, "datachannel");

  await exchangeOfferAnswer(offerer, answerer);
  const remote = (await remotePromise).channel;
  await waitForOpen(local);
  await waitForOpen(remote);
  await Promise.all([
    waitForSctpConnected(offerer, answerer),
    waitForIceGatheringComplete(offerer),
    waitForIceGatheringComplete(answerer),
  ]);

  const offererIce = offerer.sctp.transport.iceTransport;
  const answererIce = answerer.sctp.transport.iceTransport;
  const offererPair = offererIce.getSelectedCandidatePair();
  const answererPair = answererIce.getSelectedCandidatePair();

  assert.equal(offererIce.gatheringState, "complete");
  assert.equal(answererIce.gatheringState, "complete");
  assert.equal(offererPair instanceof RTCIceCandidatePair, true);
  assert.equal(answererPair instanceof RTCIceCandidatePair, true);
  assert.equal(offererPair.local instanceof RTCIceCandidate, true);
  assert.equal(offererPair.remote instanceof RTCIceCandidate, true);
  assert.equal(answererPair.local instanceof RTCIceCandidate, true);
  assert.equal(answererPair.remote instanceof RTCIceCandidate, true);
  assert.equal(typeof offererPair.local.address, "string");
  assert.equal(typeof answererPair.local.address, "string");
  assert.equal(typeof offererPair.remote.address, "string");
  assert.equal(typeof answererPair.remote.address, "string");
  assert.deepEqual(
    candidateTransportEndpoint(offererPair.local),
    candidateTransportEndpoint(answererPair.remote),
  );
  assert.deepEqual(
    candidateTransportEndpoint(offererPair.remote),
    candidateTransportEndpoint(answererPair.local),
  );
  assert.equal(offerer.sctp.transport.getRemoteCertificates()[0] instanceof ArrayBuffer, true);
  assert.equal(answerer.sctp.transport.getRemoteCertificates()[0] instanceof ArrayBuffer, true);
  assert.equal(offerer.sctp.transport.getRemoteCertificates()[0].byteLength > 0, true);
  assert.equal(answerer.sctp.transport.getRemoteCertificates()[0].byteLength > 0, true);

  offerer.close();
  answerer.close();
});

test("remote peer close disconnects the surviving data-channel ICE transport", async (t) => {
  const offerer = new RTCPeerConnection();
  const answerer = new RTCPeerConnection();
  t.after(() => closeAllAndWait(offerer, answerer));
  const local = offerer.createDataChannel("remote-close", { negotiated: true, id: 3 });
  const remote = answerer.createDataChannel("remote-close", { negotiated: true, id: 3 });

  await exchangeOfferAnswer(offerer, answerer);
  assert.equal(local.negotiated, true);
  assert.equal(remote.negotiated, true);
  await waitForSctpConnected(offerer, answerer);

  const iceTransport = offerer.sctp.transport.iceTransport;
  const disconnected = waitForState(iceTransport, "disconnected");
  answerer.close();
  await disconnected;

  assert.equal(offerer.signalingState, "stable");
  assert.equal(offerer.iceConnectionState, "disconnected");
  assert.equal(iceTransport.state, "disconnected");

  offerer.close();
});

test("two peers negotiate a data channel and exchange a string message", async (t) => {
  const offerer = new RTCPeerConnection();
  const answerer = new RTCPeerConnection();
  t.after(() => closeAllAndWait(offerer, answerer));
  const local = offerer.createDataChannel("chat");
  const remotePromise = waitFor(answerer, "datachannel");

  await exchangeOfferAnswer(offerer, answerer);

  const remoteEvent = await remotePromise;
  const remote = remoteEvent.channel;
  assert.equal(remote.label, "chat");
  assert.equal(["connecting", "open"].includes(remote.readyState), true);

  await waitForOpen(local);
  await waitForOpen(remote);

  const messagePromise = waitFor(remote, "message");
  local.send("hello");
  const message = await messagePromise;
  assert.equal(message.data, "hello");

  offerer.close();
  answerer.close();
});

test("data-channel opening burst is delivered after the datachannel event task", async (t) => {
  const offerer = new RTCPeerConnection();
  const answerer = new RTCPeerConnection();
  t.after(() => closeAllAndWait(offerer, answerer));
  const local = offerer.createDataChannel("burst");
  const toSend = Array.from({ length: 100 }, (_, index) => `message ${index}`);

  const blastMessages = (channel) => {
    assert.equal(channel.readyState, "open");
    for (const message of toSend) channel.send(message);
  };

  local.onopen = () => blastMessages(local);
  const remotePromise = new Promise((resolve) => {
    answerer.ondatachannel = ({ channel }) => {
      blastMessages(channel);
      resolve(channel);
    };
  });
  const receivedLocal = collectMessages(local, toSend.length);

  await exchangeOfferAnswer(offerer, answerer);

  const remote = await remotePromise;
  assert.deepEqual(await collectMessages(remote, toSend.length), toSend);
  assert.deepEqual(await receivedLocal, toSend);

  offerer.close();
  answerer.close();
});

test("bufferedamountlow fires after send drains below the low threshold", async (t) => {
  const offerer = new RTCPeerConnection();
  const answerer = new RTCPeerConnection();
  t.after(() => closeAllAndWait(offerer, answerer));
  const local = offerer.createDataChannel("buffered-low");
  const remotePromise = waitFor(answerer, "datachannel");

  await exchangeOfferAnswer(offerer, answerer);
  const remote = (await remotePromise).channel;
  await waitForOpen(local);
  await waitForOpen(remote);

  const low = waitFor(local, "bufferedamountlow");
  local.send("hello");
  assert.equal(local.bufferedAmount, 5);
  await low;
  assert.equal(local.bufferedAmount, 0);

  offerer.close();
  answerer.close();
});
