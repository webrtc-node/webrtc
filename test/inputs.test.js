"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { RTCPeerConnection, RTCCertificate, RTCIceCandidate } = require("..");

function peer(t, configuration) {
  const pc = new RTCPeerConnection(configuration);
  t.after(() => pc.close());
  return pc;
}

function configuredPeer(t, mode, configuration) {
  if (mode === "constructor") return peer(t, configuration);
  const pc = peer(t);
  pc.setConfiguration(configuration);
  return pc;
}

test("configuration dictionaries accept objects and functions and reject other primitives", (t) => {
  for (const mode of ["constructor", "setter"]) {
    for (const value of [undefined, null]) configuredPeer(t, mode, value);
    for (const value of [1, false, "configuration", Symbol("configuration"), 1n]) {
      assert.throws(() => configuredPeer(t, mode, value), TypeError);
    }
    const configuration = Object.assign(() => {}, { iceTransportPolicy: "relay" });
    assert.equal(
      configuredPeer(t, mode, configuration).getConfiguration().iceTransportPolicy,
      "relay",
    );
  }
});

test("configuration accepts iterable servers, iterable URLs, and inherited dictionary members", (t) => {
  for (const mode of ["constructor", "setter"]) {
    const server = Object.create({ urls: new Set(["stun:first.example", "stun:second.example"]) });
    const configuration = Object.create({ iceServers: new Set([server]) });
    const pc = configuredPeer(t, mode, configuration);
    assert.deepEqual(pc.getConfiguration().iceServers, [
      { urls: ["stun:first.example", "stun:second.example"] },
    ]);
    server.urls.add("stun:third.example");
    const returned = pc.getConfiguration();
    returned.iceServers[0].urls.push("stun:mutated.example");
    assert.equal(pc.getConfiguration().iceServers[0].urls.length, 2);
    const stringObject = { toString: () => "stun:object.example" };
    pc.setConfiguration({ iceServers: [{ urls: stringObject }] });
    assert.deepEqual(pc.getConfiguration().iceServers[0].urls, ["stun:object.example"]);
  }
});

test("configuration reads members and iterator methods once with the correct receiver", (t) => {
  for (const mode of ["constructor", "setter"]) {
    const reads = new Set();
    function once(name, value) {
      assert.equal(reads.has(name), false, `${name} read more than once`);
      reads.add(name);
      return value;
    }
    const urls = {
      get [Symbol.iterator]() {
        return once("URL iterator", function* () {
          assert.equal(this, urls);
          yield "turn:example.org";
        });
      },
    };
    const server = {
      get urls() {
        return once("urls", urls);
      },
      get username() {
        return once("username", "user");
      },
      get credential() {
        return once("credential", "pass");
      },
    };
    const servers = {
      get [Symbol.iterator]() {
        return once("server iterator", function* () {
          assert.equal(this, servers);
          yield server;
        });
      },
    };
    configuredPeer(t, mode, {
      get iceServers() {
        return once("iceServers", servers);
      },
      get certificates() {
        return once("certificates", []);
      },
      get iceCandidatePoolSize() {
        return once("pool size", 1);
      },
    });
    assert.equal(reads.size, 8);
  }
});

test("failed sequence conversion closes iterators and leaves the configuration unchanged", (t) => {
  const pc = peer(t);
  const before = pc.getConfiguration();
  const closed = [];
  const urls = {
    *[Symbol.iterator]() {
      try {
        yield "stun:example.org";
        yield Symbol("invalid URL");
      } finally {
        closed.push("urls");
      }
    },
  };
  const servers = {
    *[Symbol.iterator]() {
      try {
        yield { urls };
      } finally {
        closed.push("servers");
      }
    },
  };
  assert.throws(
    () => pc.setConfiguration({ iceServers: servers, iceTransportPolicy: "relay" }),
    TypeError,
  );
  assert.deepEqual(closed, ["urls", "servers"]);
  assert.deepEqual(pc.getConfiguration(), before);
});

