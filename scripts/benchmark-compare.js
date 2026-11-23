"use strict";

// Cross-process data-channel benchmark through the W3C API, so the same code
// can drive this package or node-datachannel's polyfill. The sender is this
// process; the receiver is a forked child running the same library.
//
//   npm run benchmark:compare -- --library=webrtc-node --scenario=rate
//   npm install --no-save node-datachannel
//   npm run benchmark:compare -- --library=node-datachannel --scenario=rate

const { fork } = require("node:child_process");
const { performance } = require("node:perf_hooks");
const { parseArgs } = require("node:util");

const { values: options } = parseArgs({
  options: {
    library: { type: "string", default: "webrtc-node" },
    scenario: { type: "string", default: "rate" },
    messages: { type: "string" },
    size: { type: "string" },
  },
});
const SCENARIOS = {
  rate: { size: 64, messages: 200000 },
  text: { size: 64, messages: 200000 },
  bulk: { size: 65536, messages: 4096 },
  pingpong: { size: 64, messages: 5000 },
};
const scenario = SCENARIOS[options.scenario];
if (!scenario) throw new Error(`--scenario must be one of ${Object.keys(SCENARIOS).join(", ")}`);
const size = Number(options.size ?? scenario.size);
const messages = Number(options.messages ?? scenario.messages);
const HIGH_WATER = 1024 * 1024;
const LOW_WATER = 256 * 1024;

function loadLibrary(name) {
  if (name === "webrtc-node") return require("..");
  if (name === "node-datachannel") {
    try {
      return require("node-datachannel/polyfill");
    } catch {
      throw new Error("Install node-datachannel first: npm install --no-save node-datachannel");
    }
  }
  throw new Error("--library must be webrtc-node or node-datachannel");
}
const { RTCPeerConnection } = loadLibrary(options.library);

// CPU time, event-loop utilization, and peak RSS for one process.
function meter() {
  const cpu = process.cpuUsage();
  const elu = performance.eventLoopUtilization();
  const start = performance.now();
  let peakRss = process.memoryUsage().rss;
  const timer = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 20);
  timer.unref();
  return () => {
    clearInterval(timer);
    const used = process.cpuUsage(cpu);
    return {
      wallMs: performance.now() - start,
      cpuMs: (used.user + used.system) / 1000,
      elu: performance.eventLoopUtilization(elu).utilization,
      peakRssMiB: Math.max(peakRss, process.memoryUsage().rss) / 1048576,
    };
  };
}

function forwardCandidates(peer, send) {
  peer.onicecandidate = ({ candidate }) => {
    if (candidate) send({ kind: "candidate", candidate: candidate.toJSON() });
  };
}

function receiver() {
  const peer = new RTCPeerConnection();
  forwardCandidates(peer, (message) => process.send(message));
  let stop;
  let received = 0;
  let expected = Number.POSITIVE_INFINITY;
  const finish = () => process.send({ kind: "done", received, ...stop() });
  peer.ondatachannel = ({ channel }) => {
    channel.binaryType = "arraybuffer";
    channel.onmessage = ({ data }) => {
      if (options.scenario === "pingpong") {
        channel.send(data);
        return;
      }
      if (received === 0) stop = meter();
      received += 1;
      if (received === expected) finish();
    };
  };
  process.on("message", async (message) => {
    if (message.kind === "offer") {
      await peer.setRemoteDescription(message.description);
      await peer.setLocalDescription(await peer.createAnswer());
      process.send({ kind: "answer", description: peer.localDescription.toJSON() });
    } else if (message.kind === "candidate") {
      peer.addIceCandidate(message.candidate).catch(() => {});
    } else if (message.kind === "expect") {
      expected = message.count;
      if (received === expected) finish();
    } else if (message.kind === "exit") {
      peer.close();
      setTimeout(() => process.exit(0), 50);
    }
  });
}

async function sender() {
  const child = fork(__filename, process.argv.slice(2), {
    env: { ...process.env, BENCHMARK_COMPARE_ROLE: "receiver" },
  });
  const waiting = new Map();
  const peer = new RTCPeerConnection();
  child.on("message", (message) => {
    if (message.kind === "candidate") {
      peer.addIceCandidate(message.candidate).catch(() => {});
      return;
    }
    waiting.get(message.kind)?.(message);
    waiting.delete(message.kind);
  });
  const next = (kind) => new Promise((resolve) => waiting.set(kind, resolve));
  forwardCandidates(peer, (message) => child.send(message));

  const channel = peer.createDataChannel("benchmark");
  channel.binaryType = "arraybuffer";
  channel.bufferedAmountLowThreshold = LOW_WATER;
  const opened = new Promise((resolve) => {
    channel.onopen = resolve;
  });
  await peer.setLocalDescription(await peer.createOffer());
  const answered = next("answer");
  child.send({ kind: "offer", description: peer.localDescription.toJSON() });
  await peer.setRemoteDescription((await answered).description);
  await opened;

  let result;
  if (options.scenario === "pingpong") {
    const payload = new Uint8Array(size);
    const samples = [];
    const stop = meter();
    for (let index = 0; index < messages; index += 1) {
      const start = performance.now();
      const echoed = new Promise((resolve) => {
        channel.onmessage = resolve;
      });
      channel.send(payload);
      await echoed;
      samples.push(performance.now() - start);
    }
    const usage = stop();
    samples.sort((a, b) => a - b);
    const percentile = (fraction) =>
      samples[Math.min(samples.length - 1, Math.floor(samples.length * fraction))];
    result = {
      rttP50Ms: percentile(0.5),
      rttP99Ms: percentile(0.99),
      cpuUsPerRoundTrip: (usage.cpuMs * 1000) / messages,
    };
  } else {
    const payload = options.scenario === "text" ? "x".repeat(size) : new Uint8Array(size);
    const done = next("done");
    child.send({ kind: "expect", count: messages });
    const stop = meter();
    let sent = 0;
    while (sent < messages) {
      while (sent < messages && channel.bufferedAmount < HIGH_WATER) {
        channel.send(payload);
        sent += 1;
      }
      if (sent < messages) {
        await new Promise((resolve) => {
          channel.onbufferedamountlow = resolve;
        });
      }
    }
    const usage = stop();
    const remote = await done;
    const seconds = remote.wallMs / 1000;
    result = {
      messagesPerSecond: messages / seconds,
      mibPerSecond: (messages * size) / 1048576 / seconds,
      senderCpuUsPerMessage: (usage.cpuMs * 1000) / messages,
      receiverCpuUsPerMessage: (remote.cpuMs * 1000) / messages,
      senderEventLoopUtilization: usage.elu,
      receiverEventLoopUtilization: remote.elu,
      receiverPeakRssMiB: remote.peakRssMiB,
    };
  }
  const rounded = Object.fromEntries(
    Object.entries(result).map(([key, value]) => [key, Number(value.toFixed(3))]),
  );
  console.log(
    JSON.stringify({
      library: options.library,
      scenario: options.scenario,
      size,
      messages,
      ...rounded,
    }),
  );
  child.send({ kind: "exit" });
  peer.close();
  setTimeout(() => process.exit(0), 100);
}

if (process.env.BENCHMARK_COMPARE_ROLE === "receiver") {
  receiver();
} else {
  sender().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
