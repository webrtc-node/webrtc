"use strict";

const { performance } = require("node:perf_hooks");
const { connectRemotePeer } = require("../test/fixtures/remote-datachannel");

function option(name, fallback, maximum, minimum = 1) {
  const argument = process.argv.slice(2).find((value) => value.startsWith(`--${name}=`));
  const value = argument === undefined ? fallback : Number(argument.slice(name.length + 3));
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`--${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function percentile(samples, fraction) {
  return Number(
    [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * fraction) - 1].toFixed(3),
  );
}

async function main() {
  const peerCount = option("peers", 4, 32);
  const messages = option("messages", 1000, 100000);
  const size = option("size", 256, 262144, 4);
  const rounds = option("rounds", 8, 100);
  const peers = [];
  const loops = [];
  const yields = [];
  const deliveries = [];
  try {
    for (let index = 0; index < peerCount; index++) {
      peers.push(await connectRemotePeer({ verifySequence: true }));
    }
    const payload = Buffer.alloc(size, 0x5a);
    for (let round = 0; round < rounds; round++) {
      const start = performance.now();
      const yielded = new Promise((resolve) =>
        setImmediate(() => resolve(performance.now() - start)),
      );
      for (let message = 0; message < messages; message++) {
        payload.writeUInt32LE(round * messages + message, 0);
        for (const { channel } of peers) channel.send(payload);
      }
      loops.push(performance.now() - start);
      yields.push(await yielded);
      await Promise.all(
        peers.map((peer) => peer.request("received", { count: (round + 1) * messages })),
      );
      deliveries.push(performance.now() - start);
    }
    console.log(
      JSON.stringify(
        {
          node: process.version,
          platform: process.platform,
          peers: peerCount,
          messagesPerPeerPerBurst: messages,
          payloadBytes: size,
          rounds,
          sendLoopMedianMs: percentile(loops, 0.5),
          sendLoopP95Ms: percentile(loops, 0.95),
          eventLoopYieldP95Ms: percentile(yields, 0.95),
          deliveryMedianMs: percentile(deliveries, 0.5),
          receivedMessages: rounds * messages * peerCount,
        },
        null,
        2,
      ),
    );
  } finally {
    await Promise.all(peers.map((peer) => peer.close()));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
