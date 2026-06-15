"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const dgram = require("node:dgram");
const path = require("node:path");
const test = require("node:test");
const { RTCCertificate, RTCPeerConnection, nonstandard } = require("..");

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

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

function waitForOpen(channel) {
  return channel.readyState === "open" ? Promise.resolve() : waitFor(channel, "open");
}

async function waitForValue(read, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = read();
    if (value != null) return value;
    await delay(10);
  }
  throw new Error("Timed out waiting for value");
}

async function unusedUdpPort() {
  const socket = dgram.createSocket("udp4");
  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(0, "127.0.0.1", resolve);
  });
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

function stunBindingRequest(username) {
  const usernameBytes = Buffer.from(username);
  const paddedUsernameLength = (usernameBytes.length + 3) & ~3;
  const attributesLength = 4 + paddedUsernameLength + 24;
  const message = Buffer.alloc(20 + attributesLength);
  message.writeUInt16BE(0x0001, 0);
  message.writeUInt16BE(attributesLength, 2);
  message.writeUInt32BE(0x2112a442, 4);
  cryptoRandomFill(message.subarray(8, 20));
  message.writeUInt16BE(0x0006, 20);
  message.writeUInt16BE(usernameBytes.length, 22);
  usernameBytes.copy(message, 24);
  const integrityOffset = 24 + paddedUsernameLength;
  message.writeUInt16BE(0x0008, integrityOffset);
  message.writeUInt16BE(20, integrityOffset + 2);
  return message;
}

function cryptoRandomFill(buffer) {
  require("node:crypto").randomFillSync(buffer);
}

