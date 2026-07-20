"use strict";

const crypto = require("node:crypto");
const native = require("./load-native");

const kHandlers = new WeakMap();
const certificateMaterial = new WeakMap();
const localDescriptionOwners = new Map();
const localDescriptionOwnerFinalizer = new FinalizationRegistry((key) => {
  if (!localDescriptionOwners.get(key)?.deref()) localDescriptionOwners.delete(key);
});
const iceUdpMuxListenerFinalizer = new FinalizationRegistry((nativeListenerRef) => {
  nativeListenerRef.deref()?.close();
});
const kInternalConstruct = Symbol("internalConstruct");
const mediaTrackSources = new WeakMap();
const mediaTrackStreams = new WeakMap();

function notifyTrackStateChanged(track) {
  for (const stream of mediaTrackStreams.get(track) || []) stream._updateActiveState();
}

function registerMediaTrackSource(track, source) {
  mediaTrackSources.set(track, source);
  if (!source || typeof source !== "object") return;
  if (!source._webrtcNodeTracks) source._webrtcNodeTracks = new WeakSet();
  if (source._webrtcNodeTracks.has(track)) return;
  source._webrtcNodeTracks.add(track);
  if (!source._webrtcNodeTrackRefs) source._webrtcNodeTrackRefs = new Set();
  source._webrtcNodeTrackRefs.add(new WeakRef(track));
  if (!source._endTracks) {
    source._endTracks = () => {
      for (const reference of source._webrtcNodeTrackRefs) {
        const sourceTrack = reference.deref();
        if (!sourceTrack) {
          source._webrtcNodeTrackRefs.delete(reference);
          continue;
        }
        if (sourceTrack._readyState === "ended") continue;
        sourceTrack._readyState = "ended";
        notifyTrackStateChanged(sourceTrack);
        sourceTrack.dispatchEvent(makeEvent("ended"));
      }
    };
  }
}

function hasOtherLiveSourceTrack(source, track) {
  if (!source?._webrtcNodeTrackRefs) return false;
  let found = false;
  for (const reference of source._webrtcNodeTrackRefs) {
    const sourceTrack = reference.deref();
    if (!sourceTrack) {
      source._webrtcNodeTrackRefs.delete(reference);
    } else if (sourceTrack !== track && sourceTrack.readyState === "live") {
      found = true;
    }
  }
  return found;
}

function descriptionPairingKey(description) {
  if (!description || typeof description.sdp !== "string" || !description.sdp) return null;
  return `${description.type}\n${description.sdp}`;
}

function mediaSectionByMid(description, mid) {
  if (!description?.sdp || mid == null) return null;
  const sections = description.sdp.split(/(?=^m=)/m).slice(1);
  return (
    sections.find((entry) => new RegExp(`(?:^|\\r?\\n)a=mid:${mid}(?:\\r?\\n|$)`).test(entry)) ||
    null
  );
}

function mediaDirectionByMid(description, mid) {
  const section = mediaSectionByMid(description, mid);
  if (!section || /^m=\S+\s+0\s/m.test(section)) return null;
  return (
    /(?:^|\r?\n)a=(sendrecv|sendonly|recvonly|inactive)(?:\r?\n|$)/.exec(section)?.[1] || "sendrecv"
  );
}

function mediaStreamIdsByMid(description, mid) {
  const section = mediaSectionByMid(description, mid);
  if (!section) return { streamIds: [], trackId: null };
  const associations = [...section.matchAll(/(?:^|\r?\n)a=msid:([^\s]+)(?:[ \t]+([^\s]+))?/g)];
  const trackId = associations.find((match) => match[2])?.[2] || null;
  return {
    streamIds: [...new Set(associations.map((match) => match[1]).filter((id) => id !== "-"))],
    trackId,
  };
}

function reverseDirection(direction) {
  if (direction === "sendonly") return "recvonly";
  if (direction === "recvonly") return "sendonly";
  return direction;
}

function disableSending(direction) {
  if (direction === "sendrecv") return "recvonly";
  if (direction === "sendonly") return "inactive";
  return direction;
}

function intersectDirections(localDirection, remoteDirection) {
  const send =
    (localDirection === "sendrecv" || localDirection === "sendonly") &&
    (remoteDirection === "sendrecv" || remoteDirection === "recvonly");
  const receive =
    (localDirection === "sendrecv" || localDirection === "recvonly") &&
    (remoteDirection === "sendrecv" || remoteDirection === "sendonly");
  if (send && receive) return "sendrecv";
  if (send) return "sendonly";
  if (receive) return "recvonly";
  return "inactive";
}

class SimpleEvent {
  constructor(type, init = {}) {
    this.type = String(type);
    this.bubbles = Boolean(init.bubbles);
    this.cancelable = Boolean(init.cancelable);
    this.defaultPrevented = false;
    this.target = null;
    this.currentTarget = null;
  }

  preventDefault() {
    if (this.cancelable) this.defaultPrevented = true;
  }
}

class SimpleMessageEvent extends SimpleEvent {
  constructor(type, init = {}) {
    super(type, init);
    this.data = init.data;
    this.origin = init.origin || "";
    this.lastEventId = init.lastEventId || "";
    this.source = init.source || null;
    this.ports = init.ports || [];
  }
}

class SimpleEventTarget {
  addEventListener(type, callback, options = undefined) {
    if (callback == null) return;
    let map = kHandlers.get(this);
    if (!map) {
      map = new Map();
      kHandlers.set(this, map);
    }
    const key = String(type);
    let listeners = map.get(key);
    if (!listeners) {
      listeners = [];
      map.set(key, listeners);
    }
    const once = typeof options === "object" && options !== null && Boolean(options.once);
    let added = false;
    if (!listeners.some((listener) => listener.callback === callback)) {
      listeners.push({ callback, once });
      added = true;
    }
    if (added && typeof this._eventListenerAdded === "function") this._eventListenerAdded(key);
  }

  removeEventListener(type, callback) {
    const key = String(type);
    const listeners = kHandlers.get(this)?.get(key);
    if (!listeners) return;
    const index = listeners.findIndex((listener) => listener.callback === callback);
    if (index !== -1) {
      listeners.splice(index, 1);
      if (typeof this._eventListenerRemoved === "function") this._eventListenerRemoved(key);
    }
  }

  dispatchEvent(event) {
    if (!event || typeof event.type !== "string") {
      throw new TypeError("dispatchEvent requires an Event object");
    }
    event.target = event.target || this;
    event.currentTarget = this;
    const registeredListeners = kHandlers.get(this)?.get(event.type);
    const listeners = registeredListeners?.length ? Array.from(registeredListeners) : null;
    const handler = this[`on${event.type}`];
    if (listeners) {
      for (const listener of listeners) {
        if (listener.once) this.removeEventListener(event.type, listener.callback);
        callListener(listener.callback, this, event);
      }
    }
    if (typeof handler === "function") callListener(handler, this, event);
    return !event.defaultPrevented;
  }

  _hasEventConsumer(type) {
    const listeners = kHandlers.get(this)?.get(String(type));
    return Boolean((listeners && listeners.length > 0) || typeof this[`on${type}`] === "function");
  }
}

function callListener(listener, target, event) {
  if (typeof listener === "function") {
    listener.call(target, event);
  } else if (listener && typeof listener.handleEvent === "function") {
    listener.handleEvent(event);
  }
}

function makeEvent(type, init) {
  return new SimpleEvent(type, init);
}

function makeMessageEvent(type, init) {
  return new SimpleMessageEvent(type, init);
}

function makeDOMException(message, name) {
  if (typeof globalThis.DOMException === "function") {
    return new globalThis.DOMException(message, name);
  }
  const error = new Error(message);
  error.name = name;
  return error;
}

function mapNativeError(error, fallbackName = "OperationError") {
  if (error?.name && error.name !== "Error") return error;
  return makeDOMException(error?.message || String(error), fallbackName);
}

function byteLength(value) {
  return Buffer.byteLength(String(value), "utf8");
}

function enforceRange(value, name, max = 65535) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > max) {
    throw new TypeError(`${name} must be an integer between 0 and ${max}`);
  }
  return number;
}

function toUnsignedLong(value) {
  if (typeof value === "bigint" || Object.prototype.toString.call(value) === "[object BigInt]") {
    throw new TypeError("Cannot convert BigInt to unsigned long");
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number === 0) return 0;
  const integer = Math.trunc(number);
  const modulo = 2 ** 32;
  return ((integer % modulo) + modulo) % modulo;
}

function validateByteLength(value, name) {
  if (byteLength(value) > 65535) {
    throw new TypeError(`${name} exceeds 65535 bytes`);
  }
}

function fingerprintFromBytes(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(":");
}

class RTCCertificate {
  constructor({
    expires,
    algorithm = "ECDSA",
    fingerprints,
    certificatePem = null,
    keyPem = null,
  } = {}) {
    this.expires = expires;
    this._algorithm = algorithm;
    this._fingerprints =
      Array.isArray(fingerprints) && fingerprints.length
        ? fingerprints.map((fingerprint) => ({
            algorithm: String(fingerprint.algorithm),
            value: String(fingerprint.value).toLowerCase(),
          }))
        : [
            {
              algorithm: "sha-256",
              value: fingerprintFromBytes(crypto.randomBytes(32)),
            },
          ];
    if (typeof certificatePem === "string" && typeof keyPem === "string") {
      certificateMaterial.set(this, { certificatePem, keyPem });
    }
  }

  getFingerprints() {
    return this._fingerprints.map((fingerprint) => ({ ...fingerprint }));
  }
}

function getCertificateMaterial(certificate) {
  return certificate instanceof RTCCertificate ? certificateMaterial.get(certificate) : undefined;
}

function normalizeEnum(value, name, allowed, defaultValue) {
  if (value === undefined) return defaultValue;
  if (value === null || !allowed.includes(value)) {
    throw new TypeError(`${name} must be one of: ${allowed.join(", ")}`);
  }
  return value;
}

function validateIceServerUrl(url) {
  if (typeof url !== "string") throw new TypeError("RTCIceServer.urls must contain strings");
  const match = /^([a-z][a-z0-9+.-]*):(.*)$/i.exec(url);
  if (!match) throw makeDOMException("Invalid ICE server URL", "SyntaxError");
  const scheme = match[1].toLowerCase();
  const rest = match[2];
  if (!["stun", "stuns", "turn", "turns"].includes(scheme)) {
    throw makeDOMException("Unsupported ICE server URL scheme", "SyntaxError");
  }
  if (!rest || rest.startsWith("//") || /[/\\#@]/.test(rest)) {
    throw makeDOMException("Invalid ICE server URL", "SyntaxError");
  }

  const [hostPort, query = ""] = rest.split("?");
  if (rest.split("?").length > 2 || !hostPort) {
    throw makeDOMException("Invalid ICE server URL", "SyntaxError");
  }
  if ((scheme === "stun" || scheme === "stuns") && query) {
    throw makeDOMException("STUN URL must not contain a query", "SyntaxError");
  }
  if ((scheme === "turn" || scheme === "turns") && query && !/^transport=(udp|tcp)$/i.test(query)) {
    throw makeDOMException("Invalid TURN transport", "SyntaxError");
  }

  let host = hostPort;
  let port = "";
  if (hostPort.startsWith("[")) {
    const end = hostPort.indexOf("]");
    if (end <= 1) throw makeDOMException("Invalid ICE server host", "SyntaxError");
    host = hostPort.slice(1, end);
    const suffix = hostPort.slice(end + 1);
    if (suffix) {
      if (!suffix.startsWith(":")) throw makeDOMException("Invalid ICE server port", "SyntaxError");
      port = suffix.slice(1);
    }
  } else {
    const colonCount = (hostPort.match(/:/g) || []).length;
    if (colonCount > 1) throw makeDOMException("Invalid ICE server host", "SyntaxError");
    if (colonCount === 1) {
      const index = hostPort.lastIndexOf(":");
      host = hostPort.slice(0, index);
      port = hostPort.slice(index + 1);
    }
  }
  if (!host) throw makeDOMException("Invalid ICE server host", "SyntaxError");
  if (port !== "") {
    const number = Number(port);
    if (!/^\d+$/.test(port) || !Number.isInteger(number) || number < 0 || number > 65535) {
      throw makeDOMException("Invalid ICE server port", "SyntaxError");
    }
  }
}

function normalizeIceServers(iceServers) {
  if (iceServers === undefined) return [];
  if (!Array.isArray(iceServers)) throw new TypeError("iceServers must be an array");
  return iceServers.map((server) => {
    if (server === null || typeof server !== "object")
      throw new TypeError("RTCIceServer must be an object");
    if (!Object.hasOwn(server, "urls")) {
      throw new TypeError("RTCIceServer.urls is required");
    }
    const urls = Array.isArray(server.urls) ? server.urls.map(String) : [String(server.urls)];
    if (urls.length === 0)
      throw makeDOMException("RTCIceServer.urls must not be empty", "SyntaxError");
    for (const url of urls) validateIceServerUrl(url);

    const requiresCredentials = urls.some((url) => /^turns?:/i.test(url));
    const username = server.username === undefined ? undefined : String(server.username);
    const credential = server.credential === undefined ? undefined : String(server.credential);
    if (requiresCredentials) {
      if (username === undefined || credential === undefined || credential === "") {
        throw makeDOMException(
          "TURN servers require username and credential",
          "InvalidAccessError",
        );
      }
      if (byteLength(username) > 509) {
        throw makeDOMException("TURN username exceeds 509 bytes", "InvalidAccessError");
      }
    }

    const normalized = { urls };
    if (username !== undefined) normalized.username = username;
    if (credential !== undefined) normalized.credential = credential;
    return normalized;
  });
}

function normalizePeerConnectionConfiguration(configuration) {
  if (configuration == null) configuration = {};
  if (typeof configuration !== "object") configuration = {};
  if (configuration.certificates === null) {
    throw new TypeError("certificates must not be null");
  }
  const certificates =
    configuration.certificates === undefined ? [] : Array.from(configuration.certificates);
  for (const certificate of certificates) {
    if (certificate == null) throw new TypeError("certificates must not contain null or undefined");
    if (certificate instanceof RTCCertificate && certificate.expires <= Date.now()) {
      throw makeDOMException("RTCCertificate has expired", "InvalidAccessError");
    }
  }
  return {
    iceServers: normalizeIceServers(configuration.iceServers),
    iceTransportPolicy: normalizeEnum(
      configuration.iceTransportPolicy,
      "iceTransportPolicy",
      ["all", "relay"],
      "all",
    ),
    bundlePolicy: normalizeEnum(
      configuration.bundlePolicy,
      "bundlePolicy",
      ["balanced", "max-compat", "max-bundle"],
      "balanced",
    ),
    rtcpMuxPolicy: normalizeEnum(
      configuration.rtcpMuxPolicy,
      "rtcpMuxPolicy",
      ["require"],
      "require",
    ),
    iceCandidatePoolSize:
      configuration.iceCandidatePoolSize === undefined
        ? 0
        : enforceRange(configuration.iceCandidatePoolSize, "iceCandidatePoolSize", 255),
    certificates,
  };
}

function cloneConfiguration(configuration) {
  return {
    iceServers: configuration.iceServers.map((server) => ({ ...server, urls: [...server.urls] })),
    iceTransportPolicy: configuration.iceTransportPolicy,
    bundlePolicy: configuration.bundlePolicy,
    rtcpMuxPolicy: configuration.rtcpMuxPolicy,
    iceCandidatePoolSize: configuration.iceCandidatePoolSize,
    certificates: [...configuration.certificates],
  };
}

function sameCertificateSet(left, right) {
  if (left.length !== right.length) return false;
  return left.every((certificate, index) => certificate === right[index]);
}

function normalizeCertificateExpiration(value) {
  if (value === undefined) return Date.now() + 30 * 24 * 60 * 60 * 1000;
  const number = Number(value);
  if (!Number.isFinite(number) || !Number.isInteger(number) || number < 0) {
    throw new TypeError("expires must be a non-negative integer");
  }
  return Date.now() + number;
}

function normalizeCertificateAlgorithm(algorithm) {
  if (typeof algorithm === "string") {
    throw makeDOMException("Unsupported certificate algorithm", "NotSupportedError");
  }
  if (algorithm === null || typeof algorithm !== "object") {
    throw makeDOMException("Unsupported certificate algorithm", "NotSupportedError");
  }
  const name = String(algorithm.name || "").toUpperCase();
  if (name === "ECDSA") {
    if (String(algorithm.namedCurve || "").toUpperCase() !== "P-256") {
      throw makeDOMException("Unsupported ECDSA curve", "NotSupportedError");
    }
    return { name: "ECDSA" };
  }
  if (name === "RSASSA-PKCS1-V1_5") {
    const hash =
      typeof algorithm.hash === "object" && algorithm.hash !== null
        ? String(algorithm.hash.name || "")
        : String(algorithm.hash || "");
    if (hash.toUpperCase() !== "SHA-256") {
      throw makeDOMException("Unsupported RSA hash", "NotSupportedError");
    }
    const modulusLength = Number(algorithm.modulusLength);
    if (!Number.isInteger(modulusLength) || modulusLength < 1024) {
      throw makeDOMException("Unsupported RSA modulus length", "NotSupportedError");
    }
    return { name: "RSASSA-PKCS1-v1_5", modulusLength };
  }
  throw makeDOMException("Unsupported certificate algorithm", "NotSupportedError");
}

function createNativeBackedCertificate({ normalizedAlgorithm, expires, expiresMs }) {
  const material = native.generateCertificate({
    algorithm: normalizedAlgorithm.name,
    modulusLength: normalizedAlgorithm.modulusLength,
    expiresMs,
  });
  return new RTCCertificate({
    expires,
    algorithm: normalizedAlgorithm.name,
    fingerprints: material.fingerprints,
    certificatePem: material.certificatePem,
    keyPem: material.keyPem,
  });
}

function importCertificate({ certificatePem, privateKeyPem, expires } = {}) {
  if (typeof certificatePem !== "string" || certificatePem.length === 0) {
    throw new TypeError("certificatePem must be a non-empty string");
  }
  if (typeof privateKeyPem !== "string" || privateKeyPem.length === 0) {
    throw new TypeError("privateKeyPem must be a non-empty string");
  }
  if (
    expires !== undefined &&
    (!Number.isFinite(Number(expires)) || !Number.isInteger(Number(expires)) || Number(expires) < 0)
  ) {
    throw new TypeError("expires must be a non-negative integer timestamp");
  }

  let material;
  try {
    material = native.importCertificate({ certificatePem, keyPem: privateKeyPem });
  } catch (error) {
    throw new TypeError(`Invalid certificate material: ${error?.message || String(error)}`);
  }
  const effectiveExpires =
    expires === undefined ? material.expires : Math.min(Number(expires), material.expires);
  return new RTCCertificate({
    expires: effectiveExpires,
    algorithm: "imported",
    fingerprints: material.fingerprints,
    certificatePem: material.certificatePem,
    keyPem: material.keyPem,
  });
}

function createDefaultNativeCertificate() {
  const expiresMs = 30 * 24 * 60 * 60 * 1000;
  return createNativeBackedCertificate({
    normalizedAlgorithm: { name: "ECDSA" },
    expires: Date.now() + expiresMs,
    expiresMs,
  });
}

function certificatePemToArrayBuffer(pem) {
  const raw = new crypto.X509Certificate(pem).raw;
  return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
}

function certificateStats(id, certificate, timestamp) {
  const material = getCertificateMaterial(certificate);
  const fingerprint = certificate?.getFingerprints?.()[0];
  if (!material || !fingerprint) return null;
  try {
    return {
      id,
      timestamp,
      type: "certificate",
      fingerprint: fingerprint.value,
      fingerprintAlgorithm: fingerprint.algorithm,
      base64Certificate: Buffer.from(certificatePemToArrayBuffer(material.certificatePem)).toString(
        "base64",
      ),
    };
  } catch {
    return null;
  }
}

function generateCertificate(algorithm) {
  try {
    const normalizedAlgorithm = normalizeCertificateAlgorithm(algorithm);
    const expiresInput = algorithm && typeof algorithm === "object" ? algorithm.expires : undefined;
    const expires = normalizeCertificateExpiration(expiresInput);
    const expiresMs = expiresInput === undefined ? 30 * 24 * 60 * 60 * 1000 : Number(expiresInput);
    return Promise.resolve(
      createNativeBackedCertificate({ normalizedAlgorithm, expires, expiresMs }),
    );
  } catch (error) {
    return Promise.reject(error);
  }
}

class IceUdpMuxListener {
  constructor(port, address = undefined) {
    this._port = enforceRange(port, "port");
    if (address !== undefined && typeof address !== "string") {
      throw new TypeError("address must be a string");
    }
    this._address = address;
    this._callback = null;
    this._closed = false;
    const weakListener = new WeakRef(this);
    this._native = new native.NativeIceUdpMuxListener(
      this._port,
      (request) => {
        const listener = weakListener.deref();
        if (!listener || listener._closed || typeof listener._callback !== "function") return;
        listener._callback(request);
      },
      this._address,
    );
    iceUdpMuxListenerFinalizer.register(this, new WeakRef(this._native), this);
  }

  port() {
    return this._port;
  }

  address() {
    return this._address;
  }

  onUnhandledStunRequest(callback) {
    if (this._closed) {
      throw makeDOMException("IceUdpMuxListener is closed", "InvalidStateError");
    }
    if (typeof callback !== "function") {
      throw new TypeError("onUnhandledStunRequest requires a function");
    }
    this._callback = callback;
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    this._callback = null;
    iceUdpMuxListenerFinalizer.unregister(this);
    this._native?.close();
    this._native = null;
  }

  stop() {
    this.close();
  }
}

function assertPeerConnection(peerConnection) {
  if (!(peerConnection instanceof RTCPeerConnection)) {
    throw new TypeError("Expected an RTCPeerConnection");
  }
}

function configurePeerConnection(peerConnection, options = {}) {
  assertPeerConnection(peerConnection);
  peerConnection._assertNotClosed();
  if (peerConnection._native) {
    throw makeDOMException(
      "Peer connection native configuration is already initialized",
      "InvalidStateError",
    );
  }
  if (options === null || typeof options !== "object") {
    throw new TypeError("Peer connection extension options must be an object");
  }

  const next = { ...peerConnection._nonstandardConfiguration };
  if (Object.hasOwn(options, "enableIceUdpMux")) {
    if (typeof options.enableIceUdpMux !== "boolean") {
      throw new TypeError("enableIceUdpMux must be a boolean");
    }
    next.enableIceUdpMux = options.enableIceUdpMux;
  }
  if (Object.hasOwn(options, "disableFingerprintVerification")) {
    if (typeof options.disableFingerprintVerification !== "boolean") {
      throw new TypeError("disableFingerprintVerification must be a boolean");
    }
    next.disableFingerprintVerification = options.disableFingerprintVerification;
  }
  if (Object.hasOwn(options, "maxMessageSize")) {
    const maxMessageSize = Number(options.maxMessageSize);
    if (!Number.isSafeInteger(maxMessageSize) || maxMessageSize < 0) {
      throw new TypeError("maxMessageSize must be a non-negative safe integer");
    }
    next.maxMessageSize = maxMessageSize;
  }
  peerConnection._nonstandardConfiguration = next;
}

function setLocalIceCredentials(peerConnection, credentials) {
  assertPeerConnection(peerConnection);
  peerConnection._setNonstandardLocalIceCredentials(credentials);
}

function getRemoteFingerprint(peerConnection) {
  assertPeerConnection(peerConnection);
  peerConnection._assertNotClosed();
  return peerConnection._native?.remoteFingerprint() ?? null;
}

function normalizeDescription(init) {
  if (init instanceof RTCSessionDescription) return init;
  return new RTCSessionDescription(init);
}

function validateSdpType(type) {
  if (!["offer", "answer", "pranswer", "rollback"].includes(type)) {
    throw new TypeError(`Invalid RTCSdpType: ${type}`);
  }
}

function isNoMediaSdp(description) {
  return (
    typeof description?.sdp === "string" &&
    /^v=0(?:\r?\n|$)/.test(description.sdp) &&
    !/\r?\nm=/.test(description.sdp)
  );
}

function hasNoActiveMedia(description) {
  if (isNoMediaSdp(description)) return true;
  if (typeof description?.sdp !== "string") return false;
  const sections = description.sdp.split(/(?=^m=)/m).slice(1);
  return sections.length > 0 && sections.every((section) => /^m=\S+\s+0\s/m.test(section));
}

function sdpSyntaxErrorLine(sdp) {
  const lines = String(sdp ?? "").split(/\r\n|\n|\r/);
  if (lines[0] !== "v=0") return 1;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === "" && index === lines.length - 1) continue;
    if (!/^[a-z]=/.test(line)) return index + 1;
  }
  return null;
}

function assertValidSdpSyntax(description) {
  if (description.type === "rollback") return;
  const line = sdpSyntaxErrorLine(description.sdp);
  if (line === null) return;
  throw new RTCError(
    {
      errorDetail: "sdp-syntax-error",
      sdpLineNumber: line,
    },
    "Invalid SDP syntax",
  );
}

function hasDataMediaSection(description) {
  return /\r?\nm=application\b/i.test(description?.sdp || "");
}

function hasNegotiatedMediaSection(description) {
  return /\r?\nm=(?:application|audio|video)\b/i.test(description?.sdp || "");
}

function hasTrickleIceOption(description) {
  return /\r?\na=ice-options:[^\r\n]*\btrickle\b/i.test(description?.sdp || "");
}

function maxMessageSizeFromSdp(description) {
  const match = /\r?\na=max-message-size:(\d+)/i.exec(description?.sdp || "");
  return match ? Number(match[1]) : null;
}

function nextTask() {
  return new Promise((resolve) => setImmediate(resolve));
}

const webRtcTaskQueue = [];
let webRtcTaskScheduled = false;

function queueWebRtcTask(task) {
  webRtcTaskQueue.push(task);
  if (webRtcTaskScheduled) return;
  webRtcTaskScheduled = true;
  setTimeout(runNextWebRtcTask, 0);
}