test("configuration rejects noniterable sequences and certificates without native identity", (t) => {
  for (const mode of ["constructor", "setter"]) {
    for (const invalid of [null, {}, { length: 0 }, "iterable string", { [Symbol.iterator]: 1 }]) {
      assert.throws(() => configuredPeer(t, mode, { iceServers: invalid }), TypeError);
      assert.throws(() => configuredPeer(t, mode, { certificates: invalid }), TypeError);
    }
    for (const invalid of [
      {},
      null,
      undefined,
      new RTCCertificate(),
      Object.create(RTCCertificate.prototype),
    ]) {
      assert.throws(() => configuredPeer(t, mode, { certificates: [invalid] }), TypeError);
    }
    assert.throws(() => configuredPeer(t, mode, { iceServers: [{ urls: undefined }] }), TypeError);
  }
});

test("certificate configuration honors inherited fields and preserves omitted certificates", async (t) => {
  const algorithm = { name: "ECDSA", namedCurve: "P-256" };
  const first = await RTCPeerConnection.generateCertificate(algorithm);
  const second = await RTCPeerConnection.generateCertificate(algorithm);
  const pc = peer(t, { certificates: new Set([first]) });
  pc.setConfiguration({});
  assert.deepEqual(pc.getConfiguration().certificates, [first]);
  const before = pc.getConfiguration();
  assert.throws(() => pc.setConfiguration(Object.create({ certificates: [second] })), {
    name: "InvalidModificationError",
  });
  assert.deepEqual(pc.getConfiguration(), before);
  let reads = 0;
  pc.setConfiguration({
    get certificates() {
      reads++;
      return new Set([first]);
    },
  });
  assert.equal(reads, 1);
  assert.deepEqual(pc.getConfiguration().certificates, [first]);
});

test("configuration numeric conversions truncate fractions and reject BigInts", (t) => {
  for (const mode of ["constructor", "setter"]) {
    for (const [input, expected] of [
      [1.9, 1],
      [255.9, 255],
      [-0.9, 0],
      ["2.9", 2],
      [false, 0],
    ]) {
      const pc = configuredPeer(t, mode, {
        iceCandidatePoolSize: input,
        iceTransportPolicy: { toString: () => "relay" },
      });
      assert.equal(pc.getConfiguration().iceCandidatePoolSize, expected);
      assert.equal(Object.is(pc.getConfiguration().iceCandidatePoolSize, -0), false);
      assert.equal(pc.getConfiguration().iceTransportPolicy, "relay");
    }
    for (const input of [1n, Object(1n), { valueOf: () => 1n }, NaN, Infinity, -1, 256]) {
      assert.throws(() => configuredPeer(t, mode, { iceCandidatePoolSize: input }), TypeError);
    }
  }
});

test("data-channel range conversions truncate fractions and reject BigInts", (t) => {
  const pc = peer(t);
  const channel = pc.createDataChannel("fractional", {
    negotiated: true,
    id: 3.9,
    maxRetransmits: 1.9,
  });
  assert.equal(channel.id, 3);
  assert.equal(channel.maxRetransmits, 1);
  assert.equal(pc.createDataChannel("lifetime", { maxPacketLifeTime: -0.9 }).maxPacketLifeTime, 0);
  for (const key of ["id", "maxRetransmits", "maxPacketLifeTime"]) {
    assert.throws(() => pc.createDataChannel("BigInt", { [key]: 1n }), TypeError);
  }
});

test("ICE server validation rejects empty ports, empty queries, and host spaces atomically", (t) => {
  const pc = peer(t);
  const before = pc.getConfiguration();
  for (const urls of [
    "stun:example.org:",
    "stun:[::1]:",
    "stun:example.org?",
    "turn:example.org?",
    "stun: example.org",
    "turn:exa mple.org",
  ]) {
    const configuration = {
      iceTransportPolicy: "relay",
      iceServers: [{ urls, username: "user", credential: "pass" }],
    };
    assert.throws(() => peer(t, configuration), { name: "SyntaxError" });
    assert.throws(() => pc.setConfiguration(configuration), { name: "SyntaxError" });
    assert.deepEqual(pc.getConfiguration(), before);
  }
  for (const urls of [
    "stun:example.org:0",
    "stun:example.org:65535",
    "stun:[::1]:3478",
    "turn:example.org?transport=UDP",
  ]) {
    pc.setConfiguration({ iceServers: [{ urls, username: "user", credential: "pass" }] });
  }
});

