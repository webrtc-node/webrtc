"use strict";

const assert = require("node:assert/strict");
const { fork } = require("node:child_process");
const { once } = require("node:events");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { setTimeout: delay } = require("node:timers/promises");
const { parseArgs } = require("node:util");

function elapsedCpuMs(start) {
  const usage = process.cpuUsage(start);
  return (usage.user + usage.system) / 1000;
}

function waitForOpen(channel) {
  return channel.readyState === "open" ? Promise.resolve() : once(channel, "open");
}

async function gather(peer) {
  await peer.setLocalDescription();
  if (peer.iceGatheringState !== "complete") await once(peer, "icegatheringstatechange");
  return peer.localDescription.toJSON();
}

function runEndpoint(packagePath) {
  const { RTCPeerConnection } = require(packagePath);
  const peers = [];
  let started;
  let received = 0;
  let signalReceipt;
  let receiveError;
  let sendBuffer;

  function trackChannel(entry, channel) {
    entry.channel = channel;
    channel.binaryType = "arraybuffer";
    channel.onmessage = ({ data }) => {
      if (!receiveError) {
        try {
          assert.equal(new DataView(data).getUint32(0, true), entry.received++);
          received++;
        } catch (error) {
          receiveError = error;
        }
      }
      signalReceipt?.();
    };
    return waitForOpen(channel);
  }

  function addPeer() {
    const entry = { peer: new RTCPeerConnection(), received: 0 };
    peers.push(entry);
    return entry;
  }

  const commands = {
    start: () => {
      started = process.cpuUsage();
    },
    sample: () => {
      if (receiveError) throw receiveError;
      return { cpuMs: elapsedCpuMs(started), received };
    },
    offer: (count) =>
      Promise.all(
        Array.from({ length: count }, () => {
          const entry = addPeer();
          entry.open = trackChannel(entry, entry.peer.createDataChannel("cpu"));
          return gather(entry.peer);
        }),
      ),
    answer: (offers) =>
      Promise.all(
        offers.map(async (offer) => {
          const entry = addPeer();
          entry.open = once(entry.peer, "datachannel").then(([event]) =>
            trackChannel(entry, event.channel),
          );
          await entry.peer.setRemoteDescription(offer);
          return gather(entry.peer);
        }),
      ),
    accept: (answers) =>
      Promise.all(answers.map((answer, index) => peers[index].peer.setRemoteDescription(answer))),
    ready: async () => {
      await Promise.all(peers.map(({ open }) => open));
    },
    exchange: async ({ from, to, size, send, receive }) => {
      if (send) {
        sendBuffer ??= Buffer.alloc(size);
        for (let sequence = from; sequence < to; sequence++) {
          sendBuffer.writeUInt32LE(sequence);
          for (const { channel } of peers) channel.send(sendBuffer);
        }
      }
      if (receive) {
        const expected = to * peers.length;
        await new Promise((resolve, reject) => {
          signalReceipt = () => {
            if (receiveError) reject(receiveError);
            else if (received >= expected) resolve();
          };
          signalReceipt();
        }).finally(() => {
          signalReceipt = undefined;
        });
      }
    },
    close: () => {
      for (const { peer } of peers) peer.close();
    },
  };

  process.on("message", async ({ command, argument }) => {
    try {
      process.send({ result: await commands[command](argument) });
    } catch (error) {
      process.send({ error: error.message });
    }
  });
}

const threadLimitEnv = "WEBRTC_NODE_LIBDATACHANNEL_THREAD_LIMIT";

function startEndpoint(packagePath, threadLimit) {
  const env = { ...process.env };
  if (threadLimit !== undefined) env[threadLimitEnv] = String(threadLimit);
  const child = fork(__filename, ["--endpoint", packagePath], { windowsHide: true, env });
  const exit = once(child, "exit");
  // A launch failure can arrive before the first command.
  exit.catch(() => {});
  return {
    child,
    exit,
    async call(command, argument) {
      if (!child.connected) throw new Error(`Endpoint disconnected before ${command}`);
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), 30000);
      const respond = once(child, "message", { signal: abort.signal });
      const disconnect = () => abort.abort();
      child.once("disconnect", disconnect);
      try {
        child.send({ command, argument }, (error) => {
          if (error) abort.abort(error);
        });
        const [{ result, error }] = await respond;
        if (error) throw new Error(`${command}: ${error}`);
        return result;
      } catch (error) {
        if (error.name === "AbortError") {
          throw new Error(`Endpoint interrupted during ${command}`, { cause: error });
        }
        throw error;
      } finally {
        child.removeListener("disconnect", disconnect);
        abort.abort();
        clearTimeout(timer);
        // Also consume the listener's rejection if send() threw synchronously.
        respond.catch(() => {});
      }
    },
  };
}

