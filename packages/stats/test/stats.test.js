"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { RTCPeerConnection, RTCStatsReport } = require("@webrtc-node/webrtc");
const { RTCStatsSampler, diffStatsReports } = require("..");

test("RTCPeerConnection.getStats returns a read-only RTCStatsReport", async () => {
  const peer = new RTCPeerConnection();
  try {
    peer.createDataChannel("stats");
    const report = await peer.getStats();
    assert.ok(report instanceof RTCStatsReport);
    assert.equal(typeof report.set, "undefined");
    const transport = report.get("transport-0");
    assert.equal(transport.type, "transport");
    assert.equal(Object.isFrozen(transport), true);
  } finally {
    peer.close();
  }
});

test("diffStatsReports computes deltas for matching standardized entries", () => {
  const previous = new Map([
    [
      "outbound-rtp-0",
      {
        id: "outbound-rtp-0",
        type: "outbound-rtp",
        timestamp: 1000,
        packetsSent: 2,
        bytesSent: 20,
      },
    ],
  ]);
  const current = new Map([
    [
      "outbound-rtp-0",
      {
        id: "outbound-rtp-0",
        type: "outbound-rtp",
        timestamp: 2000,
        packetsSent: 5,
        bytesSent: 50,
      },
    ],
  ]);
  assert.deepEqual(diffStatsReports(previous, current).get("outbound-rtp-0"), {
    id: "outbound-rtp-0",
    type: "outbound-rtp",
    timestamp: 2000,
    packetsSent: 3,
    bytesSent: 30,
  });
});

test("RTCStatsSampler samples standard reports and validates lifecycle", async () => {
  const peer = new RTCPeerConnection();
  try {
    const sampler = new RTCStatsSampler(peer, { interval: 10 });
    assert.equal((await sampler.sample()).delta, null);
    assert.ok((await sampler.sample()).delta instanceof Map);
    sampler.start(() => {});
    assert.throws(() => sampler.start(() => {}), /already running/);
    sampler.stop();
  } finally {
    peer.close();
  }
});

test("RTCStatsSampler rejects foreign targets", () => {
  assert.throws(() => new RTCStatsSampler({}), TypeError);
});
