"use strict";

const { RTCPeerConnection, nonstandard } = require("@webrtc-node/webrtc");

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

function normalizeTrackInit(init) {
  if (init == null || typeof init !== "object") throw new TypeError("track init must be an object");
  const kind = String(init.kind || "").toLowerCase();
  if (kind !== "audio" && kind !== "video") throw new TypeError("kind must be audio or video");
  const mid = String(init.mid || "");
  if (!mid || /[\s\0]/u.test(mid)) throw new TypeError("mid must be a non-empty SDP token");
  const direction = init.direction ?? "sendonly";
  if (!["sendonly", "recvonly", "sendrecv", "inactive"].includes(direction)) {
    throw new TypeError("direction must be sendonly, recvonly, sendrecv, or inactive");
  }
  const mimeType = String(init.codec?.mimeType || "").toLowerCase();
  const codec = codecs.get(mimeType);
  if (!codec || !mimeType.startsWith(`${kind}/`)) throw new TypeError(`Unsupported ${kind} codec`);
  const payloadType = Number(init.codec?.payloadType);
  if (!Number.isInteger(payloadType) || payloadType < 0 || payloadType > 127) {
    throw new RangeError("payloadType must be an integer between 0 and 127");
  }
  let ssrc;
  if (init.ssrc !== undefined) {
    ssrc = Number(init.ssrc);
    if (!Number.isInteger(ssrc) || ssrc < 1 || ssrc > 0xffffffff) {
      throw new RangeError("ssrc must be an integer between 1 and 4294967295");
    }
  }
  const profile = init.codec.profile === undefined ? undefined : String(init.codec.profile);
  if (profile && /[\r\n]/u.test(profile))
    throw new TypeError("codec profile must not contain lines");
  return Object.freeze({
    kind,
    mid,
    direction,
    codec,
    mimeType,
    payloadType,
    profile,
    ssrc,
  });
}

function toUint8Array(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data))
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new TypeError("send expects an ArrayBuffer or ArrayBufferView containing RTP or RTCP");
}

class MediaErrorEvent extends Event {
  constructor(message) {
    super("error");
    this.message = message;
  }
}

class EncodedTrack extends EventTarget {
  constructor(nativeTrack, init) {
    super();
    this._native = nativeTrack;
    this.kind = init.kind;
    this.mid = init.mid;
    this.direction = init.direction;
    this.codec = Object.freeze({
      mimeType: init.mimeType,
      payloadType: init.payloadType,
      ...(init.profile === undefined ? {} : { profile: init.profile }),
    });
    this.ssrc = init.ssrc ?? null;
    this.readyState = nativeTrack.isOpen ? "open" : "connecting";
    this.onopen = null;
    this.onclose = null;
    this.onerror = null;
    this.onmessage = null;
  }

  _handleNativeEvent(event) {
    if (event.type === "open") this.readyState = "open";
    if (event.type === "close") this.readyState = "closed";
    let dispatched;
    if (event.type === "message") {
      dispatched = new MessageEvent("message", { data: event.data });
    } else if (event.type === "error") {
      dispatched = new MediaErrorEvent(event.error || "Media track error");
    } else {
      dispatched = new Event(event.type);
    }
    this.dispatchEvent(dispatched);
    this[`on${event.type}`]?.call(this, dispatched);
  }

  send(data) {
    if (this.readyState === "closed") throw new Error("EncodedTrack is closed");
    return this._native.send(toUint8Array(data));
  }

  close() {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this._native.close();
  }

  get maxPacketSize() {
    return this._native.maxMessageSize;
  }
}

class MediaSession {
  constructor(peerConnection) {
    if (!(peerConnection instanceof RTCPeerConnection)) {
      throw new TypeError("peerConnection must be an @webrtc-node/webrtc RTCPeerConnection");
    }
    this.peerConnection = peerConnection;
    this._tracks = new Set();
    this._mids = new Set();
  }

  addTrack(init) {
    const normalized = normalizeTrackInit(init);
    if (this._mids.has(normalized.mid))
      throw new Error(`A track with mid ${normalized.mid} exists`);
    const nativePeer = nonstandard.getNativePeerConnection(this.peerConnection);
    let track;
    const nativeTrack = nativePeer.createTrack(normalized, (events) => {
      for (const event of Array.isArray(events) ? events : [events]) {
        track?._handleNativeEvent(event);
      }
    });
    track = new EncodedTrack(nativeTrack, normalized);
    this._tracks.add(track);
    this._mids.add(normalized.mid);
    track.addEventListener(
      "close",
      () => {
        this._tracks.delete(track);
        this._mids.delete(normalized.mid);
      },
      { once: true },
    );
    return track;
  }

  getTracks() {
    return [...this._tracks];
  }

  close() {
    for (const track of this._tracks) track.close();
    this._tracks.clear();
    this._mids.clear();
  }
}

module.exports = { EncodedTrack, MediaErrorEvent, MediaSession };
