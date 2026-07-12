"use strict";

const { RTCPeerConnection, RTCRtpReceiver, RTCRtpSender } = require("@webrtc-node/webrtc");

const cumulativeStatFields = new Set([
  "bytesReceived",
  "bytesSent",
  "dataChannelsClosed",
  "dataChannelsOpened",
  "messagesReceived",
  "messagesSent",
  "packetsReceived",
  "packetsSent",
]);

function assertTarget(target) {
  if (
    !(target instanceof RTCPeerConnection) &&
    !(target instanceof RTCRtpSender) &&
    !(target instanceof RTCRtpReceiver)
  )
    throw new TypeError("target must expose a standard WebRTC getStats() method");
}

function diffStatsReports(previous, current) {
  if (
    !previous ||
    typeof previous.get !== "function" ||
    !current ||
    typeof current.values !== "function"
  ) {
    throw new TypeError("diffStatsReports requires two RTCStatsReport-compatible values");
  }
  const result = new Map();
  for (const entry of current.values()) {
    const prior = previous.get(entry.id);
    if (!prior || prior.type !== entry.type) continue;
    const delta = { id: entry.id, type: entry.type, timestamp: entry.timestamp };
    for (const [key, value] of Object.entries(entry)) {
      if (
        !cumulativeStatFields.has(key) ||
        !Number.isFinite(value) ||
        !Number.isFinite(prior[key])
      ) {
        continue;
      }
      delta[key] = Math.max(0, value - prior[key]);
    }
    result.set(entry.id, Object.freeze(delta));
  }
  return result;
}

class RTCStatsSampler {
  constructor(target, options = {}) {
    assertTarget(target);
    const interval = options.interval ?? 1000;
    if (!Number.isInteger(interval) || interval < 10) {
      throw new RangeError("interval must be an integer of at least 10 milliseconds");
    }
    this.target = target;
    this.interval = interval;
    if (options.onError !== undefined && typeof options.onError !== "function") {
      throw new TypeError("onError must be a function");
    }
    this.onError = options.onError ?? null;
    this._timer = null;
    this._previous = null;
    this._sampling = false;
  }

  async sample() {
    const report = await this.target.getStats();
    const delta = this._previous ? diffStatsReports(this._previous, report) : null;
    this._previous = report;
    return Object.freeze({ report, delta });
  }

  start(callback) {
    if (typeof callback !== "function") throw new TypeError("callback must be a function");
    if (this._timer !== null) throw new Error("RTCStatsSampler is already running");
    this._timer = setInterval(async () => {
      if (this._sampling) return;
      this._sampling = true;
      try {
        await callback(await this.sample());
      } catch (error) {
        this.stop();
        if (this.onError) {
          try {
            await this.onError(error);
          } catch (handlerError) {
            process.emitWarning(handlerError, { type: "RTCStatsSamplerError" });
          }
        } else {
          process.emitWarning(error, { type: "RTCStatsSamplerError" });
        }
      } finally {
        this._sampling = false;
      }
    }, this.interval);
    return this;
  }

  stop() {
    if (this._timer !== null) clearInterval(this._timer);
    this._timer = null;
    this._previous = null;
  }
}

module.exports = { RTCStatsSampler, diffStatsReports };