test("ICE candidate pool size is immutable with an applied local description", async (t) => {
  for (const nativeBacked of [false, true]) {
    const pc = peer(t, { iceCandidatePoolSize: 1 });
    if (nativeBacked) pc.createDataChannel("pool");
    pc.setConfiguration({ iceCandidatePoolSize: 2 });
    await pc.setLocalDescription();
    const before = pc.getConfiguration();
    assert.throws(
      () => pc.setConfiguration({ iceCandidatePoolSize: 3, iceTransportPolicy: "relay" }),
      { name: "InvalidModificationError" },
    );
    assert.deepEqual(pc.getConfiguration(), before);
    pc.setConfiguration({ iceCandidatePoolSize: 2 });
    await pc.setLocalDescription({ type: "rollback" });
    pc.setConfiguration({ iceCandidatePoolSize: 3 });
    assert.equal(pc.getConfiguration().iceCandidatePoolSize, 3);
  }
  const pc = peer(t);
  await assert.rejects(pc.setLocalDescription({ type: "answer" }), { name: "InvalidStateError" });
  pc.setConfiguration({ iceCandidatePoolSize: 1 });
});

test("closing a peer from a configuration getter prevents the configuration commit", (t) => {
  const pc = peer(t);
  const before = pc.getConfiguration();
  assert.throws(
    () =>
      pc.setConfiguration({
        get iceTransportPolicy() {
          pc.close();
          return "relay";
        },
      }),
    { name: "InvalidStateError" },
  );
  assert.deepEqual(pc.getConfiguration(), before);
});

const candidateLine = "candidate:1 1 udp 2113929471 127.0.0.1 12345 typ host";

test("candidate control characters cannot inject lines into remote SDP", async (t) => {
  const offerer = peer(t);
  offerer.createDataChannel("candidate-validation");
  const receiver = peer(t);
  await receiver.setRemoteDescription(await offerer.createOffer());
  const before = receiver.remoteDescription;
  const candidates = [
    `${candidateLine}\r\na=ice-pwd:injected`,
    `${candidateLine}\na=x-injected:yes`,
    `${candidateLine}\r\n\r\n`,
    `${candidateLine}\0`,
    `${candidateLine}\t`,
    `${candidateLine}\x1f`,
    `${candidateLine}\u00a0`,
    candidateLine.replace("1 1", "1\t1"),
    ` ${candidateLine}`,
  ];
  for (const candidate of candidates) {
    for (const input of [
      { candidate, sdpMLineIndex: 0 },
      new RTCIceCandidate({ candidate, sdpMLineIndex: 0 }),
    ]) {
      await assert.rejects(receiver.addIceCandidate(input), { name: "OperationError" });
      assert.equal(receiver.remoteDescription, before);
    }
  }
  assert.equal(receiver.sctp.transport.iceTransport.getRemoteCandidates().length, 0);
  await receiver.addIceCandidate({ candidate: candidateLine, sdpMLineIndex: 0 });
  assert.ok(receiver.remoteDescription.sdp.includes(`a=${candidateLine}\r\n`));
});

test("candidate line terminators are canonicalized without changing the caller's candidate", async (t) => {
  const offerer = peer(t);
  offerer.createDataChannel("candidate-terminators");
  const receiver = peer(t);
  await receiver.setRemoteDescription(await offerer.createOffer());
  for (const suffix of ["\r", "\n", "\r\n", " ", " \r\n"]) {
    const input = new RTCIceCandidate({ candidate: candidateLine + suffix, sdpMLineIndex: 0 });
    await receiver.addIceCandidate(input);
    assert.equal(input.candidate, candidateLine + suffix);
    const lines = receiver.remoteDescription.sdp.split("\r\n");
    assert.equal(lines.filter((line) => line === `a=${candidateLine}`).length, 1);
    assert.equal(receiver.remoteDescription.sdp.includes("\r\n\r\n"), false);
  }
});
