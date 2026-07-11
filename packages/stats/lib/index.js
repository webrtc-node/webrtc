"use strict";

const { performance } = require("node:perf_hooks");
const { RTCPeerConnection, nonstandard } = require("@webrtc-node/webrtc");

function assertPeerConnection(peerConnection) {
  if (!(peerConnection instanceof RTCPeerConnection)) {
    throw new TypeError("peerConnection must be an @webrtc-node/webrtc RTCPeerConnection");
  }
}

function freezeCandidate(candidate) {
  if (candidate == null) return null;
  return Object.freeze({
    candidate: candidate.candidate,
    sdpMid: candidate.sdpMid,
    foundation: candidate.foundation,
    component: candidate.component,
    priority: candidate.priority,
    address: candidate.address,
    protocol: candidate.protocol,
    port: candidate.port,
    type: candidate.type,
    tcpType: candidate.tcpType,
    relatedAddress: candidate.relatedAddress,
    relatedPort: candidate.relatedPort,
  });
}

function snapshot(peerConnection) {
  assertPeerConnection(peerConnection);
  const timestamp = performance.timeOrigin + performance.now();
  const nativePeer = nonstandard.getNativePeerConnection(peerConnection);
  const transport = nativePeer.transportStats();
  const pair = peerConnection.sctp?.transport?.iceTransport?.getSelectedCandidatePair() ?? null;

  return Object.freeze({
    timestamp,
    type: "transport",
    connectionState: peerConnection.connectionState,
    iceConnectionState: peerConnection.iceConnectionState,
    bytesSent: transport.bytesSent,
    bytesReceived: transport.bytesReceived,
    roundTripTime: transport.roundTripTime,
    localAddress: transport.localAddress,
    remoteAddress: transport.remoteAddress,
    localCandidate: freezeCandidate(pair?.local),
    remoteCandidate: freezeCandidate(pair?.remote),
  });
}

function delta(previous, current) {
  if (!previous || !current) throw new TypeError("delta requires two stats snapshots");
  for (const [label, value] of [
    ["previous.timestamp", previous.timestamp],
    ["previous.bytesSent", previous.bytesSent],
    ["previous.bytesReceived", previous.bytesReceived],
    ["current.timestamp", current.timestamp],
    ["current.bytesSent", current.bytesSent],
    ["current.bytesReceived", current.bytesReceived],
  ]) {
    if (!Number.isFinite(value) || value < 0) {
      throw new TypeError(`${label} must be a finite non-negative number`);
    }
  }
  const elapsedMs = current.timestamp - previous.timestamp;
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) {
    throw new RangeError("current.timestamp must be greater than previous.timestamp");
  }
  const sent = Math.max(0, current.bytesSent - previous.bytesSent);
  const received = Math.max(0, current.bytesReceived - previous.bytesReceived);
  return Object.freeze({
    timestamp: current.timestamp,
    elapsedMs,
    bytesSent: sent,
    bytesReceived: received,
    sendBitrate: (sent * 8000) / elapsedMs,
    receiveBitrate: (received * 8000) / elapsedMs,
  });
}

class StatsSampler {
  constructor(peerConnection, options = {}) {
    assertPeerConnection(peerConnection);
    const interval = options.interval ?? 1000;
    if (!Number.isInteger(interval) || interval < 10) {
      throw new RangeError("interval must be an integer of at least 10 milliseconds");
    }
    this.peerConnection = peerConnection;
    this.interval = interval;
    this._timer = null;
    this._previous = null;
  }

  sample() {
    const current = snapshot(this.peerConnection);
    const change = this._previous ? delta(this._previous, current) : null;
    this._previous = current;
    return Object.freeze({ current, delta: change });
  }

  start(callback) {
    if (typeof callback !== "function") throw new TypeError("callback must be a function");
    if (this._timer !== null) throw new Error("StatsSampler is already running");
    this._timer = setInterval(() => callback(this.sample()), this.interval);
    this._timer.unref?.();
    return this;
  }

  stop() {
    if (this._timer !== null) clearInterval(this._timer);
    this._timer = null;
    this._previous = null;
  }
}

function clear(peerConnection) {
  assertPeerConnection(peerConnection);
  nonstandard.getNativePeerConnection(peerConnection).clearTransportStats();
}

module.exports = { StatsSampler, clear, delta, snapshot };
