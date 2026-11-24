import { makeDOMException } from "./errors";
import type {
  NativeFingerprint,
  NativeIceUdpMuxListener,
  NativeIceUdpMuxRequest,
} from "./native/binding";
import { native } from "./native/binding";
import { RTCPeerConnection } from "./peer-connection";
import { enforceRange } from "./webidl";

// Extension options applied before the native peer connection is created.
export interface NonstandardPeerConfiguration {
  enableIceUdpMux?: boolean;
  disableFingerprintVerification?: boolean;
  maxMessageSize?: number;
}

export const iceUdpMuxListenerFinalizer = new FinalizationRegistry<
  WeakRef<NativeIceUdpMuxListener>
>((nativeListenerRef) => {
  nativeListenerRef.deref()?.close();
});

export class IceUdpMuxListener {
  _port: number;
  _address: string | undefined;
  _callback: ((request: NativeIceUdpMuxRequest) => void) | null;
  _closed: boolean;
  _native: NativeIceUdpMuxListener | null;

  constructor(port: unknown, address: unknown = undefined) {
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

  port(): number {
    return this._port;
  }

  address(): string | undefined {
    return this._address;
  }

  onUnhandledStunRequest(callback: unknown): void {
    if (this._closed) {
      throw makeDOMException("IceUdpMuxListener is closed", "InvalidStateError");
    }
    if (typeof callback !== "function") {
      throw new TypeError("onUnhandledStunRequest requires a function");
    }
    this._callback = callback as (request: NativeIceUdpMuxRequest) => void;
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    this._callback = null;
    iceUdpMuxListenerFinalizer.unregister(this);
    this._native?.close();
    this._native = null;
  }

  stop(): void {
    this.close();
  }
}

export function assertPeerConnection(
  peerConnection: unknown,
): asserts peerConnection is RTCPeerConnection {
  if (!(peerConnection instanceof RTCPeerConnection)) {
    throw new TypeError("Expected an RTCPeerConnection");
  }
}

export function configurePeerConnection(peerConnection: unknown, options: unknown = {}): void {
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

  const input = options as Record<string, unknown>;
  const next: NonstandardPeerConfiguration = { ...peerConnection._nonstandardConfiguration };
  if (Object.hasOwn(input, "enableIceUdpMux")) {
    if (typeof input.enableIceUdpMux !== "boolean") {
      throw new TypeError("enableIceUdpMux must be a boolean");
    }
    next.enableIceUdpMux = input.enableIceUdpMux;
  }
  if (Object.hasOwn(input, "disableFingerprintVerification")) {
    if (typeof input.disableFingerprintVerification !== "boolean") {
      throw new TypeError("disableFingerprintVerification must be a boolean");
    }
    next.disableFingerprintVerification = input.disableFingerprintVerification;
  }
  if (Object.hasOwn(input, "maxMessageSize")) {
    const maxMessageSize = Number(input.maxMessageSize);
    if (!Number.isSafeInteger(maxMessageSize) || maxMessageSize < 0) {
      throw new TypeError("maxMessageSize must be a non-negative safe integer");
    }
    next.maxMessageSize = maxMessageSize;
  }
  peerConnection._nonstandardConfiguration = next;
}

export function setLocalIceCredentials(peerConnection: unknown, credentials: unknown): void {
  assertPeerConnection(peerConnection);
  peerConnection._setNonstandardLocalIceCredentials(credentials);
}

export function getRemoteFingerprint(peerConnection: unknown): NativeFingerprint | null {
  assertPeerConnection(peerConnection);
  peerConnection._assertNotClosed();
  return peerConnection._native?.remoteFingerprint() ?? null;
}
