"use strict";

// Real-time room benchmark: one host process and several player processes,
// shaped like a multiplayer game room. Each player has three negotiated data
// channels (reliable ordered, reliable unordered, unreliable unordered), sends
// small inputs at a fixed rate, and the host relays every input to the other
// players and sends a periodic sync on the unreliable channel. Only the host
// is measured: CPU, memory, event-loop delay, and event-loop utilization.
//
//   npm run benchmark:room
//   npm run benchmark:room -- --players=20 --input-rate=30 --seconds=30
//   npm run benchmark:room -- --library=node-datachannel
//   npm run benchmark:room -- --library=/path/to/another/checkout

const { fork } = require("node:child_process");
const path = require("node:path");
const { createHistogram, performance } = require("node:perf_hooks");
const { parseArgs } = require("node:util");

const { values: options } = parseArgs({
  options: {
    library: { type: "string", default: "webrtc-node" },
    players: { type: "string", default: "12" },
    "input-rate": { type: "string", default: "60" },
    "input-size": { type: "string", default: "16" },
    "sync-rate": { type: "string", default: "20" },
    "sync-size": { type: "string", default: "64" },
    warmup: { type: "string", default: "3" },
    seconds: { type: "string", default: "15" },
    role: { type: "string" },
    index: { type: "string" },
  },
});

const players = Number(options.players);
const inputRate = Number(options["input-rate"]);
const inputSize = Number(options["input-size"]);
const syncRate = Number(options["sync-rate"]);
const syncSize = Number(options["sync-size"]);
const warmupSeconds = Number(options.warmup);
const measureSeconds = Number(options.seconds);

// The same layout a browser game client negotiates.
const CHANNELS = [
  { name: "ro", init: { negotiated: true, id: 0, ordered: true } },
  { name: "ru", init: { negotiated: true, id: 1, ordered: false } },
  { name: "uu", init: { negotiated: true, id: 2, ordered: false, maxRetransmits: 0 } },
];
const RELIABLE = 0;
const UNRELIABLE = 2;

function loadLibrary(name) {
  if (name === "webrtc-node") return require("..");
  if (name === "node-datachannel") {
    try {
      return require("node-datachannel/polyfill");
    } catch {
      throw new Error("Install node-datachannel first: npm install --no-save node-datachannel");
    }
  }
  return require(path.resolve(name));
}
const { RTCPeerConnection } = loadLibrary(options.library);

function waitForGathering(peer) {
  if (peer.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    peer.addEventListener("icegatheringstatechange", () => {
      if (peer.iceGatheringState === "complete") resolve();
    });
  });
}

function openChannels(peer) {
  const channels = CHANNELS.map(({ name, init }) => {
    const channel = peer.createDataChannel(name, init);
    channel.binaryType = "arraybuffer";
    return channel;
  });
  const opened = Promise.all(
    channels.map(
      (channel) =>
        new Promise((resolve) => {
          if (channel.readyState === "open") resolve();
          else channel.addEventListener("open", resolve, { once: true });
        }),
    ),
  );
  return { channels, opened };
}

// A fresh ArrayBuffer per send, as game engines serialize each message.
function message(size, tag) {
  const buffer = new ArrayBuffer(size);
  new Uint8Array(buffer)[0] = tag;
  return buffer;
}

async function runPlayer() {
  const peer = new RTCPeerConnection();
  const { channels, opened } = openChannels(peer);
  let received = 0;
  for (const channel of channels) {
    channel.onmessage = () => {
      received += 1;
    };
  }
  await peer.setLocalDescription(await peer.createOffer());
  await waitForGathering(peer);
  process.send({ offer: peer.localDescription.toJSON() });

  let sent = 0;
  let timer;
  process.on("message", async (command) => {
    if (command.answer) {
      await peer.setRemoteDescription(command.answer);
      await opened;
      process.send({ ready: true });
    } else if (command.start) {
      // Catch up on the inputs that are due, so coarse timers keep the rate.
      const startedAt = performance.now();
      timer = setInterval(() => {
        const due = Math.floor(((performance.now() - startedAt) / 1000) * inputRate);
        while (sent < due) {
          sent += 1;
          if (channels[RELIABLE].readyState === "open") {
            channels[RELIABLE].send(message(inputSize, 1));
          }
        }
      }, 1000 / inputRate);
    } else if (command.stop) {
      clearInterval(timer);
      process.send({ stats: { sent, received } });
    } else if (command.exit) {
      peer.close();
      process.exit(0);
    }
  });
}

