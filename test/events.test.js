"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");
const { Event, EventTarget } = require("..");

test("removing and readding a listener during dispatch defers it to the next event", () => {
  const target = new EventTarget();
  const calls = [];
  const removed = () => calls.push("removed");
  target.addEventListener(
    "test",
    () => {
      calls.push("first");
      target.removeEventListener("test", removed);
      target.addEventListener("test", removed);
    },
    { once: true },
  );
  target.addEventListener("test", removed);
  target.dispatchEvent(new Event("test"));
  assert.deepEqual(calls, ["first"]);
  target.dispatchEvent(new Event("test"));
  assert.deepEqual(calls, ["first", "removed"]);
});

test("listener identity and once removal include capture", () => {
  const target = new EventTarget();
  let calls = 0;
  const listener = () => calls++;
  target.addEventListener("test", listener);
  target.addEventListener("test", listener, { capture: false, once: true });
  target.addEventListener("test", listener, { capture: true, once: true });
  target.dispatchEvent(new Event("test"));
  assert.equal(calls, 2);
  target.dispatchEvent(new Event("test"));
  assert.equal(calls, 3);
  target.removeEventListener("test", listener, true);
  target.dispatchEvent(new Event("test"));
  assert.equal(calls, 4);
  target.removeEventListener("test", listener, { capture: false });
  target.dispatchEvent(new Event("test"));
  assert.equal(calls, 4);
});

test("event targets reset between dispatches and active events cannot be redispatched", () => {
  const first = new EventTarget();
  const second = new EventTarget();
  const event = new Event("test", { cancelable: true });
  first.addEventListener("test", (received) => {
    assert.equal(received.target, first);
    assert.equal(received.currentTarget, first);
    assert.throws(() => second.dispatchEvent(received), { name: "InvalidStateError" });
    received.preventDefault();
  });
  assert.equal(first.dispatchEvent(event), false);
  assert.equal(event.target, first);
  assert.equal(event.currentTarget, null);
  second.addEventListener("test", (received) => {
    assert.equal(received.target, second);
    assert.equal(received.currentTarget, second);
  });
  assert.equal(second.dispatchEvent(event), false);
  assert.equal(event.target, second);
  assert.equal(event.currentTarget, null);
});

test("listeners validate callback types and preserve callback receivers", () => {
  const target = new EventTarget();
  for (const callback of [1, false, "listener", Symbol("listener")]) {
    assert.throws(() => target.addEventListener("test", callback), TypeError);
  }
  target.addEventListener("test", null);
  target.addEventListener("test", undefined);
  const receivers = [];
  target.addEventListener("test", function () {
    receivers.push(this);
  });
  const object = {
    handleEvent() {
      receivers.push(this);
    },
  };
  target.addEventListener("test", object);
  target.dispatchEvent(new Event("test"));
  assert.deepEqual(receivers, [target, object]);
});

function runWithUncaughtExceptions(script) {
  const child = spawnSync(
    process.execPath,
    [
      "-e",
      `
    const assert = require('node:assert/strict');
    const { setTimeout: delay } = require('node:timers/promises');
    const { Event, EventTarget, RTCPeerConnection } = require(${JSON.stringify(path.resolve(__dirname, ".."))});
    const reported = [];
    process.on('uncaughtException', error => reported.push(error));
    (async () => { ${script} })().catch(error => { console.error(error); process.exitCode = 1; });
  `,
    ],
    { encoding: "utf8", timeout: 10000, windowsHide: true },
  );
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.signal, null);
  assert.equal(child.stderr, "");
}

test("listener errors are reported asynchronously after peer close finishes all cleanup", () => {
  runWithUncaughtExceptions(`
    const pc = new RTCPeerConnection();
    const first = pc.createDataChannel('first');
    const second = pc.createDataChannel('second');
    const errors = [new Error('state'), new Error('listener'), new Error('handler')];
    const closed = [];
    pc.onsignalingstatechange = () => { throw errors[0]; };
    first.addEventListener('close', () => { throw errors[1]; });
    first.addEventListener('close', () => closed.push('first'));
    first.onclose = () => { throw errors[2]; };
    second.onclose = () => closed.push('second');
    assert.doesNotThrow(() => pc.close());
    assert.equal(first.readyState, 'closed');
    assert.equal(second.readyState, 'closed');
    assert.deepEqual(closed, ['first', 'second']);
    assert.deepEqual(reported, []);
    pc.close();
    await delay(30);
    assert.deepEqual(reported, [errors[1], errors[2], errors[0]]);
  `);
});

test("throwing message handlers preserve the remainder of direct and queued native batches", () => {
  runWithUncaughtExceptions(`
    const pc = new RTCPeerConnection();
    const errors = [];
    for (const mode of ['direct', 'queued', 'listeners']) {
      const channel = pc.createDataChannel(mode);
      channel._readyState = 'open';
      const received = [];
      const dispatched = [];
      const failure = new Error(mode);
      errors.push(failure);
      channel.onmessage = event => {
        assert.equal(event.target, channel);
        assert.equal(event.currentTarget, channel);
        assert.throws(() => channel.dispatchEvent(event), { name: 'InvalidStateError' });
        received.push(event.data);
        dispatched.push(event);
        if (event.data === 'first') throw failure;
      };
      if (mode === 'listeners') channel.addEventListener('message', () => {});
      const events = ['first', 'second', 'third'].map(data => ({ binary: false, data }));
      if (mode === 'direct') assert.equal(channel._dispatchNativeMessageBatch(events), true);
      else channel._queueMessageEvents(events);
      await delay(30);
      assert.deepEqual(received, ['first', 'second', 'third']);
      assert.ok(dispatched.every(event => event.currentTarget === null));
    }
    pc.close();
    assert.deepEqual(reported, errors);
  `);
});

test("errors reading or invoking an object listener are reported and do not stop dispatch", () => {
  runWithUncaughtExceptions(`
    const target = new EventTarget();
    const failure = new Error('handleEvent getter');
    target.addEventListener('test', { get handleEvent() { throw failure; } });
    target.addEventListener('test', {});
    let delivered = false;
    target.addEventListener('test', () => { delivered = true; });
    assert.equal(target.dispatchEvent(new Event('test')), true);
    assert.equal(delivered, true);
    assert.deepEqual(reported, []);
    await delay(30);
    assert.equal(reported.length, 2);
    assert.equal(reported[0], failure);
    assert.ok(reported[1] instanceof TypeError);
  `);
});