function parseOptions() {
  const { values } = parseArgs({
    options: {
      package: { type: "string", default: path.resolve(__dirname, "..") },
      direction: { type: "string", default: "both" },
      peers: { type: "string", default: "4" },
      messages: { type: "string", default: "128" },
      rounds: { type: "string", default: "20" },
      size: { type: "string", default: "256" },
      "idle-ms": { type: "string", default: "0" },
      "pace-ms": { type: "string", default: "0" },
      "offerer-thread-limit": { type: "string", default: process.env[threadLimitEnv] },
      "answerer-thread-limit": { type: "string", default: process.env[threadLimitEnv] },
    },
  });
  const integer = (key, min, max) => {
    const number = Number(values[key]);
    if (!Number.isInteger(number) || number < min || number > max) {
      throw new RangeError(`--${key} must be an integer from ${min} to ${max}`);
    }
    return number;
  };
  if (!["send", "receive", "both"].includes(values.direction)) {
    throw new Error("--direction must be send, receive, or both");
  }
  return {
    packagePath: path.resolve(values.package),
    direction: values.direction,
    peers: integer("peers", 1, 64),
    messages: integer("messages", 1, 65536),
    rounds: integer("rounds", 1, 10000),
    size: integer("size", 4, 262144),
    idleMs: integer("idle-ms", 0, 3600000),
    paceMs: integer("pace-ms", 0, 60000),
    offererThreadLimit:
      values["offerer-thread-limit"] === undefined
        ? undefined
        : integer("offerer-thread-limit", 2, 4294967295),
    answererThreadLimit:
      values["answerer-thread-limit"] === undefined
        ? undefined
        : integer("answerer-thread-limit", 2, 4294967295),
  };
}

async function main() {
  const options = parseOptions();
  const { packagePath, direction, peers, messages, rounds, size, idleMs, paceMs } = options;
  const endpoints = [
    startEndpoint(packagePath, options.offererThreadLimit),
    startEndpoint(packagePath, options.answererThreadLimit),
  ];
  const [offerer, answerer] = endpoints;
  const both = (command, argument) =>
    Promise.all(endpoints.map((endpoint) => endpoint.call(command, argument)));
  const aSends = direction !== "receive";
  const bSends = direction !== "send";
  async function measure(work) {
    await both("start");
    const start = performance.now();
    await work();
    const wallMs = performance.now() - start;
    const [offererSample, answererSample] = await both("sample");
    return { wallMs, offerer: offererSample, answerer: answererSample };
  }

  try {
    const setup = await measure(async () => {
      const offers = await offerer.call("offer", peers);
      const answers = await answerer.call("answer", offers);
      await offerer.call("accept", answers);
      await both("ready");
    });
    const idle = idleMs > 0 ? await measure(() => delay(idleMs)) : null;
    const deliveries = [];
    const traffic = await measure(async () => {
      const start = performance.now();
      for (let round = 0; round < rounds; round++) {
        const burstStarted = performance.now();
        const args = { from: round * messages, to: (round + 1) * messages, size };
        await Promise.all([
          offerer.call("exchange", { ...args, send: aSends, receive: bSends }),
          answerer.call("exchange", { ...args, send: bSends, receive: aSends }),
        ]);
        deliveries.push(performance.now() - burstStarted);
        const waitMs = (round + 1) * paceMs - (performance.now() - start);
        if (waitMs > 0) await delay(waitMs);
      }
    });
    const expected = peers * rounds * messages;
    assert.equal(traffic.offerer.received, bSends ? expected : 0);
    assert.equal(traffic.answerer.received, aSends ? expected : 0);
    const delivered = traffic.offerer.received + traffic.answerer.received;
    const closeCalls = await measure(() => both("close"));
    const disconnectStarted = performance.now();
    for (const { child } of endpoints) child.disconnect();
    const watchdog = setTimeout(() => {
      for (const { child } of endpoints) child.kill();
    }, 30000);
    try {
      for (const { exit } of endpoints) assert.deepEqual(await exit, [0, null]);
    } finally {
      clearTimeout(watchdog);
    }
    const disconnectToExitMs = performance.now() - disconnectStarted;
    deliveries.sort((a, b) => a - b);
    console.log(
      JSON.stringify(
        {
          ...options,
          node: process.version,
          platform: process.platform,
          arch: process.arch,
          setup,
          idle,
          traffic: {
            ...traffic,
            delivered,
            cpuUsPerMessage: ((traffic.offerer.cpuMs + traffic.answerer.cpuMs) * 1000) / delivered,
            deliveryP95Ms: deliveries[Math.ceil(deliveries.length * 0.95) - 1],
          },
          closeCalls,
          disconnectToExitMs,
        },
        null,
        2,
      ),
    );
  } finally {
    for (const { child } of endpoints) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
    await Promise.allSettled(endpoints.map(({ exit }) => exit));
  }
}

if (process.argv[2] === "--endpoint") runEndpoint(process.argv[3]);
else
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