function percentile(histogram, value) {
  return Number((histogram.percentile(value) / 1e6).toFixed(2));
}

// How long queued work waits behind other callbacks. It does not depend on
// timer resolution, which is about 15 ms on Windows and hides small delays.
function probeEventLoopDelay() {
  const histogram = createHistogram();
  let stopped = false;
  const probe = () => {
    if (stopped) return;
    const queuedAt = performance.now();
    setImmediate(() => {
      histogram.record(Math.max(1, Math.round((performance.now() - queuedAt) * 1e6)));
      setTimeout(probe, 1);
    });
  };
  probe();
  return {
    histogram,
    stop() {
      stopped = true;
    },
  };
}

async function runHost() {
  const children = [];
  const rooms = [];
  let relayed = 0;
  let received = 0;
  for (let index = 0; index < players; index += 1) {
    const child = fork(__filename, [...process.argv.slice(2), "--role=player", `--index=${index}`]);
    children.push(child);
    const peer = new RTCPeerConnection();
    const { channels, opened } = openChannels(peer);
    rooms.push({ peer, channels });
    channels[RELIABLE].onmessage = () => {
      received += 1;
      // Relay each input to every other player.
      for (let other = 0; other < rooms.length; other += 1) {
        if (other === index) continue;
        const target = rooms[other].channels[RELIABLE];
        if (target.readyState !== "open") continue;
        target.send(message(inputSize, 2));
        relayed += 1;
      }
    };
    const offer = await new Promise((resolve) =>
      child.once("message", (reply) => resolve(reply.offer)),
    );
    await peer.setRemoteDescription(offer);
    await peer.setLocalDescription(await peer.createAnswer());
    await waitForGathering(peer);
    const ready = new Promise((resolve) => child.once("message", resolve));
    child.send({ answer: peer.localDescription.toJSON() });
    await Promise.all([ready, opened]);
  }

  let syncs = 0;
  const sync = setInterval(() => {
    for (const { channels } of rooms) {
      if (channels[UNRELIABLE].readyState !== "open") continue;
      channels[UNRELIABLE].send(message(syncSize, 3));
      syncs += 1;
    }
  }, 1000 / syncRate);

  for (const child of children) child.send({ start: true });
  await new Promise((resolve) => setTimeout(resolve, warmupSeconds * 1000));

  const delayProbe = probeEventLoopDelay();
  const delay = delayProbe.histogram;
  const cpu = process.cpuUsage();
  const elu = performance.eventLoopUtilization();
  const start = performance.now();
  const counts = { received, relayed, syncs };
  let peakRss = process.memoryUsage().rss;
  const rssTimer = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 100);
  await new Promise((resolve) => setTimeout(resolve, measureSeconds * 1000));
  const elapsed = (performance.now() - start) / 1000;
  const usage = process.cpuUsage(cpu);
  const loop = performance.eventLoopUtilization(elu);
  delayProbe.stop();
  clearInterval(rssTimer);
  clearInterval(sync);

  const playerStats = await Promise.all(
    children.map(
      (child) =>
        new Promise((resolve) => {
          child.once("message", (reply) => resolve(reply.stats));
          child.send({ stop: true });
        }),
    ),
  );
  for (const child of children) child.send({ exit: true });
  for (const { peer } of rooms) peer.close();

  const inputs = received - counts.received;
  const outgoing = relayed - counts.relayed + (syncs - counts.syncs);
  const result = {
    library: options.library,
    players,
    inputRate,
    seconds: Number(elapsed.toFixed(1)),
    hostMessagesPerSecond: {
      received: Math.round(inputs / elapsed),
      sent: Math.round(outgoing / elapsed),
    },
    hostCpuPercent: Number((((usage.user + usage.system) / 1e6 / elapsed) * 100).toFixed(1)),
    hostCpuUsPerMessage: Number(
      ((usage.user + usage.system) / Math.max(1, inputs + outgoing)).toFixed(2),
    ),
    hostEventLoopUtilization: Number(loop.utilization.toFixed(3)),
    hostEventLoopDelayMs: {
      p50: percentile(delay, 50),
      p99: percentile(delay, 99),
      max: Number((delay.max / 1e6).toFixed(2)),
    },
    hostPeakRssMiB: Math.round(peakRss / 1048576),
    playerInputsSent: playerStats.reduce((sum, stats) => sum + stats.sent, 0),
    playerMessagesReceived: playerStats.reduce((sum, stats) => sum + stats.received, 0),
  };
  console.log(JSON.stringify(result));
  process.exit(0);
}

if (options.role === "player") runPlayer();
else runHost();
