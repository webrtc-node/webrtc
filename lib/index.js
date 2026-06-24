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

function descriptionPairingKey(description) {
  if (!description || typeof description.sdp !== "string" || !description.sdp) return null;
  return `${description.type}\n${description.sdp}`;
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

async function delayInvalidStateIfOperationPending(peer) {
  if (peer._operationsPending > 0) await nextTask();
}

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

function serializeSdp(sessionLines, mediaSections) {
  const lines = [...sessionLines];
  for (const section of mediaSections) lines.push(...section.lines);
  return `${lines.join("\r\n")}\r\n`;
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
}

class RTCSctpTransport extends SimpleEventTarget {
  constructor(token, peerConnection) {
    if (token !== kInternalConstruct) throw new TypeError("Illegal constructor");
    super();
    this._pc = peerConnection;
    this._transport = new RTCDtlsTransport(kInternalConstruct, peerConnection);
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
          this._pc._registerDataChannelId(this);
          break;
        }
        if (this._readyState === "connecting" || this._readyState === "open") {
          this._readyState = "open";
          this._pc._registerDataChannelId(this);
          this._dispatchOpenEvent();
        }
        break;
      case "message":
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
    this.dispatchEvent(makeEvent("open"));
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

class RTCPeerConnection extends SimpleEventTarget {
  static generateCertificate(algorithm) {
    return generateCertificate(algorithm);
  }

  constructor(configuration = {}) {
    super();
    const normalizedConfiguration = normalizePeerConnectionConfiguration(configuration);
    this._configuration = normalizedConfiguration;
    this._channels = new Map();
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
    this._localDescriptionSetByApi = false;
    this._localDescriptionRefreshScheduled = false;
    this._nativeCandidateGatheringScheduled = false;
    this._iceRestartPending = false;
    this._pendingIceRestartCredentials = null;
    this._jsOnlyIceRestartOfferPending = false;
    this._jsOnlyIceRestartRemoteOffer = false;
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
    this._localDataChannelCount = 0;
    this._negotiationNeeded = false;
    this._negotiationNeededScheduled = false;
    this._ondatachannel = null;
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
    const nativePeerConnection = new native.NativePeerConnection(nativeConfiguration, (event) => {
      if (Array.isArray(event)) {
        this._handleNativeEventBatch(event);
      } else {
        this._handleNativeEvent(event);
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
    if (this._signalingState !== "stable" && this._signalingState !== "have-local-offer") {
      await delayInvalidStateIfOperationPending(this);
      throw makeDOMException("Cannot create offer in current signaling state", "InvalidStateError");
    }
    this._operationsPending += 1;
    try {
      await nextTask();
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
      this._lastCreatedOffer = new RTCSessionDescription(offer);
      if (jsOnlyIceRestart) markJsOnlyIceRestart(this._lastCreatedOffer);
      return offer;
    } catch (error) {
      throw mapNativeError(error, "InvalidStateError");
    } finally {
      this._finishPendingOperation();
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
    if (!this.remoteDescription) {
      await delayInvalidStateIfOperationPending(this);
      throw makeDOMException("Remote description is not set", "InvalidStateError");
    }
    this._operationsPending += 1;
    try {
      await nextTask();
      if (this._jsOnlyIceRestartRemoteOffer) {
        const answer = markJsOnlyIceRestart(
          new RTCSessionDescription(this._ensureNativePeerConnection().createAnswer()),
        );
        this._lastCreatedAnswer = answer;
        Object.defineProperty(answer, "_webrtcNodeAnswerer", {
          value: this,
          configurable: true,
        });
        return answer;
      }
      if (isNoMediaSdp(this.remoteDescription)) {
        const answer = {
          type: "answer",
          sdp: this.remoteDescription.sdp,
        };
        this._lastCreatedAnswer = new RTCSessionDescription(answer);
        return answer;
      }
      const answer =
        this._prepareNonstandardLocalDescription("answer") ||
        this._ensureNativePeerConnection().createAnswer();
      this._lastCreatedAnswer = new RTCSessionDescription(answer);
      Object.defineProperty(answer, "_webrtcNodeAnswerer", {
        value: this,
        configurable: true,
      });
      return answer;
    } catch (error) {
      throw mapNativeError(error, "InvalidStateError");
    } finally {
      this._finishPendingOperation();
    }
  }

  async setLocalDescription(description = undefined) {
    this._assertNotClosed();
    const jsOnlyIceRestartDescription = Boolean(description?._webrtcNodeJsOnlyIceRestart);
    let normalized = description === undefined ? null : normalizeDescription(description);
    const type = normalized ? normalized.type : this._implicitLocalDescriptionType();
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
    this._operationsPending += 1;
    try {
      await nextTask();
      if (this._closed) return new Promise(() => {});
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
          this._localDescription && !isNoMediaSdp(this._localDescription);
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
        if (normalized.sdp === "" && this._lastCreatedAnswer) normalized = this._lastCreatedAnswer;
        const answerCreatedByThisPeer = description && description._webrtcNodeAnswerer === this;
        alreadyAppliedAnswer =
          this._localDescription?.type === "answer" &&
          (this._localDescription.sdp === normalized.sdp || answerCreatedByThisPeer);
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
        for (const candidate of this._pendingIce.splice(0)) await this.addIceCandidate(candidate);
        this._flushPendingRemoteCandidatesForNative();
        return;
      }
      if (normalized && isNoMediaSdp(normalized)) {
        await this._applyNoMediaLocalDescription(normalized);
        this._localDescriptionSetByApi = hasDataMediaSection(this._localDescription);
        return;
      }
      if (!normalized && type === "offer") {
        const offer =
          this._lastCreatedOffer ||
          new RTCSessionDescription(this._ensureNativePeerConnection().createOffer());
        if (isNoMediaSdp(offer)) {
          await this._applyNoMediaLocalDescription(offer);
          this._localDescriptionSetByApi = hasDataMediaSection(this._localDescription);
          return;
        }
      }
      if (!normalized && type === "answer" && isNoMediaSdp(this.remoteDescription)) {
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
          new RTCSessionDescription(this._ensureNativePeerConnection().createAnswer());
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
      let manuallyUpdatedSignalingState = false;
      let usedJsOnlyIceRestart = false;
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
        this._syncStatesFromNative();
        this._scheduleNativeCandidateGathering();
        manuallyUpdatedSignalingState = true;
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
          manuallyUpdatedSignalingState = true;
          usedJsOnlyIceRestart = true;
        } else {
          const localDescriptionInit = this._localOfferInit(type);
          this._ensureNativePeerConnection().setLocalDescription(type, localDescriptionInit);
          appliedIceRestart = hadIceRestartRequest;
          const nativeDescription = this._ensureNativePeerConnection().localDescription();
          this._localDescription = nativeDescription
            ? new RTCSessionDescription(nativeDescription)
            : null;
          this._syncStatesFromNative();
          this._scheduleNativeCandidateGathering();
        }
      }
      if (type === "offer") {
        this._setPendingLocalDescription(this._localDescription);
        this._syncSignalingStateFromDescriptions();
      } else if (type === "answer") {
        this._commitRemoteDescription();
        this._commitLocalDescription(this._localDescription);
        this._syncSignalingStateFromDescriptions();
        for (const candidate of this._pendingIce.splice(0)) await this.addIceCandidate(candidate);
        this._flushPendingRemoteCandidatesForNative();
      }
      this._localDescriptionSetByApi = hasDataMediaSection(this._localDescription);
      this._clearNegotiationNeededIfDataMLineIsPresent();
      this._refreshIceRole();
      if (manuallyUpdatedSignalingState && previousSignalingState !== this._signalingState)
        this._dispatchSignalingStateChange();
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
      this._finishPendingOperation();
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
    this._operationsPending += 1;
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
          this._remoteDescription && !isNoMediaSdp(this._remoteDescription);
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
          remoteDescription = await description._webrtcNodeAnswerer._ensureLocalAnswerApplied();
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
          remoteDescription = await description._webrtcNodeAnswerer._ensureLocalAnswerApplied();
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
      if (isNoMediaSdp(normalized)) {
        if (normalized.type === "offer") {
          this._rollbackLocalDescription();
          this._setPendingRemoteDescription(normalized);
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
        remoteDescription = await description._webrtcNodeAnswerer._ensureLocalAnswerApplied();
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
        for (const candidate of this._pendingIce.splice(0)) await this.addIceCandidate(candidate);
        this._flushPendingRemoteCandidatesForNative();
      }
      await nextTask();
      if (
        suppressedNativeSignalingState !== null &&
        this._suppressNextNativeSignalingState === suppressedNativeSignalingState
      ) {
        this._suppressNextNativeSignalingState = null;
      }
    } catch (error) {
      throw mapNativeError(error, "InvalidStateError");
    } finally {
      this._finishPendingOperation();
    }
  }

  async addIceCandidate(candidate = null) {
    this._assertNotClosed();
    const hasArgument = arguments.length > 0;
    if (!hasArgument && !this.remoteDescription && this._operationsPending === 0) {
      throw makeDOMException("Remote description is not set", "InvalidStateError");
    }
    if (candidate === null && hasArgument && !this.remoteDescription) return;
    if (candidate instanceof RTCIceCandidate && candidate._webrtcNodeLocalCandidate) {
      await this._addExchangedLocalCandidate(candidate);
      return;
    }
    const normalized = normalizeAddIceCandidateInput(candidate);
    if (!this.remoteDescription) {
      await delayInvalidStateIfOperationPending(this);
      if (!this.remoteDescription) {
        throw makeDOMException("Remote description is not set", "InvalidStateError");
      }
    }
    this._operationsPending += 1;
    try {
      await nextTask();
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
    } catch (error) {
      throw mapNativeError(error, "OperationError");
    } finally {
      this._finishPendingOperation();
    }
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
    const pairedPeer = this._pairedPeer;
    this._unregisterLocalDescriptionsForPairing();
    const nativePeer = this._native;
    if (nativePeer) {
      try {
        nativePeer.close();
      } catch {
        // JS-visible close state is already final; native teardown is best-effort.
      }
    }
    setImmediate(() => {
      if (pairedPeer && !pairedPeer._closed) pairedPeer._handleRemotePeerClosed();
    });
    this._connectionState = "closed";
    this._iceConnectionState = "closed";
    this._deferredIceEvents = [];
    this._preparedLocalDescription = null;
    this._nonstandardPreparedLocalDescriptionType = null;
    this._nonstandardLocalIceCredentials = null;
    this._signalingState = "closed";
    this._updateSctpTransport();
    for (const channel of this._channels.values()) {
      if (channel.readyState !== "closed") channel._handleClose();
    }
    this._dispatchSignalingStateChange();
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
    return this._sctpTransport?.transport?.iceTransport || null;
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
    const hasData =
      hasDataMediaSection(this._localDescription) || hasDataMediaSection(this._remoteDescription);
    if (!hasData) {
      this._sctpConnectedTransitionReady = false;
      this._sctpTransport = null;
      return;
    }

    if (!this._sctpTransport) this._sctpTransport = new RTCSctpTransport(kInternalConstruct, this);
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

  _finishPendingOperation() {
    this._operationsPending = Math.max(0, this._operationsPending - 1);
    if (this._operationsPending === 0) {
      this._scheduleSctpTransportUpdate();
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
      channel._openEventPending = true;
      channel._announcementPending = true;
      const sourceChannel = channel._pairedChannel;
      if (sourceChannel?.readyState === "connecting") {
        sourceChannel._readyState = "open";
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
  }

  _dispatchSignalingStateChange() {
    this._lastDispatchedSignalingState = this._signalingState;
    this.dispatchEvent(makeEvent("signalingstatechange"));
  }

  _setPendingLocalDescription(description) {
    this._pendingLocalDescription = description;
    this._localDescription = description || this._currentLocalDescription;
  }

  _commitLocalDescription(description = this._pendingLocalDescription || this._localDescription) {
    if (description) this._currentLocalDescription = description;
    this._pendingLocalDescription = null;
    this._localDescription = this._currentLocalDescription;
  }

  _rollbackLocalDescription() {
    this._pendingLocalDescription = null;
    this._localDescription = this._currentLocalDescription;
  }

  _setPendingRemoteDescription(description) {
    this._pendingRemoteDescription = description;
    this._remoteDescription = description || this._currentRemoteDescription;
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
    const nativeBackedRollback = this._localDescription && !isNoMediaSdp(this._localDescription);
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
      this._preparedLocalDescription = new RTCSessionDescription(description);
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
          new RTCSessionDescription(this._ensureNativePeerConnection().createAnswer()),
        );
      await this._applyJsOnlyLocalAnswer(answer);
      return this._localDescription;
    }
    if (isNoMediaSdp(this.remoteDescription)) {
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
      ? new RTCSessionDescription(nativeDescription)
      : null;
    this._syncStatesFromNative();
    this._commitRemoteDescription();
    this._commitLocalDescription(this._localDescription);
    this._syncSignalingStateFromDescriptions();
    this._scheduleNativeCandidateGathering();
    for (const candidate of this._pendingIce.splice(0)) await this.addIceCandidate(candidate);
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
    this._clearNegotiationNeededIfDataMLineIsPresent();
    this._refreshIceRole();
    this._updateSctpTransport();
    this._dispatchSignalingStateChange();
    await nextTask();
  }

  _scheduleNativeCandidateGathering() {
    if (this._closed || !this._native || !hasDataMediaSection(this._localDescription)) return;
    if (this._nativeCandidateGatheringScheduled) return;
    this._nativeCandidateGatheringScheduled = true;
    setImmediate(() => {
      this._nativeCandidateGatheringScheduled = false;
      if (this._closed || !this._native || !hasDataMediaSection(this._localDescription)) return;
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
      this._refreshCurrentOrPendingLocalDescription(new RTCSessionDescription(nativeDescription));
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
      case "localdescription": {
        const description = new RTCSessionDescription(event.description);
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
    if (this._closed || this._signalingState !== "stable" || this._negotiationNeeded) return;
    this._negotiationNeeded = true;
    if (this._negotiationNeededScheduled) return;
    this._negotiationNeededScheduled = true;
    setTimeout(() => {
      this._negotiationNeededScheduled = false;
      if (this._closed || this._signalingState !== "stable" || !this._negotiationNeeded) return;
      this.dispatchEvent(makeEvent("negotiationneeded"));
    }, 0);
  }

  _clearNegotiationNeededIfDataMLineIsPresent() {
    const sdp = this._localDescription?.sdp || this._remoteDescription?.sdp || "";
    if (/\r?\nm=application\b/i.test(sdp)) {
      this._negotiationNeeded = false;
    }
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

module.exports = {
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
    native,
  },
};