function runNextWebRtcTask() {
  const task = webRtcTaskQueue.shift();
  try {
    task?.();
  } finally {
    if (webRtcTaskQueue.length > 0) {
      setTimeout(runNextWebRtcTask, 0);
    } else {
      webRtcTaskScheduled = false;
    }
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const CLOSE_FLUSH_DELAY_MS = 50;
const CLOSE_FLUSH_POLL_INTERVAL_MS = 25;
const CLOSE_FLUSH_TIMEOUT_MS = 60000;
const BUFFERED_AMOUNT_NATIVE_DRAIN_POLL_INTERVAL_MS = 10;
const REMOTE_CLOSE_MESSAGE_GRACE_MS = 25;
const MESSAGE_CONSUMER_GATE_TIMEOUT_MS = 1000;
const SCTP_CONNECT_POLL_INTERVAL_MS = 25;
const SCTP_CONNECT_POLL_TIMEOUT_MS = 5000;
const DATA_CHANNEL_OPEN_REPAIR_INTERVAL_MS = 25;
const DATA_CHANNEL_OPEN_REPAIR_TIMEOUT_MS = 5000;
const DATA_CHANNEL_ANNOUNCEMENT_REPAIR_INTERVAL_MS = 25;
const DATA_CHANNEL_ANNOUNCEMENT_REPAIR_GRACE_MS = 250;
const DATA_CHANNEL_ANNOUNCEMENT_REPAIR_TIMEOUT_MS = 5000;
const NATIVE_CLOSE_SUPPRESSION_WINDOW_MS = 5000;
const DEFAULT_SCTP_MAX_MESSAGE_SIZE = 262144;
const LIBDATACHANNEL_SCTP_MAX_CHANNELS = 1024;
let nextUnsupportedDataChannelBindingId = -1;

const ICE_CREDENTIAL_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function randomIceCredential(length) {
  const bytes = crypto.randomBytes(length);
  let value = "";
  for (const byte of bytes) value += ICE_CREDENTIAL_CHARS[byte & 0x3f];
  return value;
}

function createIceRestartCredentials() {
  return {
    iceUfrag: randomIceCredential(16),
    icePwd: randomIceCredential(32),
  };
}

function rewriteIceCredentials(sdp, credentials) {
  if (!/^a=ice-ufrag:/m.test(sdp) || !/^a=ice-pwd:/m.test(sdp)) return sdp;
  return sdp
    .replace(/^a=ice-ufrag:.*$/gm, `a=ice-ufrag:${credentials.iceUfrag}`)
    .replace(/^a=ice-pwd:.*$/gm, `a=ice-pwd:${credentials.icePwd}`);
}

function markJsOnlyIceRestart(description) {
  if (description && typeof description === "object") {
    Object.defineProperty(description, "_webrtcNodeJsOnlyIceRestart", {
      value: true,
      configurable: true,
    });
  }
  return description;
}

function hasDifferentIceCredentials(left, right) {
  const leftParameters = firstIceParameters(left);
  const rightParameters = firstIceParameters(right);
  if (!leftParameters || !rightParameters) return false;
  return (
    leftParameters.usernameFragment !== rightParameters.usernameFragment ||
    leftParameters.password !== rightParameters.password
  );
}

class RTCSessionDescription {
  constructor(init) {
    if (!init || typeof init !== "object")
      throw new TypeError("RTCSessionDescriptionInit required");
    this.type = String(init.type || "");
    validateSdpType(this.type);
    this.sdp = String(init.sdp || "");
  }

  toJSON() {
    return { type: this.type, sdp: this.sdp };
  }
}

class RTCIceCandidate {
  constructor(init = {}) {
    if (init == null || typeof init !== "object")
      throw new TypeError("RTCIceCandidateInit required");
    const sdpMid = init.sdpMid == null ? null : String(init.sdpMid);
    const sdpMLineIndex = init.sdpMLineIndex == null ? null : Number(init.sdpMLineIndex);
    if (sdpMid === null && sdpMLineIndex === null) {
      throw new TypeError("Either sdpMid or sdpMLineIndex must be provided");
    }

    this.candidate = init.candidate === undefined ? "" : String(init.candidate);
    this.sdpMid = sdpMid;
    this.sdpMLineIndex = sdpMLineIndex;
    this.usernameFragment = init.usernameFragment == null ? null : String(init.usernameFragment);
    this.relayProtocol = init.relayProtocol == null ? null : String(init.relayProtocol);
    this.url = init.url == null ? null : String(init.url);

    const parsed = parseCandidate(this.candidate);
    this.foundation = parsed.foundation;
    this.component = parsed.component;
    this.priority = parsed.priority;
    this.address = parsed.address;
    this.protocol = parsed.protocol;
    this.port = parsed.port;
    this.type = parsed.type;
    this.tcpType = parsed.tcpType;
    this.relatedAddress = parsed.relatedAddress;
    this.relatedPort = parsed.relatedPort;
  }

  toJSON() {
    return {
      candidate: this.candidate,
      sdpMid: this.sdpMid,
      sdpMLineIndex: this.sdpMLineIndex,
      usernameFragment: this.usernameFragment,
    };
  }
}

class RTCIceCandidatePair {
  constructor(token, local, remote) {
    if (token !== kInternalConstruct) throw new TypeError("Illegal constructor");
    defineReadonly(this, "local", local);
    defineReadonly(this, "remote", remote);
  }
}

function parseCandidate(candidate) {
  const empty = {
    foundation: null,
    component: null,
    priority: null,
    address: null,
    protocol: null,
    port: null,
    type: null,
    tcpType: null,
    relatedAddress: null,
    relatedPort: null,
  };
  if (typeof candidate !== "string" || !candidate.startsWith("candidate:")) return empty;
  const parts = candidate.slice("candidate:".length).trim().split(/\s+/);
  if (parts.length < 8) return empty;
  const result = { ...empty };
  result.foundation = parts[0] || null;
  result.component = parts[1] === "1" ? "rtp" : parts[1] === "2" ? "rtcp" : null;
  result.protocol = parts[2] ? parts[2].toLowerCase() : null;
  result.priority = Number(parts[3]);
  result.address = parts[4] || null;
  result.port = Number(parts[5]);
  const typIndex = parts.indexOf("typ");
  if (typIndex !== -1 && parts[typIndex + 1]) result.type = parts[typIndex + 1];
  const tcpIndex = parts.indexOf("tcptype");
  if (tcpIndex !== -1 && parts[tcpIndex + 1]) result.tcpType = parts[tcpIndex + 1];
  const raddrIndex = parts.indexOf("raddr");
  if (raddrIndex !== -1 && parts[raddrIndex + 1]) result.relatedAddress = parts[raddrIndex + 1];
  const rportIndex = parts.indexOf("rport");
  if (rportIndex !== -1 && parts[rportIndex + 1])
    result.relatedPort = Number(parts[rportIndex + 1]);
  return result;
}

function normalizeAddIceCandidateInput(init) {
  if (init instanceof RTCIceCandidate) return init;
  if (init == null) {
    return {
      candidate: "",
      sdpMid: null,
      sdpMLineIndex: null,
      usernameFragment: null,
      toJSON() {
        return {
          candidate: this.candidate,
          sdpMid: this.sdpMid,
          sdpMLineIndex: this.sdpMLineIndex,
          usernameFragment: this.usernameFragment,
        };
      },
    };
  }
  if (typeof init !== "object") throw new TypeError("RTCIceCandidateInit required");
  const candidate = init.candidate == null ? "" : String(init.candidate);
  const sdpMid = init.sdpMid == null ? null : String(init.sdpMid);
  const sdpMLineIndex = init.sdpMLineIndex == null ? null : Number(init.sdpMLineIndex);
  if (candidate !== "" && sdpMid === null && sdpMLineIndex === null) {
    throw new TypeError("Either sdpMid or sdpMLineIndex must be provided");
  }
  return {
    candidate,
    sdpMid,
    sdpMLineIndex,
    usernameFragment: init.usernameFragment == null ? null : String(init.usernameFragment),
    toJSON() {
      return {
        candidate: this.candidate,
        sdpMid: this.sdpMid,
        sdpMLineIndex: this.sdpMLineIndex,
        usernameFragment: this.usernameFragment,
      };
    },
  };
}

function splitSdpLines(sdp) {
  return String(sdp || "")
    .split(/\r?\n/)
    .filter((line) => line !== "");
}

function parseSdpMediaSections(sdp) {
  const sessionLines = [];
  const mediaSections = [];
  let sessionIceUfrag = null;
  let sessionIcePwd = null;
  let current = null;
  for (const line of splitSdpLines(sdp)) {
    if (line.startsWith("m=")) {
      current = { startLine: line, lines: [line], mid: null, iceUfrag: null, icePwd: null };
      mediaSections.push(current);
    } else if (current) {
      current.lines.push(line);
      if (line.startsWith("a=mid:")) current.mid = line.slice("a=mid:".length);
      if (line.startsWith("a=ice-ufrag:")) current.iceUfrag = line.slice("a=ice-ufrag:".length);
      if (line.startsWith("a=ice-pwd:")) current.icePwd = line.slice("a=ice-pwd:".length);
    } else {
      sessionLines.push(line);
      if (line.startsWith("a=ice-ufrag:")) sessionIceUfrag = line.slice("a=ice-ufrag:".length);
      if (line.startsWith("a=ice-pwd:")) sessionIcePwd = line.slice("a=ice-pwd:".length);
    }
  }
  for (const section of mediaSections) {
    if (section.iceUfrag === null) section.iceUfrag = sessionIceUfrag;
    if (section.icePwd === null) section.icePwd = sessionIcePwd;
  }
  return { sessionLines, mediaSections };
}

function effectiveTransceiverMid(transceiver) {
  return transceiver._mid ?? transceiver._nativeMid;
}

function rtpCodecsFromMediaSection(section, kind) {
  const codecs = [];
  if (!section) return codecs;
  const wildcardFeedback = section.lines
    .filter((line) => line.startsWith("a=rtcp-fb:* "))
    .map((line) => line.slice("a=rtcp-fb:* ".length));
  for (const payloadTypeText of section.startLine.split(/\s+/).slice(3)) {
    const payloadType = Number(payloadTypeText);
    const rtpmap = section.lines.find((line) => line.startsWith(`a=rtpmap:${payloadTypeText} `));
    if (!Number.isInteger(payloadType) || !rtpmap) continue;
    const encoding = rtpmap.slice(rtpmap.indexOf(" ") + 1).split("/");
    const clockRate = Number(encoding[1]);
    if (!encoding[0] || !Number.isInteger(clockRate)) continue;
    const codec = {
      payloadType,
      mimeType: `${kind}/${encoding[0]}`,
      clockRate,
      codec: encoding[0],
      rtcpFeedback: [
        ...wildcardFeedback,
        ...section.lines
          .filter((line) => line.startsWith(`a=rtcp-fb:${payloadTypeText} `))
          .map((line) => line.slice(`a=rtcp-fb:${payloadTypeText} `.length)),
      ],
    };
    const channels = Number(encoding[2]);
    if (Number.isInteger(channels)) codec.channels = channels;
    const fmtp = section.lines.find((line) => line.startsWith(`a=fmtp:${payloadTypeText} `));
    if (fmtp) {
      codec.sdpFmtpLine = fmtp.slice(fmtp.indexOf(" ") + 1);
      codec.profile = codec.sdpFmtpLine;
      const apt = /(?:^|;)\s*apt=(\d+)(?:;|$)/i.exec(codec.sdpFmtpLine);
      if (apt) codec.associatedPayloadType = Number(apt[1]);
    }
    codecs.push(codec);
  }
  return codecs;
}

function negotiatedRtpParameters(transceiver) {
  const peer = transceiver._peerConnection;
  const answer =
    peer._currentLocalDescription?.type === "answer"
      ? peer._currentLocalDescription
      : peer._currentRemoteDescription?.type === "answer"
        ? peer._currentRemoteDescription
        : null;
  const section = parseSdpMediaSections(answer?.sdp || "").mediaSections.find(
    (entry) => entry.mid === effectiveTransceiverMid(transceiver),
  );
  const codecs = rtpCodecsFromMediaSection(section, transceiver._kind).map(
    ({
      codec: _codec,
      profile: _profile,
      rtcpFeedback: _feedback,
      associatedPayloadType: _apt,
      ...codec
    }) => codec,
  );
  const headerExtensions = [];
  if (section) {
    for (const line of section.lines) {
      const match = /^a=extmap:(\d+)(?:\/\S+)?\s+(\S+)/.exec(line);
      if (!match) continue;
      headerExtensions.push({ uri: match[2], id: Number(match[1]), encrypted: false });
    }
  }
  return {
    headerExtensions,
    reducedSize: Boolean(section?.lines.includes("a=rtcp-rsize")),
    codecs,
  };
}

function senderRtpParameters(transceiver, transactionId) {
  const negotiated = negotiatedRtpParameters(transceiver);
  return {
    transactionId,
    encodings: transceiver._sendEncodings.map((encoding) => ({ ...encoding })),
    headerExtensions: negotiated.headerExtensions,
    rtcp: {
      cname: transceiver._peerConnection._rtcpCname,
      reducedSize: negotiated.reducedSize,
    },
    codecs: negotiated.codecs,
  };
}

function receiverRtpParameters(transceiver) {
  const negotiated = negotiatedRtpParameters(transceiver);
  return {
    headerExtensions: negotiated.headerExtensions,
    rtcp: { reducedSize: negotiated.reducedSize },
    codecs: negotiated.codecs,
  };
}

const rtpCodecCapabilities = {
  audio: [
    { mimeType: "audio/opus", clockRate: 48000, channels: 2 },
    { mimeType: "audio/PCMA", clockRate: 8000, channels: 1 },
    { mimeType: "audio/PCMU", clockRate: 8000, channels: 1 },
    { mimeType: "audio/G722", clockRate: 8000, channels: 1 },
    { mimeType: "audio/AAC", clockRate: 48000, channels: 2 },
  ],
  video: [
    { mimeType: "video/H264", clockRate: 90000 },
    { mimeType: "video/H265", clockRate: 90000 },
    { mimeType: "video/VP8", clockRate: 90000 },
    { mimeType: "video/VP9", clockRate: 90000 },
    { mimeType: "video/AV1", clockRate: 90000 },
    { mimeType: "video/rtx", clockRate: 90000 },
    { mimeType: "video/red", clockRate: 90000 },
    { mimeType: "video/ulpfec", clockRate: 90000 },
  ],
};

const defaultRtpPayloadTypes = new Map([
  ["audio/opus", 111],
  ["audio/pcma", 8],
  ["audio/pcmu", 0],
  ["audio/g722", 9],
  ["audio/aac", 112],
  ["video/vp8", 96],
  ["video/vp9", 98],
  ["video/av1", 100],
  ["video/h264", 102],
  ["video/h265", 104],
  ["video/red", 116],
  ["video/ulpfec", 117],
]);

const defaultVideoRtcpFeedback = ["nack", "nack pli", "ccm fir", "goog-remb"];
const resilienceCodecNames = new Set(["rtx", "red", "ulpfec", "cn"]);

const midHeaderExtensionUri = "urn:ietf:params:rtp-hdrext:sdes:mid";
const ssrcAudioLevelExtensionUri = "urn:ietf:params:rtp-hdrext:ssrc-audio-level";
const csrcAudioLevelExtensionUri = "urn:ietf:params:rtp-hdrext:csrc-audio-level";
const rtpSourceRetentionMs = 10_000;
const rtpHeaderExtensionCapabilities = {
  audio: [
    { uri: midHeaderExtensionUri },
    { uri: ssrcAudioLevelExtensionUri },
    { uri: csrcAudioLevelExtensionUri },
  ],
  video: [{ uri: midHeaderExtensionUri }],
};

function getRtpCapabilities(kind) {
  const normalizedKind = String(kind);
  const codecs = rtpCodecCapabilities[normalizedKind];
  if (!codecs) return null;
  return {
    codecs: codecs.map((codec) => ({ ...codec })),
    headerExtensions: rtpHeaderExtensionCapabilities[normalizedKind].map((extension) => ({
      ...extension,
    })),
  };
}

function parseRtpHeaderExtensions(bytes, headerLength) {
  const values = new Map();
  if ((bytes[0] & 0x10) === 0 || headerLength + 4 > bytes.byteLength) return values;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const profile = view.getUint16(headerLength);
  const extensionLength = view.getUint16(headerLength + 2) * 4;
  let offset = headerLength + 4;
  const end = offset + extensionLength;
  if (end > bytes.byteLength) return values;

  if (profile === 0xbede) {
    while (offset < end) {
      const descriptor = bytes[offset++];
      if (descriptor === 0) continue;
      const id = descriptor >> 4;
      if (id === 15) break;
      const length = (descriptor & 0x0f) + 1;
      if (offset + length > end) break;
      values.set(id, bytes.subarray(offset, offset + length));
      offset += length;
    }
    return values;
  }

  if ((profile & 0xfff0) === 0x1000) {
    while (offset < end) {
      const id = bytes[offset++];
      if (id === 0) continue;
      if (offset >= end) break;
      const length = bytes[offset++];
      if (offset + length > end) break;
      values.set(id, bytes.subarray(offset, offset + length));
      offset += length;
    }
  }
  return values;
}

function linearAudioLevel(extension) {
  if (!extension || extension.byteLength === 0) return undefined;
  const level = extension[0] & 0x7f;
  return level === 127 ? 0 : 10 ** (-level / 20);
}

function parseRtpSourcePacket(data, kind, extensionIds) {
  const bytes = toUint8Array(data);
  if (bytes.byteLength < 12 || bytes[0] >> 6 !== 2) return null;
  const payloadType = bytes[1] & 0x7f;
  if (payloadType >= 64 && payloadType <= 95) return null;
  const csrcCount = bytes[0] & 0x0f;
  const headerLength = 12 + csrcCount * 4;
  if (headerLength > bytes.byteLength) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const extensions = parseRtpHeaderExtensions(bytes, headerLength);
  const rtpTimestamp = view.getUint32(4);
  const synchronizationSource = {
    source: view.getUint32(8),
    rtpTimestamp,
  };
  if (kind === "audio") {
    const audioLevel = linearAudioLevel(
      extensions.get(extensionIds.get(ssrcAudioLevelExtensionUri)),
    );
    if (audioLevel !== undefined) synchronizationSource.audioLevel = audioLevel;
  }

  const contributingSources = [];
  const contributingAudioLevels =
    kind === "audio" ? extensions.get(extensionIds.get(csrcAudioLevelExtensionUri)) : null;
  for (let index = 0; index < csrcCount; index += 1) {
    const source = { source: view.getUint32(12 + index * 4), rtpTimestamp };
    const audioLevel = linearAudioLevel(contributingAudioLevels?.subarray(index, index + 1));
    if (audioLevel !== undefined) source.audioLevel = audioLevel;
    contributingSources.push(source);
  }
  return { synchronizationSource, contributingSources };
}

function updateRtpSource(map, source, timestamp) {
  const current = map.get(source.source);
  if (current && timestamp - current.timestamp <= rtpSourceRetentionMs) {
    const rtpDelta = (source.rtpTimestamp - current.rtpTimestamp) >>> 0;
    if (rtpDelta >= 0x80000000) return;
  }
  map.set(source.source, { timestamp, ...source });
}

function currentRtpSources(map) {
  const cutoff = performance.timeOrigin + performance.now() - rtpSourceRetentionMs;
  for (const [source, value] of map) {
    if (value.timestamp < cutoff) map.delete(source);
  }
  return [...map.values()]
    .sort((left, right) => right.timestamp - left.timestamp)
    .map((source) => ({ ...source }));
}

function rtpCodecName(codec) {
  const separator = codec.mimeType.indexOf("/");
  return separator === -1 ? "" : codec.mimeType.slice(separator + 1);
}

function rtpCodecKey(codec, suffix = "") {
  return [
    codec.mimeType.toLowerCase(),
    codec.clockRate,
    codec.channels ?? "",
    codec.sdpFmtpLine ?? "",
    suffix,
  ].join("|");
}

function sameRtpCodecCapability(left, right) {
  return (
    left.mimeType.toLowerCase() === right.mimeType.toLowerCase() &&
    left.clockRate === right.clockRate &&
    sameOptionalMember(left, right, "channels") &&
    sameOptionalMember(left, right, "sdpFmtpLine")
  );
}

function supportedNegotiatedCodec(kind, codec) {
  return rtpCodecCapabilities[kind].some(
    (capability) =>
      capability.mimeType.toLowerCase() === codec.mimeType.toLowerCase() &&
      capability.clockRate === codec.clockRate &&
      (capability.channels === undefined || capability.channels === codec.channels),
  );
}

function isResilienceCodec(codec) {
  return resilienceCodecNames.has(rtpCodecName(codec).toLowerCase());
}

function encodedSourceMatchesCodec(kind, source, codec) {
  if (!source?.codec) return false;
  const mimeType = (codec.mimeType || `${kind}/${codec.codec}`).toLowerCase();
  if (mimeType !== source.codec.mimeType) return false;
  if (codec.clockRate !== source.codec.clockRate) return false;
  if ((codec.channels ?? 1) !== (source.codec.channels ?? 1)) return false;
  const fmtp = codec.sdpFmtpLine ?? codec.profile;
  return source.codec.profile === undefined || fmtp === source.codec.profile;
}

function assertEncodedSourceCodecMapping(kind, codecs, source) {
  if (!source?.codec) return;
  const compatible = codecs.filter((codec) => encodedSourceMatchesCodec(kind, source, codec));
  if (compatible.length === 0) {
    throw makeDOMException(
      "Encoded source codec is not present in the negotiated media section",
      "OperationError",
    );
  }
  if (!compatible.some((codec) => codec.payloadType === source.codec.payloadType)) {
    throw makeDOMException(
      "Encoded source payload type conflicts with the negotiated codec mapping",
      "OperationError",
    );
  }
}

function rememberCodecPayloadTypes(transceiver, codecs) {
  const payloadTypes = new Map();
  const genericPrimaryCodecs = new Set();
  for (const codec of codecs) {
    const normalized = {
      mimeType: codec.mimeType || `${transceiver._kind}/${codec.codec}`,
      clockRate: codec.clockRate,
      ...(codec.channels === undefined ? {} : { channels: codec.channels }),
      ...((codec.sdpFmtpLine ?? codec.profile) === undefined
        ? {}
        : { sdpFmtpLine: codec.sdpFmtpLine ?? codec.profile }),
    };
    const codecName = rtpCodecName(normalized).toLowerCase();
    if (codecName === "rtx") {
      const apt =
        codec.associatedPayloadType ??
        Number(/(?:^|;)\s*apt=(\d+)(?:;|$)/i.exec(normalized.sdpFmtpLine || "")?.[1]);
      if (Number.isInteger(apt)) {
        payloadTypes.set(
          rtpCodecKey(
            { mimeType: normalized.mimeType, clockRate: normalized.clockRate },
            `apt=${apt}`,
          ),
          codec.payloadType,
        );
      }
      continue;
    }
    payloadTypes.set(rtpCodecKey(normalized), codec.payloadType);
    const generic = { ...normalized };
    delete generic.sdpFmtpLine;
    const genericKey = rtpCodecKey(generic);
    if (!genericPrimaryCodecs.has(genericKey)) {
      payloadTypes.set(genericKey, codec.payloadType);
      genericPrimaryCodecs.add(genericKey);
    }
  }
  transceiver._codecPayloadTypes = payloadTypes;
}

function normalizeCodecPreferences(kind, value) {
  const codecs = toSequence(value, "codecs").map((codec, index) =>
    normalizeRtpCodec(codec, `codecs[${index}]`, false),
  );
  if (codecs.length === 0) return [];
  const unique = [];
  for (const codec of codecs) {
    if (!unique.some((entry) => sameRtpCodecCapability(entry, codec))) unique.push(codec);
  }
  const capabilities = rtpCodecCapabilities[kind];
  if (unique.some((codec) => !capabilities.some((entry) => sameRtpCodecCapability(entry, codec)))) {
    throw makeDOMException(
      "Codec is not supported by this transceiver",
      "InvalidModificationError",
    );
  }
  if (unique.every(isResilienceCodec)) {
    throw makeDOMException(
      "Codec preferences must include a primary media codec",
      "InvalidModificationError",
    );
  }
  return unique.map((codec) => ({ ...codec }));
}

function reserveRtpPayloadType(transceiver, codec, preferred, suffix = "") {
  const key = rtpCodecKey(codec, suffix);
  const existing = transceiver._codecPayloadTypes.get(key);
  if (existing !== undefined) return existing;
  const used = new Set(transceiver._codecPayloadTypes.values());
  let payloadType = preferred;
  if (!Number.isInteger(payloadType) || used.has(payloadType)) {
    payloadType = Array.from({ length: 32 }, (_, index) => index + 96).find(
      (candidate) => !used.has(candidate),
    );
  }
  if (payloadType === undefined) {
    throw makeDOMException("No RTP payload type is available", "OperationError");
  }
  transceiver._codecPayloadTypes.set(key, payloadType);
  return payloadType;
}

function reserveEncodedSourcePayloadType(transceiver, source) {
  if (!source?.codec?.mimeType) return;
  const capability = rtpCodecCapabilities[transceiver._kind].find(
    (entry) => entry.mimeType.toLowerCase() === source.codec.mimeType,
  );
  if (!capability) return;
  const key = rtpCodecKey(capability);
  const occupied = [...transceiver._codecPayloadTypes].find(
    ([candidateKey, payloadType]) =>
      candidateKey !== key && payloadType === source.codec.payloadType,
  );
  if (occupied) {
    const peer = transceiver._peerConnection;
    if (peer._currentLocalDescription || peer._pendingLocalDescription) {
      throw makeDOMException(
        "Encoded source payload type is already negotiated for another codec",
        "InvalidModificationError",
      );
    }
    transceiver._codecPayloadTypes.delete(occupied[0]);
  }
  const existing = transceiver._codecPayloadTypes.get(key);
  if (existing !== undefined && existing !== source.codec.payloadType) {
    const peer = transceiver._peerConnection;
    if (peer._currentLocalDescription || peer._pendingLocalDescription) {
      throw makeDOMException(
        "Encoded source payload type differs from the negotiated codec mapping",
        "InvalidModificationError",
      );
    }
  }
  transceiver._codecPayloadTypes.set(key, source.codec.payloadType);
}

function codecDescriptionFromCapability(transceiver, capability, source) {
  const sourceMatches = source?.codec?.mimeType === capability.mimeType.toLowerCase();
  const payloadType = reserveRtpPayloadType(
    transceiver,
    capability,
    sourceMatches
      ? source.codec.payloadType
      : defaultRtpPayloadTypes.get(capability.mimeType.toLowerCase()),
  );
  const resilience = isResilienceCodec(capability);
  return {
    payloadType,
    codec: rtpCodecName(capability),
    clockRate: capability.clockRate,
    ...(capability.channels === undefined ? {} : { channels: capability.channels }),
    ...(sourceMatches && source.codec.profile !== undefined
      ? { profile: source.codec.profile }
      : capability.sdpFmtpLine === undefined
        ? {}
        : { profile: capability.sdpFmtpLine }),
    rtcpFeedback: transceiver._kind === "video" && !resilience ? [...defaultVideoRtcpFeedback] : [],
  };
}

function offerCodecDescriptions(transceiver, source) {
  reserveEncodedSourcePayloadType(transceiver, source);
  let preferences =
    transceiver._preferredCodecs.length > 0
      ? transceiver._preferredCodecs
      : rtpCodecCapabilities[transceiver._kind];
  if (transceiver._preferredCodecs.length === 0 && source?.codec?.mimeType) {
    preferences = [...preferences].sort((left, right) => {
      const leftMatches = left.mimeType.toLowerCase() === source.codec.mimeType;
      const rightMatches = right.mimeType.toLowerCase() === source.codec.mimeType;
      return Number(rightMatches) - Number(leftMatches);
    });
  }
  const includeRtx = preferences.some((codec) => rtpCodecName(codec).toLowerCase() === "rtx");
  const primaryDescriptions = new Map();
  for (const capability of preferences) {
    if (rtpCodecName(capability).toLowerCase() === "rtx") continue;
    primaryDescriptions.set(
      capability,
      codecDescriptionFromCapability(transceiver, capability, source),
    );
  }
  const descriptions = [];
  for (const capability of preferences) {
    const name = rtpCodecName(capability).toLowerCase();
    if (name === "rtx") continue;
    const primary = primaryDescriptions.get(capability);
    descriptions.push(primary);
    if (includeRtx && !isResilienceCodec(capability)) {
      const rtxCapability = { mimeType: "video/rtx", clockRate: primary.clockRate };
      descriptions.push({
        payloadType: reserveRtpPayloadType(
          transceiver,
          rtxCapability,
          undefined,
          `apt=${primary.payloadType}`,
        ),
        codec: "rtx",
        clockRate: primary.clockRate,
        profile: `apt=${primary.payloadType}`,
        rtcpFeedback: [],
      });
    }
  }
  assertEncodedSourceCodecMapping(transceiver._kind, descriptions, source);
  return descriptions;
}

function answerCodecDescriptions(transceiver, section, source) {
  const remote = rtpCodecsFromMediaSection(section, transceiver._kind);
  const explicit = transceiver._preferredCodecs.length > 0;
  const preferences = explicit
    ? transceiver._preferredCodecs
    : rtpCodecCapabilities[transceiver._kind];
  const allowRtx = preferences.some((codec) => rtpCodecName(codec).toLowerCase() === "rtx");
  const baseRemote = remote.filter(
    (codec) =>
      rtpCodecName(codec).toLowerCase() !== "rtx" &&
      supportedNegotiatedCodec(transceiver._kind, codec),
  );
  const ordered = [];
  if (explicit) {
    for (const preference of preferences) {
      if (rtpCodecName(preference).toLowerCase() === "rtx") continue;
      for (const codec of baseRemote) {
        if (ordered.includes(codec)) continue;
        if (
          preference.mimeType.toLowerCase() === codec.mimeType.toLowerCase() &&
          preference.clockRate === codec.clockRate &&
          (preference.channels === undefined || preference.channels === codec.channels)
        ) {
          ordered.push(codec);
        }
      }
    }
  } else {
    ordered.push(...baseRemote);
  }
  const result = [];
  for (const codec of ordered) {
    result.push(codec);
    if (!allowRtx || isResilienceCodec(codec)) continue;
    result.push(
      ...remote.filter(
        (candidate) =>
          rtpCodecName(candidate).toLowerCase() === "rtx" &&
          candidate.associatedPayloadType === codec.payloadType,
      ),
    );
  }
  assertEncodedSourceCodecMapping(transceiver._kind, result, source);
  return nativeCodecDescriptionsFromCodecs(result);
}

function nativeCodecDescriptionsFromCodecs(codecs) {
  return codecs.map(
    ({ mimeType: _mimeType, sdpFmtpLine: _fmtp, associatedPayloadType: _apt, ...codec }) => codec,
  );
}

function nativeCodecDescriptions(peer, transceiver, source, localSection = null) {
  if (localSection) {
    const parsedCodecs = rtpCodecsFromMediaSection(localSection, transceiver._kind);
    assertEncodedSourceCodecMapping(transceiver._kind, parsedCodecs, source);
    rememberCodecPayloadTypes(transceiver, parsedCodecs);
    const codecs = nativeCodecDescriptionsFromCodecs(parsedCodecs);
    if (codecs.length === 0) {
      throw makeDOMException("Local media section has no RTP codecs", "OperationError");
    }
    return codecs;
  }
  const remoteSection =
    peer._signalingState === "have-remote-offer"
      ? parseSdpMediaSections(peer.remoteDescription?.sdp || "").mediaSections.find(
          (section) => section.mid === effectiveTransceiverMid(transceiver),
        )
      : null;
  const codecs = remoteSection
    ? answerCodecDescriptions(transceiver, remoteSection, source)
    : offerCodecDescriptions(transceiver, source);
  if (codecs.length === 0) {
    throw makeDOMException("No common RTP codec is available", "OperationError");
  }
  return codecs;
}

function cloneRtpSendParameters(parameters) {
  return {
    transactionId: parameters.transactionId,
    encodings: parameters.encodings.map((encoding) => ({
      ...encoding,
      ...(encoding.codec === undefined ? {} : { codec: { ...encoding.codec } }),
    })),
    headerExtensions: parameters.headerExtensions.map((extension) => ({ ...extension })),
    rtcp: { ...parameters.rtcp },
    codecs: parameters.codecs.map((codec) => ({ ...codec })),
  };
}

function requiredDictionaryMember(dictionary, name) {
  const value = dictionary[name];
  if (value === undefined) throw new TypeError(`${name} is required`);
  return value;
}

function toSequence(value, name) {
  if (value == null || typeof value[Symbol.iterator] !== "function") {
    throw new TypeError(`${name} must be iterable`);
  }
  return Array.from(value);
}

function toFiniteDouble(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(`${name} must be a finite number`);
  return number;
}

function normalizeRtpCodec(codec, name, includePayloadType) {
  if (codec == null || (typeof codec !== "object" && typeof codec !== "function")) {
    throw new TypeError(`${name} must be an object`);
  }
  const result = {
    mimeType: String(requiredDictionaryMember(codec, "mimeType")),
    clockRate: toUnsignedLong(requiredDictionaryMember(codec, "clockRate")),
  };
  if (includePayloadType) {
    result.payloadType = enforceRange(
      requiredDictionaryMember(codec, "payloadType"),
      `${name}.payloadType`,
      255,
    );
  }
  if (codec.channels !== undefined) {
    result.channels = enforceRange(codec.channels, `${name}.channels`, 65535);
  }
  if (codec.sdpFmtpLine !== undefined) result.sdpFmtpLine = String(codec.sdpFmtpLine);
  return result;
}

function normalizeRtpSendParameters(parameters, kind) {
  if (parameters == null || (typeof parameters !== "object" && typeof parameters !== "function")) {
    throw new TypeError("parameters must be an RTCRtpSendParameters dictionary");
  }
  const transactionId = String(requiredDictionaryMember(parameters, "transactionId"));
  const encodings = toSequence(requiredDictionaryMember(parameters, "encodings"), "encodings").map(
    (encoding, index) => {
      const value = encoding == null ? {} : Object(encoding);
      const normalized = { active: value.active === undefined ? true : Boolean(value.active) };
      if (value.rid !== undefined) normalized.rid = String(value.rid);
      if (value.codec !== undefined) {
        normalized.codec = normalizeRtpCodec(value.codec, `encodings[${index}].codec`, false);
      }
      if (value.maxBitrate !== undefined) normalized.maxBitrate = toUnsignedLong(value.maxBitrate);
      if (value.maxFramerate !== undefined) {
        normalized.maxFramerate = toFiniteDouble(
          value.maxFramerate,
          `encodings[${index}].maxFramerate`,
        );
      }
      if (value.scaleResolutionDownBy !== undefined) {
        normalized.scaleResolutionDownBy = toFiniteDouble(
          value.scaleResolutionDownBy,
          `encodings[${index}].scaleResolutionDownBy`,
        );
      }
      if (kind === "audio") {
        delete normalized.maxFramerate;
        delete normalized.scaleResolutionDownBy;
      } else if (normalized.scaleResolutionDownBy === undefined) {
        normalized.scaleResolutionDownBy = 1;
      }
      return normalized;
    },
  );
  const headerExtensions = toSequence(
    requiredDictionaryMember(parameters, "headerExtensions"),
    "headerExtensions",
  ).map((extension, index) => {
    if (extension == null || (typeof extension !== "object" && typeof extension !== "function")) {
      throw new TypeError(`headerExtensions[${index}] must be an object`);
    }
    return {
      uri: String(requiredDictionaryMember(extension, "uri")),
      id: enforceRange(requiredDictionaryMember(extension, "id"), `headerExtensions[${index}].id`),
      encrypted: extension.encrypted === undefined ? false : Boolean(extension.encrypted),
    };
  });
  const rtcpValue = requiredDictionaryMember(parameters, "rtcp");
  if (rtcpValue == null || (typeof rtcpValue !== "object" && typeof rtcpValue !== "function")) {
    throw new TypeError("rtcp must be an object");
  }
  const rtcp = {};
  if (rtcpValue.cname !== undefined) rtcp.cname = String(rtcpValue.cname);
  if (rtcpValue.reducedSize !== undefined) rtcp.reducedSize = Boolean(rtcpValue.reducedSize);
  const codecs = toSequence(requiredDictionaryMember(parameters, "codecs"), "codecs").map(
    (codec, index) => normalizeRtpCodec(codec, `codecs[${index}]`, true),
  );
  return { transactionId, encodings, headerExtensions, rtcp, codecs };
}

function sameOptionalMember(left, right, name) {
  return (
    Object.hasOwn(left, name) === Object.hasOwn(right, name) &&
    (!Object.hasOwn(left, name) || left[name] === right[name])
  );
}

function sameRtpCodec(left, right, includePayloadType) {
  return (
    (!includePayloadType || left.payloadType === right.payloadType) &&
    left.mimeType === right.mimeType &&
    left.clockRate === right.clockRate &&
    sameOptionalMember(left, right, "channels") &&
    sameOptionalMember(left, right, "sdpFmtpLine")
  );
}

function sameRtpParameterSequence(left, right, compare) {
  return left.length === right.length && left.every((entry, index) => compare(entry, right[index]));
}

function hasModifiedReadOnlyRtpParameters(parameters, lastReturned) {
  if (parameters.transactionId !== lastReturned.transactionId) return true;
  if (parameters.encodings.length !== lastReturned.encodings.length) return true;
  if (
    parameters.encodings.some(
      (encoding, index) => !sameOptionalMember(encoding, lastReturned.encodings[index], "rid"),
    )
  ) {
    return true;
  }
  if (
    !sameRtpParameterSequence(parameters.headerExtensions, lastReturned.headerExtensions, (a, b) =>
      ["uri", "id", "encrypted"].every((name) => a[name] === b[name]),
    )
  ) {
    return true;
  }
  if (
    !sameOptionalMember(parameters.rtcp, lastReturned.rtcp, "cname") ||
    !sameOptionalMember(parameters.rtcp, lastReturned.rtcp, "reducedSize")
  ) {
    return true;
  }
  return !sameRtpParameterSequence(parameters.codecs, lastReturned.codecs, (a, b) =>
    sameRtpCodec(a, b, true),
  );
}

function validateSupportedSenderParameters(transceiver, parameters) {
  for (const encoding of parameters.encodings) {
    if (encoding.scaleResolutionDownBy !== undefined && encoding.scaleResolutionDownBy < 1) {
      throw new RangeError("scaleResolutionDownBy must be at least 1");
    }
    if (encoding.maxFramerate !== undefined && encoding.maxFramerate < 0) {
      throw new RangeError("maxFramerate must not be negative");
    }
    if (encoding.codec !== undefined) {
      const choosableCodecs = parameters.codecs;
      if (!choosableCodecs.some((codec) => sameRtpCodec(encoding.codec, codec, false))) {
        throw makeDOMException("The selected codec was not negotiated", "InvalidModificationError");
      }
      throw makeDOMException(
        "Per-encoding codec selection is unavailable for pre-encoded media",
        "OperationError",
      );
    }
    if (encoding.maxBitrate !== undefined || encoding.maxFramerate !== undefined) {
      throw makeDOMException(
        "Bitrate and frame-rate controls require an encoder or packet pacer",
        "OperationError",
      );
    }
    if (transceiver._kind === "video" && encoding.scaleResolutionDownBy !== 1) {
      throw makeDOMException("Resolution scaling requires an encoder", "OperationError");
    }
  }
  const activeChanged = parameters.encodings.some(
    (encoding, index) => encoding.active !== transceiver._sendEncodings[index]?.active,
  );
  if (activeChanged && parameters.encodings.length > 1) {
    throw makeDOMException(
      "Per-encoding activation requires negotiated encoded layers",
      "OperationError",
    );
  }
}

function normalizeInitialSendEncodings(kind, value) {
  const encodings = value === undefined ? [] : Array.from(value);
  const normalized = encodings.map((encoding, index) => {
    const input = encoding == null ? {} : Object(encoding);
    const result = { active: input.active === undefined ? true : Boolean(input.active) };
    if (input.rid !== undefined) {
      const rid = String(input.rid);
      if (!/^[A-Za-z0-9]{1,255}$/.test(rid)) {
        throw new TypeError(`sendEncodings[${index}].rid is not a valid RID`);
      }
      result.rid = rid;
    }
    if (input.maxBitrate !== undefined || input.codec !== undefined) {
      throw makeDOMException(
        "Encoded media does not provide sender-side bitrate or codec control",
        "NotSupportedError",
      );
    }
    if (kind === "video") {
      if (input.maxFramerate !== undefined) {
        throw makeDOMException(
          "Encoded media does not provide sender-side frame-rate control",
          "NotSupportedError",
        );
      }
      const scale =
        input.scaleResolutionDownBy === undefined
          ? 1
          : toFiniteDouble(
              input.scaleResolutionDownBy,
              `sendEncodings[${index}].scaleResolutionDownBy`,
            );
      if (scale < 1) throw new RangeError("scaleResolutionDownBy must be at least 1");
      if (scale !== 1) {
        throw makeDOMException(
          "Encoded media does not provide sender-side resolution scaling",
          "NotSupportedError",
        );
      }
      result.scaleResolutionDownBy = 1;
    }
    return result;
  });
  const ridCount = normalized.filter((encoding) => encoding.rid !== undefined).length;
  if (ridCount !== 0 && ridCount !== normalized.length) {
    throw new TypeError("Either all or none of sendEncodings must contain a rid");
  }
  const rids = new Set();
  for (const encoding of normalized) {
    if (encoding.rid === undefined) continue;
    if (rids.has(encoding.rid)) throw new TypeError("sendEncodings contains duplicate rid values");
    rids.add(encoding.rid);
  }
  const result =
    normalized.length > 0
      ? [normalized[0]]
      : [kind === "video" ? { active: true, scaleResolutionDownBy: 1 } : { active: true }];
  delete result[0].rid;
  return result;
}

function serializeSdp(sessionLines, mediaSections) {
  const lines = [...sessionLines];
  for (const section of mediaSections) lines.push(...section.lines);
  return `${lines.join("\r\n")}\r\n`;
}

function orderCodecAttributeLines(description) {
  if (!description?.sdp) return description;
  const parsed = parseSdpMediaSections(description.sdp);
  let changed = false;
  for (const section of parsed.mediaSections) {
    if (!/^m=(?:audio|video)\b/i.test(section.startLine)) continue;
    const payloadTypes = section.startLine.split(/\s+/).slice(3);
    const groups = new Map();
    const remaining = [];
    let insertionIndex = null;
    for (const line of section.lines) {
      const match = /^a=(?:rtpmap|fmtp|rtcp-fb):(\d+)(?:\s|$)/i.exec(line);
      if (!match) {
        remaining.push(line);
        continue;
      }
      insertionIndex ??= remaining.length;
      const lines = groups.get(match[1]) || [];
      lines.push(line);
      groups.set(match[1], lines);
    }
    if (insertionIndex === null) continue;
    const ordered = [];
    for (const payloadType of payloadTypes) {
      const lines = groups.get(payloadType);
      if (!lines) continue;
      ordered.push(...lines);
      groups.delete(payloadType);
    }
    for (const lines of groups.values()) ordered.push(...lines);
    remaining.splice(insertionIndex, 0, ...ordered);
    section.lines = remaining;
    section.startLine = remaining[0];
    changed = true;
  }
  if (!changed) return description;
  return new RTCSessionDescription({
    type: description.type,
    sdp: serializeSdp(parsed.sessionLines, parsed.mediaSections),
  });
}

function alignMediaDirections(description, template) {
  if (!description?.sdp || !template?.sdp) return description;
  const parsed = parseSdpMediaSections(description.sdp);
  const templateParsed = parseSdpMediaSections(template.sdp);
  const templateDirections = new Map(
    templateParsed.mediaSections.map((section) => [
      section.mid,
      section.lines.find((line) => /^a=(?:sendrecv|sendonly|recvonly|inactive)$/.test(line)) ||
        "a=sendrecv",
    ]),
  );
  for (const section of parsed.mediaSections) {
    const direction = templateDirections.get(section.mid);
    if (!direction) continue;
    const index = section.lines.findIndex((line) =>
      /^a=(?:sendrecv|sendonly|recvonly|inactive)$/.test(line),
    );
    if (index === -1) section.lines.push(direction);
    else section.lines[index] = direction;
  }
  return new RTCSessionDescription({
    type: description.type,
    sdp: serializeSdp(parsed.sessionLines, parsed.mediaSections),
  });
}

function rejectMediaSection(section) {
  const lines = [...section.lines];
  lines[0] = lines[0].replace(/^(m=\S+)\s+\d+\s/i, "$1 0 ");
  return { ...section, startLine: lines[0], lines };
}

function reconcileRejectedMediaSections(description, history) {
  if (!description?.sdp || !history?.sdp) return description;
  const parsed = parseSdpMediaSections(description.sdp);
  const historical = parseSdpMediaSections(history.sdp);
  if (!historical.mediaSections.some((section) => /^m=\S+\s+0\s/i.test(section.startLine))) {
    return description;
  }

  const output = new Array(historical.mediaSections.length);
  const used = new Set();
  for (let index = 0; index < historical.mediaSections.length; index += 1) {
    const previous = historical.mediaSections[index];
    if (previous.mid === null) continue;
    const generatedIndex = parsed.mediaSections.findIndex(
      (section, candidateIndex) => !used.has(candidateIndex) && section.mid === previous.mid,
    );
    if (generatedIndex === -1) continue;
    output[index] = parsed.mediaSections[generatedIndex];
    used.add(generatedIndex);
  }

  const remaining = parsed.mediaSections.filter((_, index) => !used.has(index));
  for (let index = 0; index < historical.mediaSections.length; index += 1) {
    if (output[index]) continue;
    const previous = historical.mediaSections[index];
    output[index] = /^m=\S+\s+0\s/i.test(previous.startLine)
      ? remaining.shift() || previous
      : rejectMediaSection(previous);
  }
  output.push(...remaining);

  return new RTCSessionDescription({
    type: description.type,
    sdp: serializeSdp(parsed.sessionLines, output.filter(Boolean)),
  });
}

function validateCandidateSyntax(candidate) {
  if (candidate === "") return true;
  if (typeof candidate !== "string" || !candidate.startsWith("candidate:")) return false;
  const parts = candidate.slice("candidate:".length).trim().split(/\s+/);
  const typIndex = parts.indexOf("typ");
  return parts.length >= 8 && typIndex >= 6 && Boolean(parts[typIndex + 1]);
}

function selectCandidateSections(description, candidate) {
  const parsed = parseSdpMediaSections(description?.sdp || "");
  const sections = parsed.mediaSections;
  if (sections.length === 0) return { parsed, targets: [] };

  let targets;
  if (candidate.sdpMid !== null) {
    const section = sections.find((entry) => entry.mid === candidate.sdpMid);
    if (!section)
      throw makeDOMException("sdpMid does not match a remote media section", "OperationError");
    targets = [section];
  } else if (candidate.sdpMLineIndex !== null) {
    const index = Number(candidate.sdpMLineIndex);
    if (!Number.isInteger(index) || index < 0 || index >= sections.length) {
      throw makeDOMException(
        "sdpMLineIndex does not match a remote media section",
        "OperationError",
      );
    }
    targets = [sections[index]];
  } else if (candidate.usernameFragment !== null) {
    targets = sections.filter((entry) => entry.iceUfrag === candidate.usernameFragment);
    if (targets.length === 0) {
      throw makeDOMException(
        "usernameFragment does not match a remote ICE generation",
        "OperationError",
      );
    }
  } else {
    targets = sections;
  }

  if (candidate.usernameFragment !== null) {
    const matches = targets.some((entry) => entry.iceUfrag === candidate.usernameFragment);
    if (!matches) {
      throw makeDOMException(
        "usernameFragment does not match the selected media section",
        "OperationError",
      );
    }
  }

  return { parsed, targets };
}

function appendRemoteCandidateToDescription(description, candidate) {
  if (!description?.sdp || isNoMediaSdp(description)) return description;
  if (!validateCandidateSyntax(candidate.candidate)) {
    throw makeDOMException("Invalid ICE candidate syntax", "OperationError");
  }

  const { parsed, targets } = selectCandidateSections(description, candidate);
  if (targets.length === 0) return description;

  const line = candidate.candidate === "" ? "a=end-of-candidates" : `a=${candidate.candidate}`;
  for (const section of targets) {
    if (!section.lines.includes(line)) section.lines.push(line);
  }
  return new RTCSessionDescription({
    type: description.type,
    sdp: serializeSdp(parsed.sessionLines, parsed.mediaSections),
  });
}

function isIceCandidateLine(line) {
  return line.startsWith("a=candidate:") || line === "a=end-of-candidates";
}

function stripIceCandidateLinesFromDescription(description) {
  if (!description?.sdp || isNoMediaSdp(description)) return description;
  const parsed = parseSdpMediaSections(description.sdp);
  let stripped = false;
  for (const section of parsed.mediaSections) {
    section.lines = section.lines.filter((line) => {
      if (!isIceCandidateLine(line)) return true;
      stripped = true;
      return false;
    });
  }
  if (!stripped) return description;
  const result = new RTCSessionDescription({
    type: description.type,
    sdp: serializeSdp(parsed.sessionLines, parsed.mediaSections),
  });
  if (description._webrtcNodeJsOnlyIceRestart) markJsOnlyIceRestart(result);
  return result;
}

function extractIceCandidatesFromDescription(description) {
  if (!description?.sdp || isNoMediaSdp(description)) return [];
  const parsed = parseSdpMediaSections(description.sdp);
  const candidates = [];
  for (let index = 0; index < parsed.mediaSections.length; index += 1) {
    const section = parsed.mediaSections[index];
    for (const line of section.lines) {
      if (!line.startsWith("a=candidate:")) continue;
      candidates.push(
        new RTCIceCandidate({
          candidate: line.slice("a=".length),
          sdpMid: section.mid,
          sdpMLineIndex: index,
          usernameFragment: section.iceUfrag,
        }),
      );
    }
  }
  return candidates;
}

function resolveCandidateMid(description, candidate) {
  if (candidate.sdpMid !== null) return candidate.sdpMid;
  if (candidate.sdpMLineIndex === null) return null;
  const index = Number(candidate.sdpMLineIndex);
  const section = parseSdpMediaSections(description?.sdp || "").mediaSections[index];
  return section?.mid || null;
}

function firstIceParameters(description) {
  const section = parseSdpMediaSections(description?.sdp || "").mediaSections.find(
    (entry) => entry.iceUfrag && entry.icePwd,
  );
  if (!section) return null;
  return {
    usernameFragment: section.iceUfrag,
    password: section.icePwd,
  };
}

function dtlsSetupFromDescription(description) {
  const parsed = parseSdpMediaSections(description?.sdp || "");
  const section =
    parsed.mediaSections.find((entry) => /^m=application\b/i.test(entry.startLine)) ||
    parsed.mediaSections[0];
  const setupLine =
    section?.lines.find((line) => /^a=setup:/i.test(line)) ||
    parsed.sessionLines.find((line) => /^a=setup:/i.test(line));
  return setupLine ? setupLine.slice("a=setup:".length).toLowerCase() : null;
}

function sameCandidate(left, right) {
  return (
    left.candidate === right.candidate &&
    left.sdpMid === right.sdpMid &&
    left.sdpMLineIndex === right.sdpMLineIndex &&
    left.usernameFragment === right.usernameFragment
  );
}

function sameCandidateEndpoint(left, right) {
  if (!left || !right) return false;
  return (
    left.component === right.component &&
    left.protocol === right.protocol &&
    left.address === right.address &&
    left.port === right.port &&
    left.address !== null &&
    left.port !== null
  );
}

function candidateStats(id, type, candidate, timestamp) {
  const stats = {
    id,
    timestamp,
    type,
    transportId: "transport-0",
  };
  const fields = {
    address: candidate.address,
    port: candidate.port,
    protocol: candidate.protocol,
    candidateType: candidate.type,
    priority: candidate.priority,
    foundation: candidate.foundation,
    relayProtocol: candidate.relayProtocol,
    url: candidate.url,
  };
  for (const [name, value] of Object.entries(fields)) {
    if (value !== null && value !== undefined) stats[name] = value;
  }
  return stats;
}

function selectKnownCandidateByEndpoint(candidates, selectedCandidate) {
  return (
    candidates.find((candidate) => sameCandidateEndpoint(candidate, selectedCandidate)) ||
    selectedCandidate
  );
}

class RTCDataChannelEvent extends SimpleEvent {
  constructor(type, init) {
    if (!init || !init.channel) throw new TypeError("RTCDataChannelEventInit.channel is required");
    super(type, init);
    this.channel = init.channel;
  }
}

class RTCPeerConnectionIceEvent extends SimpleEvent {
  constructor(type, init = {}) {
    if (arguments.length === 0) throw new TypeError("type is required");
    if (
      init.candidate !== undefined &&
      init.candidate !== null &&
      !(init.candidate instanceof RTCIceCandidate)
    ) {
      throw new TypeError("candidate must be an RTCIceCandidate or null");
    }
    super(type, init);
    this.candidate = init.candidate == null ? null : init.candidate;
    this.url = init.url === undefined ? null : init.url;
  }
}

class RTCPeerConnectionIceErrorEvent extends SimpleEvent {
  constructor(type, init = {}) {
    if (arguments.length === 0) throw new TypeError("type is required");
    super(type, init);
    this.address =
      init.address === undefined || init.address === null ? null : String(init.address);
    this.port =
      init.port === undefined || init.port === null ? null : enforceRange(init.port, "port");
    this.url = init.url === undefined ? "" : String(init.url);
    this.errorCode = init.errorCode === undefined ? 0 : enforceRange(init.errorCode, "errorCode");
    this.errorText = init.errorText === undefined ? "" : String(init.errorText);
  }
}

class RTCError extends Error {
  constructor(init, message = "") {
    if (!init || typeof init !== "object" || init.errorDetail === undefined) {
      throw new TypeError("RTCErrorInit.errorDetail is required");
    }
    const errorDetail = String(init.errorDetail);
    if (
      ![
        "data-channel-failure",
        "dtls-failure",
        "fingerprint-failure",
        "sctp-failure",
        "sdp-syntax-error",
        "hardware-encoder-error",
        "hardware-encoder-not-available",
      ].includes(errorDetail)
    ) {
      throw new TypeError(`Invalid RTCErrorDetailType: ${errorDetail}`);
    }
    super(message);
    defineReadonly(this, "name", "OperationError");
    defineReadonly(this, "code", 0);
    defineReadonly(this, "errorDetail", errorDetail);
    defineReadonly(this, "sdpLineNumber", init.sdpLineNumber ?? null);
    defineReadonly(this, "sctpCauseCode", init.sctpCauseCode ?? null);
    defineReadonly(this, "receivedAlert", init.receivedAlert ?? null);
    defineReadonly(this, "sentAlert", init.sentAlert ?? null);
  }
}

function defineReadonly(target, name, value) {
  Object.defineProperty(target, name, {
    value,
    enumerable: true,
    configurable: true,
    writable: false,
  });
}

class RTCErrorEvent extends SimpleEvent {
  constructor(type, init = {}) {
    super(type, init);
    this.error = init.error;
  }
}

class RTCIceTransport extends SimpleEventTarget {
  constructor(token, peerConnection) {
    if (token !== kInternalConstruct) throw new TypeError("Illegal constructor");
    super();
    this._pc = peerConnection;
    this._stateOverride = null;
    this._connectionSequenceRequested = false;
    this._connectionSequenceStarted = false;
    this._connectionSequenceReplaying = false;
    this.onstatechange = null;
    this.ongatheringstatechange = null;
    this.onselectedcandidatepairchange = null;
  }

  get role() {
    return this._pc._iceRole;
  }

  get component() {
    return "rtp";
  }

  get state() {
    if (this._pc._closed) return "closed";
    return this._stateOverride || this._pc.iceConnectionState;
  }

  get gatheringState() {
    const state = this._pc.iceGatheringState;
    if (
      state === "new" &&
      (this._pc._localIceCandidates.length > 0 ||
        this.state === "connected" ||
        this.state === "completed")
    ) {
      return "gathering";
    }
    return state;
  }

  getLocalCandidates() {
    return this._pc._localIceCandidates.map((candidate) => new RTCIceCandidate(candidate.toJSON()));
  }

  getRemoteCandidates() {
    return this._pc._remoteIceCandidates.map(
      (candidate) => new RTCIceCandidate(candidate.toJSON()),
    );
  }

  getSelectedCandidatePair() {
    if (!["connected", "completed"].includes(this.state)) return null;
    const localCandidates = this.getLocalCandidates();
    const remoteCandidates = this.getRemoteCandidates();
    const hasExplicitlyNegotiatedPeerTransport = Boolean(
      this._pc._hasExplicitlyNegotiatedDataTransport() &&
        this._pc._pairedPeer?._hasExplicitlyNegotiatedDataTransport(),
    );
    const hasJsVisibleRemoteCandidate =
      remoteCandidates.length > 0 ||
      this._pc._sameProcessIceCandidateExchange ||
      this._pc._explicitIceCandidateExchange ||
      hasExplicitlyNegotiatedPeerTransport;
    if (!hasJsVisibleRemoteCandidate) return null;
    const nativePair = this._pc._native?.selectedCandidatePair();
    if (nativePair?.local && nativePair?.remote) {
      const nativeLocal = new RTCIceCandidate(nativePair.local);
      const nativeRemote = new RTCIceCandidate(nativePair.remote);
      return new RTCIceCandidatePair(
        kInternalConstruct,
        selectKnownCandidateByEndpoint(localCandidates, nativeLocal),
        selectKnownCandidateByEndpoint(remoteCandidates, nativeRemote),
      );
    }
    const pairedPeer = this._pc._pairedPeer;
    const pairedLocalCandidates =
      pairedPeer?._localIceCandidates?.map(
        (candidate) => new RTCIceCandidate(candidate.toJSON()),
      ) || [];
    const pairedRemoteCandidates =
      pairedPeer?._remoteIceCandidates?.map(
        (candidate) => new RTCIceCandidate(candidate.toJSON()),
      ) || [];
    const local = localCandidates[0] || pairedRemoteCandidates[0] || null;
    const remote = remoteCandidates[0] || pairedLocalCandidates[0] || null;
    if (!local || !remote) return null;
    return new RTCIceCandidatePair(kInternalConstruct, local, remote);
  }

  getLocalParameters() {
    return firstIceParameters(this._pc.localDescription);
  }

  getRemoteParameters() {
    return firstIceParameters(this._pc.remoteDescription);
  }

  _eventListenerAdded(type) {
    if (type !== "statechange") return;
    this._connectionSequenceRequested = true;
    this._queueConnectedSequenceIfNeeded();
  }

  _handlePeerIceConnectionState(state) {
    if (this._connectionSequenceReplaying && (state === "connected" || state === "completed")) {
      return;
    }
    if ((state === "connected" || state === "completed") && this._queueConnectedSequenceIfNeeded())
      return;

    this._stateOverride = null;
    this.dispatchEvent(makeEvent("statechange"));
  }

  _queueConnectedSequenceIfNeeded() {
    if (
      !this._connectionSequenceRequested ||
      this._connectionSequenceStarted ||
      !this._pc._hasNegotiatedDataTransport() ||
      !["connected", "completed"].includes(this._pc.iceConnectionState)
    ) {
      return false;
    }
    this._connectionSequenceStarted = true;
    this._connectionSequenceReplaying = true;
    setTimeout(() => {
      if (this._pc._closed || this._stateOverride === "disconnected") return;
      this._stateOverride = "checking";
      this.dispatchEvent(makeEvent("statechange"));
      this._stateOverride = "connected";
      setTimeout(() => {
        if (this._pc._closed || this._stateOverride !== "connected") return;
        this.dispatchEvent(makeEvent("statechange"));
        this._connectionSequenceReplaying = false;
      }, 0);
    }, 0);
    return true;
  }

  _forceState(state, { dispatch = true } = {}) {
    this._connectionSequenceStarted = true;
    this._stateOverride = state;
    if (dispatch) this.dispatchEvent(makeEvent("statechange"));
  }
}

class RTCDtlsTransport extends SimpleEventTarget {
  constructor(token, peerConnection) {
    if (token !== kInternalConstruct) throw new TypeError("Illegal constructor");
    super();
    this._pc = peerConnection;
    this.iceTransport = new RTCIceTransport(kInternalConstruct, peerConnection);
    this._lastState = "new";
    this.onstatechange = null;
    this.onerror = null;
  }

  get state() {
    if (this._pc._closed || this._pc.connectionState === "closed") return "closed";
    if (this._pc.connectionState === "connected" || this._pc._sctpTransport?._state === "connected")
      return "connected";
    if (this._pc.connectionState === "failed") return "failed";
    if (!this._pc.localDescription || !this._pc.remoteDescription) return "new";
    return "connecting";
  }

  getRemoteCertificates() {
    if (this.state !== "connected") return [];
    const certificate = this._pc._pairedPeer?._nativeCertificates?.[0];
    const material = getCertificateMaterial(certificate);
    if (!material) return [];
    try {
      return [certificatePemToArrayBuffer(material.certificatePem)];
    } catch {
      return [];
    }
  }

  _syncState() {
    const state = this.state;
    if (state === this._lastState) return;
    this._lastState = state;
    this.dispatchEvent(makeEvent("statechange"));
  }
}

class RTCSctpTransport extends SimpleEventTarget {
  constructor(token, peerConnection, transport) {
    if (token !== kInternalConstruct) throw new TypeError("Illegal constructor");
    super();
    this._pc = peerConnection;
    this._transport = transport;
    this._state = "connecting";
    this._maxMessageSize = null;
    this._maxChannels = null;
    this.onstatechange = null;
  }

  get transport() {
    return this._transport;
  }

  get state() {
    return this._state;
  }

  get maxMessageSize() {
    return this._maxMessageSize;
  }

  get maxChannels() {
    if (this._maxChannels === null && this._state === "connected") {
      this._maxChannels = this._pc._currentSctpMaxChannels() || LIBDATACHANNEL_SCTP_MAX_CHANNELS;
    }
    return this._maxChannels;
  }

  _setState(state) {
    if (this._state === state) return;
    this._state = state;
    this.dispatchEvent(makeEvent("statechange"));
  }

  _setLimits({ maxMessageSize, maxChannels }) {
    this._maxMessageSize = maxMessageSize;
    this._maxChannels = maxChannels;
  }
}

class UnsupportedNativeDataChannel {
  constructor(label, options) {
    this.bindingId = nextUnsupportedDataChannelBindingId--;
    this.label = label;
    this.ordered = options.ordered;
    this.protocol = options.protocol;
    this.negotiated = options.negotiated;
    this.maxPacketLifeTime = options.maxPacketLifeTime ?? null;
    this.maxRetransmits = options.maxRetransmits ?? null;
    this.id = options.id;
    this.bufferedAmount = 0;
    this.maxMessageSize = DEFAULT_SCTP_MAX_MESSAGE_SIZE;
    this.isOpen = false;
    this.isClosed = false;
  }

  close() {
    this.isClosed = true;
  }

  setBufferedAmountLowThreshold() {}

  sendString() {
    throw new Error("RTCDataChannel stream id exceeds libdatachannel's native stream limit");
  }

  sendBinary() {
    throw new Error("RTCDataChannel stream id exceeds libdatachannel's native stream limit");
  }
}

class SyntheticNativeDataChannel {
  constructor(label, options) {
    this.bindingId = nextUnsupportedDataChannelBindingId--;
    this.label = label;
    this.ordered = options.ordered;
    this.protocol = options.protocol;
    this.negotiated = options.negotiated;
    this.maxPacketLifeTime = options.maxPacketLifeTime ?? null;
    this.maxRetransmits = options.maxRetransmits ?? null;
    this.id = options.id;
    this.bufferedAmount = 0;
    this.maxMessageSize = DEFAULT_SCTP_MAX_MESSAGE_SIZE;
    this.isOpen = true;
    this.isClosed = false;
  }

  close() {
    this.isOpen = false;
    this.isClosed = true;
  }

  setBufferedAmountLowThreshold() {}

  sendString() {
    return true;
  }

  sendBinary() {
    return true;
  }
}

class RTCDataChannel extends SimpleEventTarget {
  static _fromNative(
    peerConnection,
    nativeChannel,
    initialReadyState = undefined,
    assignedId = null,
  ) {
    const channel = new RTCDataChannel(
      peerConnection,
      nativeChannel,
      initialReadyState,
      assignedId,
    );
    peerConnection._channels.set(channel._native.bindingId, channel);
    peerConnection._registerDataChannelId(channel);
    if (channel._registeredDataChannelId == null && channel._effectiveId() == null) {
      peerConnection._dataChannelIdRefreshNeeded = true;
    }
    return channel;
  }

  constructor(peerConnection, nativeChannel, initialReadyState = undefined, assignedId = null) {
    super();
    this._pc = peerConnection;
    this._native = nativeChannel;
    this._readyState =
      initialReadyState ||
      (nativeChannel.isOpen ? "open" : nativeChannel.isClosed ? "closed" : "connecting");
    this._binaryType = "arraybuffer";
    this._bufferedAmount = 0;
    this._bufferedAmountLowThreshold = 0;
    this._pendingBufferedAmountDecrease = 0;
    this._bufferedAmountDecreaseScheduled = false;
    this._sendTail = Promise.resolve();
    this._pendingSendCount = 0;
    this._nativeCloseScheduled = false;
    this._openEventPending = false;
    this._openEventDispatched = false;
    this._announcementPending = false;
    this._nativeEventDrainActive = false;
    this._queuedNativeEvents = [];
    this._queuedMessageEvents = [];
    this._queuedMessageEventIndex = 0;
    this._messageEventFlushScheduled = false;
    this._messageEventGateActive = false;
    this._messageConsumerGateActive = false;
    this._messageEventListenerCount = 0;
    this._messageHandlerNeedsTaskYield = false;
    this._pendingPairedDeliveryBytes = 0;
    this._nativeCloseEventQueued = false;
    this._nativeCloseSuppressionDeadline = 0;
    this._nativeCloseSuppressionsRemaining = 0;
    this._openEventDeferredForIce = false;
    this._openEventDeferredForDataChannel = false;
    this._openEventDataChannelDeferralExpired = false;
    this._registeredDataChannelId = null;
    this._assignedId = assignedId;
    this._messagesSent = 0;
    this._bytesSent = 0;
    this._messagesReceived = 0;
    this._bytesReceived = 0;
    this._statsOpened = false;
    this._statsClosed = false;
    this._pairedChannel = null;
    this._createdLocally = false;
    this._negotiatedOverride = null;
    this._syntheticIncoming = false;
    this.onopen = null;
    this._onmessage = null;
    this.onclose = null;
    this.onerror = null;
    this.onclosing = null;
    this.onbufferedamountlow = null;
  }

  get label() {
    return this._native.label;
  }

  get ordered() {
    return this._native.ordered;
  }

  get maxPacketLifeTime() {
    return this._native.maxPacketLifeTime;
  }

  get maxRetransmits() {
    return this._native.maxRetransmits;
  }

  get protocol() {
    return this._native.protocol;
  }

  get negotiated() {
    return this._negotiatedOverride ?? this._native.negotiated;
  }

  get id() {
    const nativeId = this._native.id;
    if (nativeId != null) this._assignedId = nativeId;
    const id = nativeId ?? this._assignedId;
    this._pc._registerDataChannelId(this, id);
    return id;
  }

  get readyState() {
    return this._readyState;
  }

  get bufferedAmount() {
    return this._bufferedAmount;
  }

  get bufferedAmountLowThreshold() {
    return this._bufferedAmountLowThreshold;
  }

  set bufferedAmountLowThreshold(value) {
    const threshold = toUnsignedLong(value);
    this._bufferedAmountLowThreshold = threshold;
    this._native.setBufferedAmountLowThreshold(threshold);
  }

  get binaryType() {
    return this._binaryType;
  }

  set binaryType(value) {
    if (value === "arraybuffer" || value === "blob") this._binaryType = value;
  }

  get onmessage() {
    return this._onmessage;
  }

  set onmessage(callback) {
    this._onmessage = typeof callback === "function" ? callback : null;
    this._messageHandlerNeedsTaskYield = this._messageContinuationNeedsTaskYield(this._onmessage);
    if (this._onmessage) this._releaseMessageConsumerGate();
  }

  send(data) {
    if (this._readyState === "connecting") {
      throw makeDOMException("RTCDataChannel is not open", "InvalidStateError");
    }
    if (this._readyState === "closing" || this._readyState === "closed") {
      throw makeDOMException("RTCDataChannel is closing or closed", "InvalidStateError");
    }

    if (typeof data === "string") {
      const payload = data;
      const size = byteLength(payload);
      this._assertWithinMaxMessageSize(size);
      if (this._hasPendingSends() || !this._nativeReadyForSend()) {
        this._enqueueSend(() => this._sendNativeString(payload), size);
      } else {
        if (this._sendNativeString(payload)) {
          this._increaseBufferedAmount(size);
          this._recordSentMessage(size);
        } else {
          this._enqueueSend(() => this._sendNativeString(payload), size);
        }
      }
      return;
    }

    if (typeof Blob !== "undefined" && data instanceof Blob) {
      const blob = data;
      this._assertWithinMaxMessageSize(blob.size);
      this._enqueueSend(async () => {
        const buffer = await blob.arrayBuffer();
        return this._sendNativeBinary(new Uint8Array(buffer));
      }, blob.size);
      return;
    }

    const view = data instanceof Uint8Array ? data : toUint8Array(data);
    const size = view.byteLength;
    this._assertWithinMaxMessageSize(size);
    if (this._hasPendingSends() || !this._nativeReadyForSend()) {
      const payload = new Uint8Array(view);
      this._enqueueSend(() => this._sendNativeBinary(payload), size);
    } else {
      if (this._sendNativeBinary(view)) {
        this._increaseBufferedAmount(size);
        this._recordSentMessage(size);
      } else {
        const payload = new Uint8Array(view);
        this._enqueueSend(() => this._sendNativeBinary(payload), size);
      }
    }
  }

  close() {
    if (this._readyState === "closing" || this._readyState === "closed") return;
    this._readyState = "closing";
    if (!this._pairedChannel) {
      this._pc._pairDataChannelById(this, this._effectiveId());
    }
    const pairedChannel = this._pairedChannel;
    const shouldDrainBeforeClose =
      this._bufferedAmount > 0 || this._hasPendingSends() || this._pendingPairedDeliveryBytes > 0;
    if (!this._nativeCloseScheduled) {
      this._nativeCloseScheduled = true;
      const closeNative = () => {
        const close = () => {
          const synthesizePairedClose = pairedChannel && pairedChannel.readyState !== "closed";
          this._native.close();
          if (synthesizePairedClose) {
            setTimeout(() => pairedChannel._handleRemoteChannelClose(), 0);
          }
          setTimeout(() => {
            if (this._readyState === "closing") this._handleClose();
          }, 0);
        };
        if (shouldDrainBeforeClose) {
          this._closeNativeAfterBufferedSends(close);
        } else {
          setImmediate(close);
        }
      };
      if (this._hasPendingSends()) {
        this._sendTail.then(closeNative, closeNative);
      } else {
        closeNative();
      }
    }
  }

  _increaseBufferedAmount(size) {
    if (!size) return;
    this._bufferedAmount += size;
    this._queueBufferedAmountDecrease(size);
  }

  _queueBufferedAmountDecrease(size) {
    if (!size) return;
    if (this._usesSyntheticPairDelivery()) {
      setImmediate(() => this._decreaseBufferedAmount(size));
      return;
    }
    this._pendingBufferedAmountDecrease += size;
    this._scheduleBufferedAmountDecrease();
  }

  _scheduleBufferedAmountDecrease(waitForNativeDrain = false) {
    if (this._bufferedAmountDecreaseScheduled) return;
    this._bufferedAmountDecreaseScheduled = true;
    const run = () => {
      this._bufferedAmountDecreaseScheduled = false;
      this._flushBufferedAmountDecrease();
    };
    if (waitForNativeDrain) {
      setTimeout(run, BUFFERED_AMOUNT_NATIVE_DRAIN_POLL_INTERVAL_MS);
    } else {
      setImmediate(run);
    }
  }

  _flushBufferedAmountDecrease() {
    if (this._pendingBufferedAmountDecrease <= 0) return;
    const nativeBufferedAmount = Number(this._native?.bufferedAmount || 0);
    if (nativeBufferedAmount > 0 && this._readyState !== "closed") {
      this._scheduleBufferedAmountDecrease(true);
      return;
    }
    const amount = this._pendingBufferedAmountDecrease;
    this._pendingBufferedAmountDecrease = 0;
    this._decreaseBufferedAmount(amount);
  }

  _hasPendingSends() {
    return this._pendingSendCount > 0;
  }

  _effectiveId() {
    return this._native.id ?? this._assignedId;
  }

  _assignId(id) {
    if (this._native.id != null || this._assignedId != null) return;
    this._assignedId = id;
    this._pc._registerDataChannelId(this, id);
    if (this._pairedChannel?._syntheticIncoming && this._pairedChannel._effectiveId() == null) {
      this._pairedChannel._assignId(id);
    }
    this._pc._pairedPeer?._scheduleDataChannelAnnouncementRepair();
  }

  _adoptNativeChannel(nativeChannel, initialReadyState = undefined) {
    const previousBindingId = this._native.bindingId;
    if (this._pc._channels.get(previousBindingId) === this) {
      this._pc._channels.delete(previousBindingId);
    }
    this._native = nativeChannel;
    this._syntheticIncoming = false;
    this._pc._channels.set(nativeChannel.bindingId, this);
    if (initialReadyState) {
      this._readyState = initialReadyState;
    } else if (nativeChannel.isOpen) {
      this._readyState = "open";
    } else if (nativeChannel.isClosed) {
      this._readyState = "closed";
    }
    if (this._readyState === "open") this._recordStatsOpened();
    this._pc._registerDataChannelId(this);
  }

  _assertWithinMaxMessageSize(size) {
    const maxMessageSize = this._pc._sctpTransport?._maxMessageSize;
    if (
      maxMessageSize !== null &&
      maxMessageSize !== Number.POSITIVE_INFINITY &&
      size > maxMessageSize
    ) {
      throw new TypeError("RTCDataChannel message exceeds RTCSctpTransport.maxMessageSize");
    }
  }

  _enqueueSend(operation, size) {
    this._pendingSendCount += 1;
    this._bufferedAmount += size;
    const run = async () => {
      try {
        await this._waitForNativeSendReady();
        await this._waitForNativeSendAccepted(operation);
        this._recordSentMessage(size);
      } catch (error) {
        this.dispatchEvent(
          new RTCErrorEvent("error", {
            error: new RTCError(
              { errorDetail: "data-channel-failure" },
              error?.message || String(error),
            ),
          }),
        );
      } finally {
        this._pendingSendCount -= 1;
        this._queueBufferedAmountDecrease(size);
      }
    };
    this._sendTail = this._sendTail.then(run, run);
  }

  _nativeReadyForSend() {
    return this._usesSyntheticPairDelivery() || Boolean(this._native?.isOpen);
  }

  _recordSentMessage(size) {
    this._messagesSent += 1;
    this._bytesSent += size;
  }

  async _waitForNativeSendReady() {
    if (this._nativeReadyForSend()) return;
    const deadline = Date.now() + DATA_CHANNEL_OPEN_REPAIR_TIMEOUT_MS;
    while (!this._nativeReadyForSend() && this._readyState !== "closed" && Date.now() < deadline) {
      await delay(DATA_CHANNEL_OPEN_REPAIR_INTERVAL_MS);
    }
    if (!this._nativeReadyForSend()) {
      throw makeDOMException("RTCDataChannel is not open", "InvalidStateError");
    }
  }

  async _waitForNativeSendAccepted(operation) {
    const deadline = Date.now() + DATA_CHANNEL_OPEN_REPAIR_TIMEOUT_MS;
    while (this._readyState !== "closed" && Date.now() < deadline) {
      if (await operation()) return;
      await delay(DATA_CHANNEL_OPEN_REPAIR_INTERVAL_MS);
      await this._waitForNativeSendReady();
    }
    throw makeDOMException("RTCDataChannel send was not accepted", "OperationError");
  }

  _sendNativeString(data) {
    if (this._usesSyntheticPairDelivery()) {
      this._trackPendingPairedDelivery(byteLength(data));
      this._deliverSyntheticMessage({ binary: false, data });
      return true;
    }
    try {
      let sent = this._native.sendString(data);
      if (sent !== false) {
        sent = true;
      } else {
        sent = Boolean(this._native?.isOpen);
      }
      if (sent && this._pairedChannel) this._pendingPairedDeliveryBytes += byteLength(data);
      return sent;
    } catch (error) {
      throw mapNativeError(error, "OperationError");
    }
  }

  _sendNativeBinary(data) {
    if (this._usesSyntheticPairDelivery()) {
      const view = toUint8Array(data);
      const copy = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
      this._trackPendingPairedDelivery(copy.byteLength);
      this._deliverSyntheticMessage({ binary: true, data: copy });
      return true;
    }
    try {
      const view = data instanceof Uint8Array ? data : toUint8Array(data);
      let sent = this._native.sendBinary(view);
      if (sent !== false) {
        sent = true;
      } else {
        sent = Boolean(this._native?.isOpen);
      }
      if (sent && this._pairedChannel && view.byteLength > 0) {
        this._pendingPairedDeliveryBytes += view.byteLength;
      }
      return sent;
    } catch (error) {
      throw mapNativeError(error, "OperationError");
    }
  }

  _usesSyntheticPairDelivery() {
    return this._syntheticIncoming || this._pairedChannel?._syntheticIncoming;
  }

  _deliverSyntheticMessage(event) {
    const target = this._pairedChannel;
    if (!target || target.readyState === "closed") return;
    setImmediate(() => {
      if (target.readyState === "closed") return;
      target._handleNativeEvent({ type: "message", ...event });
    });
  }

  _trackPendingPairedDelivery(size) {
    if (!this._pairedChannel || size <= 0) return;
    this._pendingPairedDeliveryBytes += size;
  }

  _markPairedDeliveryReceived(event) {
    const sender = this._pairedChannel;
    if (!sender || sender.readyState === "closed") return;
    const size = event.binary ? event.data?.byteLength || 0 : byteLength(event.data || "");
    if (size <= 0) return;
    sender._pendingPairedDeliveryBytes = Math.max(0, sender._pendingPairedDeliveryBytes - size);
    sender._decreaseBufferedAmountForPairedDelivery(size);
  }

  _decreaseBufferedAmountForPairedDelivery(size) {
    const pending = Math.min(size, this._pendingBufferedAmountDecrease);
    if (pending > 0) {
      this._pendingBufferedAmountDecrease -= pending;
    }
    this._decreaseBufferedAmount(size);
  }

  _decreaseBufferedAmount(size) {
    const previous = this._bufferedAmount;
    this._bufferedAmount = Math.max(0, this._bufferedAmount - size);
    if (
      previous > this._bufferedAmountLowThreshold &&
      this._bufferedAmount <= this._bufferedAmountLowThreshold
    ) {
      this.dispatchEvent(makeEvent("bufferedamountlow"));
    }
  }

  _closeNativeAfterBufferedSends(close) {
    const deadline = Date.now() + CLOSE_FLUSH_TIMEOUT_MS;
    const poll = () => {
      const nativeBufferedAmount = Number(this._native?.bufferedAmount || 0);
      const pairedDeliveryDrained = this._pendingPairedDeliveryBytes === 0;
      const nativeBufferDrained = this._bufferedAmount === 0 && nativeBufferedAmount === 0;
      const drained = this._pairedChannel ? pairedDeliveryDrained : nativeBufferDrained;
      if (drained || Date.now() >= deadline) {
        setTimeout(close, CLOSE_FLUSH_DELAY_MS);
        return;
      }
      setTimeout(poll, CLOSE_FLUSH_POLL_INTERVAL_MS);
    };
    poll();
  }

  _handleNativeEvent(event, fromQueue = false) {
    if (!fromQueue && (this._announcementPending || this._nativeEventDrainActive)) {
      if (event.type === "open") {
        this._readyState = "open";
        this._recordStatsOpened();
        this._openEventPending = true;
      } else {
        this._queuedNativeEvents.push(event);
      }
      return;
    }

    switch (event.type) {
      case "open":
        if (this._openEventPending) {
          this._readyState = "open";
          this._recordStatsOpened();
          this._pc._registerDataChannelId(this);
          break;
        }
        if (this._readyState === "connecting" || this._readyState === "open") {
          this._readyState = "open";
          this._recordStatsOpened();
          this._pc._registerDataChannelId(this);
          this._dispatchOpenEvent();
        }
        break;
      case "message":
        this._messagesReceived += 1;
        this._bytesReceived += event.binary
          ? event.data?.byteLength || 0
          : byteLength(event.data || "");
        this._queueMessageEvent(event);
        break;
      case "bufferedamountlow":
        // The JS facade owns W3C bufferedAmount timing; native low-water events
        // use libdatachannel's transport queue and can race the JS-visible counter.
        break;
      case "error":
        this.dispatchEvent(
          new RTCErrorEvent("error", {
            error: new RTCError({ errorDetail: "data-channel-failure" }, event.error || ""),
          }),
        );
        break;
      case "close":
        this._queueNativeCloseEvent();
        break;
    }
  }

  _queueNativeCloseEvent() {
    if (this._nativeCloseEventQueued) return;
    this._nativeCloseEventQueued = true;
    this._deferRemoteCloseUntilMessagesFlushed(() => {
      this._nativeCloseEventQueued = false;
      this._handleNativeCloseEvent();
    });
  }

  _deferRemoteCloseUntilMessagesFlushed(callback) {
    const notBefore = Date.now() + REMOTE_CLOSE_MESSAGE_GRACE_MS;
    const closeAfterMessages = () => {
      if (this._readyState === "closed") return;
      if (
        Date.now() < notBefore ||
        this._messageEventGateActive ||
        this._messageEventFlushScheduled ||
        this._queuedMessageEvents.length > 0
      ) {
        setTimeout(closeAfterMessages, 0);
        return;
      }
      callback();
    };
    setTimeout(closeAfterMessages, 0);
  }

  _handleNativeCloseEvent() {
    if (this._shouldSuppressSpuriousNativeClose()) return;
    if (this._readyState === "open") {
      this._readyState = "closing";
      this.dispatchEvent(makeEvent("closing"));
      setTimeout(() => this._finishRemoteClose(), 0);
    } else {
      this._handleClose();
    }
  }

  _armNativeCloseSuppression() {
    this._nativeCloseSuppressionDeadline = Date.now() + NATIVE_CLOSE_SUPPRESSION_WINDOW_MS;
    this._nativeCloseSuppressionsRemaining = 1;
  }

  _shouldSuppressSpuriousNativeClose() {
    if (
      this._nativeCloseSuppressionsRemaining === 0 ||
      Date.now() > this._nativeCloseSuppressionDeadline
    ) {
      this._nativeCloseSuppressionsRemaining = 0;
      return false;
    }
    const shouldSuppress = Boolean(
      this._pc._pairedPeer &&
        this._pairedChannel &&
        this._readyState === "open" &&
        this._pairedChannel.readyState === "open" &&
        this._pc.connectionState === "connected" &&
        ["connected", "completed"].includes(this._pc.iceConnectionState) &&
        this._pc.sctp?.state === "connected",
    );
    if (shouldSuppress) this._nativeCloseSuppressionsRemaining -= 1;
    return shouldSuppress;
  }

  _finishRemoteClose() {
    if (this._readyState !== "closing") return;
    const peerFailed =
      this._pc.connectionState === "closed" ||
      this._pc.connectionState === "disconnected" ||
      this._pc.connectionState === "failed" ||
      this._pc.iceConnectionState === "closed" ||
      this._pc.iceConnectionState === "disconnected" ||
      this._pc.iceConnectionState === "failed";
    if (peerFailed && this._hasEventConsumer("error") && this._hasEventConsumer("close")) {
      this.dispatchEvent(
        new RTCErrorEvent("error", {
          error: new RTCError(
            {
              name: "OperationError",
              errorDetail: "sctp-failure",
              sctpCauseCode: null,
            },
            "The SCTP association was closed",
          ),
        }),
      );
    }
    this._handleClose();
  }

  _handleRemoteChannelClose() {
    if (this._readyState === "closed") return;
    this._deferRemoteCloseUntilMessagesFlushed(() => {
      if (this._readyState === "closed") return;
      if (this._readyState === "open" || this._readyState === "connecting") {
        this._readyState = "closing";
        this.dispatchEvent(makeEvent("closing"));
        setTimeout(() => this._handleClose(), 0);
        return;
      }
      if (this._readyState === "closing") {
        setTimeout(() => this._handleClose(), 0);
      }
    });
  }

  _handlePeerConnectionFailure() {
    if (this._readyState === "closed") return;
    if (this._readyState === "open") {
      this._readyState = "closing";
    }
    if (this._hasEventConsumer("error") && this._hasEventConsumer("close")) {
      this.dispatchEvent(
        new RTCErrorEvent("error", {
          error: new RTCError(
            {
              name: "OperationError",
              errorDetail: "sctp-failure",
              sctpCauseCode: null,
            },
            "The SCTP association was closed",
          ),
        }),
      );
    }
    this._handleClose();
  }

  _handleClose() {
    if (this._readyState === "closed") return;
    const id = this._effectiveId();
    this._readyState = "closed";
    if (this._statsOpened && !this._statsClosed) {
      this._statsClosed = true;
      this._pc._dataChannelsClosed += 1;
    }
    if (this._pairedChannel?._pairedChannel === this) this._pairedChannel._pairedChannel = null;
    this._pairedChannel = null;
    this._pc._unregisterDataChannelId(this);
    if (this._pc._channels.get(this._native.bindingId) === this) {
      this._pc._channels.delete(this._native.bindingId);
    }
    if (!this._createdLocally && id != null) {
      this._pc._remoteAnnouncedDataChannelIds.delete(id);
      this._pc._pendingSyntheticDataChannelAnnouncements.delete(id);
    }
    this.dispatchEvent(makeEvent("close"));
  }

  _announceOpenAfterDataChannelEvent() {
    if (!this._openEventPending) return;
    this._openEventPending = false;
    setTimeout(() => {
      if (this._readyState === "open") this._dispatchOpenEvent();
    }, 0);
  }

  _dispatchOpenEvent() {
    if (this._openEventDispatched || this._readyState !== "open") return;
    const pendingIcePeer = this._pendingIceEventPeer();
    if (pendingIcePeer) {
      if (this._openEventDeferredForIce) return;
      this._openEventDeferredForIce = true;
      pendingIcePeer._afterDeferredIceEventsFlushed(() => {
        this._openEventDeferredForIce = false;
        this._dispatchOpenEvent();
      });
      return;
    }
    const pendingDataChannelPeer = this._pendingDataChannelAnnouncementPeer();
    if (pendingDataChannelPeer) {
      if (this._openEventDeferredForDataChannel) return;
      this._openEventDeferredForDataChannel = true;
      pendingDataChannelPeer._afterDataChannelAnnouncementSettled(
        this._effectiveId(),
        (settled) => {
          this._openEventDeferredForDataChannel = false;
          if (!settled) this._openEventDataChannelDeferralExpired = true;
          this._dispatchOpenEvent();
        },
      );
      return;
    }
    this._openEventDispatched = true;
    this._recordStatsOpened();
    this.dispatchEvent(makeEvent("open"));
  }

  _recordStatsOpened() {
    if (!this._statsOpened) {
      this._statsOpened = true;
      this._pc._dataChannelsOpened += 1;
    }
  }

  _pendingIceEventPeer() {
    const peers = [this._pc, this._pc._pairedPeer].filter(Boolean);
    return peers.find((peer) => peer._hasPendingDeferredIceEvents());
  }

  _pendingDataChannelAnnouncementPeer() {
    if (this._openEventDataChannelDeferralExpired) return null;
    if (!this._createdLocally || this.negotiated) return null;
    const id = this._effectiveId();
    const peer = this._pc._pairedPeer;
    if (!peer || peer._closed || id == null || !peer._hasEventConsumer("datachannel")) return null;
    return peer._hasSettledDataChannelAnnouncement(id) ? null : peer;
  }

  _repairMissedOpenEvent() {
    if (this._readyState !== "connecting" || this._native.isClosed || !this._native.isOpen)
      return false;
    this._readyState = "open";
    this._recordStatsOpened();
    this._pc._registerDataChannelId(this);
    if (this._announcementPending) {
      this._openEventPending = true;
    } else {
      this._dispatchOpenEvent();
    }
    return true;
  }

  _flushQueuedNativeEventsAfterAnnouncement() {
    if (!this._queuedNativeEvents.length) return;
    this._nativeEventDrainActive = true;
    const dispatchNext = () => {
      const event = this._queuedNativeEvents.shift();
      if (!event) {
        this._nativeEventDrainActive = false;
        return;
      }
      this._handleNativeEvent(event, true);
      if (this._queuedNativeEvents.length) setImmediate(dispatchNext);
      else this._nativeEventDrainActive = false;
    };
    setImmediate(dispatchNext);
  }

  _queueMessageEvent(event) {
    this._queuedMessageEvents.push(event);
    this._scheduleMessageEventFlush();
  }

  _queueMessageEvents(events) {
    for (const event of events) this._queuedMessageEvents.push(event);
    this._scheduleMessageEventFlush();
  }

  _scheduleMessageEventFlush() {
    if (this._messageEventFlushScheduled) return;
    this._messageEventFlushScheduled = true;
    setImmediate(() => {
      this._messageEventFlushScheduled = false;
      this._flushQueuedMessageEvents();
    });
  }

  _scheduleMessageEventContinuation({ yieldToTask = false } = {}) {
    if (this._messageEventFlushScheduled) return;
    this._messageEventFlushScheduled = true;
    const schedule = yieldToTask ? setTimeout : setImmediate;
    schedule(
      () => {
        this._messageEventFlushScheduled = false;
        this._flushQueuedMessageEvents();
      },
      yieldToTask ? 1 : 0,
    );
  }

  _messageContinuationNeedsTaskYield(handler = this._onmessage) {
    if (typeof handler !== "function") return false;
    try {
      return /\[native code\]/.test(Function.prototype.toString.call(handler));
    } catch {
      return false;
    }
  }

  _hasMessageEventListeners() {
    return this._messageEventListenerCount > 0;
  }

  _canContinueMessageBatchInCurrentTask(handler, yieldToTask) {
    return (
      typeof handler === "function" &&
      handler instanceof Function &&
      this._onmessage === handler &&
      !yieldToTask &&
      !this._hasMessageEventListeners()
    );
  }

  _canUseDirectMessageHandler(handler, yieldToTask, hasMessageListeners) {
    return !hasMessageListeners && this._canContinueMessageBatchInCurrentTask(handler, yieldToTask);
  }

  _dispatchMessageEvent(event, directHandler) {
    const messageEvent = makeMessageEvent("message", { data: this._convertMessage(event) });
    if (directHandler) {
      messageEvent.target = this;
      messageEvent.currentTarget = this;
      callListener(directHandler, this, messageEvent);
    } else {
      this.dispatchEvent(messageEvent);
    }
  }

  _flushQueuedMessageEvents() {
    while (true) {
      if (this._readyState === "closed") {
        this._queuedMessageEvents.length = 0;
        this._queuedMessageEventIndex = 0;
        return;
      }

      const pendingPeer =
        this._pc._operationsPending > 0
          ? this._pc
          : this._pc._pairedPeer?._operationsPending > 0
            ? this._pc._pairedPeer
            : null;
      if (pendingPeer) {
        pendingPeer._afterOperationsIdle(() => this._scheduleMessageEventFlush());
        return;
      }

      if (this._messageEventGateActive) return;
      if (this._messageConsumerGateActive && !this._hasEventConsumer("message")) return;
      if (this._messageConsumerGateActive) this._messageConsumerGateActive = false;

      const event = this._queuedMessageEvents[this._queuedMessageEventIndex++];
      if (!event) {
        this._queuedMessageEventIndex = 0;
        return;
      }
      const handler = this._onmessage;
      const hasMessageListeners = this._hasMessageEventListeners();
      const yieldToTask = this._messageHandlerNeedsTaskYield;
      const directHandler = this._canUseDirectMessageHandler(
        handler,
        yieldToTask,
        hasMessageListeners,
      )
        ? handler
        : null;
      this._markPairedDeliveryReceived(event);
      this._dispatchMessageEvent(event, directHandler);

      if (this._queuedMessageEventIndex >= this._queuedMessageEvents.length) {
        this._queuedMessageEvents.length = 0;
        this._queuedMessageEventIndex = 0;
        return;
      }
      if (this._queuedMessageEventIndex > 1024) {
        this._queuedMessageEvents.splice(0, this._queuedMessageEventIndex);
        this._queuedMessageEventIndex = 0;
      }
      if (!this._canContinueMessageBatchInCurrentTask(handler, yieldToTask)) {
        this._scheduleMessageEventContinuation({ yieldToTask });
        return;
      }
    }
  }

  _dispatchNativeMessageBatch(events) {
    if (this._readyState === "closed") return true;
    if (this._queuedMessageEvents.length > 0) return false;
    const pendingPeer =
      this._pc._operationsPending > 0
        ? this._pc
        : this._pc._pairedPeer?._operationsPending > 0
          ? this._pc._pairedPeer
          : null;
    if (pendingPeer || this._messageEventGateActive) return false;
    if (this._messageConsumerGateActive && !this._hasEventConsumer("message")) return false;
    if (this._messageConsumerGateActive) this._messageConsumerGateActive = false;

    const handler = this._onmessage;
    const hasMessageListeners = this._hasMessageEventListeners();
    const yieldToTask = this._messageHandlerNeedsTaskYield;
    const directHandler = this._canUseDirectMessageHandler(
      handler,
      yieldToTask,
      hasMessageListeners,
    )
      ? handler
      : null;
    if (!directHandler) return false;

    const shouldCreateBlob = this._binaryType === "blob" && typeof Blob !== "undefined";
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      this._markPairedDeliveryReceived(event);
      const messageEvent = makeMessageEvent("message", {
        data: event.binary && shouldCreateBlob ? new Blob([event.data]) : event.data,
      });
      messageEvent.target = this;
      messageEvent.currentTarget = this;
      directHandler.call(this, messageEvent);
      if (this._readyState === "closed") return true;
      if (
        index + 1 < events.length &&
        !this._canContinueMessageBatchInCurrentTask(handler, yieldToTask)
      ) {
        for (let remaining = index + 1; remaining < events.length; remaining += 1) {
          this._queuedMessageEvents.push(events[remaining]);
        }
        this._scheduleMessageEventContinuation({ yieldToTask: this._messageHandlerNeedsTaskYield });
        return true;
      }
    }
    return true;
  }

  _gateMessageEventsAfterAnnouncement() {
    if (this._messageEventGateActive) return;
    this._messageEventGateActive = true;
    setTimeout(() => {
      setTimeout(() => {
        this._messageEventGateActive = false;
        this._scheduleMessageEventFlush();
      }, 0);
    }, 0);
  }

  _gateMessageEventsUntilConsumer() {
    if (this._hasEventConsumer("message")) return;
    this._messageConsumerGateActive = true;
    setTimeout(() => this._releaseMessageConsumerGate(), MESSAGE_CONSUMER_GATE_TIMEOUT_MS);
  }

  _releaseMessageConsumerGate() {
    if (!this._messageConsumerGateActive) return;
    this._messageConsumerGateActive = false;
    this._scheduleMessageEventFlush();
  }

  _eventListenerAdded(type) {
    if (type !== "message") return;
    this._messageEventListenerCount += 1;
    this._releaseMessageConsumerGate();
  }

  _eventListenerRemoved(type) {
    if (type === "message" && this._messageEventListenerCount > 0) {
      this._messageEventListenerCount -= 1;
    }
  }

  _convertMessage(event) {
    if (!event.binary) return event.data;
    if (this._binaryType === "blob" && typeof Blob !== "undefined") {
      return new Blob([event.data]);
    }
    return event.data;
  }
}

function toUint8Array(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  throw new TypeError(
    "RTCDataChannel.send expects a string, Blob, ArrayBuffer, or ArrayBufferView",
  );
}

class MediaStreamTrack extends SimpleEventTarget {
  constructor(token, init) {
    super();
    if (token !== kInternalConstruct) throw new TypeError("Illegal constructor");
    this._kind = init.kind;
    this._id = init.id || crypto.randomUUID();
    this._label = init.label || "";
    this._enabled = true;
    this._muted = Boolean(init.muted);
    this._readyState = "live";
    this._contentHint = "";
    this.onended = null;
    this.onmute = null;
    this.onunmute = null;
    registerMediaTrackSource(this, init.source || null);
  }

  get kind() {
    return this._kind;
  }
  get id() {
    return this._id;
  }
  get label() {
    return this._label;
  }
  get enabled() {
    return this._enabled;
  }
  set enabled(value) {
    this._enabled = Boolean(value);
  }
  get muted() {
    return this._muted;
  }
  get readyState() {
    return this._readyState;
  }
  get contentHint() {
    return this._contentHint;
  }
  set contentHint(value) {
    this._contentHint = String(value);
  }

  clone() {
    const clone = new MediaStreamTrack(kInternalConstruct, {
      kind: this._kind,
      label: this._label,
      source: mediaTrackSources.get(this),
      muted: this._muted,
    });
    clone._enabled = this._enabled;
    clone._contentHint = this._contentHint;
    if (this._readyState === "ended") clone._readyState = "ended";
    return clone;
  }

  stop() {
    if (this._readyState === "ended") return;
    this._readyState = "ended";
    const source = mediaTrackSources.get(this);
    if (!hasOtherLiveSourceTrack(source, this)) source?.stop?.(this);
    notifyTrackStateChanged(this);
  }

  getCapabilities() {
    return {};
  }
  getConstraints() {
    return {};
  }
  getSettings() {
    return {};
  }
  applyConstraints() {
    return Promise.resolve();
  }
}

class MediaStreamTrackEvent extends SimpleEvent {
  constructor(type, init) {
    super(type, init);
    if (!init || !(init.track instanceof MediaStreamTrack)) {
      throw new TypeError("MediaStreamTrackEvent requires a MediaStreamTrack");
    }
    this.track = init.track;
  }
}

class MediaStream extends SimpleEventTarget {
  constructor(tracks = []) {
    super();
    this._id = crypto.randomUUID();
    this._tracks = [];
    this._active = false;
    this.onactive = null;
    this.oninactive = null;
    this.onaddtrack = null;
    this.onremovetrack = null;
    const initialTracks = tracks instanceof MediaStream ? tracks.getTracks() : Array.from(tracks);
    for (const track of initialTracks) this._addTrack(track, false, false);
    this._active = this._tracks.some((track) => track.readyState === "live");
  }

  get id() {
    return this._id;
  }
  get active() {
    return this._active;
  }
  getTracks() {
    return [...this._tracks];
  }
  getAudioTracks() {
    return this._tracks.filter((track) => track.kind === "audio");
  }
  getVideoTracks() {
    return this._tracks.filter((track) => track.kind === "video");
  }
  getTrackById(id) {
    return this._tracks.find((track) => track.id === String(id)) || null;
  }

  addTrack(track) {
    this._addTrack(track, false);
  }

  _addTrack(track, dispatch, updateActive = true) {
    if (!(track instanceof MediaStreamTrack))
      throw new TypeError("track must be a MediaStreamTrack");
    if (this._tracks.includes(track)) return;
    this._tracks.push(track);
    let streams = mediaTrackStreams.get(track);
    if (!streams) {
      streams = new Set();
      mediaTrackStreams.set(track, streams);
    }
    streams.add(this);
    if (updateActive) this._updateActiveState();
    if (dispatch) this.dispatchEvent(new MediaStreamTrackEvent("addtrack", { track }));
  }

  removeTrack(track) {
    this._removeTrack(track, false);
  }

  _removeTrack(track, dispatch) {
    if (!(track instanceof MediaStreamTrack))
      throw new TypeError("track must be a MediaStreamTrack");
    const index = this._tracks.indexOf(track);
    if (index === -1) return;
    this._tracks.splice(index, 1);
    mediaTrackStreams.get(track)?.delete(this);
    this._updateActiveState();
    if (dispatch) this.dispatchEvent(new MediaStreamTrackEvent("removetrack", { track }));
  }

  _updateActiveState() {
    const active = this._tracks.some((track) => track.readyState === "live");
    if (active === this._active) return;
    this._active = active;
    this.dispatchEvent(makeEvent(active ? "active" : "inactive"));
  }

  clone() {
    return new MediaStream(this._tracks.map((track) => track.clone()));
  }
}

const encodedMediaCodecs = new Map([
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

function normalizeEncodedMediaInit(init) {
  if (init == null || typeof init !== "object") throw new TypeError("init must be an object");
  const kind = String(init.kind || "").toLowerCase();
  if (kind !== "audio" && kind !== "video") throw new TypeError("kind must be audio or video");
  const mimeType = String(init.codec?.mimeType || "").toLowerCase();
  const codec = encodedMediaCodecs.get(mimeType);
  if (!codec || !mimeType.startsWith(`${kind}/`)) throw new TypeError(`Unsupported ${kind} codec`);
  const payloadType = Number(init.codec?.payloadType);
  if (!Number.isInteger(payloadType) || payloadType < 0 || payloadType > 127) {
    throw new RangeError("payloadType must be an integer between 0 and 127");
  }
  const profile = init.codec.profile === undefined ? undefined : String(init.codec.profile);
  if (profile && /[\r\n]/u.test(profile)) {
    throw new TypeError("codec profile must not contain lines");
  }
  let ssrc;
  if (init.ssrc !== undefined) {
    ssrc = Number(init.ssrc);
    if (!Number.isInteger(ssrc) || ssrc < 1 || ssrc > 0xffffffff) {
      throw new RangeError("ssrc must be an integer between 1 and 4294967295");
    }
  }
  const capability = rtpCodecCapabilities[kind].find(
    (entry) => entry.mimeType.toLowerCase() === mimeType,
  );
  return {
    kind,
    mimeType,
    codec,
    payloadType,
    profile,
    ssrc,
    clockRate: capability.clockRate,
    channels: capability.channels,
  };
}

class EncodedMediaSource extends SimpleEventTarget {
  constructor(init) {
    super();
    const normalized = normalizeEncodedMediaInit(init);
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
    this._closed = false;
    this._source = {
      codec: {
        mimeType: normalized.mimeType,
        codec: normalized.codec,
        payloadType: normalized.payloadType,
        profile: normalized.profile,
        clockRate: normalized.clockRate,
        channels: normalized.channels,
      },
      ssrc: normalized.ssrc,
      nativeTracks: new Set(),
      _attachNativeTrack: (nativeTrack) => {
        if (this._closed) return;
        this._source.nativeTracks.add(nativeTrack);
        this._refreshReadyState();
      },
      _detachNativeTrack: (nativeTrack) => {
        if (!this._source.nativeTracks.delete(nativeTrack)) return;
        this._refreshReadyState();
      },
      _handleNativeEvent: (event, nativeTrack) => this._handleNativeEvent(event, nativeTrack),
      stop: () => this.close(),
    };
    this.track = new MediaStreamTrack(kInternalConstruct, {
      kind: normalized.kind,
      label: init.label === undefined ? `encoded ${normalized.kind}` : String(init.label),
      source: this._source,
    });
  }

  _refreshReadyState() {
    if (this._closed) {
      this.readyState = "closed";
      return;
    }
    let hasBinding = false;
    let hasOpenBinding = false;
    for (const nativeTrack of this._source.nativeTracks) {
      if (nativeTrack.isClosed) {
        this._source.nativeTracks.delete(nativeTrack);
        continue;
      }
      hasBinding = true;
      if (nativeTrack.isOpen) hasOpenBinding = true;
    }
    this.readyState = hasOpenBinding ? "open" : hasBinding ? "connecting" : "new";
  }

  _handleNativeEvent(event, nativeTrack) {
    if (this._closed || !this._source.nativeTracks.has(nativeTrack)) return;
    if (event.type === "close") {
      this._source.nativeTracks.delete(nativeTrack);
      this._refreshReadyState();
      return;
    }
    const wasOpen = this.readyState === "open";
    if (event.type === "open") this._refreshReadyState();
    if (event.type === "open" && (wasOpen || this.readyState !== "open")) return;
    const dispatched = new SimpleEvent(event.type);
    if (event.type === "error") dispatched.message = event.error || "Media track error";
    this.dispatchEvent(dispatched);
  }

  send(packet) {
    if (this._closed) throw new Error("EncodedMediaSource is closed");
    const nativeTracks = [...this._source.nativeTracks];
    if (nativeTracks.length === 0) {
      throw makeDOMException("Track is not attached to an RTP sender", "InvalidStateError");
    }
    const bytes = toUint8Array(packet);
    let sent = false;
    for (const nativeTrack of nativeTracks) {
      if (nativeTrack.isClosed) {
        this._source.nativeTracks.delete(nativeTrack);
        continue;
      }
      if (!nativeTrack.isOpen) continue;
      try {
        sent = nativeTrack.send(bytes) || sent;
      } catch (error) {
        if (!/^Track is (?:not open|closed)$/u.test(String(error?.message))) throw error;
        if (nativeTrack.isClosed) this._source.nativeTracks.delete(nativeTrack);
      }
    }
    this._refreshReadyState();
    return sent;
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    this._source.nativeTracks.clear();
    this.readyState = "closed";
    this._source._endTracks?.();
    this.dispatchEvent(new SimpleEvent("close"));
  }

  get maxPacketSize() {
    const limits = [...this._source.nativeTracks]
      .filter((nativeTrack) => !nativeTrack.isClosed)
      .map((nativeTrack) => nativeTrack.maxMessageSize)
      .filter((limit) => Number.isFinite(limit));
    return limits.length === 0 ? null : Math.min(...limits);
  }
}

class EncodedMediaSink extends SimpleEventTarget {
  constructor(track) {
    super();
    if (!(track instanceof MediaStreamTrack)) {
      throw new TypeError("track must be a MediaStreamTrack");
    }
    const source = mediaTrackSources.get(track);
    if (!source?.listeners) {
      throw makeDOMException("Track is not an encoded RTP receiver", "InvalidStateError");
    }
    this.track = track;
    this.onpacket = null;
    const listener = (packet) => {
      this.dispatchEvent(new SimpleMessageEvent("packet", { data: packet }));
    };
    source.listeners.add(listener);
    this._unsubscribe = () => source.listeners.delete(listener);
  }

  close() {
    this._unsubscribe?.();
    this._unsubscribe = null;
  }
}

class RTCRtpSender {
  static getCapabilities(kind) {
    return getRtpCapabilities(kind);
  }

  constructor(token, peerConnection, track, streams) {
    if (token !== kInternalConstruct) throw new TypeError("Illegal constructor");
    this._peerConnection = peerConnection;
    this._track = track;
    this._streams = [...streams];
    this._lastReturnedParameters = null;
  }
  get track() {
    return this._track;
  }
  get transport() {
    return this._transceiver._nativeSendTrack || this._transceiver._nativeReceiveTrack
      ? this._peerConnection._dtlsTransport
      : null;
  }
  getParameters() {
    if (this._lastReturnedParameters === null) {
      const parameters = senderRtpParameters(this._transceiver, crypto.randomUUID());
      this._lastReturnedParameters = parameters;
      queueWebRtcTask(() => {
        if (this._lastReturnedParameters === parameters) this._lastReturnedParameters = null;
      });
    }
    return cloneRtpSendParameters(this._lastReturnedParameters);
  }
  setParameters(parameters, setParameterOptions = {}) {
    let normalized;
    try {
      normalized = normalizeRtpSendParameters(parameters, this._transceiver._kind);
      if (
        setParameterOptions != null &&
        typeof setParameterOptions !== "object" &&
        typeof setParameterOptions !== "function"
      ) {
        throw new TypeError("setParameterOptions must be an object");
      }
    } catch (error) {
      return Promise.reject(error);
    }
    const transceiver = this._transceiver;
    if (transceiver.stopping || transceiver.stopped) {
      return Promise.reject(makeDOMException("Transceiver is stopping", "InvalidStateError"));
    }
    const lastReturned = this._lastReturnedParameters;
    if (lastReturned === null) {
      return Promise.reject(
        makeDOMException("getParameters() was not called in this task", "InvalidStateError"),
      );
    }
    if (hasModifiedReadOnlyRtpParameters(normalized, lastReturned)) {
      return Promise.reject(
        makeDOMException("Read-only RTP parameters were modified", "InvalidModificationError"),
      );
    }
    try {
      validateSupportedSenderParameters(transceiver, normalized);
    } catch (error) {
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      queueWebRtcTask(() => {
        try {
          transceiver._sendEncodings = normalized.encodings.map((encoding) => ({ ...encoding }));
          transceiver._nativeSendTrack?.setActive(
            transceiver._sendEncodings.some((encoding) => encoding.active),
          );
          if (this._lastReturnedParameters === lastReturned) {
            this._lastReturnedParameters = null;
          }
          resolve();
        } catch (error) {
          reject(mapNativeError(error));
        }
      });
    });
  }
  replaceTrack(track) {
    if (track !== null && !(track instanceof MediaStreamTrack)) {
      return Promise.reject(new TypeError("track must be a MediaStreamTrack or null"));
    }
    if (track && track.kind !== this._transceiver._kind) {
      return Promise.reject(new TypeError("track kind does not match the sender"));
    }
    return this._peerConnection._replaceSenderTrackOnOperationsChain(this, track);
  }
  setStreams(...streams) {
    if (this._peerConnection._closed) {
      throw makeDOMException("RTCPeerConnection is closed", "InvalidStateError");
    }
    for (const stream of streams)
      if (!(stream instanceof MediaStream)) throw new TypeError("stream must be a MediaStream");
    const nextStreams = [...new Set(streams)];
    if (
      nextStreams.length === this._streams.length &&
      nextStreams.every((stream) => this._streams.includes(stream))
    ) {
      return;
    }
    this._streams = nextStreams;
    this._peerConnection._markNegotiationNeeded();
  }
  getStats() {
    return this._peerConnection.getStats(this);
  }
}

class RTCRtpReceiver {
  static getCapabilities(kind) {
    return getRtpCapabilities(kind);
  }

  constructor(token, peerConnection, kind) {
    if (token !== kInternalConstruct) throw new TypeError("Illegal constructor");
    this._peerConnection = peerConnection;
    this._track = new MediaStreamTrack(kInternalConstruct, {
      kind,
      label: `remote ${kind}`,
      muted: true,
    });
    this._synchronizationSources = new Map();
    this._contributingSources = new Map();
  }
  get track() {
    return this._track;
  }
  get transport() {
    return this._transceiver._nativeReceiveTrack || this._transceiver._nativeSendTrack
      ? this._peerConnection._dtlsTransport
      : null;
  }
  getParameters() {
    return receiverRtpParameters(this._transceiver);
  }
  getContributingSources() {
    return currentRtpSources(this._contributingSources);
  }
  getSynchronizationSources() {
    return currentRtpSources(this._synchronizationSources);
  }
  _handleRtpPacket(data) {
    const extensionIds = new Map(
      this.getParameters().headerExtensions.map(({ uri, id }) => [uri, id]),
    );
    const sources = parseRtpSourcePacket(data, this._track.kind, extensionIds);
    if (!sources) return;
    const timestamp = performance.timeOrigin + performance.now();
    updateRtpSource(this._synchronizationSources, sources.synchronizationSource, timestamp);
    for (const source of sources.contributingSources) {
      updateRtpSource(this._contributingSources, source, timestamp);
    }
  }
  getStats() {
    return this._peerConnection.getStats(this);
  }
}

const rtpDirections = ["sendrecv", "sendonly", "recvonly", "inactive"];

class RTCRtpTransceiver {
  constructor(token, peerConnection, kind, track, direction, streams, sendEncodings = []) {
    if (token !== kInternalConstruct) throw new TypeError("Illegal constructor");
    this._peerConnection = peerConnection;
    this._kind = kind;
    this._mid = null;
    this._nativeMid = null;
    this._midAssignedByPendingLocalOffer = false;
    this._direction = direction;
    this._currentDirection = null;
    this._stopping = false;
    this._stopped = false;
    this._hasEverSent = false;
    this._nativeSendTrack = null;
    this._nativeReceiveTrack = null;
    this._nativeAnnouncedReceiveTrack = null;
    this._nativeReceiveTracks = new Set();
    this._createdByAddTrack = false;
    this._preferredCodecs = [];
    this._codecPayloadTypes = new Map();
    this._sendEncodings =
      sendEncodings.length > 0
        ? sendEncodings
        : [kind === "video" ? { active: true, scaleResolutionDownBy: 1 } : { active: true }];
    this._senderTrackId = track?.id || crypto.randomUUID();
    this._sender = new RTCRtpSender(kInternalConstruct, peerConnection, track, streams);
    this._receiver = new RTCRtpReceiver(kInternalConstruct, peerConnection, kind);
    this._sender._transceiver = this;
    this._receiver._transceiver = this;
  }
  get mid() {
    return this._mid;
  }
  get sender() {
    return this._sender;
  }
  get receiver() {
    return this._receiver;
  }
  get stopped() {
    return this._stopped;
  }
  get stopping() {
    return this._stopping;
  }
  get direction() {
    return this._stopping || this._remoteStopping || this._stopped ? "stopped" : this._direction;
  }
  set direction(value) {
    if (!rtpDirections.includes(value)) throw new TypeError("Invalid RTCRtpTransceiver direction");
    if (this._stopping || this._stopped)
      throw makeDOMException("Transceiver is stopping", "InvalidStateError");
    if (value === this._direction) return;
    this._direction = value;
    this._peerConnection._markNegotiationNeeded();
  }
  get currentDirection() {
    return this._currentDirection;
  }
  stop() {
    if (this._stopping || this._stopped) return;
    this._peerConnection._detachSenderSource(this._sender);
    this._stopping = true;
    this._peerConnection._queueReceiverTrackEnded(this);
    this._peerConnection._markNegotiationNeeded();
  }
  setCodecPreferences(codecs) {
    this._preferredCodecs = normalizeCodecPreferences(this._kind, codecs);
  }
}

class RTCStatsReport {
  constructor(token) {
    if (token !== kInternalConstruct) throw new TypeError("Illegal constructor");
    this._data = new Map();
  }
  get size() {
    return this._data.size;
  }
  get(id) {
    return this._data.get(id);
  }
  has(id) {
    return this._data.has(id);
  }
  keys() {
    return this._data.keys();
  }
  values() {
    return this._data.values();
  }
  entries() {
    return this._data.entries();
  }
  forEach(callback, thisArg = undefined) {
    this._data.forEach((value, key) => {
      callback.call(thisArg, value, key, this);
    });
  }
  [Symbol.iterator]() {
    return this.entries();
  }
  _set(stat) {
    this._data.set(stat.id, Object.freeze(stat));
  }
}

class RTCTrackEvent extends SimpleEvent {
  constructor(type, init) {
    super(type, init);
    if (!init || !init.receiver || !init.track || !init.transceiver) {
      throw new TypeError("receiver, track, and transceiver are required");
    }
    this.receiver = init.receiver;
    this.track = init.track;
    this.streams = Object.freeze(Array.from(init.streams || []));
    this.transceiver = init.transceiver;
  }
}

class RTCPeerConnection extends SimpleEventTarget {
  static generateCertificate(algorithm) {
    return generateCertificate(algorithm);
  }

  constructor(configuration = {}) {
    super();
    const normalizedConfiguration = normalizePeerConnectionConfiguration(configuration);
    this._configuration = normalizedConfiguration;
    this._rtcpCname = crypto.randomUUID();
    this._channels = new Map();
    this._transceivers = [];
    this._nativeMediaTracks = new Map();
    this._usedDataChannelIds = new Map();
    this._dataChannelIdRefreshNeeded = false;
    this._closed = false;
    this._localDescription = null;
    this._remoteDescription = null;
    this._currentLocalDescription = null;
    this._pendingLocalDescription = null;
    this._currentRemoteDescription = null;
    this._pendingRemoteDescription = null;
    this._localDescriptionPairingKeys = new Set();
    this._pairedPeer = null;
    this._sctpTransport = null;
    this._dtlsTransport = null;
    this._canTrickleIceCandidates = null;
    this._selfRemoteDescription = false;
    this._pendingIce = [];
    this._localIceCandidates = [];
    this._remoteIceCandidates = [];
    this._pendingRemoteCandidatesForNative = [];
    this._deferredIceEvents = [];
    this._iceEventFlushScheduled = false;
    this._processingDeferredIceEvent = false;
    this._iceEventIdleCallbacks = [];
    this._iceRole = "unknown";
    this._preparedLocalDescription = null;
    this._nonstandardPreparedLocalDescriptionType = null;
    this._nonstandardLocalIceCredentials = null;
    this._nonstandardConfiguration = {
      enableIceUdpMux: false,
      disableFingerprintVerification: false,
      maxMessageSize: undefined,
    };
    this._lastCreatedOffer = null;
    this._lastCreatedAnswer = null;
    this._localMediaDirectionTemplate = null;
    this._localDescriptionSetByApi = false;
    this._localDescriptionRefreshScheduled = false;
    this._nativeCandidateGatheringScheduled = false;
    this._iceRestartPending = false;
    this._pendingIceRestartCredentials = null;
    this._jsOnlyIceRestartOfferPending = false;
    this._jsOnlyIceRestartRemoteOffer = false;
    this._operationTail = Promise.resolve();
    this._operationsPending = 0;
    this._operationIdleCallbacks = [];
    this._explicitIceCandidateExchange = false;
    this._sameProcessIceCandidateExchange = false;
    this._suppressNextNativeSignalingState = null;
    this._sctpTransportUpdateScheduled = false;
    this._sctpConnectedTransitionScheduled = false;
    this._sctpConnectedTransitionReady = false;
    this._sctpConnectPollScheduled = false;
    this._sctpConnectPollDeadline = 0;
    this._connectedStateRepairScheduled = false;
    this._dataChannelOpenRepairScheduled = false;
    this._dataChannelOpenRepairDeadline = 0;
    this._dataChannelAnnouncementRepairScheduled = false;
    this._dataChannelAnnouncementRepairReadyAt = 0;
    this._dataChannelAnnouncementRepairDeadline = 0;
    this._remoteAnnouncedDataChannelIds = new Set();
    this._pendingSyntheticDataChannelAnnouncements = new Map();
    this._pendingTrackEventTasks = new Set();
    this._localDataChannelCount = 0;
    this._dataChannelsOpened = 0;
    this._dataChannelsClosed = 0;
    this._remoteMediaStreams = new Map();
    this._negotiationNeeded = false;
    this._negotiationNeededScheduled = false;
    this._negotiationRevision = 0;
    this._negotiatedRevision = 0;
    this._pendingLocalNegotiationRevision = null;
    this._lastCreatedOfferRevision = null;
    this._lastCreatedAnswerRevision = null;
    this._ondatachannel = null;
    this.ontrack = null;
    this._pendingDataChannelEvents = [];
    this._pendingNativeDataChannelEvents = new Map();
    this._dataChannelFlushScheduled = false;
    this.onicecandidate = null;
    this.onicecandidateerror = null;
    this.onicegatheringstatechange = null;
    this.oniceconnectionstatechange = null;
    this.onconnectionstatechange = null;
    this.onsignalingstatechange = null;
    this.onnegotiationneeded = null;
    this._connectionState = "new";
    this._iceConnectionState = "new";
    this._iceGatheringState = "new";
    this._signalingState = "stable";
    this._lastDispatchedSignalingState = "stable";
    this._native = null;
    this._nativeCertificates = null;
  }

  getConfiguration() {
    return cloneConfiguration(this._configuration);
  }

  _ensureNativePeerConnection() {
    if (this._native) return this._native;
    const nativeConfiguration = {
      iceServers: this._configuration.iceServers.map((server) => ({
        ...server,
        urls: [...server.urls],
      })),
      iceTransportPolicy: this._configuration.iceTransportPolicy,
      ...this._nonstandardConfiguration,
    };
    let nativeCertificates = this._configuration.certificates;
    if (nativeCertificates.length === 0) {
      nativeCertificates = [createDefaultNativeCertificate()];
    }
    const material = getCertificateMaterial(nativeCertificates[0]);
    if (material) {
      nativeConfiguration.certificatePem = material.certificatePem;
      nativeConfiguration.keyPem = material.keyPem;
    }
    const weakPeerConnection = new WeakRef(this);
    const nativePeerConnection = new native.NativePeerConnection(nativeConfiguration, (event) => {
      const peerConnection = weakPeerConnection.deref();
      if (!peerConnection) {
        try {
          event?.channel?.close?.();
          event?.track?.close?.();
        } catch {
          // Native ownership cleanup remains responsible for late event payloads.
        }
        return;
      }
      if (Array.isArray(event)) {
        peerConnection._handleNativeEventBatch(event);
      } else {
        peerConnection._handleNativeEvent(event);
      }
    });
    this._nativeCertificates = nativeCertificates;
    this._native = nativePeerConnection;
    return this._native;
  }

  setConfiguration(configuration = {}) {
    this._assertNotClosed();
    const hasCertificates =
      configuration &&
      typeof configuration === "object" &&
      Object.hasOwn(configuration, "certificates");
    const normalizedConfiguration = normalizePeerConnectionConfiguration(configuration);
    if (!hasCertificates) normalizedConfiguration.certificates = this._configuration.certificates;
    if (normalizedConfiguration.bundlePolicy !== this._configuration.bundlePolicy) {
      throw makeDOMException("bundlePolicy cannot be changed", "InvalidModificationError");
    }
    if (normalizedConfiguration.rtcpMuxPolicy !== this._configuration.rtcpMuxPolicy) {
      throw makeDOMException("rtcpMuxPolicy cannot be changed", "InvalidModificationError");
    }
    if (
      !sameCertificateSet(normalizedConfiguration.certificates, this._configuration.certificates)
    ) {
      throw makeDOMException("certificates cannot be changed", "InvalidModificationError");
    }
    this._configuration = normalizedConfiguration;
  }

  addTrack(track, ...streams) {
    this._assertNotClosed();
    if (!(track instanceof MediaStreamTrack))
      throw new TypeError("track must be a MediaStreamTrack");
    for (const stream of streams)
      if (!(stream instanceof MediaStream)) throw new TypeError("stream must be a MediaStream");
    if (this.getSenders().some((sender) => sender.track === track)) {
      throw makeDOMException("Track is already being sent", "InvalidAccessError");
    }
    let transceiver = this._transceivers.find(
      (candidate) =>
        !candidate.stopped &&
        !candidate.stopping &&
        candidate._kind === track.kind &&
        candidate.sender.track === null &&
        !candidate._hasEverSent,
    );
    if (transceiver) {
      this._assertTrackCompatibleWithTransceiver(transceiver, track);
      transceiver.sender._track = track;
      if (!transceiver._hasEverSent) transceiver._senderTrackId = track.id;
      transceiver.sender._streams = [...new Set(streams)];
      if (transceiver._nativeSendTrack) {
        mediaTrackSources.get(track)?._attachNativeTrack?.(transceiver._nativeSendTrack);
      }
      if (transceiver.direction === "recvonly") transceiver._direction = "sendrecv";
      else if (transceiver.direction === "inactive") transceiver._direction = "sendonly";
    } else {
      transceiver = this._createTransceiver(track.kind, track, "sendrecv", streams);
      transceiver._createdByAddTrack = true;
    }
    this._markNegotiationNeeded();
    return transceiver.sender;
  }

  removeTrack(sender) {
    this._assertNotClosed();
    if (!(sender instanceof RTCRtpSender)) throw new TypeError("sender must be an RTCRtpSender");
    if (sender._peerConnection !== this) {
      throw makeDOMException("sender is owned by another RTCPeerConnection", "InvalidAccessError");
    }
    const transceiver = sender._transceiver;
    if (transceiver.stopped || transceiver.stopping || sender.track === null) return;
    this._detachSenderSource(sender);
    sender._track = null;
    if (transceiver.direction === "sendrecv") transceiver._direction = "recvonly";
    else if (transceiver.direction === "sendonly") transceiver._direction = "inactive";
    this._markNegotiationNeeded();
  }

  addTransceiver(trackOrKind, init = {}) {
    this._assertNotClosed();
    const track = trackOrKind instanceof MediaStreamTrack ? trackOrKind : null;
    const kind = track ? track.kind : String(trackOrKind);
    if (kind !== "audio" && kind !== "video") throw new TypeError("kind must be audio or video");
    const direction = init.direction === undefined ? "sendrecv" : init.direction;
    if (!rtpDirections.includes(direction))
      throw new TypeError("Invalid RTCRtpTransceiver direction");
    const streams = init.streams === undefined ? [] : Array.from(init.streams);
    for (const stream of streams)
      if (!(stream instanceof MediaStream)) throw new TypeError("stream must be a MediaStream");
    const normalizedSendEncodings = normalizeInitialSendEncodings(kind, init.sendEncodings);
    const transceiver = this._createTransceiver(
      kind,
      track,
      direction,
      streams,
      normalizedSendEncodings,
    );
    this._markNegotiationNeeded();
    return transceiver;
  }

  _createTransceiver(kind, track, direction, streams, sendEncodings = []) {
    const transceiver = new RTCRtpTransceiver(
      kInternalConstruct,
      this,
      kind,
      track,
      direction,
      [...new Set(streams)],
      sendEncodings,
    );
    this._transceivers.push(transceiver);
    return transceiver;
  }

  _queueReceiverTrackEnded(transceiver, afterDescriptionTask = false) {
    if (transceiver._receiverEndQueued || transceiver.receiver.track.readyState === "ended") return;
    transceiver._receiverEndQueued = true;
    const end = () => {
      const receiverTrack = transceiver.receiver.track;
      if (receiverTrack.readyState === "ended") return;
      const source = mediaTrackSources.get(receiverTrack);
      if (source?._endTracks) {
        source._endTracks();
        return;
      }
      receiverTrack._readyState = "ended";
      notifyTrackStateChanged(receiverTrack);
      receiverTrack.dispatchEvent(makeEvent("ended"));
    };
    if (afterDescriptionTask) setImmediate(() => setImmediate(end));
    else setTimeout(end, 0);
  }

  _markRemotelyStoppedTransceivers(description) {
    for (const transceiver of this._transceivers) {
      const section = mediaSectionByMid(description, effectiveTransceiverMid(transceiver));
      if (!section || !/^m=\S+\s+0\s/m.test(section)) continue;
      transceiver._remoteStopping = true;
      transceiver._currentDirection = "stopped";
      this._queueReceiverTrackEnded(transceiver, true);
    }
  }

  _rollbackProvisionalRemoteTransceivers() {
    for (const transceiver of this._transceivers) {
      if (transceiver._reusedForRemoteOffer) {
        transceiver._reusedForRemoteOffer = false;
        const nativeTrack =
          transceiver._nativeAnnouncedReceiveTrack ||
          (transceiver._nativeReceiveTrack === transceiver._nativeSendTrack
            ? null
            : transceiver._nativeReceiveTrack);
        transceiver._nativeReceiveTrack = null;
        transceiver._nativeAnnouncedReceiveTrack = null;
        if (nativeTrack) transceiver._nativeReceiveTracks.delete(nativeTrack);
        transceiver._mid = null;
        transceiver._nativeMid = null;
        transceiver._currentDirection = null;
        if (nativeTrack) setImmediate(() => setImmediate(() => nativeTrack.close()));
        continue;
      }
      if (!transceiver._provisionalRemoteOffer || transceiver._stopped) continue;
      transceiver._provisionalRemoteOffer = false;
      transceiver._remoteStopping = false;
      transceiver._stopped = true;
      transceiver._currentDirection = "stopped";
      transceiver._mid = null;
      transceiver._nativeMid = null;
      const nativeTracks = new Set([
        transceiver._nativeSendTrack,
        transceiver._nativeReceiveTrack,
        transceiver._nativeAnnouncedReceiveTrack,
        ...transceiver._nativeReceiveTracks,
      ]);
      transceiver._nativeSendTrack = null;
      transceiver._nativeReceiveTrack = null;
      transceiver._nativeAnnouncedReceiveTrack = null;
      transceiver._nativeReceiveTracks.clear();
      for (const nativeTrack of nativeTracks) {
        if (nativeTrack) setImmediate(() => setImmediate(() => nativeTrack.close()));
      }
      this._queueReceiverTrackEnded(transceiver, true);
    }
  }

  _assertTrackCompatibleWithTransceiver(transceiver, track) {
    const source = mediaTrackSources.get(track);
    if (!transceiver._codec || !source?.codec) return;
    if (
      transceiver._codec.codec !== source.codec.codec ||
      transceiver._codec.payloadType !== source.codec.payloadType ||
      transceiver._codec.profile !== source.codec.profile
    ) {
      throw makeDOMException(
        "Replacement encoded track codec does not match the negotiated sender",
        "InvalidModificationError",
      );
    }
  }

  _detachSenderSource(sender) {
    mediaTrackSources.get(sender.track)?._detachNativeTrack?.(sender._transceiver._nativeSendTrack);
  }

  _assertSenderTrackReplacement(sender, track) {
    const transceiver = sender._transceiver;
    if (this._closed) throw makeDOMException("RTCPeerConnection is closed", "InvalidStateError");
    if (transceiver.stopped || transceiver.stopping) {
      throw makeDOMException("Transceiver is stopping", "InvalidStateError");
    }
    if (track) this._assertTrackCompatibleWithTransceiver(transceiver, track);
  }

  _replaceSenderTrack(sender, track) {
    const transceiver = sender._transceiver;
    this._assertSenderTrackReplacement(sender, track);
    this._detachSenderSource(sender);
    sender._track = track;
    if (track && transceiver._nativeSendTrack) {
      mediaTrackSources.get(track)?._attachNativeTrack?.(transceiver._nativeSendTrack);
    }
  }

  async _replaceSenderTrackOnOperationsChain(sender, track) {
    if (this._operationsPending === 0) this._assertSenderTrackReplacement(sender, track);
    const finishOperation = await this._beginPendingOperation();
    try {
      await nextTask();
      this._replaceSenderTrack(sender, track);
    } finally {
      finishOperation();
    }
  }

  _materializeTransceivers(localDescriptionTemplate = null) {
    const nativePeer = this._ensureNativePeerConnection();
    const localSections = localDescriptionTemplate
      ? parseSdpMediaSections(localDescriptionTemplate.sdp).mediaSections
      : [];
    for (let index = 0; index < this._transceivers.length; index += 1) {
      const transceiver = this._transceivers[index];
      if (transceiver.stopped) continue;
      if (transceiver._remoteStopping) continue;
      if (this._signalingState === "have-remote-offer" && transceiver.mid === null) continue;
      const nativeDirection = this._answerDirectionFor(transceiver) || transceiver.direction;
      const nativeSends = nativeDirection === "sendrecv" || nativeDirection === "sendonly";
      const source = mediaTrackSources.get(transceiver.sender.track);
      const nativeHasSource = nativeSends && transceiver.sender.track !== null;
      const localSection = localSections.find(
        (section) => section.mid === effectiveTransceiverMid(transceiver),
      );
      const codecs = nativeCodecDescriptions(
        this,
        transceiver,
        nativeHasSource ? source : null,
        localSection,
      );
      const codec = source?.codec || {
        codec: codecs[0].codec,
        payloadType: codecs[0].payloadType,
        profile: codecs[0].profile,
      };
      transceiver._codec = codec;
      const ssrc = nativeHasSource
        ? (source?.ssrc ?? transceiver._ssrc ?? crypto.randomInt(1, 0x100000000))
        : null;
      if (ssrc !== null) transceiver._ssrc = ssrc;
      const existingNativeTrack = transceiver._nativeSendTrack || transceiver._nativeReceiveTrack;
      if (existingNativeTrack) {
        transceiver._nativeSendTrack = existingNativeTrack;
        existingNativeTrack.updateDescription(
          nativeDirection,
          transceiver.stopping,
          ssrc,
          transceiver.sender._streams.map((stream) => stream.id),
          nativeHasSource ? transceiver._senderTrackId : null,
          this._rtcpCname,
          codecs,
        );
        existingNativeTrack.setActive(
          transceiver._sendEncodings.some((encoding) => encoding.active),
        );
        if (!transceiver.stopping) source?._attachNativeTrack?.(existingNativeTrack);
        continue;
      }
      if (transceiver.stopping) {
        transceiver._stopping = false;
        transceiver._stopped = true;
        transceiver._currentDirection = "stopped";
        transceiver._mid = null;
        this._queueReceiverTrackEnded(transceiver);
        continue;
      }
      const mid = source?.mid || `media-${index}`;
      const nativeTrack = nativePeer.createTrack(
        {
          kind: transceiver._kind,
          mid,
          direction: nativeDirection,
          codecs,
          ssrc,
          streamIds: transceiver.sender._streams.map((stream) => stream.id),
          trackId: nativeHasSource ? transceiver._senderTrackId : null,
          cname: this._rtcpCname,
        },
        (events) => {
          for (const event of Array.isArray(events) ? events : [events]) {
            const senderSource = mediaTrackSources.get(transceiver.sender.track);
            if (event.type !== "message") {
              senderSource?._handleNativeEvent?.(event, nativeTrack);
            }
            const receiverSource = mediaTrackSources.get(transceiver.receiver.track);
            if (receiverSource !== senderSource || event.type === "message") {
              receiverSource?._handleNativeEvent?.(event, nativeTrack);
            }
          }
        },
      );
      transceiver._nativeSendTrack = nativeTrack;
      nativeTrack.setActive(transceiver._sendEncodings.some((encoding) => encoding.active));
      transceiver._nativeReceiveTracks.add(nativeTrack);
      this._ensureDtlsTransport();
      transceiver._nativeMid = mid;
      this._nativeMediaTracks.set(nativeTrack.bindingId, transceiver);
      source?._attachNativeTrack?.(nativeTrack);
    }
  }

  _answerDirectionFor(transceiver) {
    if (this._signalingState !== "have-remote-offer") return null;
    const remoteDirection = mediaDirectionByMid(
      this.remoteDescription,
      effectiveTransceiverMid(transceiver),
    );
    if (!remoteDirection) return null;
    return intersectDirections(transceiver.direction, remoteDirection);
  }

  _prepareRemoteTransceivers(description) {
    const { mediaSections } = parseSdpMediaSections(description?.sdp || "");
    for (const section of mediaSections) {
      const media = /^m=(audio|video)\s+(\d+)\s/i.exec(section.startLine);
      if (!media) continue;
      const mid = section.lines.find((line) => /^a=mid:/i.test(line))?.slice(6);
      if (!mid) continue;
      const remoteDirection =
        section.lines
          .find((line) => /^a=(sendrecv|sendonly|recvonly|inactive)$/i.test(line))
          ?.slice(2)
          .toLowerCase() || "sendrecv";
      let transceiver = this._transceivers.find((entry) => effectiveTransceiverMid(entry) === mid);
      if (!transceiver) {
        transceiver = this._transceivers.find(
          (entry) =>
            entry.mid === null &&
            entry._createdByAddTrack &&
            entry._kind === media[1].toLowerCase() &&
            !entry.stopped &&
            !entry.stopping &&
            !entry._nativeReceiveTrack,
        );
        if (transceiver) transceiver._reusedForRemoteOffer = true;
        else {
          transceiver = this._createTransceiver(
            media[1].toLowerCase(),
            null,
            disableSending(reverseDirection(remoteDirection)),
            [],
          );
          transceiver._provisionalRemoteOffer = true;
        }
        transceiver._mid = mid;
        transceiver._nativeMid = mid;
      }
      if (media[2] === "0") {
        transceiver._remoteStopping = true;
        transceiver._lastTrackEventAssociationKey = null;
        continue;
      }
      if (remoteDirection !== "sendrecv" && remoteDirection !== "sendonly") {
        transceiver._lastTrackEventAssociationKey = null;
        continue;
      }
      this._ensureRemoteTrackSource(transceiver);
      const streams = this._applyRemoteTrackAssociations(transceiver, description);
      this._queueTrackEvent(
        transceiver,
        streams,
        this._remoteTrackAssociationKey(transceiver, description),
      );
    }
  }

  _ensureRemoteTrackSource(transceiver, nativeTrack = null) {
    let source = mediaTrackSources.get(transceiver.receiver.track);
    if (!source?.listeners) {
      source = {
        nativeTrack,
        listeners: new Set(),
        _handleNativeEvent(event) {
          if (event.type === "message") {
            transceiver.receiver._handleRtpPacket(event.data);
            if (transceiver.receiver.track._muted) {
              transceiver.receiver.track._muted = false;
              transceiver.receiver.track.dispatchEvent(makeEvent("unmute"));
            }
            for (const listener of this.listeners) listener(event.data);
          }
          if (event.type === "close") this._endTracks?.();
        },
      };
      registerMediaTrackSource(transceiver.receiver.track, source);
    } else if (nativeTrack) {
      source.nativeTrack = nativeTrack;
    }
    return source;
  }

  _adoptIncomingNativeTrack(nativeTrack) {
    const appliedRemoteDescription =
      this._pendingRemoteDescription || this._currentRemoteDescription;
    const remoteSection = mediaSectionByMid(appliedRemoteDescription, nativeTrack.mid);
    if (!remoteSection || /^m=\S+\s+0\s/m.test(remoteSection)) {
      nativeTrack.close();
      return;
    }
    let transceiver = this._transceivers.find(
      (entry) => effectiveTransceiverMid(entry) === nativeTrack.mid,
    );
    let reusedForRemoteOffer = false;
    if (!transceiver) {
      transceiver = this._transceivers.find(
        (entry) =>
          entry.mid === null &&
          entry._createdByAddTrack &&
          entry._kind === nativeTrack.kind &&
          !entry.stopped &&
          !entry.stopping &&
          !entry._nativeReceiveTrack,
      );
      reusedForRemoteOffer = Boolean(transceiver);
    }
    if (reusedForRemoteOffer) transceiver._reusedForRemoteOffer = true;
    if (!transceiver) {
      transceiver = this._createTransceiver(
        nativeTrack.kind,
        null,
        disableSending(nativeTrack.direction),
        [],
      );
      transceiver._provisionalRemoteOffer = true;
    }
    transceiver._mid = nativeTrack.mid;
    transceiver._nativeMid = nativeTrack.mid;
    transceiver._nativeAnnouncedReceiveTrack = nativeTrack;
    transceiver._nativeReceiveTracks.add(nativeTrack);
    transceiver._nativeReceiveTrack ||= transceiver._nativeSendTrack || nativeTrack;
    this._ensureDtlsTransport();
    const remoteDescription =
      this._pendingRemoteDescription ||
      this._currentRemoteDescription ||
      this._native?.remoteDescription?.();
    const streams = this._applyRemoteTrackAssociations(transceiver, remoteDescription);
    const associationKey = this._remoteTrackAssociationKey(transceiver, remoteDescription);
    this._ensureRemoteTrackSource(transceiver, transceiver._nativeReceiveTrack);
    this._nativeMediaTracks.set(nativeTrack.bindingId, transceiver);
    const remoteDirection = mediaDirectionByMid(remoteDescription, transceiver.mid);
    if (remoteDirection === "sendrecv" || remoteDirection === "sendonly") {
      this._queueTrackEvent(transceiver, streams, associationKey);
    }
  }

  _applyRemoteTrackAssociations(transceiver, description) {
    const association = mediaStreamIdsByMid(description, transceiver.mid);
    if (association.trackId) transceiver.receiver.track._id = association.trackId;
    const streams = association.streamIds.map((id) => {
      let stream = this._remoteMediaStreams.get(id);
      if (!stream) {
        stream = new MediaStream();
        stream._id = id;
        this._remoteMediaStreams.set(id, stream);
      }
      stream._addTrack(transceiver.receiver.track, true);
      return stream;
    });
    for (const previous of transceiver._remoteStreams || []) {
      if (!streams.includes(previous)) previous._removeTrack(transceiver.receiver.track, true);
    }
    transceiver._remoteStreams = streams;
    return streams;
  }

  _remoteTrackAssociationKey(transceiver, description) {
    const association = mediaStreamIdsByMid(description, transceiver.mid);
    return `${transceiver.mid}|${association.trackId || ""}|${association.streamIds.join(",")}`;
  }

  _queueTrackEvent(transceiver, streams, associationKey) {
    if (
      transceiver._lastTrackEventAssociationKey === associationKey ||
      transceiver._pendingTrackEventAssociationKey === associationKey
    ) {
      return;
    }
    transceiver._pendingTrackEventAssociationKey = associationKey;
    let finishTask;
    const task = new Promise((resolve) => {
      finishTask = resolve;
    });
    this._pendingTrackEventTasks.add(task);
    setTimeout(() => {
      try {
        if (this._closed || transceiver.stopped) return;
        transceiver._pendingTrackEventAssociationKey = null;
        transceiver._lastTrackEventAssociationKey = associationKey;
        this.dispatchEvent(
          new RTCTrackEvent("track", {
            receiver: transceiver.receiver,
            track: transceiver.receiver.track,
            streams,
            transceiver,
          }),
        );
      } finally {
        this._pendingTrackEventTasks.delete(task);
        finishTask();
      }
    }, 0);
  }

  async _waitForPendingTrackEvents() {
    while (this._pendingTrackEventTasks.size > 0) {
      await Promise.all([...this._pendingTrackEventTasks]);
    }
  }

  _updateRemoteTrackAssociations(description) {
    for (const transceiver of this._transceivers) {
      if (!transceiver._nativeReceiveTrack || transceiver.stopped || transceiver.mid === null)
        continue;
      const remoteDirection = mediaDirectionByMid(description, transceiver.mid);
      if (remoteDirection !== "sendrecv" && remoteDirection !== "sendonly") continue;
      const associationKey = this._remoteTrackAssociationKey(transceiver, description);
      if (transceiver._lastTrackEventAssociationKey === associationKey) continue;
      const streams = this._applyRemoteTrackAssociations(transceiver, description);
      this._queueTrackEvent(transceiver, streams, associationKey);
    }
  }

  getSenders() {
    return this._transceivers.filter((entry) => !entry.stopped).map((entry) => entry.sender);
  }
  getReceivers() {
    return this._transceivers.filter((entry) => !entry.stopped).map((entry) => entry.receiver);
  }
  getTransceivers() {
    return this._transceivers.filter((entry) => !entry.stopped);
  }

  async getStats(selector = null) {
    if (
      selector !== null &&
      !(selector instanceof MediaStreamTrack) &&
      !(selector instanceof RTCRtpSender) &&
      !(selector instanceof RTCRtpReceiver)
    ) {
      throw new TypeError("selector must be a MediaStreamTrack, RTCRtpSender, or RTCRtpReceiver");
    }
    if (
      (selector instanceof RTCRtpSender || selector instanceof RTCRtpReceiver) &&
      selector._peerConnection !== this
    ) {
      throw makeDOMException(
        "Selector is not owned by this RTCPeerConnection",
        "InvalidAccessError",
      );
    }
    if (selector instanceof MediaStreamTrack) {
      const associations = this._transceivers.flatMap((transceiver) => {
        if (transceiver.stopped) return [];
        const matches = [];
        if (transceiver.sender.track === selector) matches.push(transceiver.sender);
        if (transceiver.receiver.track === selector) matches.push(transceiver.receiver);
        return matches;
      });
      if (associations.length !== 1) {
        throw makeDOMException(
          "Track selector must identify exactly one sender or receiver",
          "InvalidAccessError",
        );
      }
    }
    const report = new RTCStatsReport(kInternalConstruct);
    const timestamp = performance.timeOrigin + performance.now();
    if (selector === null) {
      report._set({
        id: "peer-connection",
        timestamp,
        type: "peer-connection",
        dataChannelsOpened: this._dataChannelsOpened,
        dataChannelsClosed: this._dataChannelsClosed,
      });
      for (const channel of new Set(this._channels.values())) {
        const dataChannelIdentifier = channel.id;
        if (dataChannelIdentifier == null) continue;
        report._set({
          id: `data-channel-${channel._native.bindingId}`,
          timestamp,
          type: "data-channel",
          label: channel.label,
          protocol: channel.protocol,
          dataChannelIdentifier,
          state: channel.readyState,
          messagesSent: channel._messagesSent,
          bytesSent: channel._bytesSent,
          messagesReceived: channel._messagesReceived,
          bytesReceived: channel._bytesReceived,
        });
      }
    }
    if (!this._native || this._closed) {
      await nextTask();
      return report;
    }
    const selectedPair = this._dtlsTransport?.iceTransport.getSelectedCandidatePair();
    const selectedTransceivers = this._transceivers.filter((transceiver) => {
      if (transceiver.stopped || transceiver.stopping) return false;
      if (selector === null) return true;
      if (selector instanceof RTCRtpSender) return transceiver.sender === selector;
      if (selector instanceof RTCRtpReceiver) return transceiver.receiver === selector;
      return transceiver.sender.track === selector || transceiver.receiver.track === selector;
    });
    for (const transceiver of selectedTransceivers) {
      const sendStats = transceiver._nativeSendTrack?.stats();
      const receiveTracks = new Set([
        ...transceiver._nativeReceiveTracks,
        transceiver._nativeReceiveTrack,
        transceiver._nativeAnnouncedReceiveTrack,
      ]);
      let receiveTrack = null;
      let receiveStats = null;
      for (const candidate of receiveTracks) {
        if (!candidate) continue;
        const candidateStats = candidate.stats();
        if (!receiveStats || candidateStats.packetsReceived > receiveStats.packetsReceived) {
          receiveTrack = candidate;
          receiveStats = candidateStats;
        }
      }
      if (!sendStats && !receiveStats) continue;
      const parameters = senderRtpParameters(transceiver);
      const codec =
        parameters.codecs.find((entry) => entry.payloadType === transceiver._codec?.payloadType) ||
        parameters.codecs[0];
      const codecId = codec ? `codec-${transceiver.mid}-${codec.payloadType}` : undefined;
      if (codec) {
        report._set({
          id: codecId,
          timestamp,
          type: "codec",
          transportId: "transport-0",
          ...codec,
        });
      }
      const source = mediaTrackSources.get(transceiver.sender.track);
      const includeOutbound =
        selector === null ||
        selector === transceiver.sender ||
        selector === transceiver.sender.track;
      const includeInbound =
        selector === null ||
        selector === transceiver.receiver ||
        selector === transceiver.receiver.track;
      if (
        includeOutbound &&
        transceiver.sender.track &&
        !transceiver.stopped &&
        (transceiver.currentDirection === "sendrecv" || transceiver.currentDirection === "sendonly")
      ) {
        report._set({
          id: `outbound-rtp-${transceiver.mid}`,
          timestamp,
          type: "outbound-rtp",
          ssrc: source?.ssrc ?? transceiver._ssrc,
          kind: transceiver._kind,
          mid: transceiver.mid,
          transportId: "transport-0",
          ...(codecId ? { codecId } : {}),
          packetsSent: sendStats?.packetsSent ?? 0,
          bytesSent: sendStats?.bytesSent ?? 0,
        });
      }
      if (
        includeInbound &&
        receiveStats &&
        (receiveStats.packetsReceived > 0 || receiveStats.bytesReceived > 0)
      ) {
        report._set({
          id: `inbound-rtp-${transceiver.mid}`,
          timestamp,
          type: "inbound-rtp",
          ssrc: receiveTrack?.ssrc ?? 0,
          kind: transceiver._kind,
          mid: transceiver.mid,
          transportId: "transport-0",
          ...(codecId ? { codecId } : {}),
          trackIdentifier: transceiver.receiver.track.id,
          packetsReceived: receiveStats.packetsReceived,
          bytesReceived: receiveStats.bytesReceived,
        });
      }
    }
    {
      const stats = this._native.transportStats();
      const localCertificate = certificateStats(
        "local-certificate-0",
        this._nativeCertificates?.[0],
        timestamp,
      );
      const pairedRemoteCertificate = certificateStats(
        "remote-certificate-0",
        this._pairedPeer?._nativeCertificates?.[0],
        timestamp,
      );
      const verifiedRemoteFingerprint = this._native.remoteFingerprint();
      const remoteCertificate =
        this._dtlsTransport?.state === "connected" &&
        pairedRemoteCertificate &&
        verifiedRemoteFingerprint &&
        pairedRemoteCertificate.fingerprintAlgorithm === verifiedRemoteFingerprint.algorithm &&
        pairedRemoteCertificate.fingerprint.toLowerCase() ===
          String(verifiedRemoteFingerprint.value).toLowerCase()
          ? pairedRemoteCertificate
          : null;
      if (localCertificate) report._set(localCertificate);
      if (remoteCertificate) report._set(remoteCertificate);
      report._set({
        id: "transport-0",
        timestamp,
        type: "transport",
        bytesSent: stats.bytesSent,
        bytesReceived: stats.bytesReceived,
        dtlsState: this._dtlsTransport?.state ?? "new",
        iceState: this._dtlsTransport?.iceTransport.state ?? "new",
        ...(selectedPair ? { selectedCandidatePairId: "candidate-pair-0" } : {}),
        ...(localCertificate ? { localCertificateId: localCertificate.id } : {}),
        ...(remoteCertificate ? { remoteCertificateId: remoteCertificate.id } : {}),
      });
    }
    if (selectedPair) {
      report._set(
        candidateStats("local-candidate-0", "local-candidate", selectedPair.local, timestamp),
      );
      report._set(
        candidateStats("remote-candidate-0", "remote-candidate", selectedPair.remote, timestamp),
      );
      report._set({
        id: "candidate-pair-0",
        timestamp,
        type: "candidate-pair",
        transportId: "transport-0",
        localCandidateId: "local-candidate-0",
        remoteCandidateId: "remote-candidate-0",
        state: "succeeded",
        nominated: true,
      });
    }
    await nextTask();
    return report;
  }

  get localDescription() {
    return this._pendingLocalDescription || this._currentLocalDescription;
  }

  get currentLocalDescription() {
    return this._currentLocalDescription;
  }

  get pendingLocalDescription() {
    return this._pendingLocalDescription;
  }

  get remoteDescription() {
    return this._pendingRemoteDescription || this._currentRemoteDescription;
  }

  get currentRemoteDescription() {
    return this._currentRemoteDescription;
  }

  get pendingRemoteDescription() {
    return this._pendingRemoteDescription;
  }

  get signalingState() {
    return this._closed ? "closed" : this._signalingState;
  }

  get iceGatheringState() {
    return this._iceGatheringState;
  }

  get iceConnectionState() {
    return this._iceConnectionState;
  }

  get connectionState() {
    return this._connectionState;
  }

  get canTrickleIceCandidates() {
    return this._canTrickleIceCandidates;
  }

  get sctp() {
    return this._sctpTransport;
  }

  get ondatachannel() {
    return this._ondatachannel;
  }

  set ondatachannel(callback) {
    this._ondatachannel = typeof callback === "function" ? callback : null;
    this._scheduleDataChannelFlush();
    this._scheduleDataChannelAnnouncementRepair();
    this._pairedPeer?._scheduleDataChannelAnnouncementRepair();
  }

  createDataChannel(label, init = {}) {
    this._assertNotClosed();
    if (arguments.length === 0) throw new TypeError("createDataChannel requires a label");
    const options = normalizeDataChannelInit(init);
    const stringLabel = String(label);
    validateByteLength(stringLabel, "label");
    validateByteLength(options.protocol, "protocol");
    if (options.negotiated && this._isDataChannelIdInUse(options.id)) {
      throw makeDOMException("RTCDataChannel id is already in use", "OperationError");
    }
    const nativeChannel = this._createNativeDataChannel(stringLabel, options);
    const assignedId = options.negotiated ? options.id : null;
    const channel = RTCDataChannel._fromNative(this, nativeChannel, undefined, assignedId);
    channel._createdLocally = true;
    this._localDataChannelCount += 1;
    if (this._localDataChannelCount === 1) this._markNegotiationNeeded();
    this._assignDataChannelIdsFromDtlsRole();
    this._scheduleDataChannelOpenRepair();
    this._pairedPeer?._scheduleDataChannelAnnouncementRepair();
    return channel;
  }

  _createNativeDataChannel(label, options) {
    try {
      return this._ensureNativePeerConnection().createDataChannel(label, options);
    } catch (error) {
      const highNegotiatedStream =
        options.negotiated &&
        options.id >= LIBDATACHANNEL_SCTP_MAX_CHANNELS &&
        /stream id is too high/i.test(error?.message || "");
      if (!highNegotiatedStream) throw error;
      return new UnsupportedNativeDataChannel(label, options);
    }
  }

  async createOffer(options = undefined) {
    this._assertNotClosed();
    const optionsObject = options !== null && typeof options === "object" ? options : {};
    const iceRestartRequested = optionsObject.iceRestart === true;
    if (
      this._operationsPending === 0 &&
      this._signalingState !== "stable" &&
      this._signalingState !== "have-local-offer"
    ) {
      throw makeDOMException("Cannot create offer in current signaling state", "InvalidStateError");
    }
    const finishOperation = await this._beginPendingOperation();
    try {
      await nextTask();
      if (this._closed) return new Promise(() => {});
      if (this._signalingState !== "stable" && this._signalingState !== "have-local-offer") {
        throw makeDOMException(
          "Cannot create offer in current signaling state",
          "InvalidStateError",
        );
      }
      this._materializeTransceivers();
      if (iceRestartRequested && !this._nonstandardLocalIceCredentials) {
        this._iceRestartPending = true;
        this._armDataChannelNativeCloseSuppression();
      }
      let offer =
        this._prepareNonstandardLocalDescription("offer") ||
        this._ensureNativePeerConnection().createOffer();
      const jsOnlyIceRestart = this._iceRestartPending && !this._canApplyNativeIceCredentials();
      if (this._iceRestartPending && !jsOnlyIceRestart) {
        offer = {
          type: offer.type,
          sdp: rewriteIceCredentials(offer.sdp, this._ensureIceRestartCredentials()),
        };
      }
      offer = reconcileRejectedMediaSections(offer, this._currentLocalDescription);
      offer = orderCodecAttributeLines(offer);
      this._lastCreatedOffer = new RTCSessionDescription(offer);
      this._lastCreatedOfferRevision = this._negotiationRevision;
      if (jsOnlyIceRestart) markJsOnlyIceRestart(this._lastCreatedOffer);
      return offer;
    } catch (error) {
      throw mapNativeError(error, "InvalidStateError");
    } finally {
      finishOperation();
    }
  }

  _armDataChannelNativeCloseSuppression() {
    const peers = new Set([this, this._pairedPeer].filter(Boolean));
    for (const peer of peers) {
      for (const channel of peer._channels.values()) channel._armNativeCloseSuppression();
    }
  }

  restartIce() {
    if (this._closed) return;
    if (!this._localDescription && !this._remoteDescription) return;
    this._iceRestartPending = true;
    this._pendingIceRestartCredentials = null;
    this._armDataChannelNativeCloseSuppression();
    if (this._signalingState === "stable") this._markNegotiationNeeded();
  }

  async createAnswer() {
    this._assertNotClosed();
    if (!this.remoteDescription && this._operationsPending === 0) {
      throw makeDOMException("Remote description is not set", "InvalidStateError");
    }
    const finishOperation = await this._beginPendingOperation();
    try {
      await nextTask();
      if (this._closed) return new Promise(() => {});
      if (!this.remoteDescription) {
        throw makeDOMException("Remote description is not set", "InvalidStateError");
      }
      this._materializeTransceivers();
      if (this._jsOnlyIceRestartRemoteOffer) {
        const answer = markJsOnlyIceRestart(
          orderCodecAttributeLines(
            new RTCSessionDescription(this._ensureNativePeerConnection().createAnswer()),
          ),
        );
        this._lastCreatedAnswer = answer;
        this._lastCreatedAnswerRevision = this._negotiationRevision;
        Object.defineProperty(answer, "_webrtcNodeAnswerer", {
          value: this,
          configurable: true,
        });
        return answer;
      }
      if (hasNoActiveMedia(this.remoteDescription)) {
        const answer = {
          type: "answer",
          sdp: this.remoteDescription.sdp,
        };
        this._lastCreatedAnswer = new RTCSessionDescription(answer);
        this._lastCreatedAnswerRevision = this._negotiationRevision;
        return answer;
      }
      let answer =
        this._prepareNonstandardLocalDescription("answer") ||
        this._ensureNativePeerConnection().createAnswer();
      answer = orderCodecAttributeLines(answer);
      this._lastCreatedAnswer = new RTCSessionDescription(answer);
      this._lastCreatedAnswerRevision = this._negotiationRevision;
      Object.defineProperty(answer, "_webrtcNodeAnswerer", {
        value: this,
        configurable: true,
      });
      return answer;
    } catch (error) {
      throw mapNativeError(error, "InvalidStateError");
    } finally {
      finishOperation();
    }
  }

  async setLocalDescription(description = undefined) {
    this._assertNotClosed();
    const jsOnlyIceRestartDescription = Boolean(description?._webrtcNodeJsOnlyIceRestart);
    let normalized = description === undefined ? null : normalizeDescription(description);
    if (
      normalized?.type === "rollback" &&
      this._signalingState !== "have-local-offer" &&
      this._operationsPending === 0
    ) {
      throw makeDOMException(
        "Cannot roll back a local description in current signaling state",
        "InvalidStateError",
      );
    }
    const finishOperation = await this._beginPendingOperation();
    try {
      await nextTask();
      if (this._closed) return new Promise(() => {});
      const type = normalized ? normalized.type : this._implicitLocalDescriptionType();
      if (normalized?.type === "offer") {
        if (this._signalingState !== "stable" && this._signalingState !== "have-local-offer") {
          throw makeDOMException(
            "Cannot set a local offer in current signaling state",
            "InvalidStateError",
          );
        }
        if (normalized.sdp === "" && this._lastCreatedOffer) normalized = this._lastCreatedOffer;
        if (!this._lastCreatedOffer || normalized.sdp !== this._lastCreatedOffer.sdp) {
          throw makeDOMException(
            "Local offer does not match the last created offer",
            "InvalidModificationError",
          );
        }
      }
      if (normalized?.type === "rollback") {
        if (this._signalingState !== "have-local-offer") {
          throw makeDOMException(
            "Cannot roll back a local description in current signaling state",
            "InvalidStateError",
          );
        }
        const previousState = this._signalingState;
        const previousGatheringState = this._iceGatheringState;
        const rollingBackInitialOffer = !this._currentLocalDescription;
        const nativeBackedRollback =
          this._localDescription && !hasNoActiveMedia(this._localDescription);
        if (nativeBackedRollback) {
          this._suppressNextNativeSignalingState = "stable";
          try {
            this._ensureNativePeerConnection().setLocalDescription("rollback");
          } catch (error) {
            this._suppressNextNativeSignalingState = null;
            throw error;
          }
        }
        this._rollbackLocalDescription();
        this._localDescriptionSetByApi = hasDataMediaSection(this._localDescription);
        this._localIceCandidates = [];
        this._unregisterLocalDescriptionsForPairing();
        this._syncStatesFromNative();
        this._signalingState = "stable";
        if (rollingBackInitialOffer) {
          this._iceGatheringState = "new";
        }
        this._refreshIceRole();
        this._updateSctpTransport();
        if (rollingBackInitialOffer && previousGatheringState !== "new") {
          this.dispatchEvent(makeEvent("icegatheringstatechange"));
          this._iceTransport()?.dispatchEvent(makeEvent("gatheringstatechange"));
        }
        if (previousState !== this._signalingState) this._dispatchSignalingStateChange();
        await nextTask();
        if (this._suppressNextNativeSignalingState === "stable")
          this._suppressNextNativeSignalingState = null;
        return;
      }
      if (normalized?.type === "pranswer") {
        if (
          this._signalingState !== "have-remote-offer" &&
          this._signalingState !== "have-local-pranswer"
        ) {
          throw makeDOMException(
            "Cannot set a local pranswer in current signaling state",
            "InvalidStateError",
          );
        }
        const previousState = this._signalingState;
        this._setPendingLocalDescription(normalized);
        this._localDescriptionSetByApi = hasDataMediaSection(this._localDescription);
        this._registerLocalDescriptionForPairing();
        this._signalingState = "have-local-pranswer";
        this._refreshIceRole();
        this._updateSctpTransport();
        if (previousState !== this._signalingState) this._dispatchSignalingStateChange();
        await nextTask();
        return;
      }
      let alreadyAppliedAnswer = false;
      if (normalized?.type === "answer") {
        if (description?._webrtcNodeApplicationPromise) {
          await description._webrtcNodeApplicationPromise;
        }
        if (normalized.sdp === "" && this._lastCreatedAnswer) normalized = this._lastCreatedAnswer;
        alreadyAppliedAnswer =
          this._localDescription?.type === "answer" &&
          (this._localDescription.sdp === normalized.sdp ||
            description?._webrtcNodeApplied === true ||
            Boolean(description?._webrtcNodeApplicationPromise));
        if (
          !alreadyAppliedAnswer &&
          this._signalingState !== "have-remote-offer" &&
          this._signalingState !== "have-local-pranswer"
        ) {
          throw makeDOMException(
            "Cannot set a local answer in current signaling state",
            "InvalidStateError",
          );
        }
        if (!this._lastCreatedAnswer || normalized.sdp !== this._lastCreatedAnswer.sdp) {
          throw makeDOMException(
            "Local answer does not match the last created answer",
            "InvalidModificationError",
          );
        }
      }
      if (alreadyAppliedAnswer) {
        this._localDescriptionSetByApi = hasDataMediaSection(this._localDescription);
        this._syncStatesFromNative();
        this._refreshIceRole();
        for (const candidate of this._pendingIce.splice(0)) {
          await this._addIceCandidateWithoutChain(candidate);
        }
        this._flushPendingRemoteCandidatesForNative();
        return;
      }
      if (normalized && hasNoActiveMedia(normalized)) {
        await this._applyNoMediaLocalDescription(normalized);
        this._localDescriptionSetByApi = hasDataMediaSection(this._localDescription);
        return;
      }
      if (!normalized && type === "offer") {
        this._materializeTransceivers();
        const offer =
          this._lastCreatedOffer ||
          orderCodecAttributeLines(
            new RTCSessionDescription(this._ensureNativePeerConnection().createOffer()),
          );
        if (isNoMediaSdp(offer)) {
          await this._applyNoMediaLocalDescription(offer);
          this._localDescriptionSetByApi = hasDataMediaSection(this._localDescription);
          return;
        }
      }
      if (!normalized && type === "answer" && hasNoActiveMedia(this.remoteDescription)) {
        const answer =
          this._lastCreatedAnswer ||
          new RTCSessionDescription({
            type: "answer",
            sdp: this.remoteDescription.sdp,
          });
        await this._applyNoMediaLocalDescription(answer);
        this._localDescriptionSetByApi = hasDataMediaSection(this._localDescription);
        return;
      }
      if (type === "answer" && this._jsOnlyIceRestartRemoteOffer) {
        const answer =
          normalized ||
          this._lastCreatedAnswer ||
          orderCodecAttributeLines(
            new RTCSessionDescription(this._ensureNativePeerConnection().createAnswer()),
          );
        await this._applyJsOnlyLocalAnswer(answer);
        this._localDescriptionSetByApi = hasDataMediaSection(this._localDescription);
        return;
      }
      if (type === "offer" && this._shouldApplyDataOnlyLocalOffer(normalized)) {
        const offer = normalized || this._currentLocalDescription || this._lastCreatedOffer;
        await this._applyDataOnlyLocalOffer(offer);
        this._localDescriptionSetByApi = hasDataMediaSection(this._localDescription);
        return;
      }
      if (type === "answer" && this._shouldApplyDataOnlyLocalAnswer(normalized)) {
        const answer = normalized || this._currentLocalDescription || this._lastCreatedAnswer;
        await this._applyDataOnlyLocalAnswer(answer);
        this._localDescriptionSetByApi = hasDataMediaSection(this._localDescription);
        return;
      }
      const previousIceGatheringState = this._iceGatheringState;
      const previousSignalingState = this._signalingState;
      let appliedIceRestart = false;
      let usedJsOnlyIceRestart = false;
      let pendingLocalOfferApplied = false;
      if (
        this._localDescription?.type === type &&
        type !== "offer" &&
        !this._pendingRemoteDescription
      ) {
        this._syncStatesFromNative();
      } else if (this._preparedLocalDescription && type === this._preparedLocalDescription.type) {
        this._localDescription = this._preparedLocalDescription;
        this._preparedLocalDescription = null;
        this._nonstandardPreparedLocalDescriptionType = null;
        this._nonstandardLocalIceCredentials = null;
        if (type === "offer") {
          this._setPendingLocalDescription(this._localDescription);
          pendingLocalOfferApplied = true;
        }
        this._syncStatesFromNative();
        this._scheduleNativeCandidateGathering();
      } else {
        const hadIceRestartRequest =
          (this._iceRestartPending || jsOnlyIceRestartDescription) && type === "offer";
        const useJsOnlyIceRestart = hadIceRestartRequest && !this._canApplyNativeIceCredentials();
        if (useJsOnlyIceRestart) {
          const localDescription = new RTCSessionDescription(
            normalized ||
              this._lastCreatedOffer ||
              this._ensureNativePeerConnection().createOffer(),
          );
          this._localDescription = markJsOnlyIceRestart(localDescription);
          this._jsOnlyIceRestartOfferPending = true;
          this._signalingState = "have-local-offer";
          appliedIceRestart = true;
          usedJsOnlyIceRestart = true;
        } else {
          if (type === "offer" || type === "answer") this._materializeTransceivers(normalized);
          const localDescriptionInit = this._localOfferInit(type);
          this._ensureNativePeerConnection().setLocalDescription(type, localDescriptionInit);
          if (type === "offer" || type === "answer") this._materializeTransceivers(normalized);
          appliedIceRestart = hadIceRestartRequest;
          const nativeDescription = this._ensureNativePeerConnection().localDescription();
          const generatedDescription = nativeDescription
            ? orderCodecAttributeLines(new RTCSessionDescription(nativeDescription))
            : null;
          const directionTemplate =
            normalized || (type === "offer" ? this._lastCreatedOffer : this._lastCreatedAnswer);
          this._localMediaDirectionTemplate = directionTemplate;
          this._localDescription = reconcileRejectedMediaSections(
            alignMediaDirections(generatedDescription, directionTemplate),
            directionTemplate,
          );
          if (type === "offer") {
            this._setPendingLocalDescription(this._localDescription);
            pendingLocalOfferApplied = true;
          }
          this._syncStatesFromNative();
          this._scheduleNativeCandidateGathering();
        }
      }
      if (type === "offer") {
        if (!pendingLocalOfferApplied) this._setPendingLocalDescription(this._localDescription);
        this._syncSignalingStateFromDescriptions();
      } else if (type === "answer") {
        this._commitRemoteDescription();
        this._commitLocalDescription(this._localDescription);
        this._syncSignalingStateFromDescriptions();
        for (const candidate of this._pendingIce.splice(0)) {
          await this._addIceCandidateWithoutChain(candidate);
        }
        this._flushPendingRemoteCandidatesForNative();
      }
      this._localDescriptionSetByApi = hasDataMediaSection(this._localDescription);
      this._clearNegotiationNeededIfDataMLineIsPresent();
      this._refreshIceRole();
      if (previousSignalingState !== this._signalingState) this._dispatchSignalingStateChange();
      if (appliedIceRestart) {
        if (previousIceGatheringState === "complete") this._queueSyntheticIceRestartGathering();
        this._clearIceRestartRequest();
      }
      await nextTask();
      if (usedJsOnlyIceRestart) {
        this._registerLocalDescriptionForPairing();
      } else {
        await this._refreshLocalDescriptionAfterGatheringWindow();
        this._registerLocalDescriptionForPairing();
      }
    } catch (error) {
      throw mapNativeError(error, "InvalidStateError");
    } finally {
      finishOperation();
    }
  }

  async setRemoteDescription(description) {
    this._assertNotClosed();
    const jsOnlyIceRestartDescription = Boolean(description?._webrtcNodeJsOnlyIceRestart);
    const normalized = normalizeDescription(description);
    if (
      normalized.type === "answer" &&
      this._signalingState !== "have-local-offer" &&
      this._signalingState !== "have-remote-pranswer" &&
      !this._jsOnlyIceRestartOfferPending &&
      this._operationsPending === 0
    ) {
      throw makeDOMException(
        "Cannot set a remote answer in current signaling state",
        "InvalidStateError",
      );
    }
    if (
      normalized.type === "pranswer" &&
      this._signalingState !== "have-local-offer" &&
      this._signalingState !== "have-remote-pranswer" &&
      this._operationsPending === 0
    ) {
      throw makeDOMException(
        "Cannot set a remote pranswer in current signaling state",
        "InvalidStateError",
      );
    }
    if (
      normalized.type === "rollback" &&
      this._signalingState !== "have-remote-offer" &&
      this._operationsPending === 0
    ) {
      throw makeDOMException(
        "Cannot roll back a remote description in current signaling state",
        "InvalidStateError",
      );
    }
    const finishOperation = await this._beginPendingOperation();
    try {
      await nextTask();
      if (this._closed) return new Promise(() => {});
      if (
        normalized.type === "answer" &&
        this._signalingState !== "have-local-offer" &&
        this._signalingState !== "have-remote-pranswer" &&
        !this._jsOnlyIceRestartOfferPending
      ) {
        throw makeDOMException(
          "Cannot set a remote answer in current signaling state",
          "InvalidStateError",
        );
      }
      if (normalized.type === "pranswer") {
        if (
          this._signalingState !== "have-local-offer" &&
          this._signalingState !== "have-remote-pranswer"
        ) {
          throw makeDOMException(
            "Cannot set a remote pranswer in current signaling state",
            "InvalidStateError",
          );
        }
        const previousState = this._signalingState;
        this._setPendingRemoteDescription(normalized);
        this._pairWithRemoteDescription(this._remoteDescription);
        this._canTrickleIceCandidates = hasTrickleIceOption(normalized);
        this._signalingState = "have-remote-pranswer";
        this._refreshIceRole();
        this._updateSctpTransport();
        if (previousState !== this._signalingState) this._dispatchSignalingStateChange();
        await nextTask();
        return;
      }
      if (
        normalized.type === "offer" &&
        (this._signalingState === "have-local-offer" ||
          this._signalingState === "have-remote-pranswer")
      ) {
        await this._implicitRollbackLocalDescription();
        if (this._closed) return new Promise(() => {});
      }
      assertValidSdpSyntax(normalized);
      if (normalized.type === "rollback") {
        if (this._signalingState !== "have-remote-offer") {
          throw makeDOMException(
            "Cannot roll back a remote description in current signaling state",
            "InvalidStateError",
          );
        }
        const previousState = this._signalingState;
        const nativeBackedRollback =
          this._remoteDescription && !hasNoActiveMedia(this._remoteDescription);
        if (nativeBackedRollback) {
          this._suppressNextNativeSignalingState = "stable";
          try {
            this._ensureNativePeerConnection().setRemoteDescription({ type: "rollback", sdp: "" });
          } catch (error) {
            this._suppressNextNativeSignalingState = null;
            throw error;
          }
        }
        this._rollbackRemoteDescription();
        this._rollbackProvisionalRemoteTransceivers();
        this._remoteIceCandidates = [];
        if (this._pairedPeer?._pairedPeer === this) this._pairedPeer._pairedPeer = null;
        this._pairedPeer = null;
        this._selfRemoteDescription = false;
        this._syncStatesFromNative();
        this._signalingState = "stable";
        this._refreshIceRole();
        this._updateSctpTransport();
        if (previousState !== this._signalingState) this._dispatchSignalingStateChange();
        await nextTask();
        if (this._suppressNextNativeSignalingState === "stable")
          this._suppressNextNativeSignalingState = null;
        return;
      }
      if (
        normalized.type === "offer" &&
        this._isJsOnlyIceRestartRemoteOffer(normalized, jsOnlyIceRestartDescription)
      ) {
        const previousState = this._signalingState;
        this._setPendingRemoteDescription(markJsOnlyIceRestart(normalized));
        this._pairWithRemoteDescription(this._remoteDescription);
        this._canTrickleIceCandidates = hasTrickleIceOption(normalized);
        this._signalingState = "have-remote-offer";
        this._jsOnlyIceRestartRemoteOffer = true;
        this._armDataChannelNativeCloseSuppression();
        this._refreshIceRole();
        this._updateSctpTransport();
        if (previousState !== this._signalingState) this._dispatchSignalingStateChange();
        await nextTask();
        return;
      }
      if (
        normalized.type === "answer" &&
        (jsOnlyIceRestartDescription || this._jsOnlyIceRestartOfferPending)
      ) {
        const previousState = this._signalingState;
        let remoteDescription = normalized;
        if (description && description._webrtcNodeAnswerer) {
          const application = description._webrtcNodeAnswerer._ensureLocalAnswerApplied();
          Object.defineProperty(description, "_webrtcNodeApplicationPromise", {
            value: application,
            configurable: true,
          });
          remoteDescription = await application;
          Object.defineProperty(description, "_webrtcNodeApplied", {
            value: true,
            configurable: true,
          });
        }
        this._setPendingRemoteDescription(markJsOnlyIceRestart(remoteDescription));
        this._commitLocalDescription();
        this._commitRemoteDescription(this._remoteDescription);
        this._canTrickleIceCandidates = hasTrickleIceOption(remoteDescription);
        this._signalingState = "stable";
        this._jsOnlyIceRestartOfferPending = false;
        this._clearIceRestartRequest();
        this._refreshIceRole();
        this._assignDataChannelIdsFromDtlsRole();
        this._updateSctpTransport();
        if (previousState !== this._signalingState) this._dispatchSignalingStateChange();
        await nextTask();
        return;
      }
      if (normalized.type === "offer" && this._shouldApplyDataOnlyRemoteOffer(normalized)) {
        const previousState = this._signalingState;
        this._setPendingRemoteDescription(normalized);
        this._pairWithRemoteDescription(this._remoteDescription);
        this._canTrickleIceCandidates = hasTrickleIceOption(normalized);
        this._syncSignalingStateFromDescriptions();
        this._refreshIceRole();
        this._updateSctpTransport();
        if (previousState !== this._signalingState) this._dispatchSignalingStateChange();
        await nextTask();
        return;
      }
      if (normalized.type === "answer" && this._shouldApplyDataOnlyRemoteAnswer(normalized)) {
        const previousState = this._signalingState;
        let remoteDescription = normalized;
        if (description && description._webrtcNodeAnswerer) {
          const application = description._webrtcNodeAnswerer._ensureLocalAnswerApplied();
          Object.defineProperty(description, "_webrtcNodeApplicationPromise", {
            value: application,
            configurable: true,
          });
          remoteDescription = await application;
          Object.defineProperty(description, "_webrtcNodeApplied", {
            value: true,
            configurable: true,
          });
        }
        this._setPendingRemoteDescription(remoteDescription);
        this._commitLocalDescription();
        this._commitRemoteDescription(this._remoteDescription);
        this._canTrickleIceCandidates = hasTrickleIceOption(remoteDescription);
        this._syncSignalingStateFromDescriptions();
        this._refreshIceRole();
        this._assignDataChannelIdsFromDtlsRole();
        this._updateSctpTransport();
        if (previousState !== this._signalingState) this._dispatchSignalingStateChange();
        await nextTask();
        return;
      }
      if (hasNoActiveMedia(normalized)) {
        if (normalized.type === "offer") {
          this._rollbackLocalDescription();
          this._setPendingRemoteDescription(normalized);
          this._prepareRemoteTransceivers(normalized);
          this._markRemotelyStoppedTransceivers(normalized);
        } else if (normalized.type === "answer") {
          this._commitLocalDescription();
          this._commitRemoteDescription(normalized);
        } else {
          this._setPendingRemoteDescription(normalized);
        }
        this._pairWithRemoteDescription(this._remoteDescription);
        this._canTrickleIceCandidates = hasTrickleIceOption(normalized);
        if (normalized.type === "offer") {
          this._signalingState = "have-remote-offer";
        } else if (normalized.type === "answer") {
          this._signalingState = "stable";
          this._updateNegotiatedTransceivers();
        }
        this._refreshIceRole();
        this._updateSctpTransport();
        this._dispatchSignalingStateChange();
        await nextTask();
        return;
      }
      if (normalized.type === "offer" && this._signalingState === "have-remote-offer") {
        this._setPendingRemoteDescription(normalized);
        this._pairWithRemoteDescription(this._remoteDescription);
        this._canTrickleIceCandidates = hasTrickleIceOption(normalized);
        this._refreshIceRole();
        this._updateSctpTransport();
        await nextTask();
        return;
      }
      let remoteDescription = normalized;
      if (normalized.type === "answer" && description && description._webrtcNodeAnswerer) {
        const application = description._webrtcNodeAnswerer._ensureLocalAnswerApplied();
        Object.defineProperty(description, "_webrtcNodeApplicationPromise", {
          value: application,
          configurable: true,
        });
        remoteDescription = await application;
        Object.defineProperty(description, "_webrtcNodeApplied", {
          value: true,
          configurable: true,
        });
      }
      const previousSignalingState = this._signalingState;
      let suppressedNativeSignalingState = null;
      let nativeRemoteDescription = remoteDescription;
      let deferredCandidatesForNative = [];
      if (normalized.type === "offer") {
        deferredCandidatesForNative = extractIceCandidatesFromDescription(remoteDescription);
        if (deferredCandidatesForNative.length > 0) {
          nativeRemoteDescription = stripIceCandidateLinesFromDescription(remoteDescription);
        }
      }
      this._ensureNativePeerConnection().setRemoteDescription(nativeRemoteDescription.toJSON());
      this._queuePendingRemoteCandidatesForNative(deferredCandidatesForNative);
      this._canTrickleIceCandidates = hasTrickleIceOption(remoteDescription);
      this._remoteDescription = new RTCSessionDescription(remoteDescription);
      this._pairWithRemoteDescription(this._remoteDescription);
      this._prepareRemoteTransceivers(this._remoteDescription);
      this._syncStatesFromNative();
      if (normalized.type === "offer") {
        this._rollbackLocalDescription();
        this._setPendingRemoteDescription(this._remoteDescription);
        this._syncSignalingStateFromDescriptions();
      } else if (normalized.type === "answer") {
        this._commitLocalDescription();
        this._commitRemoteDescription(this._remoteDescription);
        this._syncSignalingStateFromDescriptions();
      }
      this._refreshIceRole();
      this._assignDataChannelIdsFromDtlsRole();
      if (previousSignalingState !== this._signalingState) {
        suppressedNativeSignalingState = this._signalingState;
        this._suppressNextNativeSignalingState = suppressedNativeSignalingState;
        this._dispatchSignalingStateChange();
      }
      if (normalized.type !== "offer") {
        for (const candidate of this._pendingIce.splice(0)) {
          await this._addIceCandidateWithoutChain(candidate);
        }
        this._flushPendingRemoteCandidatesForNative();
      }
      await nextTask();
      await this._waitForPendingTrackEvents();
      if (
        suppressedNativeSignalingState !== null &&
        this._suppressNextNativeSignalingState === suppressedNativeSignalingState
      ) {
        this._suppressNextNativeSignalingState = null;
      }
    } catch (error) {
      throw mapNativeError(error, "InvalidStateError");
    } finally {
      finishOperation();
    }
  }

  async addIceCandidate(candidate = null) {
    this._assertNotClosed();
    const hasArgument = arguments.length > 0;
    if (!hasArgument && !this.remoteDescription && this._operationsPending === 0) {
      throw makeDOMException("Remote description is not set", "InvalidStateError");
    }
    if (candidate === null && hasArgument && !this.remoteDescription) return;
    const normalized = normalizeAddIceCandidateInput(candidate);
    if (!this.remoteDescription && this._operationsPending === 0) {
      throw makeDOMException("Remote description is not set", "InvalidStateError");
    }
    const finishOperation = await this._beginPendingOperation();
    try {
      await nextTask();
      await this._addIceCandidateWithoutChain(normalized);
    } catch (error) {
      throw mapNativeError(error, "OperationError");
    } finally {
      finishOperation();
    }
  }

  async _addIceCandidateWithoutChain(candidate) {
    if (candidate instanceof RTCIceCandidate && candidate._webrtcNodeLocalCandidate) {
      await this._addExchangedLocalCandidate(candidate);
      return;
    }
    const normalized = normalizeAddIceCandidateInput(candidate);
    if (!this.remoteDescription) {
      throw makeDOMException("Remote description is not set", "InvalidStateError");
    }
    const remoteDescription = appendRemoteCandidateToDescription(
      this._remoteDescription,
      normalized,
    );
    if (normalized.candidate === "") {
      this._refreshCurrentOrPendingRemoteDescription(remoteDescription);
      return;
    }
    const nativeCandidate = normalized.toJSON();
    if (nativeCandidate.sdpMid === null) {
      nativeCandidate.sdpMid = resolveCandidateMid(this._remoteDescription, normalized);
    }
    if (nativeCandidate.candidate) {
      this._rememberRemoteIceCandidate(
        new RTCIceCandidate({
          candidate: nativeCandidate.candidate,
          sdpMid: nativeCandidate.sdpMid,
          sdpMLineIndex: nativeCandidate.sdpMLineIndex,
          usernameFragment: nativeCandidate.usernameFragment,
        }),
      );
      this._markExplicitIceCandidateExchange();
    }
    if (this._shouldDeferRemoteCandidateUntilLocalAnswer()) {
      this._queuePendingRemoteCandidatesForNative([normalized]);
      this._refreshCurrentOrPendingRemoteDescription(remoteDescription);
      return;
    }
    this._ensureNativePeerConnection().addRemoteCandidate(nativeCandidate);
    this._refreshCurrentOrPendingRemoteDescription(remoteDescription);
  }

  async _addExchangedLocalCandidate(candidate) {
    if (!candidate.candidate) return;
    this._sameProcessIceCandidateExchange = true;
    if (this._pairedPeer) this._pairedPeer._sameProcessIceCandidateExchange = true;
    this._rememberRemoteIceCandidate(candidate);
    this._markExplicitIceCandidateExchange();
    if (!this.remoteDescription || this._shouldDeferRemoteCandidateUntilLocalAnswer()) {
      if (!this._pendingIce.some((entry) => sameCandidate(entry, candidate))) {
        this._pendingIce.push(candidate);
      }
      return;
    }

    if (this._remoteDescription?.sdp?.includes(candidate.candidate)) return;
    const nativeCandidate = candidate.toJSON();
    if (nativeCandidate.sdpMid === null) {
      nativeCandidate.sdpMid = resolveCandidateMid(this._remoteDescription, candidate);
    }
    try {
      this._ensureNativePeerConnection().addRemoteCandidate(nativeCandidate);
      this._refreshCurrentOrPendingRemoteDescription(
        appendRemoteCandidateToDescription(this._remoteDescription, candidate),
      );
    } catch {
      // Exchanged local candidates are delivered from event handlers that do
      // not await addIceCandidate(); keep them best-effort like browser ICE.
    }
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    for (const transceiver of this._transceivers) {
      this._detachSenderSource(transceiver.sender);
    }
    const pairedPeer = this._pairedPeer;
    this._unregisterLocalDescriptionsForPairing();
    const nativePeer = this._native;
    if (nativePeer) {
      try {
        if (nativePeer.signalingState === "have-remote-offer" && this._lastCreatedAnswer) {
          nativePeer.setLocalDescription("answer");
          this._commitRemoteDescription();
          this._commitLocalDescription(this._lastCreatedAnswer);
          setTimeout(() => {
            try {
              nativePeer.close();
            } catch {
              // The JavaScript peer is already observably closed.
            }
          }, 0);
        } else {
          nativePeer.close();
        }
      } catch {
        // JS-visible close state is already final; native teardown is best-effort.
      }
    }
    setImmediate(() => {
      if (pairedPeer && !pairedPeer._closed) pairedPeer._handleRemotePeerClosed();
    });
    this._connectionState = "closed";
    this._iceConnectionState = "closed";
    this._iceGatheringState = "new";
    this._deferredIceEvents = [];
    this._preparedLocalDescription = null;
    this._nonstandardPreparedLocalDescriptionType = null;
    this._nonstandardLocalIceCredentials = null;
    this._signalingState = "closed";
    this._updateSctpTransport();
    for (const channel of this._channels.values()) {
      if (channel.readyState !== "closed") channel._handleClose();
    }
    for (const transceiver of this._transceivers) {
      transceiver._stopping = false;
      transceiver._stopped = true;
      transceiver._currentDirection = "stopped";
      const receiverTrack = transceiver.receiver.track;
      if (receiverTrack.readyState !== "ended") {
        const source = mediaTrackSources.get(receiverTrack);
        if (source?._endTracks) source._endTracks();
        else {
          receiverTrack._readyState = "ended";
          notifyTrackStateChanged(receiverTrack);
          receiverTrack.dispatchEvent(makeEvent("ended"));
        }
      }
    }
    this.dispatchEvent(makeEvent("iceconnectionstatechange"));
    this.dispatchEvent(makeEvent("connectionstatechange"));
  }

  _registerLocalDescriptionForPairing() {
    const key = descriptionPairingKey(this._localDescription);
    if (!key) return;
    localDescriptionOwners.set(key, new WeakRef(this));
    if (!this._localDescriptionPairingKeys.has(key)) {
      localDescriptionOwnerFinalizer.register(this, key, this);
    }
    this._localDescriptionPairingKeys.add(key);
  }

  _unregisterLocalDescriptionsForPairing() {
    localDescriptionOwnerFinalizer.unregister(this);
    for (const key of this._localDescriptionPairingKeys) {
      const owner = localDescriptionOwners.get(key)?.deref();
      if (!owner || owner === this) localDescriptionOwners.delete(key);
    }
    this._localDescriptionPairingKeys.clear();
    if (this._pairedPeer?._pairedPeer === this) this._pairedPeer._pairedPeer = null;
    this._pairedPeer = null;
  }

  _pairWithRemoteDescription(description) {
    const key = descriptionPairingKey(description);
    if (!key) return;
    const peerRef = localDescriptionOwners.get(key);
    const peer = peerRef?.deref();
    const ownCreatedOffer =
      description?.type === "offer" && this._lastCreatedOffer?.sdp === description.sdp;
    if (!peer) {
      if (peerRef) localDescriptionOwners.delete(key);
      this._selfRemoteDescription = ownCreatedOffer;
      return;
    }
    if (peer === this) {
      this._selfRemoteDescription = true;
      return;
    }
    if (peer._closed) return;
    this._selfRemoteDescription = false;
    this._pairedPeer = peer;
    peer._pairedPeer = this;
    if (this._explicitIceCandidateExchange || peer._explicitIceCandidateExchange) {
      this._explicitIceCandidateExchange = true;
      peer._explicitIceCandidateExchange = true;
    }
    if (this._sameProcessIceCandidateExchange || peer._sameProcessIceCandidateExchange) {
      this._sameProcessIceCandidateExchange = true;
      peer._sameProcessIceCandidateExchange = true;
    }
    this._pairExistingDataChannels();
    peer._pairExistingDataChannels();
    this._scheduleDataChannelAnnouncementRepair();
    peer._scheduleDataChannelAnnouncementRepair();
  }

  _markExplicitIceCandidateExchange() {
    this._explicitIceCandidateExchange = true;
    this._updateSctpTransport();
    if (this._pairedPeer && !this._pairedPeer._explicitIceCandidateExchange) {
      this._pairedPeer._explicitIceCandidateExchange = true;
      this._pairedPeer._scheduleSctpTransportUpdate();
    }
  }

  _rememberLocalIceCandidate(candidate) {
    if (!candidate?.candidate) return;
    if (!this._localIceCandidates.some((entry) => sameCandidate(entry, candidate))) {
      this._localIceCandidates.push(candidate);
    }
  }

  _rememberRemoteIceCandidate(candidate) {
    if (!candidate?.candidate) return;
    if (!this._remoteIceCandidates.some((entry) => sameCandidate(entry, candidate))) {
      this._remoteIceCandidates.push(candidate);
    }
  }

  _refreshIceRole() {
    if (this._localDescription?.type === "offer" && this._remoteDescription?.type === "answer") {
      this._iceRole = "controlling";
      return;
    }
    if (this._remoteDescription?.type === "offer" && this._localDescription?.type === "answer") {
      this._iceRole = "controlled";
      return;
    }
    this._iceRole = "unknown";
  }

  _iceTransport() {
    return this._dtlsTransport?.iceTransport || null;
  }

  _ensureDtlsTransport() {
    if (!this._dtlsTransport) {
      this._dtlsTransport = new RTCDtlsTransport(kInternalConstruct, this);
    }
    return this._dtlsTransport;
  }

  _pairExistingDataChannels() {
    for (const channel of this._channels.values()) {
      const id = channel.id;
      if (id != null) this._pairDataChannelById(channel, id);
    }
  }

  _pairDataChannelById(channel, id) {
    if (!this._pairedPeer || id == null || channel.readyState === "closed") return;
    for (const peerChannel of this._pairedPeer._channels.values()) {
      if (peerChannel.readyState === "closed") continue;
      if (peerChannel.id === id) {
        channel._pairedChannel = peerChannel;
        peerChannel._pairedChannel = channel;
        return;
      }
    }
  }

  _handleRemotePeerClosed() {
    if (this._closed) return;
    this._connectionState = "disconnected";
    this._iceConnectionState = "disconnected";
    this._updateSctpTransport();
    this._iceTransport()?._forceState("disconnected");
    this.dispatchEvent(makeEvent("iceconnectionstatechange"));
    this.dispatchEvent(makeEvent("connectionstatechange"));
    this._closeChannelsOnPeerFailure({ includeDisconnected: true });
  }

  _updateSctpTransport() {
    this._dtlsTransport?._syncState();
    const hasData =
      hasDataMediaSection(this._localDescription) || hasDataMediaSection(this._remoteDescription);
    if (!hasData) {
      this._sctpConnectedTransitionReady = false;
      this._sctpTransport = null;
      return;
    }

    if (!this._sctpTransport) {
      this._sctpTransport = new RTCSctpTransport(
        kInternalConstruct,
        this,
        this._ensureDtlsTransport(),
      );
    }
    const closed =
      this._closed ||
      this._connectionState === "closed" ||
      this._iceConnectionState === "closed" ||
      this._connectionState === "failed" ||
      this._iceConnectionState === "failed" ||
      this._connectionState === "disconnected" ||
      this._iceConnectionState === "disconnected";
    const dataTransportNegotiated =
      hasDataMediaSection(this._localDescription) && hasDataMediaSection(this._remoteDescription);
    const pairedDataTransportNegotiated =
      this._pairedPeer &&
      hasDataMediaSection(this._pairedPeer._localDescription) &&
      hasDataMediaSection(this._pairedPeer._remoteDescription);
    const nativeTransportConnected =
      this._connectionState === "connected" ||
      this._iceConnectionState === "connected" ||
      this._iceConnectionState === "completed";
    const pairedNativeTransportConnected =
      this._pairedPeer &&
      (this._pairedPeer._connectionState === "connected" ||
        this._pairedPeer._iceConnectionState === "connected" ||
        this._pairedPeer._iceConnectionState === "completed");
    const nativeConnected =
      nativeTransportConnected && dataTransportNegotiated && !this._selfRemoteDescription;
    const sameProcessConnected =
      this._sameProcessIceCandidateExchange &&
      dataTransportNegotiated &&
      pairedDataTransportNegotiated &&
      (nativeTransportConnected || pairedNativeTransportConnected);
    const operationsSettled =
      (this._operationsPending === 0 &&
        (!this._pairedPeer || this._pairedPeer._operationsPending === 0)) ||
      this._sctpTransport.state === "connected";
    const shouldConnect = (nativeConnected || sameProcessConnected) && operationsSettled;
    let connected = shouldConnect;
    if (closed || !shouldConnect) this._sctpConnectedTransitionReady = false;
    if (
      shouldConnect &&
      this._sctpTransport.state !== "connected" &&
      !this._sctpConnectedTransitionReady
    ) {
      this._scheduleSctpConnectedTransition();
      connected = false;
    }
    this._sctpTransport._setLimits({
      maxMessageSize: this._currentSctpMaxMessageSize(),
      maxChannels: connected ? this._currentSctpMaxChannels() : null,
    });
    this._sctpTransport._setState(closed ? "closed" : connected ? "connected" : "connecting");
    if (connected || closed) this._sctpConnectPollDeadline = 0;
    if (connected) {
      this._scheduleConnectedStateRepair();
      this._scheduleDataChannelOpenRepair();
      this._scheduleDataChannelAnnouncementRepair();
      this._pairedPeer?._scheduleDataChannelAnnouncementRepair();
    }
    this._scheduleSctpConnectPollIfNeeded();
  }

  _scheduleSctpConnectedTransition() {
    if (this._sctpConnectedTransitionScheduled) return;
    this._sctpConnectedTransitionScheduled = true;
    setImmediate(() => {
      this._sctpConnectedTransitionScheduled = false;
      if (this._closed || !this._sctpTransport) return;
      this._sctpConnectedTransitionReady = true;
      this._updateSctpTransport();
    });
  }

  _shouldRepairConnectedState() {
    return Boolean(
      !this._closed &&
        this._sctpTransport?.state === "connected" &&
        this._sameProcessIceCandidateExchange &&
        this._hasNegotiatedDataTransport() &&
        this._pairedPeer?._hasNegotiatedDataTransport() &&
        this._operationsPending === 0 &&
        this._pairedPeer._operationsPending === 0 &&
        this._connectionState !== "failed" &&
        this._connectionState !== "disconnected" &&
        this._iceConnectionState !== "failed" &&
        this._iceConnectionState !== "disconnected" &&
        (this._connectionState !== "connected" ||
          !["connected", "completed"].includes(this._iceConnectionState)),
    );
  }

  _scheduleConnectedStateRepair() {
    if (this._connectedStateRepairScheduled || !this._shouldRepairConnectedState()) return;
    this._connectedStateRepairScheduled = true;
    setTimeout(() => {
      this._connectedStateRepairScheduled = false;
      if (!this._shouldRepairConnectedState()) return;

      if (this._iceConnectionState === "new") {
        this._iceConnectionState = "checking";
        this.dispatchEvent(makeEvent("iceconnectionstatechange"));
        this._iceTransport()?._handlePeerIceConnectionState("checking");
      }
      if (this._connectionState === "new") {
        this._connectionState = "connecting";
        this.dispatchEvent(makeEvent("connectionstatechange"));
      }

      setTimeout(() => {
        if (!this._shouldRepairConnectedState()) return;
        if (!["connected", "completed"].includes(this._iceConnectionState)) {
          this._iceConnectionState = "connected";
          this.dispatchEvent(makeEvent("iceconnectionstatechange"));
          this._iceTransport()?._handlePeerIceConnectionState("connected");
        }
        if (this._connectionState !== "connected") {
          this._connectionState = "connected";
          this._updateSctpTransport();
          this.dispatchEvent(makeEvent("connectionstatechange"));
        }
      }, 0);
    }, 0);
  }

  _hasNegotiatedDataTransport() {
    return (
      hasDataMediaSection(this._localDescription) && hasDataMediaSection(this._remoteDescription)
    );
  }

  _hasExplicitlyNegotiatedDataTransport() {
    return this._localDescriptionSetByApi && this._hasNegotiatedDataTransport();
  }

  _shouldDeferRemoteCandidateUntilLocalAnswer() {
    return (
      this._remoteDescription?.type === "offer" &&
      (this._signalingState === "have-remote-offer" ||
        this._pairedPeer?.signalingState === "have-local-offer" ||
        this._operationsPending > 0 ||
        this._pairedPeer?._operationsPending > 0)
    );
  }

  _queuePendingRemoteCandidatesForNative(candidates) {
    for (const candidate of candidates) {
      if (!candidate?.candidate) continue;
      if (
        !this._pendingRemoteCandidatesForNative.some((entry) => sameCandidate(entry, candidate))
      ) {
        this._pendingRemoteCandidatesForNative.push(candidate);
      }
    }
  }

  _flushPendingRemoteCandidatesForNative() {
    if (!this._remoteDescription || this._shouldDeferRemoteCandidateUntilLocalAnswer()) return;
    const candidates = this._pendingRemoteCandidatesForNative.splice(0);
    for (const candidate of candidates) {
      try {
        const nativeCandidate = candidate.toJSON();
        if (nativeCandidate.sdpMid === null) {
          nativeCandidate.sdpMid = resolveCandidateMid(this._remoteDescription, candidate);
        }
        this._ensureNativePeerConnection().addRemoteCandidate(nativeCandidate);
      } catch {
        // Same-process and inline SDP candidate races are best-effort.
      }
    }
  }

  async _beginPendingOperation() {
    this._operationsPending += 1;
    const predecessor = this._operationTail;
    let release;
    this._operationTail = new Promise((resolve) => {
      release = resolve;
    });
    await predecessor;
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      release();
      this._finishPendingOperation();
    };
  }

  _finishPendingOperation() {
    this._operationsPending = Math.max(0, this._operationsPending - 1);
    if (this._operationsPending === 0) {
      this._scheduleSctpTransportUpdate();
      this._scheduleNegotiationNeededEvent();
      if (this._pairedPeer && !this._pairedPeer._closed) {
        this._pairedPeer._scheduleSctpTransportUpdate();
      }
      this._flushPendingRemoteCandidatesForNative();
      this._pairedPeer?._flushPendingRemoteCandidatesForNative();
      this._scheduleDeferredIceEventFlush();
      const callbacks = this._operationIdleCallbacks.splice(0);
      for (const callback of callbacks) setImmediate(callback);
    }
  }

  _afterOperationsIdle(callback) {
    if (this._closed || this._operationsPending === 0) {
      setImmediate(callback);
      return;
    }
    this._operationIdleCallbacks.push(callback);
  }

  _shouldDeferIceEvent(event) {
    if (this._processingDeferredIceEvent || this._operationsPending === 0) return false;
    return event.type === "localcandidate" || event.type === "icegatheringstatechange";
  }

  _scheduleDeferredIceEventFlush() {
    if (this._iceEventFlushScheduled || this._deferredIceEvents.length === 0) return;
    this._iceEventFlushScheduled = true;
    setImmediate(() => {
      this._iceEventFlushScheduled = false;
      if (this._closed) {
        this._deferredIceEvents = [];
        this._flushIceEventIdleCallbacks();
        return;
      }
      if (this._operationsPending > 0) {
        this._scheduleDeferredIceEventFlush();
        return;
      }
      const event = this._deferredIceEvents.shift();
      this._processingDeferredIceEvent = true;
      try {
        if (event) this._handleNativeEvent(event);
      } finally {
        this._processingDeferredIceEvent = false;
      }
      if (this._deferredIceEvents.length) this._scheduleDeferredIceEventFlush();
      else this._flushIceEventIdleCallbacks();
    });
  }

  _hasPendingDeferredIceEvents() {
    return (
      this._deferredIceEvents.length > 0 ||
      this._iceEventFlushScheduled ||
      this._processingDeferredIceEvent
    );
  }

  _afterDeferredIceEventsFlushed(callback) {
    if (this._closed || !this._hasPendingDeferredIceEvents()) {
      setImmediate(callback);
      return;
    }
    this._iceEventIdleCallbacks.push(callback);
    this._scheduleDeferredIceEventFlush();
  }

  _flushIceEventIdleCallbacks() {
    if (this._hasPendingDeferredIceEvents()) return;
    const callbacks = this._iceEventIdleCallbacks.splice(0);
    for (const callback of callbacks) setImmediate(callback);
  }

  _queueSyntheticIceRestartGathering() {
    const hasGatheringStateEvent = this._deferredIceEvents.some(
      (event) => event.type === "icegatheringstatechange",
    );
    if (hasGatheringStateEvent) return;
    this._deferredIceEvents.push(
      { type: "icegatheringstatechange", state: "gathering" },
      { type: "icegatheringstatechange", state: "complete" },
    );
  }

  _scheduleSctpTransportUpdate() {
    if (this._sctpTransportUpdateScheduled) return;
    this._sctpTransportUpdateScheduled = true;
    setImmediate(() => {
      this._sctpTransportUpdateScheduled = false;
      if (
        !this._closed &&
        this._connectionState !== "closed" &&
        this._iceConnectionState !== "closed" &&
        this._native
      ) {
        this._connectionState = this._native.connectionState;
        this._iceConnectionState = this._native.iceConnectionState;
      }
      this._updateSctpTransport();
    });
  }

  _scheduleSctpConnectPollIfNeeded() {
    if (
      this._closed ||
      this._operationsPending > 0 ||
      this._pairedPeer?._operationsPending > 0 ||
      this._sctpTransport?.state !== "connecting" ||
      !hasDataMediaSection(this._localDescription) ||
      !hasDataMediaSection(this._remoteDescription)
    ) {
      return;
    }

    const now = Date.now();
    if (!this._sctpConnectPollDeadline) {
      this._sctpConnectPollDeadline = now + SCTP_CONNECT_POLL_TIMEOUT_MS;
    }
    if (this._sctpConnectPollScheduled || now >= this._sctpConnectPollDeadline) return;
    this._sctpConnectPollScheduled = true;
    setTimeout(() => {
      this._sctpConnectPollScheduled = false;
      if (this._closed || this._sctpTransport?.state !== "connecting") return;
      this._scheduleSctpTransportUpdate();
    }, SCTP_CONNECT_POLL_INTERVAL_MS);
  }

  _scheduleDataChannelOpenRepair() {
    if (this._closed || this._dataChannelOpenRepairScheduled) return;
    if (this._sctpTransport?.state !== "connected") return;
    const now = Date.now();
    if (!this._dataChannelOpenRepairDeadline) {
      this._dataChannelOpenRepairDeadline = now + DATA_CHANNEL_OPEN_REPAIR_TIMEOUT_MS;
    }
    if (now >= this._dataChannelOpenRepairDeadline) return;
    this._dataChannelOpenRepairScheduled = true;
    setTimeout(() => {
      this._dataChannelOpenRepairScheduled = false;
      if (this._closed || this._sctpTransport?.state !== "connected") return;
      let hasConnectingChannel = false;
      for (const channel of this._channels.values()) {
        if (channel.readyState === "connecting") {
          hasConnectingChannel = true;
          channel._repairMissedOpenEvent();
        }
      }
      if (hasConnectingChannel) {
        this._scheduleDataChannelOpenRepair();
      } else {
        this._dataChannelOpenRepairDeadline = 0;
      }
    }, DATA_CHANNEL_OPEN_REPAIR_INTERVAL_MS);
  }

  _scheduleDataChannelAnnouncementRepair() {
    if (this._closed || this._dataChannelAnnouncementRepairScheduled) return;
    if (!this._hasDataChannelAnnouncementRepairCandidates()) {
      this._dataChannelAnnouncementRepairReadyAt = 0;
      this._dataChannelAnnouncementRepairDeadline = 0;
      return;
    }
    const now = Date.now();
    const canRepair = this._canRepairDataChannelAnnouncements();
    if (canRepair && !this._dataChannelAnnouncementRepairDeadline) {
      this._dataChannelAnnouncementRepairReadyAt = now + DATA_CHANNEL_ANNOUNCEMENT_REPAIR_GRACE_MS;
      this._dataChannelAnnouncementRepairDeadline =
        now + DATA_CHANNEL_ANNOUNCEMENT_REPAIR_TIMEOUT_MS;
    }
    if (canRepair && now >= this._dataChannelAnnouncementRepairDeadline) {
      this._dataChannelAnnouncementRepairReadyAt = 0;
      this._dataChannelAnnouncementRepairDeadline = 0;
      return;
    }
    this._dataChannelAnnouncementRepairScheduled = true;
    setTimeout(() => {
      this._dataChannelAnnouncementRepairScheduled = false;
      if (this._closed) return;
      const repairable = this._canRepairDataChannelAnnouncements();
      if (repairable && !this._dataChannelAnnouncementRepairDeadline) {
        const now = Date.now();
        this._dataChannelAnnouncementRepairReadyAt =
          now + DATA_CHANNEL_ANNOUNCEMENT_REPAIR_GRACE_MS;
        this._dataChannelAnnouncementRepairDeadline =
          now + DATA_CHANNEL_ANNOUNCEMENT_REPAIR_TIMEOUT_MS;
      }
      const canCreateSyntheticAnnouncement =
        this._pendingSyntheticDataChannelAnnouncements.size > 0 ||
        Date.now() >= this._dataChannelAnnouncementRepairReadyAt;
      const hasWork = repairable
        ? canCreateSyntheticAnnouncement
          ? this._repairMissingDataChannelAnnouncements()
          : this._hasDataChannelAnnouncementRepairCandidates()
        : this._hasDataChannelAnnouncementRepairCandidates();
      if (hasWork) {
        this._scheduleDataChannelAnnouncementRepair();
      } else {
        this._dataChannelAnnouncementRepairReadyAt = 0;
        this._dataChannelAnnouncementRepairDeadline = 0;
      }
    }, DATA_CHANNEL_ANNOUNCEMENT_REPAIR_INTERVAL_MS);
  }

  _canRepairDataChannelAnnouncements() {
    return Boolean(
      this._pairedPeer &&
        !this._pairedPeer._closed &&
        this._operationsPending === 0 &&
        this._pairedPeer._operationsPending === 0 &&
        this._hasNegotiatedDataTransport() &&
        this._pairedPeer._hasNegotiatedDataTransport(),
    );
  }

  _hasDataChannelAnnouncementRepairCandidates() {
    if (!this._pairedPeer || this._pairedPeer._closed) return false;
    if (this._pendingSyntheticDataChannelAnnouncements.size > 0) return true;
    for (const sourceChannel of this._pairedPeer._channels.values()) {
      if (
        !sourceChannel._createdLocally ||
        sourceChannel.negotiated ||
        sourceChannel.readyState === "closed"
      ) {
        continue;
      }
      const id = sourceChannel._effectiveId();
      if (id == null || !this._hasRemoteDataChannelForId(id)) return true;
    }
    return false;
  }

  _repairMissingDataChannelAnnouncements() {
    if (!this._pairedPeer || this._pairedPeer._closed) return false;
    let hasPendingWork = false;

    for (const [id, channel] of this._pendingSyntheticDataChannelAnnouncements) {
      if (channel.readyState === "closed") {
        this._pendingSyntheticDataChannelAnnouncements.delete(id);
        continue;
      }
      if (!channel._native.isOpen) {
        hasPendingWork = true;
        continue;
      }
      channel._readyState = "open";
      channel._recordStatsOpened();
      channel._openEventPending = true;
      channel._announcementPending = true;
      const sourceChannel = channel._pairedChannel;
      if (sourceChannel?.readyState === "connecting") {
        sourceChannel._readyState = "open";
        sourceChannel._recordStatsOpened();
        sourceChannel._pc._registerDataChannelId(sourceChannel);
        sourceChannel._dispatchOpenEvent();
      }
      this._remoteAnnouncedDataChannelIds.add(id);
      this._pendingSyntheticDataChannelAnnouncements.delete(id);
      this._pendingDataChannelEvents.push(new RTCDataChannelEvent("datachannel", { channel }));
      this._scheduleDataChannelFlush();
    }

    for (const sourceChannel of this._pairedPeer._channels.values()) {
      if (
        !sourceChannel._createdLocally ||
        sourceChannel.negotiated ||
        sourceChannel.readyState === "closed"
      ) {
        continue;
      }
      let id = sourceChannel.id;
      if (id == null) {
        this._assignSyntheticDataChannelIdIfNeeded(sourceChannel);
        id = sourceChannel.id;
      }
      if (id == null) {
        hasPendingWork = true;
        continue;
      }
      if (this._hasRemoteDataChannelForId(id)) continue;
      const channel = this._createSyntheticIncomingDataChannel(sourceChannel, id);
      if (channel) hasPendingWork = true;
    }

    return hasPendingWork || this._pendingSyntheticDataChannelAnnouncements.size > 0;
  }

  _assignSyntheticDataChannelIdIfNeeded(channel) {
    if (channel.negotiated || channel._effectiveId() != null || channel.readyState === "closed") {
      return;
    }
    const parity = channel._pc._dataChannelIdParityFromDtlsRole() ?? 1;
    const id = channel._pc._nextAvailableDataChannelId(parity);
    if (id != null) channel._assignId(id);
  }

  _hasRemoteDataChannelForId(id) {
    if (
      this._remoteAnnouncedDataChannelIds.has(id) ||
      this._pendingSyntheticDataChannelAnnouncements.has(id)
    ) {
      return true;
    }
    for (const channel of this._channels.values()) {
      if (!channel._createdLocally && channel.readyState !== "closed" && channel.id === id)
        return true;
    }
    return false;
  }

  _syntheticIncomingDataChannelForId(id) {
    const pending = this._pendingSyntheticDataChannelAnnouncements.get(id);
    if (pending && pending.readyState !== "closed") return pending;
    for (const event of this._pendingDataChannelEvents) {
      const channel = event.channel;
      if (channel?._syntheticIncoming && channel.readyState !== "closed" && channel.id === id) {
        return channel;
      }
    }
    for (const channel of this._channels.values()) {
      if (channel._syntheticIncoming && channel.readyState !== "closed" && channel.id === id) {
        return channel;
      }
    }
    return null;
  }

  _hasPendingDataChannelEventForId(id) {
    return this._pendingDataChannelEvents.some((event) => {
      const channel = event.channel;
      const channelId =
        typeof channel?._effectiveId === "function" ? channel._effectiveId() : channel?.id;
      return channelId === id;
    });
  }

  _hasSettledDataChannelAnnouncement(id) {
    if (id == null) return false;
    if (
      this._pendingSyntheticDataChannelAnnouncements.has(id) ||
      this._hasPendingDataChannelEventForId(id)
    ) {
      return false;
    }
    if (this._remoteAnnouncedDataChannelIds.has(id)) return true;
    for (const channel of this._channels.values()) {
      if (!channel._createdLocally && channel.readyState !== "closed" && channel.id === id) {
        return true;
      }
    }
    return false;
  }

  _afterDataChannelAnnouncementSettled(id, callback) {
    const deadline = Date.now() + DATA_CHANNEL_ANNOUNCEMENT_REPAIR_TIMEOUT_MS;
    const poll = () => {
      const settled = this._hasSettledDataChannelAnnouncement(id);
      if (
        settled ||
        this._closed ||
        !this._hasEventConsumer("datachannel") ||
        Date.now() >= deadline
      ) {
        setTimeout(() => callback(settled), 0);
        return;
      }
      this._scheduleDataChannelAnnouncementRepair();
      this._scheduleDataChannelFlush();
      setTimeout(poll, DATA_CHANNEL_ANNOUNCEMENT_REPAIR_INTERVAL_MS);
    };
    setTimeout(poll, 0);
  }

  _createSyntheticIncomingDataChannel(sourceChannel, id) {
    const options = {
      ordered: sourceChannel.ordered,
      maxPacketLifeTime: sourceChannel.maxPacketLifeTime,
      maxRetransmits: sourceChannel.maxRetransmits,
      protocol: sourceChannel.protocol,
      negotiated: true,
      id,
    };
    const nativeChannel = new SyntheticNativeDataChannel(sourceChannel.label, options);
    const channel = RTCDataChannel._fromNative(this, nativeChannel, undefined, id);
    channel._createdLocally = false;
    channel._negotiatedOverride = false;
    channel._syntheticIncoming = true;
    channel._pairedChannel = sourceChannel;
    sourceChannel._pairedChannel = channel;
    this._pendingSyntheticDataChannelAnnouncements.set(id, channel);
    return channel;
  }

  _currentSctpMaxMessageSize() {
    if (!this._localDescription || !this._remoteDescription) return null;
    if (
      !hasDataMediaSection(this._localDescription) ||
      !hasDataMediaSection(this._remoteDescription)
    )
      return null;
    if (this._selfRemoteDescription && !this._explicitIceCandidateExchange) return null;
    const localLimit =
      maxMessageSizeFromSdp(this._localDescription) || DEFAULT_SCTP_MAX_MESSAGE_SIZE;
    const remoteLimit = maxMessageSizeFromSdp(this._remoteDescription);
    if (remoteLimit === null) return Math.min(65536, localLimit);
    if (remoteLimit === 0) return localLimit || Number.POSITIVE_INFINITY;
    return localLimit === 0 ? remoteLimit : Math.min(remoteLimit, localLimit);
  }

  _currentSctpMaxChannels() {
    const connected =
      this._connectionState === "connected" || this._sctpTransport?.state === "connected";
    if (!connected || this._selfRemoteDescription) return null;
    if (!this._native) return null;
    const maxId = Number(this._native.maxDataChannelId);
    return Number.isFinite(maxId) && maxId >= 0 ? maxId + 1 : LIBDATACHANNEL_SCTP_MAX_CHANNELS;
  }

  _implicitLocalDescriptionType() {
    return this._signalingState === "have-remote-offer" ? "answer" : "offer";
  }

  _descriptionSignalingState() {
    if (this._closed) return "closed";
    if (this._pendingLocalDescription?.type === "offer") return "have-local-offer";
    if (this._pendingRemoteDescription?.type === "offer") return "have-remote-offer";
    if (this._pendingLocalDescription?.type === "pranswer") return "have-local-pranswer";
    if (this._pendingRemoteDescription?.type === "pranswer") return "have-remote-pranswer";
    return "stable";
  }

  _syncSignalingStateFromDescriptions() {
    if (this._jsOnlyIceRestartOfferPending) {
      this._signalingState = "have-local-offer";
      return;
    }
    this._signalingState = this._descriptionSignalingState();
    if (this._signalingState === "stable") {
      this._updateNegotiatedTransceivers();
      this._scheduleNegotiationNeededEvent();
    }
  }

  _updateNegotiatedTransceivers() {
    const localIsAnswer = this._currentLocalDescription?.type === "answer";
    const answer = localIsAnswer ? this._currentLocalDescription : this._currentRemoteDescription;
    if (answer?.type !== "answer") return;
    for (const transceiver of this._transceivers) {
      if (transceiver._stopped) continue;
      if (transceiver._stopping) {
        this._detachSenderSource(transceiver.sender);
        transceiver._stopping = false;
        transceiver._stopped = true;
        transceiver._currentDirection = "stopped";
        transceiver._mid = null;
        transceiver._nativeSendTrack?.close();
        transceiver._nativeReceiveTrack?.close();
        transceiver._nativeAnnouncedReceiveTrack?.close();
        for (const nativeTrack of transceiver._nativeReceiveTracks) nativeTrack.close();
        this._queueReceiverTrackEnded(transceiver);
        continue;
      }
      const answerDirection = mediaDirectionByMid(answer, transceiver.mid);
      const answerSection = mediaSectionByMid(answer, transceiver.mid);
      if (answerSection && /^m=\S+\s+0\s/m.test(answerSection)) {
        if (!localIsAnswer && !transceiver._provisionalRemoteOffer) {
          transceiver._remoteStopping = false;
          transceiver._currentDirection = "inactive";
          transceiver._provisionalRemoteOffer = false;
          transceiver._reusedForRemoteOffer = false;
          continue;
        }
        transceiver._stopping = false;
        transceiver._remoteStopping = false;
        transceiver._stopped = true;
        transceiver._currentDirection = "stopped";
        transceiver._mid = null;
        this._detachSenderSource(transceiver.sender);
        transceiver._nativeSendTrack?.close();
        transceiver._nativeReceiveTrack?.close();
        transceiver._nativeAnnouncedReceiveTrack?.close();
        for (const nativeTrack of transceiver._nativeReceiveTracks) nativeTrack.close();
        this._queueReceiverTrackEnded(transceiver);
        continue;
      }
      transceiver._currentDirection = localIsAnswer
        ? answerDirection
        : reverseDirection(answerDirection);
      transceiver._provisionalRemoteOffer = false;
      transceiver._reusedForRemoteOffer = false;
      if (
        transceiver._currentDirection === "sendrecv" ||
        transceiver._currentDirection === "sendonly"
      ) {
        transceiver._hasEverSent = true;
      }
    }
  }

  _dispatchSignalingStateChange() {
    this._lastDispatchedSignalingState = this._signalingState;
    this.dispatchEvent(makeEvent("signalingstatechange"));
  }

  _setPendingLocalDescription(description) {
    if (description?.type === "offer") {
      const sections = parseSdpMediaSections(description.sdp).mediaSections;
      for (const transceiver of this._transceivers) {
        if (transceiver._mid !== null || transceiver._nativeMid === null) continue;
        const section = sections.find((entry) => entry.mid === transceiver._nativeMid);
        if (!section) continue;
        transceiver._mid = section.mid;
        transceiver._midAssignedByPendingLocalOffer = true;
      }
    }
    this._pendingLocalDescription = description;
    this._localDescription = description || this._currentLocalDescription;
    if (description?.type === "offer") {
      this._pendingLocalNegotiationRevision = this._revisionForLocalDescription(description);
      this._recomputeNegotiationNeeded(this._pendingLocalNegotiationRevision);
    }
  }

  _commitLocalDescription(description = this._pendingLocalDescription || this._localDescription) {
    if (description) this._currentLocalDescription = description;
    if (description?.type === "offer") {
      this._negotiatedRevision = Math.max(
        this._negotiatedRevision,
        this._pendingLocalNegotiationRevision ?? this._revisionForLocalDescription(description),
      );
      this._pendingLocalNegotiationRevision = null;
    } else if (
      description?.type === "answer" &&
      this._answerRepresentsPendingNegotiation(description)
    ) {
      this._negotiatedRevision = Math.max(
        this._negotiatedRevision,
        this._revisionForLocalDescription(description),
      );
    }
    this._pendingLocalDescription = null;
    this._localDescription = this._currentLocalDescription;
    for (const transceiver of this._transceivers) {
      transceiver._midAssignedByPendingLocalOffer = false;
    }
    this._recomputeNegotiationNeeded();
  }

  _answerRepresentsPendingNegotiation(description) {
    if (
      this._localDataChannelCount > 0 &&
      !parseSdpMediaSections(description.sdp).mediaSections.some((section) =>
        /^m=application\s+(?!0(?:\s|$))/i.test(section.startLine),
      )
    ) {
      return false;
    }
    return this._transceivers.every((transceiver) => {
      if (transceiver.stopped) return true;
      if (transceiver.stopping || transceiver.mid === null) return false;
      const section = mediaSectionByMid(description, transceiver.mid);
      return Boolean(section && !/^m=\S+\s+0\s/m.test(section));
    });
  }

  _rollbackLocalDescription() {
    for (const transceiver of this._transceivers) {
      if (!transceiver._midAssignedByPendingLocalOffer) continue;
      transceiver._mid = null;
      transceiver._midAssignedByPendingLocalOffer = false;
    }
    this._pendingLocalDescription = null;
    this._localDescription = this._currentLocalDescription;
    this._pendingLocalNegotiationRevision = null;
    this._recomputeNegotiationNeeded();
  }

  _revisionForLocalDescription(description) {
    if (
      description?.type === "offer" &&
      this._lastCreatedOffer &&
      description.sdp === this._lastCreatedOffer.sdp
    ) {
      return this._lastCreatedOfferRevision ?? this._negotiationRevision;
    }
    if (
      description?.type === "answer" &&
      this._lastCreatedAnswer &&
      description.sdp === this._lastCreatedAnswer.sdp
    ) {
      return this._lastCreatedAnswerRevision ?? this._negotiationRevision;
    }
    return this._negotiationRevision;
  }

  _setPendingRemoteDescription(description) {
    this._pendingRemoteDescription = description;
    this._remoteDescription = description || this._currentRemoteDescription;
    if (description?.type === "offer") this._updateRemoteTrackAssociations(description);
  }

  _commitRemoteDescription(
    description = this._pendingRemoteDescription || this._remoteDescription,
  ) {
    if (description) this._currentRemoteDescription = description;
    this._pendingRemoteDescription = null;
    this._remoteDescription = this._currentRemoteDescription;
  }

  _rollbackRemoteDescription() {
    this._pendingRemoteDescription = null;
    this._remoteDescription = this._currentRemoteDescription;
  }

  async _implicitRollbackLocalDescription() {
    const previousState = this._signalingState;
    const previousGatheringState = this._iceGatheringState;
    const rollingBackInitialOffer = !this._currentLocalDescription;
    const nativeBackedRollback =
      this._localDescription && !hasNoActiveMedia(this._localDescription);
    if (nativeBackedRollback) {
      this._suppressNextNativeSignalingState = "stable";
      try {
        this._ensureNativePeerConnection().setLocalDescription("rollback");
      } catch (error) {
        this._suppressNextNativeSignalingState = null;
        throw error;
      }
    }
    this._rollbackLocalDescription();
    this._localIceCandidates = [];
    this._unregisterLocalDescriptionsForPairing();
    this._syncStatesFromNative();
    this._signalingState = "stable";
    if (rollingBackInitialOffer) this._iceGatheringState = "new";
    this._refreshIceRole();
    this._updateSctpTransport();
    if (rollingBackInitialOffer && previousGatheringState !== "new") {
      this.dispatchEvent(makeEvent("icegatheringstatechange"));
      this._iceTransport()?.dispatchEvent(makeEvent("gatheringstatechange"));
    }
    if (previousState !== this._signalingState) this._dispatchSignalingStateChange();
    await nextTask();
    if (this._suppressNextNativeSignalingState === "stable")
      this._suppressNextNativeSignalingState = null;
  }

  _refreshCurrentOrPendingLocalDescription(description) {
    if (!description) return;
    description = alignMediaDirections(description, this._localMediaDirectionTemplate);
    description = reconcileRejectedMediaSections(description, this._localMediaDirectionTemplate);
    this._localDescription = description;
    if (this._pendingLocalDescription?.type === description.type) {
      this._pendingLocalDescription = description;
    } else {
      this._currentLocalDescription = description;
    }
  }

  _refreshCurrentOrPendingRemoteDescription(description) {
    if (!description) return;
    this._remoteDescription = description;
    if (this._pendingRemoteDescription?.type === description.type) {
      this._pendingRemoteDescription = description;
    } else {
      this._currentRemoteDescription = description;
    }
  }

  _ensureIceRestartCredentials() {
    if (!this._pendingIceRestartCredentials) {
      this._pendingIceRestartCredentials = createIceRestartCredentials();
    }
    return this._pendingIceRestartCredentials;
  }

  _setNonstandardLocalIceCredentials(credentials) {
    this._assertNotClosed();
    if (credentials === null || typeof credentials !== "object") {
      throw new TypeError("ICE credentials must be an object");
    }
    const iceUfrag = credentials.iceUfrag;
    const icePwd = credentials.icePwd;
    if (typeof iceUfrag !== "string" || iceUfrag.length < 4) {
      throw new TypeError("iceUfrag must contain at least 4 characters");
    }
    if (typeof icePwd !== "string" || icePwd.length < 22) {
      throw new TypeError("icePwd must contain at least 22 characters");
    }
    if (byteLength(iceUfrag) > 256 || byteLength(icePwd) > 256) {
      throw new TypeError("ICE credentials must not exceed 256 bytes");
    }
    if (!/^[A-Za-z0-9+/]+$/.test(iceUfrag) || !/^[A-Za-z0-9+/]+$/.test(icePwd)) {
      throw new TypeError("ICE credentials may contain only ASCII letters, digits, +, or /");
    }
    if (this._nonstandardPreparedLocalDescriptionType) {
      const current = this._nonstandardLocalIceCredentials;
      if (current?.iceUfrag === iceUfrag && current?.icePwd === icePwd) return;
      throw makeDOMException(
        "Local ICE credentials have already been applied",
        "InvalidStateError",
      );
    }
    if (!this._canApplyNativeIceCredentials()) {
      throw makeDOMException(
        "Explicit local ICE credentials must be set before the first local description",
        "InvalidStateError",
      );
    }
    this._nonstandardLocalIceCredentials = { iceUfrag, icePwd };
  }

  _prepareNonstandardLocalDescription(type) {
    if (!this._nonstandardLocalIceCredentials) return null;
    if (this._nonstandardPreparedLocalDescriptionType) {
      if (this._nonstandardPreparedLocalDescriptionType !== type) {
        throw makeDOMException(
          "Explicit local ICE credentials were applied to another description type",
          "InvalidStateError",
        );
      }
      return this._preparedLocalDescription?.toJSON() ?? null;
    }

    this._nonstandardPreparedLocalDescriptionType = type;
    const nativeSignalingState = type === "offer" ? "have-local-offer" : "stable";
    this._suppressNextNativeSignalingState = nativeSignalingState;
    try {
      const nativePeerConnection = this._ensureNativePeerConnection();
      nativePeerConnection.setLocalDescription(type, this._nonstandardLocalIceCredentials);
      const description = nativePeerConnection.localDescription();
      if (!description) {
        throw new Error("libdatachannel did not generate a local description");
      }
      this._preparedLocalDescription = orderCodecAttributeLines(
        new RTCSessionDescription(description),
      );
      return this._preparedLocalDescription.toJSON();
    } catch (error) {
      this._nonstandardPreparedLocalDescriptionType = null;
      this._preparedLocalDescription = null;
      if (this._suppressNextNativeSignalingState === nativeSignalingState) {
        this._suppressNextNativeSignalingState = null;
      }
      throw error;
    }
  }

  _localOfferInit(type) {
    if (type !== "offer" || !this._iceRestartPending || !this._canApplyNativeIceCredentials()) {
      return undefined;
    }
    return this._ensureIceRestartCredentials();
  }

  _canApplyNativeIceCredentials() {
    return (
      this._iceGatheringState === "new" &&
      !this._localDescription &&
      !this._currentLocalDescription &&
      !this._pendingLocalDescription
    );
  }

  _isJsOnlyIceRestartRemoteOffer(description, explicitMarker) {
    if (explicitMarker) return true;
    if (description.type !== "offer" || !this._currentRemoteDescription) return false;
    if (!hasDataMediaSection(description) || !hasDataMediaSection(this._currentRemoteDescription)) {
      return false;
    }
    return hasDifferentIceCredentials(description, this._currentRemoteDescription);
  }

  _shouldApplyDataOnlyLocalOffer(description) {
    return (
      !this._iceRestartPending &&
      this._signalingState === "stable" &&
      this._currentLocalDescription?.type === "offer" &&
      this._currentRemoteDescription?.type === "answer" &&
      hasDataMediaSection(this._currentLocalDescription) &&
      hasDataMediaSection(this._currentRemoteDescription) &&
      (!description ||
        (hasDataMediaSection(description) &&
          !hasDifferentIceCredentials(description, this._currentLocalDescription)))
    );
  }

  _shouldApplyDataOnlyLocalAnswer(description) {
    return (
      this._pendingRemoteDescription?.type === "offer" &&
      this._currentRemoteDescription?.type === "offer" &&
      this._currentLocalDescription?.type === "answer" &&
      hasDataMediaSection(this._pendingRemoteDescription) &&
      hasDataMediaSection(this._currentRemoteDescription) &&
      hasDataMediaSection(this._currentLocalDescription) &&
      !hasDifferentIceCredentials(this._pendingRemoteDescription, this._currentRemoteDescription) &&
      (!description ||
        (hasDataMediaSection(description) &&
          !hasDifferentIceCredentials(description, this._currentLocalDescription)))
    );
  }

  _shouldApplyDataOnlyRemoteOffer(description) {
    return (
      this._signalingState === "stable" &&
      this._currentRemoteDescription?.type === "offer" &&
      this._currentLocalDescription?.type === "answer" &&
      hasDataMediaSection(description) &&
      hasDataMediaSection(this._currentRemoteDescription) &&
      hasDataMediaSection(this._currentLocalDescription) &&
      !hasDifferentIceCredentials(description, this._currentRemoteDescription)
    );
  }

  _shouldApplyDataOnlyRemoteAnswer(description) {
    return (
      this._pendingLocalDescription?.type === "offer" &&
      this._currentLocalDescription?.type === "offer" &&
      this._currentRemoteDescription?.type === "answer" &&
      hasDataMediaSection(description) &&
      hasDataMediaSection(this._pendingLocalDescription) &&
      hasDataMediaSection(this._currentLocalDescription) &&
      hasDataMediaSection(this._currentRemoteDescription) &&
      !hasDifferentIceCredentials(this._pendingLocalDescription, this._currentLocalDescription) &&
      !hasDifferentIceCredentials(description, this._currentRemoteDescription)
    );
  }

  _clearIceRestartRequest() {
    this._iceRestartPending = false;
    this._pendingIceRestartCredentials = null;
  }

  _assertNotClosed() {
    if (this._closed) throw makeDOMException("RTCPeerConnection is closed", "InvalidStateError");
  }

  async _ensureLocalAnswerApplied() {
    if (this._localDescription?.type === "answer" && !this._pendingRemoteDescription)
      return this._localDescription;
    if (this._jsOnlyIceRestartRemoteOffer) {
      const answer =
        this._lastCreatedAnswer ||
        markJsOnlyIceRestart(
          orderCodecAttributeLines(
            new RTCSessionDescription(this._ensureNativePeerConnection().createAnswer()),
          ),
        );
      await this._applyJsOnlyLocalAnswer(answer);
      return this._localDescription;
    }
    if (hasNoActiveMedia(this.remoteDescription)) {
      const answer =
        this._lastCreatedAnswer ||
        new RTCSessionDescription({
          type: "answer",
          sdp: this.remoteDescription.sdp,
        });
      await this._applyNoMediaLocalDescription(answer);
      return this._localDescription;
    }
    this._ensureNativePeerConnection().setLocalDescription("answer");
    const nativeDescription = this._ensureNativePeerConnection().localDescription();
    this._localDescription = nativeDescription
      ? orderCodecAttributeLines(new RTCSessionDescription(nativeDescription))
      : null;
    this._syncStatesFromNative();
    this._commitRemoteDescription();
    this._commitLocalDescription(this._localDescription);
    this._syncSignalingStateFromDescriptions();
    this._scheduleNativeCandidateGathering();
    for (const candidate of this._pendingIce.splice(0)) {
      await this._addIceCandidateWithoutChain(candidate);
    }
    this._flushPendingRemoteCandidatesForNative();
    await nextTask();
    await this._refreshLocalDescriptionAfterGatheringWindow();
    this._registerLocalDescriptionForPairing();
    return this._localDescription;
  }

  async _applyJsOnlyLocalAnswer(description) {
    const previousState = this._signalingState;
    const localDescription = markJsOnlyIceRestart(new RTCSessionDescription(description));
    this._commitRemoteDescription();
    this._commitLocalDescription(localDescription);
    this._registerLocalDescriptionForPairing();
    this._jsOnlyIceRestartRemoteOffer = false;
    this._clearNegotiationNeededIfDataMLineIsPresent();
    this._signalingState = "stable";
    this._refreshIceRole();
    this._updateSctpTransport();
    if (previousState !== this._signalingState) this._dispatchSignalingStateChange();
    await nextTask();
  }

  async _applyDataOnlyLocalOffer(description) {
    const previousState = this._signalingState;
    const localDescription = new RTCSessionDescription(description);
    this._setPendingLocalDescription(localDescription);
    this._registerLocalDescriptionForPairing();
    this._syncSignalingStateFromDescriptions();
    this._refreshIceRole();
    this._updateSctpTransport();
    if (previousState !== this._signalingState) this._dispatchSignalingStateChange();
    await nextTask();
  }

  async _applyDataOnlyLocalAnswer(description) {
    const previousState = this._signalingState;
    const localDescription = new RTCSessionDescription(description);
    this._commitRemoteDescription();
    this._commitLocalDescription(localDescription);
    this._registerLocalDescriptionForPairing();
    this._clearNegotiationNeededIfDataMLineIsPresent();
    this._syncSignalingStateFromDescriptions();
    this._refreshIceRole();
    this._updateSctpTransport();
    if (previousState !== this._signalingState) this._dispatchSignalingStateChange();
    await nextTask();
  }

  async _applyNoMediaLocalDescription(description) {
    const localDescription = new RTCSessionDescription(description);
    if (localDescription.type === "offer") {
      this._setPendingLocalDescription(localDescription);
    } else if (localDescription.type === "answer") {
      this._commitRemoteDescription();
      this._commitLocalDescription(localDescription);
    } else {
      this._setPendingLocalDescription(localDescription);
    }
    this._registerLocalDescriptionForPairing();
    this._signalingState = description.type === "offer" ? "have-local-offer" : "stable";
    if (this._signalingState === "stable") this._updateNegotiatedTransceivers();
    this._clearNegotiationNeededIfDataMLineIsPresent();
    this._refreshIceRole();
    this._updateSctpTransport();
    this._dispatchSignalingStateChange();
    await nextTask();
  }

  _scheduleNativeCandidateGathering() {
    if (this._closed || !this._native || !hasNegotiatedMediaSection(this._localDescription)) return;
    if (this._nativeCandidateGatheringScheduled) return;
    this._nativeCandidateGatheringScheduled = true;
    setImmediate(() => {
      this._nativeCandidateGatheringScheduled = false;
      if (this._closed || !this._native || !hasNegotiatedMediaSection(this._localDescription))
        return;
      try {
        this._native.gatherLocalCandidates();
      } catch {
        // Gathering may already be complete or the native transport may be closing.
      }
    });
  }

  _refreshLocalDescriptionFromNative() {
    if (this._closed || !this._localDescription) return;
    if (!this._native) return;
    const nativeDescription = this._native.localDescription();
    if (nativeDescription) {
      this._refreshCurrentOrPendingLocalDescription(
        orderCodecAttributeLines(new RTCSessionDescription(nativeDescription)),
      );
      this._registerLocalDescriptionForPairing();
    }
    this._syncStatesFromNative();
  }

  _refreshLocalDescriptionAfterGatheringWindow() {
    this._refreshLocalDescriptionFromNative();
    if (this._closed || !this._localDescription || this._iceGatheringState === "complete") return;
    if (this._localDescriptionRefreshScheduled) return;
    this._localDescriptionRefreshScheduled = true;
    setTimeout(() => {
      this._localDescriptionRefreshScheduled = false;
      this._refreshLocalDescriptionFromNative();
    }, 50);
  }

  _syncStatesFromNative() {
    if (this._closed) return;
    if (!this._native) return;
    this._connectionState = this._native.connectionState;
    this._iceConnectionState = this._native.iceConnectionState;
    this._syncSignalingStateFromDescriptions();
    this._refreshIceRole();
    this._updateSctpTransport();
  }

  _handleNativeEvent(event) {
    if (this._closed) {
      try {
        event.channel?.close?.();
      } catch {
        // Closed peers must ignore late native callbacks; channel close is best-effort.
      }
      return;
    }
    if (this._shouldDeferIceEvent(event)) {
      this._deferredIceEvents.push(event);
      return;
    }

    if (event.target === "datachannel") {
      const channel = this._channels.get(event.channelId);
      if (channel) {
        channel._handleNativeEvent(event);
      } else if (event.channelId) {
        const events = this._pendingNativeDataChannelEvents.get(event.channelId) || [];
        events.push(event);
        this._pendingNativeDataChannelEvents.set(event.channelId, events);
      }
      return;
    }

    if (event.target === "track") {
      const transceiver = this._nativeMediaTracks.get(event.trackId);
      const nativeTrack = transceiver
        ? [
            transceiver._nativeSendTrack,
            transceiver._nativeReceiveTrack,
            transceiver._nativeAnnouncedReceiveTrack,
            ...transceiver._nativeReceiveTracks,
          ].find((track) => track?.bindingId === event.trackId)
        : null;
      const senderSource = transceiver && mediaTrackSources.get(transceiver.sender.track);
      const receiverSource = transceiver && mediaTrackSources.get(transceiver.receiver.track);
      if (event.type !== "message") senderSource?._handleNativeEvent?.(event, nativeTrack);
      if (receiverSource !== senderSource || event.type === "message") {
        receiverSource?._handleNativeEvent?.(event, nativeTrack);
      }
      return;
    }

    switch (event.type) {
      case "datachannel": {
        const incomingId = event.channel?.id ?? null;
        let channel =
          incomingId == null ? null : this._syntheticIncomingDataChannelForId(incomingId);
        const adoptedSynthetic = Boolean(channel && channel.readyState !== "closed");
        if (adoptedSynthetic) {
          this._pendingSyntheticDataChannelAnnouncements.delete(incomingId);
          channel._adoptNativeChannel(event.channel, event.channelReadyState);
        } else {
          channel = RTCDataChannel._fromNative(this, event.channel, event.channelReadyState);
        }
        const id = channel.id;
        if (id != null) {
          if (adoptedSynthetic && this._remoteAnnouncedDataChannelIds.has(id)) {
            this._flushPendingNativeDataChannelEvents(channel, event.channel.bindingId);
            channel._flushQueuedNativeEventsAfterAnnouncement();
            if (!channel._announcementPending) channel._announceOpenAfterDataChannelEvent();
            break;
          }
          if (this._remoteAnnouncedDataChannelIds.has(id)) {
            channel.close();
            break;
          }
          this._remoteAnnouncedDataChannelIds.add(id);
        }
        channel._createdLocally = false;
        channel._openEventPending = channel.readyState === "open";
        channel._announcementPending = true;
        this._pendingDataChannelEvents.push(new RTCDataChannelEvent("datachannel", { channel }));
        this._flushPendingNativeDataChannelEvents(channel, event.channelId);
        this._scheduleDataChannelFlush();
        break;
      }
      case "track":
        this._adoptIncomingNativeTrack(event.track);
        break;
      case "localdescription": {
        const description = orderCodecAttributeLines(new RTCSessionDescription(event.description));
        if (this._nonstandardPreparedLocalDescriptionType === description.type) {
          this._preparedLocalDescription = description;
          break;
        }
        this._refreshCurrentOrPendingLocalDescription(description);
        this._registerLocalDescriptionForPairing();
        this._refreshIceRole();
        this._updateSctpTransport();
        break;
      }
      case "localcandidate": {
        const candidateInit = {
          candidate: event.candidate.candidate,
          sdpMid: event.candidate.sdpMid || "0",
        };
        const candidate = new RTCIceCandidate(candidateInit);
        Object.defineProperty(candidate, "_webrtcNodeLocalCandidate", {
          value: true,
          configurable: true,
        });
        this._rememberLocalIceCandidate(candidate);
        this._refreshCurrentOrPendingLocalDescription(
          appendRemoteCandidateToDescription(this._localDescription, candidate),
        );
        this.dispatchEvent(new RTCPeerConnectionIceEvent("icecandidate", { candidate }));
        break;
      }
      case "icegatheringstatechange":
        this._iceGatheringState = event.state;
        this.dispatchEvent(makeEvent("icegatheringstatechange"));
        this._iceTransport()?.dispatchEvent(makeEvent("gatheringstatechange"));
        if (event.state === "complete") {
          this.dispatchEvent(new RTCPeerConnectionIceEvent("icecandidate", { candidate: null }));
        }
        break;
      case "iceconnectionstatechange":
        this._iceConnectionState = event.state;
        this._updateSctpTransport();
        this.dispatchEvent(makeEvent("iceconnectionstatechange"));
        this._iceTransport()?._handlePeerIceConnectionState(event.state);
        this._closeChannelsOnPeerFailure();
        break;
      case "connectionstatechange":
        this._connectionState = event.state;
        this._updateSctpTransport();
        this.dispatchEvent(makeEvent("connectionstatechange"));
        this._closeChannelsOnPeerFailure();
        break;
      case "signalingstatechange":
        if (this._jsOnlyIceRestartOfferPending) {
          this._signalingState = "have-local-offer";
          break;
        }
        if (this._suppressNextNativeSignalingState === event.state) {
          this._suppressNextNativeSignalingState = null;
          break;
        }
        if (event.state !== this._descriptionSignalingState()) break;
        if (
          event.state === this._signalingState &&
          event.state === this._lastDispatchedSignalingState
        ) {
          break;
        }
        this._signalingState = event.state;
        this._dispatchSignalingStateChange();
        break;
    }
  }

  _handleNativeEventBatch(events) {
    if (!events.length) return;
    const first = events[0];
    if (first?.target !== "datachannel" || first.type !== "message" || first.channelId == null) {
      for (const event of events) this._handleNativeEvent(event);
      return;
    }

    const channelId = first.channelId;
    for (let index = 1; index < events.length; index += 1) {
      const event = events[index];
      if (
        event?.target !== "datachannel" ||
        event.type !== "message" ||
        event.channelId !== channelId
      ) {
        for (const item of events) this._handleNativeEvent(item);
        return;
      }
    }

    const channel = this._channels.get(channelId);
    if (channel) {
      if (channel._announcementPending || channel._nativeEventDrainActive) {
        for (const event of events) channel._queuedNativeEvents.push(event);
        return;
      }
      if (channel._dispatchNativeMessageBatch(events)) return;
      channel._queueMessageEvents(events);
      return;
    }

    const pending = this._pendingNativeDataChannelEvents.get(channelId) || [];
    for (const event of events) pending.push(event);
    this._pendingNativeDataChannelEvents.set(channelId, pending);
  }

  _registerDataChannelId(channel, id = channel._effectiveId()) {
    if (id == null) return;
    if (channel._registeredDataChannelId === id) return;
    this._unregisterDataChannelId(channel);
    const existing = this._usedDataChannelIds.get(id);
    if (existing && existing !== channel && existing.readyState !== "closed") return;
    channel._registeredDataChannelId = id;
    this._usedDataChannelIds.set(id, channel);
    this._pairDataChannelById(channel, id);
  }

  _flushPendingNativeDataChannelEvents(channel, channelId) {
    const events = this._pendingNativeDataChannelEvents.get(channelId);
    if (!events) return;
    this._pendingNativeDataChannelEvents.delete(channelId);
    for (const event of events) {
      if (channel._announcementPending || channel._nativeEventDrainActive) {
        channel._queuedNativeEvents.push(event);
      } else {
        channel._handleNativeEvent(event, true);
      }
    }
  }

  _unregisterDataChannelId(channel) {
    const id = channel._registeredDataChannelId;
    if (id == null) return;
    if (this._usedDataChannelIds.get(id) === channel) {
      this._usedDataChannelIds.delete(id);
    }
    channel._registeredDataChannelId = null;
  }

  _isDataChannelIdInUse(id) {
    let channel = this._usedDataChannelIds.get(id);
    if (channel && channel.readyState !== "closed") return true;
    if (!this._dataChannelIdRefreshNeeded) return false;

    let refreshStillNeeded = false;
    for (const currentChannel of this._channels.values()) {
      if (currentChannel.readyState === "closed") continue;
      const effectiveId = currentChannel._effectiveId();
      if (effectiveId == null) {
        refreshStillNeeded = true;
        continue;
      }
      this._registerDataChannelId(currentChannel, effectiveId);
    }
    this._dataChannelIdRefreshNeeded = refreshStillNeeded;
    channel = this._usedDataChannelIds.get(id);
    return Boolean(channel && channel.readyState !== "closed");
  }

  _dataChannelIdParityFromDtlsRole() {
    if (this._remoteDescription?.type !== "answer") return null;
    if (this._localDescription?.type !== "offer") return null;
    const setup = dtlsSetupFromDescription(this._remoteDescription);
    if (setup === "passive") return 0;
    if (setup === "active") return 1;
    return null;
  }

  _nextAvailableDataChannelId(parity) {
    for (let id = parity; id <= 65534; id += 2) {
      if (!this._isDataChannelIdInUse(id)) return id;
    }
    return null;
  }

  _assignDataChannelIdsFromDtlsRole() {
    const parity = this._dataChannelIdParityFromDtlsRole();
    if (parity === null) return;
    for (const channel of this._channels.values()) {
      if (channel.negotiated || channel._effectiveId() != null || channel.readyState === "closed")
        continue;
      const id = this._nextAvailableDataChannelId(parity);
      if (id === null) {
        channel._handlePeerConnectionFailure();
        continue;
      }
      channel._assignId(id);
    }
  }

  _closeChannelsOnPeerFailure({ includeDisconnected = false } = {}) {
    if (this._closed) return;
    const failed =
      this._connectionState === "closed" ||
      this._connectionState === "failed" ||
      this._iceConnectionState === "closed" ||
      this._iceConnectionState === "failed" ||
      (includeDisconnected &&
        (this._connectionState === "disconnected" || this._iceConnectionState === "disconnected"));
    if (!failed) return;
    for (const channel of this._channels.values()) {
      channel._handlePeerConnectionFailure();
    }
  }

  _markNegotiationNeeded() {
    if (this._closed) return;
    this._negotiationRevision += 1;
    this._negotiationNeeded = true;
    this._scheduleNegotiationNeededEvent();
  }

  _scheduleNegotiationNeededEvent() {
    if (
      this._closed ||
      this._operationsPending > 0 ||
      this._signalingState !== "stable" ||
      !this._negotiationNeeded
    ) {
      return;
    }
    if (this._negotiationNeededScheduled) return;
    this._negotiationNeededScheduled = true;
    queueWebRtcTask(() => {
      this._negotiationNeededScheduled = false;
      if (
        this._closed ||
        this._operationsPending > 0 ||
        this._signalingState !== "stable" ||
        !this._negotiationNeeded
      ) {
        return;
      }
      this.dispatchEvent(makeEvent("negotiationneeded"));
    });
  }

  _clearNegotiationNeededIfDataMLineIsPresent() {
    this._recomputeNegotiationNeeded(
      this._pendingLocalNegotiationRevision ?? this._negotiatedRevision,
    );
  }

  _recomputeNegotiationNeeded(representedRevision = this._negotiatedRevision) {
    this._negotiationNeeded = this._negotiationRevision > representedRevision;
    this._scheduleNegotiationNeededEvent();
  }

  _eventListenerAdded(type) {
    if (type === "datachannel") {
      this._scheduleDataChannelFlush();
      this._scheduleDataChannelAnnouncementRepair();
      this._pairedPeer?._scheduleDataChannelAnnouncementRepair();
    }
  }

  _scheduleDataChannelFlush() {
    if (this._dataChannelFlushScheduled || !this._pendingDataChannelEvents.length) return;
    this._dataChannelFlushScheduled = true;
    setTimeout(() => {
      this._dataChannelFlushScheduled = false;
      if (this._closed || !this._hasEventConsumer("datachannel")) return;
      const events = this._pendingDataChannelEvents.splice(0);
      for (const event of events) {
        if (this._closed) return;
        event.channel._gateMessageEventsUntilConsumer();
        this.dispatchEvent(event);
        event.channel._announcementPending = false;
        event.channel._announceOpenAfterDataChannelEvent();
        event.channel._gateMessageEventsAfterAnnouncement();
        event.channel._gateMessageEventsUntilConsumer();
        event.channel._flushQueuedNativeEventsAfterAnnouncement();
      }
      if (this._pendingDataChannelEvents.length) this._scheduleDataChannelFlush();
    }, 0);
  }
}

function normalizeDataChannelInit(init) {
  const options = {
    ordered: init.ordered !== undefined ? Boolean(init.ordered) : true,
    maxPacketLifeTime: init.maxPacketLifeTime,
    maxRetransmits: init.maxRetransmits,
    protocol: init.protocol === undefined ? "" : String(init.protocol),
    negotiated: init.negotiated !== undefined ? Boolean(init.negotiated) : false,
    id: init.id,
  };

  if (options.maxPacketLifeTime != null) {
    options.maxPacketLifeTime = enforceRange(options.maxPacketLifeTime, "maxPacketLifeTime");
  }
  if (options.maxRetransmits != null) {
    options.maxRetransmits = enforceRange(options.maxRetransmits, "maxRetransmits");
  }
  if (options.maxPacketLifeTime != null && options.maxRetransmits != null) {
    throw new TypeError("maxPacketLifeTime and maxRetransmits are mutually exclusive");
  }
  if (options.id != null) {
    options.id = enforceRange(options.id, "id", 65535);
  }
  if (options.negotiated && options.id == null) {
    throw new TypeError("negotiated RTCDataChannel requires an id");
  }
  if (options.negotiated && options.id > 65534) {
    throw new TypeError("id must be an integer between 0 and 65534");
  }
  if (!options.negotiated) {
    options.id = undefined;
  }
  return options;
}

function getNativePeerConnection(peerConnection) {
  if (!(peerConnection instanceof RTCPeerConnection)) {
    throw new TypeError("Expected an RTCPeerConnection from @webrtc-node/webrtc");
  }
  peerConnection._assertNotClosed();
  return peerConnection._ensureNativePeerConnection();
}

module.exports = {
  MediaStream,
  MediaStreamTrack,
  MediaStreamTrackEvent,
  RTCRtpSender,
  RTCRtpReceiver,
  RTCRtpTransceiver,
  RTCStatsReport,
  RTCTrackEvent,
  RTCPeerConnection,
  RTCDataChannel,
  RTCSessionDescription,
  RTCIceCandidate,
  RTCIceCandidatePair,
  RTCCertificate,
  RTCDataChannelEvent,
  RTCPeerConnectionIceEvent,
  RTCPeerConnectionIceErrorEvent,
  RTCError,
  RTCErrorEvent,
  RTCIceTransport,
  RTCSctpTransport,
  RTCDtlsTransport,
  EventTarget: SimpleEventTarget,
  Event: SimpleEvent,
  MessageEvent: SimpleMessageEvent,
  nonstandard: {
    IceUdpMuxListener,
    configurePeerConnection,
    setLocalIceCredentials,
    getRemoteFingerprint,
    importCertificate,
    getNativePeerConnection,
    EncodedMediaSource,
    EncodedMediaSink,
    native,
  },
};
