// @ts-nocheck -- converted from JavaScript; strict typing lands module by module.

const native = require("./native/load");

import { makeDOMException } from "./errors";
import { RTCPeerConnection } from "./peer-connection";
import { enforceRange } from "./webidl";

export const iceUdpMuxListenerFinalizer = new FinalizationRegistry((nativeListenerRef) => {
  nativeListenerRef.deref()?.close();
});

export class IceUdpMuxListener {
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

export function assertPeerConnection(peerConnection) {
  if (!(peerConnection instanceof RTCPeerConnection)) {
    throw new TypeError("Expected an RTCPeerConnection");
  }
}

export function configurePeerConnection(peerConnection, options = {}) {
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

export function setLocalIceCredentials(peerConnection, credentials) {
  assertPeerConnection(peerConnection);
  peerConnection._setNonstandardLocalIceCredentials(credentials);
}

export function getRemoteFingerprint(peerConnection) {
  assertPeerConnection(peerConnection);
  peerConnection._assertNotClosed();
  return peerConnection._native?.remoteFingerprint() ?? null;
}
