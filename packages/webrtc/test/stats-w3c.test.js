"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { RTCPeerConnection, RTCStatsReport } = require("..");

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

test("peer, sender, and receiver stats collection stays asynchronous", async () => {
  const peer = new RTCPeerConnection();
  try {
    const { sender, receiver } = peer.addTransceiver("audio");
    const settled = [false, false, false];
    const promises = [peer.getStats(), sender.getStats(), receiver.getStats()].map(
      (promise, index) =>
        promise.then((report) => {
          settled[index] = true;
          return report;
        }),
    );

    for (let iteration = 0; iteration < 20; iteration += 1) await Promise.resolve();
    assert.deepEqual(settled, [false, false, false]);
    const reports = await Promise.all(promises);
    assert.ok(reports.every((report) => report instanceof RTCStatsReport));
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
