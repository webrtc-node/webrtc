"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const test = require("node:test");
const vm = require("node:vm");
const { connectRemotePeer } = require("./fixtures/remote-datachannel");

test("binary sends accept cross-realm buffers and use intrinsic view boundaries", async (t) => {
  const remote = await connectRemotePeer({ record: true });
  t.after(() => remote.close());
  const values = vm.runInNewContext(`[
    Uint8Array.of(1, 2, 3).buffer,
    new Uint8Array(Uint8Array.of(0, 4, 5, 0).buffer, 1, 2),
    new DataView(Uint8Array.of(0, 6, 7, 0).buffer, 1, 2),
    new Uint16Array([0x0808, 0x0909])
  ]`);
  for (const value of [
    Uint8Array.of(10, 11),
    new DataView(Uint8Array.of(12, 13).buffer),
    Uint8Array.of(14, 15).buffer,
  ]) {
    for (const key of ["buffer", "byteOffset", "byteLength"]) {
      Object.defineProperty(value, key, {
        get() {
          throw new Error(`unexpected ${key} getter`);
        },
      });
    }
    values.push(value);
  }
  for (const value of values) remote.channel.send(value);
  remote.channel.send(Buffer.from([0, 16, 17, 0]).subarray(1, 3));
  const received = await remote.request("received", { count: values.length + 1 });
  assert.deepEqual(received.messages, [
    [1, 2, 3],
    [4, 5],
    [6, 7],
    [8, 8, 9, 9],
    [10, 11],
    [12, 13],
    [14, 15],
    [16, 17],
  ]);
});

test("detached buffers and views send empty binary messages", async (t) => {
  const remote = await connectRemotePeer({ record: true });
  t.after(() => remote.close());
  const buffer = new ArrayBuffer(8);
  const values = [buffer, new Uint8Array(buffer, 2, 4), new DataView(buffer, 2, 4)];
  structuredClone(buffer, { transfer: [buffer] });
  const foreign = vm.runInNewContext("new ArrayBuffer(4)");
  structuredClone(foreign, { transfer: [foreign] });
  values.push(foreign, new ArrayBuffer(0), new Uint8Array(0), new DataView(new ArrayBuffer(0)));
  for (const value of values) remote.channel.send(value);
  assert.equal(remote.channel.bufferedAmount, 0);
  remote.channel.send("after empty messages");
  const received = await remote.request("received", { count: values.length + 1 });
  assert.deepEqual(received.messages, [...values.map(() => []), "after empty messages"]);
});

test("shared and resizable send buffers are rejected without enqueueing data", async (t) => {
  const remote = await connectRemotePeer({ record: true });
  t.after(() => remote.close());
  const shared = new SharedArrayBuffer(8);
  const resizable = new ArrayBuffer(8, { maxByteLength: 16 });
  const values = [
    shared,
    new Uint8Array(shared),
    new DataView(shared),
    resizable,
    new Uint8Array(resizable),
    new DataView(resizable),
    vm.runInNewContext("new ArrayBuffer(4, { maxByteLength: 8 })"),
  ];
  if (typeof SharedArrayBuffer.prototype.grow === "function") {
    const growable = new SharedArrayBuffer(8, { maxByteLength: 16 });
    values.push(new Uint8Array(growable), new DataView(growable));
  }
  for (const value of values) {
    assert.throws(() => remote.channel.send(value), TypeError);
    assert.equal(remote.channel.bufferedAmount, 0);
    assert.equal(remote.channel._native.bufferedAmount, 0);
  }
  remote.channel.send("after rejected buffers");
  assert.deepEqual((await remote.request("received", { count: 1 })).messages, [
    "after rejected buffers",
  ]);
});

test("queued sends copy buffer slices and preserve mixed-message order through close", async (t) => {
  const remote = await connectRemotePeer({ record: true });
  t.after(() => remote.close());
  const { channel } = remote;
  const expected = [];
  let expectedBytes = 0;
  for (let index = 0; index < 256; index++) {
    const buffer = new ArrayBuffer(12);
    const view = new Uint8Array(buffer, 4, 4);
    view.set([index, 1, 2, 3]);
    expected.push(Array.from(view));
    expectedBytes += view.byteLength;
    channel.send(view);
    view.fill(0xff);
    structuredClone(buffer, { transfer: [buffer] });
  }
  for (const [text, received] of [
    ["世界", "世界"],
    ["a\0b", "a\0b"],
    ["😀", "😀"],
    ["\ud800", "\ufffd"],
  ]) {
    channel.send(text);
    expected.push(received);
    expectedBytes += Buffer.byteLength(text);
  }
  channel.send(new Blob([Uint8Array.of(4, 5, 6)]));
  expected.push([4, 5, 6]);
  expectedBytes += 3;
  channel.send("");
  expected.push("");
  channel.send(new Uint8Array());
  expected.push([]);
  channel.send("tail");
  expected.push("tail");
  expectedBytes += 4;
  assert.equal(channel.bufferedAmount, expectedBytes);
  channel.close();
  const received = await remote.request("received", { count: expected.length });
  assert.deepEqual(received.messages, expected);
  assert.equal(received.bytes, expectedBytes);
});

