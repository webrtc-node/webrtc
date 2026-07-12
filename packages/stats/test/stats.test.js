"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { RTCPeerConnection, RTCStatsReport } = require("@webrtc-node/webrtc");
const { RTCStatsSampler, diffStatsReports } = require("..");

function waitFor(target, type, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), timeout);
    target.addEventListener(
      type,
      (event) => {
        clearTimeout(timer);
        resolve(event);
      },
      { once: true },
    );
  });
}

async function negotiate(offerer, answerer) {
  await offerer.setLocalDescription(await offerer.createOffer());
  await answerer.setRemoteDescription(offerer.localDescription);
  await answerer.setLocalDescription(await answerer.createAnswer());
  await offerer.setRemoteDescription(answerer.localDescription);
}

test("RTCPeerConnection.getStats returns a read-only RTCStatsReport", async () => {
  const peer = new RTCPeerConnection();
  try {
    peer.createDataChannel("stats");
    const report = await peer.getStats();
    assert.ok(report instanceof RTCStatsReport);
    assert.equal(typeof report.set, "undefined");
    const transport = report.get("transport-0");
    assert.equal(transport.type, "transport");
    assert.equal(transport.dtlsState, "new");
    assert.equal(transport.iceState, "new");
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
        ssrc: 100,
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
        ssrc: 200,
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
  const peer = new RTCPeerConnection();
  try {
    assert.throws(() => new RTCStatsSampler(peer, { onError: true }), TypeError);
  } finally {
    peer.close();
  }
});

test("RTCStatsSampler stops and reports asynchronous callback failures", async () => {
  const peer = new RTCPeerConnection();
  try {
    let samples = 0;
    const reported = new Promise((resolve) => {
      const sampler = new RTCStatsSampler(peer, { interval: 10, onError: resolve });
      sampler.start(() => {
        samples += 1;
        throw new Error("consumer failed");
      });
    });
    const error = await reported;
    assert.match(error.message, /consumer failed/);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(samples, 1);
  } finally {
    peer.close();
  }
});

test("standard data-channel stats count accepted and received messages", async () => {
  const offerer = new RTCPeerConnection();
  const answerer = new RTCPeerConnection();
  try {
    const remoteChannelPromise = waitFor(answerer, "datachannel").then((event) => event.channel);
    const channel = offerer.createDataChannel("telemetry", { protocol: "json" });
    await negotiate(offerer, answerer);
    const remoteChannel = await remoteChannelPromise;
    await Promise.all([
      channel.readyState === "open" ? undefined : waitFor(channel, "open"),
      remoteChannel.readyState === "open" ? undefined : waitFor(remoteChannel, "open"),
    ]);
    const received = waitFor(remoteChannel, "message");
    channel.send("hello");
    await received;

    const localReport = await offerer.getStats();
    const local = [...localReport.values()].find((entry) => entry.type === "data-channel");
    assert.deepEqual(
      {
        label: local.label,
        protocol: local.protocol,
        dataChannelIdentifier: local.dataChannelIdentifier,
        state: local.state,
        messagesSent: local.messagesSent,
        bytesSent: local.bytesSent,
        messagesReceived: local.messagesReceived,
        bytesReceived: local.bytesReceived,
      },
      {
        label: "telemetry",
        protocol: "json",
        dataChannelIdentifier: channel.id,
        state: "open",
        messagesSent: 1,
        bytesSent: 5,
        messagesReceived: 0,
        bytesReceived: 0,
      },
    );
    assert.equal(localReport.get("peer-connection").dataChannelsOpened, 1);

    const remote = [...(await answerer.getStats()).values()].find(
      (entry) => entry.type === "data-channel",
    );
    assert.equal(remote.messagesReceived, 1);
    assert.equal(remote.bytesReceived, 5);

    const closed = waitFor(channel, "close");
    channel.close();
    await closed;
    const closedReport = await offerer.getStats();
    assert.equal(closedReport.get("peer-connection").dataChannelsClosed, 1);
  } finally {
    offerer.close();
    answerer.close();
  }
});