async function sendUntil(socket, message, port, completed, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!completed() && Date.now() < deadline) {
    await new Promise((resolve, reject) => {
      socket.send(message, port, "127.0.0.1", (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    await delay(20);
  }
  if (!completed()) throw new Error("Timed out waiting for ICE UDP mux callback");
}

function closeAll(...values) {
  for (const value of values) {
    try {
      value?.close();
    } catch {
      // Cleanup should continue after an earlier assertion failure.
    }
  }
}

async function waitForIceGatheringComplete(peerConnection) {
  while (peerConnection.iceGatheringState !== "complete") {
    await waitFor(peerConnection, "icegatheringstatechange");
  }
}

async function exchangeDescriptions(offerer, answerer) {
  const offer = await offerer.createOffer();
  await offerer.setLocalDescription(offer);
  await waitForIceGatheringComplete(offerer);
  await answerer.setRemoteDescription(offerer.localDescription);
  const answer = await answerer.createAnswer();
  await answerer.setLocalDescription(answer);
  await waitForIceGatheringComplete(answerer);
  await offerer.setRemoteDescription(answerer.localDescription);
}

function generatedCertificateMaterial() {
  return nonstandard.native.generateCertificate({
    algorithm: "ECDSA",
    expiresMs: 60_000,
  });
}

test("IceUdpMuxListener reports its endpoint and stops callback delivery", async (t) => {
  const port = await unusedUdpPort();
  const listener = new nonstandard.IceUdpMuxListener(port, "127.0.0.1");
  const sender = dgram.createSocket("udp4");
  t.after(() => {
    closeAll(listener);
    sender.close();
  });

  assert.equal(listener.port(), port);
  assert.equal(listener.address(), "127.0.0.1");

  const requests = [];
  listener.onUnhandledStunRequest((request) => requests.push(request));
  await sendUntil(
    sender,
    stunBindingRequest("local-ufrag:remote-ufrag"),
    port,
    () => requests.length > 0,
  );

  assert.equal(requests[0].localUfrag, "local-ufrag");
  assert.equal(requests[0].ufrag, "remote-ufrag");
  assert.equal(requests[0].host, "127.0.0.1");
  assert.equal(Number.isInteger(requests[0].port), true);

  listener.close();
  listener.close();
  listener.stop();
  await new Promise((resolve) => {
    sender.send(stunBindingRequest("closed:request"), port, "127.0.0.1", resolve);
  });
  await delay(100);
  assert.equal(requests.length, 1);
  assert.throws(
    () => listener.onUnhandledStunRequest(() => {}),
    (error) => error?.name === "InvalidStateError",
  );
});

test("IceUdpMuxListener reports occupied ports as JavaScript exceptions", async (t) => {
  const port = await unusedUdpPort();
  const listener = new nonstandard.IceUdpMuxListener(port, "127.0.0.1");
  t.after(() => listener.close());

  assert.throws(
    () => new nonstandard.IceUdpMuxListener(port, "127.0.0.1"),
    /Failed to register ICE UDP mux listener/,
  );
});

test("nonstandard peer configuration is pre-construction and secure by default", () => {
  const peerConnection = new RTCPeerConnection();
  assert.equal(peerConnection._nonstandardConfiguration.disableFingerprintVerification, false);

  nonstandard.configurePeerConnection(peerConnection, {
    enableIceUdpMux: true,
    maxMessageSize: 262144,
  });
  assert.deepEqual(peerConnection._nonstandardConfiguration, {
    enableIceUdpMux: true,
    disableFingerprintVerification: false,
    maxMessageSize: 262144,
  });

  peerConnection.createDataChannel("initialized");
  assert.throws(
    () => nonstandard.configurePeerConnection(peerConnection, { maxMessageSize: 65536 }),
    (error) => error?.name === "InvalidStateError",
  );
  peerConnection.close();
});

test("explicit local ICE credentials preserve standard setLocalDescription timing", async (t) => {
  const peerConnection = new RTCPeerConnection({ iceServers: [] });
  t.after(() => peerConnection.close());
  let signalingStateChanges = 0;
  let gatheringStateChanges = 0;
  peerConnection.addEventListener("signalingstatechange", () => {
    signalingStateChanges += 1;
  });
  peerConnection.addEventListener("icegatheringstatechange", () => {
    gatheringStateChanges += 1;
  });
  nonstandard.configurePeerConnection(peerConnection, { maxMessageSize: 262144 });
  peerConnection.createDataChannel("direct", { negotiated: true, id: 0 });
  nonstandard.setLocalIceCredentials(peerConnection, {
    iceUfrag: "directOfferUfrag",
    icePwd: "directOfferPassword12345",
  });

  const offer = await peerConnection.createOffer({ iceRestart: true });
  assert.match(offer.sdp, /^a=ice-ufrag:directOfferUfrag\r?$/m);
  assert.match(offer.sdp, /^a=ice-pwd:directOfferPassword12345\r?$/m);
  assert.match(offer.sdp, /^a=max-message-size:262144\r?$/m);
  assert.equal(peerConnection.localDescription, null);
  assert.equal(peerConnection.currentLocalDescription, null);
  assert.equal(peerConnection.signalingState, "stable");
  assert.equal(peerConnection.iceGatheringState, "new");
  assert.equal(signalingStateChanges, 0);
  assert.equal(gatheringStateChanges, 0);

  await peerConnection.setLocalDescription(offer);
  assert.equal(peerConnection.localDescription?.type, "offer");
  assert.equal(peerConnection.currentLocalDescription, null);
  assert.equal(peerConnection.signalingState, "have-local-offer");
  assert.match(peerConnection.localDescription.sdp, /^a=ice-ufrag:directOfferUfrag\r?$/m);
  assert.equal(signalingStateChanges, 1);
});

test("explicit local ICE credentials are applied to generated answers", async (t) => {
  const offerer = new RTCPeerConnection({ iceServers: [] });
  const answerer = new RTCPeerConnection({ iceServers: [] });
  t.after(() => closeAll(offerer, answerer));
  offerer.createDataChannel("offer", { negotiated: true, id: 0 });
  answerer.createDataChannel("answer", { negotiated: true, id: 0 });

  await offerer.setLocalDescription(await offerer.createOffer());
  await answerer.setRemoteDescription(offerer.localDescription);
  nonstandard.setLocalIceCredentials(answerer, {
    iceUfrag: "directAnswerUfrag",
    icePwd: "directAnswerPassword1234",
  });

  const answer = await answerer.createAnswer();
  assert.match(answer.sdp, /^a=ice-ufrag:directAnswerUfrag\r?$/m);
  assert.match(answer.sdp, /^a=ice-pwd:directAnswerPassword1234\r?$/m);
  assert.equal(answerer.localDescription, null);
  assert.equal(answerer.signalingState, "have-remote-offer");

  await answerer.setLocalDescription(answer);
  assert.equal(answerer.localDescription?.type, "answer");
  assert.equal(answerer.currentLocalDescription?.type, "answer");
  assert.equal(answerer.signalingState, "stable");
});

test("standard setLocalDescription remains unchanged without extensions", async (t) => {
  const peerConnection = new RTCPeerConnection({ iceServers: [] });
  t.after(() => peerConnection.close());
  peerConnection.createDataChannel("standard");

  const offer = await peerConnection.createOffer();
  assert.equal(peerConnection.localDescription, null);
  assert.equal(peerConnection.signalingState, "stable");
  await peerConnection.setLocalDescription(offer);
  assert.equal(peerConnection.localDescription?.type, "offer");
  assert.equal(peerConnection.signalingState, "have-local-offer");
});

test("enableIceUdpMux gathers on the listener port", async (t) => {
  const port = await unusedUdpPort();
  const listener = new nonstandard.IceUdpMuxListener(port);
  const peerConnection = new RTCPeerConnection({ iceServers: [] });
  t.after(() => closeAll(peerConnection, listener));

  nonstandard.configurePeerConnection(peerConnection, { enableIceUdpMux: true });
  peerConnection.createDataChannel("mux", { negotiated: true, id: 0 });
  nonstandard.setLocalIceCredentials(peerConnection, {
    iceUfrag: "muxLocalUfrag",
    icePwd: "muxLocalPassword123456",
  });
  await peerConnection.setLocalDescription(await peerConnection.createOffer());
  await waitForIceGatheringComplete(peerConnection);
  const candidatePorts = [
    ...(peerConnection.localDescription?.sdp ?? "").matchAll(
      /^a=candidate:.* UDP .* \S+ (\d+) typ host\r?$/gm,
    ),
  ].map((match) => Number(match[1]));
  assert.notEqual(candidatePorts.length, 0);
  assert.equal(
    candidatePorts.every((candidatePort) => candidatePort === port),
    true,
  );
});

test("imported certificates are private, validated, and used in local SDP", async (t) => {
  const first = generatedCertificateMaterial();
  const second = generatedCertificateMaterial();
  const certificate = nonstandard.importCertificate({
    certificatePem: first.certificatePem,
    privateKeyPem: first.keyPem,
  });

  assert.equal(certificate instanceof RTCCertificate, true);
  assert.equal(Object.hasOwn(certificate, "_certificatePem"), false);
  assert.equal(Object.hasOwn(certificate, "_keyPem"), false);
  assert.equal(
    Object.values(certificate).some((value) => value === first.keyPem),
    false,
  );
  assert.throws(
    () =>
      nonstandard.importCertificate({
        certificatePem: first.certificatePem,
        privateKeyPem: second.keyPem,
      }),
    /do not match/,
  );
  assert.throws(
    () =>
      nonstandard.importCertificate({
        certificatePem: "not a certificate",
        privateKeyPem: "not a private key",
      }),
    /Invalid certificate material/,
  );

  const peerConnection = new RTCPeerConnection({
    iceServers: [],
    certificates: [certificate],
  });
  t.after(() => peerConnection.close());
  peerConnection.createDataChannel("certificate");
  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);

  const expected = certificate.getFingerprints()[0].value.toLowerCase();
  const actual = /^a=fingerprint:sha-256 ([^\r\n]+)$/im.exec(
    peerConnection.localDescription.sdp,
  )?.[1];
  assert.equal(actual?.toLowerCase(), expected);
});

test("getRemoteFingerprint returns the connected peer certificate", async (t) => {
  const material = generatedCertificateMaterial();
  const answererCertificate = nonstandard.importCertificate({
    certificatePem: material.certificatePem,
    privateKeyPem: material.keyPem,
  });
  const offerer = new RTCPeerConnection({ iceServers: [] });
  const answerer = new RTCPeerConnection({
    iceServers: [],
    certificates: [answererCertificate],
  });
  t.after(() => closeAll(offerer, answerer));

  const localChannel = offerer.createDataChannel("fingerprint");
  await exchangeDescriptions(offerer, answerer);
  await waitForOpen(localChannel);

  const fingerprint = await waitForValue(() => nonstandard.getRemoteFingerprint(offerer));
  assert.equal(fingerprint.algorithm, "sha-256");
  assert.equal(
    fingerprint.value.toLowerCase(),
    answererCertificate.getFingerprints()[0].value.toLowerCase(),
  );
});

test("live UDP mux listeners are closed during environment shutdown", async () => {
  const port = await unusedUdpPort();
  const root = path.resolve(__dirname, "..");
  const script = `
    const { nonstandard } = require(${JSON.stringify(root)});
    globalThis.listener = new nonstandard.IceUdpMuxListener(${port}, "127.0.0.1");
  `;
  const child = spawn(process.execPath, ["-e", script], {
    stdio: "ignore",
    windowsHide: true,
  });
  const exit = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Child process did not exit with a live ICE UDP mux listener"));
    }, 5000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  assert.deepEqual(await exit, { code: 0, signal: null });
});

test("garbage-collected UDP mux listener wrappers are safe", async () => {
  const port = await unusedUdpPort();
  const root = path.resolve(__dirname, "..");
  const script = `
    const { nonstandard } = require(${JSON.stringify(root)});
    let resolveFinalized;
    const finalized = new Promise((resolve) => {
      resolveFinalized = resolve;
    });
    const registry = new FinalizationRegistry(resolveFinalized);
    let listener = new nonstandard.IceUdpMuxListener(${port}, "127.0.0.1");
    registry.register(listener, undefined);
    listener = null;

    const deadline = Date.now() + 5000;
    (async () => {
      while (Date.now() < deadline) {
        global.gc();
        await new Promise((resolve) => setImmediate(resolve));
        const result = await Promise.race([
          finalized.then(() => true),
          new Promise((resolve) => setTimeout(() => resolve(false), 10)),
        ]);
        if (result) {
          return;
        }
      }
      throw new Error("ICE UDP mux listener was not garbage collected");
    })().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  `;
  const child = spawn(process.execPath, ["--expose-gc", "-e", script], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let childOutput = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    childOutput += chunk;
  });
  child.stderr.on("data", (chunk) => {
    childOutput += chunk;
  });
  const exit = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Child process did not complete the ICE UDP mux GC test"));
    }, 10000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  assert.deepEqual(await exit, { code: 0, signal: null }, childOutput);
});
