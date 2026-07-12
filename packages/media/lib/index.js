"use strict";

const {
  Event,
  EventTarget,
  MediaStreamTrack,
  MessageEvent,
  nonstandard,
} = require("@webrtc-node/webrtc");

const codecs = new Map([
  ["audio/opus", "opus"],
  ["audio/pcma", "PCMA"],
  ["audio/pcmu", "PCMU"],
  ["audio/g722", "G722"],
  ["audio/aac", "AAC"],
  ["video/h264", "H264"],
  ["video/h265", "H265"],
  ["video/vp8", "VP8"],
  ["video/vp9", "VP9"],
  ["video/av1", "AV1"],
]);

function normalizeInit(init) {
  if (init == null || typeof init !== "object") throw new TypeError("init must be an object");
  const kind = String(init.kind || "").toLowerCase();
  if (kind !== "audio" && kind !== "video") throw new TypeError("kind must be audio or video");
  const mimeType = String(init.codec?.mimeType || "").toLowerCase();
  const codec = codecs.get(mimeType);
  if (!codec || !mimeType.startsWith(`${kind}/`)) throw new TypeError(`Unsupported ${kind} codec`);
  const payloadType = Number(init.codec?.payloadType);
  if (!Number.isInteger(payloadType) || payloadType < 0 || payloadType > 127) {
    throw new RangeError("payloadType must be an integer between 0 and 127");
  }
  const profile = init.codec.profile === undefined ? undefined : String(init.codec.profile);
  if (profile && /[\r\n]/u.test(profile))
    throw new TypeError("codec profile must not contain lines");
  let ssrc;
  if (init.ssrc !== undefined) {
    ssrc = Number(init.ssrc);
    if (!Number.isInteger(ssrc) || ssrc < 1 || ssrc > 0xffffffff) {
      throw new RangeError("ssrc must be an integer between 1 and 4294967295");
    }
  }
  return { kind, mimeType, codec, payloadType, profile, ssrc };
}

class EncodedMediaSource extends EventTarget {
  constructor(init) {
    super();
    const normalized = normalizeInit(init);
    this.codec = Object.freeze({
      mimeType: normalized.mimeType,
      payloadType: normalized.payloadType,
      ...(normalized.profile === undefined ? {} : { profile: normalized.profile }),
    });
    this.ssrc = normalized.ssrc ?? null;
    this.readyState = "new";
    this.onopen = null;
    this.onclose = null;
    this.onerror = null;
    this._source = {
      codec: {
        codec: normalized.codec,
        payloadType: normalized.payloadType,
        profile: normalized.profile,
      },
      ssrc: normalized.ssrc,
      _attachNativeTrack: (nativeTrack) => {
        this._source.nativeTrack = nativeTrack;
        this.readyState = nativeTrack.isOpen ? "open" : "connecting";
      },
      _handleNativeEvent: (event) => this._handleNativeEvent(event),
      stop: () => this.close(),
    };
    this.track = nonstandard.createMediaStreamTrack({
      kind: normalized.kind,
      label: init.label === undefined ? `encoded ${normalized.kind}` : String(init.label),
      source: this._source,
    });
  }

  _handleNativeEvent(event) {
    if (event.type === "open") this.readyState = "open";
    if (event.type === "close") this.readyState = "closed";
    const dispatched = new Event(event.type);
    if (event.type === "error") dispatched.message = event.error || "Media track error";
    this.dispatchEvent(dispatched);
  }

  send(packet) {
    if (this.track.readyState === "ended") throw new Error("MediaStreamTrack is ended");
    return nonstandard.sendEncodedPacket(this.track, packet);
  }

  close() {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this._source.nativeTrack?.close();
    if (this.track.readyState !== "ended") this.track.stop();
  }

  get maxPacketSize() {
    return this._source.nativeTrack?.maxMessageSize ?? null;
  }
}

class EncodedMediaSink extends EventTarget {
  constructor(track) {
    super();
    if (!(track instanceof MediaStreamTrack))
      throw new TypeError("track must be a MediaStreamTrack");
    this.track = track;
    this.onpacket = null;
    this._unsubscribe = nonstandard.onEncodedPacket(track, (packet) => {
      this.dispatchEvent(new MessageEvent("packet", { data: packet }));
    });
  }
  close() {
    this._unsubscribe?.();
    this._unsubscribe = null;
  }
}

module.exports = { EncodedMediaSink, EncodedMediaSource };
