import { certificatePemToArrayBuffer, getCertificateMaterial } from "./certificate";
import { LIBDATACHANNEL_SCTP_MAX_CHANNELS } from "./constants";
import { kInternalConstruct } from "./errors";
import type { SimpleEvent } from "./events";
import { makeEvent, SimpleEventTarget } from "./events";
import type { RTCPeerConnection } from "./peer-connection";
import {
  firstIceParameters,
  RTCIceCandidate,
  RTCIceCandidatePair,
  selectKnownCandidateByEndpoint,
} from "./sdp";

export type EventHandler = ((event: SimpleEvent) => unknown) | null;

export class RTCIceTransport extends SimpleEventTarget {
  _pc: RTCPeerConnection;
  _stateOverride: string | null;
  _connectionSequenceRequested: boolean;
  _connectionSequenceStarted: boolean;
  _connectionSequenceReplaying: boolean;
  onstatechange: EventHandler;
  ongatheringstatechange: EventHandler;
  onselectedcandidatepairchange: EventHandler;

  constructor(token: unknown, peerConnection: RTCPeerConnection) {
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

  get role(): string {
    return this._pc._iceRole;
  }

  get component(): string {
    return "rtp";
  }

  get state(): string {
    if (this._pc._closed) return "closed";
    return this._stateOverride || this._pc.iceConnectionState;
  }

  get gatheringState(): string {
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

  getLocalCandidates(): RTCIceCandidate[] {
    return this._pc._localIceCandidates.map((candidate) => new RTCIceCandidate(candidate.toJSON()));
  }

  getRemoteCandidates(): RTCIceCandidate[] {
    return this._pc._remoteIceCandidates.map(
      (candidate) => new RTCIceCandidate(candidate.toJSON()),
    );
  }

  getSelectedCandidatePair(): RTCIceCandidatePair | null {
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

  getLocalParameters(): ReturnType<typeof firstIceParameters> {
    return firstIceParameters(this._pc.localDescription);
  }

  getRemoteParameters(): ReturnType<typeof firstIceParameters> {
    return firstIceParameters(this._pc.remoteDescription);
  }

  _eventListenerAdded(type: string): void {
    if (type !== "statechange") return;
    this._connectionSequenceRequested = true;
    this._queueConnectedSequenceIfNeeded();
  }

  _handlePeerIceConnectionState(state: string): void {
    if (this._connectionSequenceReplaying && (state === "connected" || state === "completed")) {
      return;
    }
    if ((state === "connected" || state === "completed") && this._queueConnectedSequenceIfNeeded())
      return;

    this._stateOverride = null;
    this.dispatchEvent(makeEvent("statechange"));
  }

  _queueConnectedSequenceIfNeeded(): boolean {
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

  _forceState(state: string, { dispatch = true }: { dispatch?: boolean } = {}): void {
    this._connectionSequenceStarted = true;
    this._stateOverride = state;
    if (dispatch) this.dispatchEvent(makeEvent("statechange"));
  }
}

export class RTCDtlsTransport extends SimpleEventTarget {
  _pc: RTCPeerConnection;
  iceTransport: RTCIceTransport;
  onstatechange: EventHandler;
  onerror: EventHandler;

  constructor(token: unknown, peerConnection: RTCPeerConnection) {
    if (token !== kInternalConstruct) throw new TypeError("Illegal constructor");
    super();
    this._pc = peerConnection;
    this.iceTransport = new RTCIceTransport(kInternalConstruct, peerConnection);
    this.onstatechange = null;
    this.onerror = null;
  }

  get state(): string {
    if (this._pc._closed || this._pc._remoteTransportClosed) return "closed";
    if (this._pc.connectionState === "connected" || this._pc._sctpTransport?._state === "connected")
      return "connected";
    if (this._pc.connectionState === "failed") return "failed";
    if (!this._pc.localDescription || !this._pc.remoteDescription) return "new";
    return "connecting";
  }

  getRemoteCertificates(): ArrayBuffer[] {
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

export class RTCSctpTransport extends SimpleEventTarget {
  _pc: RTCPeerConnection;
  _transport: RTCDtlsTransport;
  _state: string;
  _maxMessageSize: number | null;
  _maxChannels: number | null;
  onstatechange: EventHandler;

  constructor(token: unknown, peerConnection: RTCPeerConnection) {
    if (token !== kInternalConstruct) throw new TypeError("Illegal constructor");
    super();
    this._pc = peerConnection;
    this._transport = new RTCDtlsTransport(kInternalConstruct, peerConnection);
    this._state = "connecting";
    this._maxMessageSize = null;
    this._maxChannels = null;
    this.onstatechange = null;
  }

  get transport(): RTCDtlsTransport {
    return this._transport;
  }

  get state(): string {
    return this._state;
  }

  get maxMessageSize(): number | null {
    return this._maxMessageSize;
  }

  get maxChannels(): number | null {
    if (this._maxChannels === null && this._state === "connected") {
      this._maxChannels = this._pc._currentSctpMaxChannels() || LIBDATACHANNEL_SCTP_MAX_CHANNELS;
    }
    return this._maxChannels;
  }

  _setState(state: string): void {
    if (this._state === state) return;
    this._state = state;
    this.dispatchEvent(makeEvent("statechange"));
  }

  _setLimits({
    maxMessageSize,
    maxChannels,
  }: {
    maxMessageSize: number | null;
    maxChannels: number | null;
  }): void {
    this._maxMessageSize = maxMessageSize;
    this._maxChannels = maxChannels;
  }
}