test("native close waits behind queued sends, including empty messages", async (t) => {
  const remote = await connectRemotePeer({ verifySequence: true });
  t.after(() => remote.close());
  const { channel } = remote;
  const payload = Buffer.alloc(4096, 0x5a);
  const messages = 1000;
  for (let index = 0; index < messages; index++) {
    payload.writeUInt32LE(index, 0);
    assert.equal(channel._native.sendBinary(payload), true);
  }
  channel._native.sendString("");
  channel._native.sendString("last");
  channel._native.close();
  channel._native.close();
  const received = await remote.request("received", { count: messages + 2 });
  assert.equal(received.count, messages + 2);
  assert.equal(received.bytes, messages * payload.byteLength + 4);
  const deadline = Date.now() + 5000;
  while (channel._native.bufferedAmount > 0 && Date.now() < deadline) await delay(5);
  assert.equal(channel._native.bufferedAmount, 0);
});

test("a send exceeding native queue capacity fails without changing bufferedAmount", async (t) => {
  const remote = await connectRemotePeer({ maxMessageSize: 70 * 1024 * 1024 });
  t.after(() => remote.close());
  const { channel } = remote;
  const payload = new Uint8Array(64 * 1024 * 1024 + 1);
  assert.throws(() => channel.send(payload), {
    name: "OperationError",
    message: "Native send queue is full",
  });
  assert.throws(() => channel.send("é".repeat(32 * 1024 * 1024 + 1)), {
    name: "OperationError",
    message: "Native send queue is full",
  });
  assert.equal(channel.bufferedAmount, 0);
  assert.equal(channel._native.bufferedAmount, 0);
  channel.send("after rejection");
  assert.equal((await remote.request("received", { count: 1 })).count, 1);
});

test("closing a peer with queued sends preserves other peers sharing its send worker", async (t) => {
  const closing = await connectRemotePeer();
  t.after(() => closing.close());
  const survivor = await connectRemotePeer({ record: true });
  t.after(() => survivor.close());
  const payload = new Uint8Array(262144);
  for (let index = 0; index < 64; index++) closing.channel.send(payload);
  closing.peerConnection.close();
  survivor.channel.send("still connected");
  const received = await survivor.request("received", { count: 1 });
  assert.deepEqual(received.messages, ["still connected"]);
});

test("terminating a Worker with a native send backlog preserves other environments", () => {
  const root = path.resolve(__dirname, "..");
  const fixture = path.join(__dirname, "fixtures", "remote-datachannel.js");
  const workerScript = `
    const { parentPort, workerData } = require('node:worker_threads');
    const { connectRemotePeer } = require(workerData);
    (async () => {
      const remote = await connectRemotePeer();
      const payload = Buffer.alloc(262144);
      for (let index = 0; index < 100; index++) remote.channel.send(payload);
      parentPort.postMessage('ready');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    })();
  `;
  const script = `
    const assert = require('node:assert/strict');
    const { once } = require('node:events');
    const { Worker } = require('node:worker_threads');
    const { RTCPeerConnection } = require(${JSON.stringify(root)});
    (async () => {
      const pc = new RTCPeerConnection();
      pc.createDataChannel('survivor');
      for (let index = 0; index < 3; index++) {
        const worker = new Worker(${JSON.stringify(workerScript)}, {
          eval: true, workerData: ${JSON.stringify(fixture)}
        });
        await once(worker, 'message');
        assert.equal(await worker.terminate(), 1);
        assert.equal((await pc.createOffer()).type, 'offer');
      }
      pc.close();
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const child = spawnSync(process.execPath, ["-e", script], {
    encoding: "utf8",
    timeout: 20000,
    windowsHide: true,
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.signal, null);
  assert.equal(child.stderr, "");
});

test("terminating receivers during native message bursts preserves the shared addon", async (t) => {
  const { RTCPeerConnection } = require("..");
  const survivor = new RTCPeerConnection();
  t.after(() => survivor.close());
  for (let cycle = 0; cycle < 12; cycle++) {
    const remote = await connectRemotePeer();
    try {
      remote.channel.send("ready");
      await remote.request("received", { count: 1 });
      for (let index = 0; index < 1000; index++) remote.channel.send(`message ${index}`);
    } finally {
      await remote.close();
    }
    assert.equal((await survivor.createOffer()).type, "offer");
  }
});

test("terminating the last addon environment permits a fresh environment to initialize", () => {
  const root = path.resolve(__dirname, "..");
  const workerScript = `
    const { parentPort, workerData } = require('node:worker_threads');
    const { RTCPeerConnection } = require(workerData);
    (async () => {
      const peers = [];
      for (let index = 0; index < 8; index++) {
        const pc = new RTCPeerConnection();
        pc.createDataChannel('last-environment-' + index);
        peers.push(pc);
        await pc.createOffer();
      }
      for (const pc of peers) pc.close();
      parentPort.postMessage('ready');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const script = `
    const assert = require('node:assert/strict');
    const { once } = require('node:events');
    const { Worker } = require('node:worker_threads');
    (async () => {
      // Keep the parent free of the addon until every Worker environment has exited.
      for (let index = 0; index < 10; index++) {
        const worker = new Worker(${JSON.stringify(workerScript)}, {
          eval: true, workerData: ${JSON.stringify(root)}
        });
        const [message] = await once(worker, 'message');
        assert.equal(message, 'ready');
        assert.equal(await worker.terminate(), 1);
      }
      const { RTCPeerConnection } = require(${JSON.stringify(root)});
      const pc = new RTCPeerConnection();
      assert.equal((await pc.createOffer()).type, 'offer');
      pc.close();
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const child = spawnSync(process.execPath, ["-e", script], {
    encoding: "utf8",
    timeout: 20000,
    windowsHide: true,
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.signal, null);
  assert.equal(child.stderr, "");
});
