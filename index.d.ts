export type RTCDataChannelState = "connecting" | "open" | "closing" | "closed";
export type RTCSdpType = "offer" | "answer" | "pranswer" | "rollback";
export type RTCSctpTransportState = "connecting" | "connected" | "closed";
export type RTCDtlsTransportState = "new" | "connecting" | "connected" | "closed" | "failed";
export type RTCIceRole = "unknown" | "controlling" | "controlled";
export type RTCIceComponent = "rtp" | "rtcp";
export type RTCIceTransportState =
  | "new"
  | "checking"
  | "connected"
  | "completed"
  | "disconnected"
  | "failed"
  | "closed";
export type RTCIceGathererState = "new" | "gathering" | "complete";

export interface EventInit {
  bubbles?: boolean;
  cancelable?: boolean;
}

export class Event {
  constructor(type: string, init?: EventInit);
  readonly type: string;
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  readonly defaultPrevented: boolean;
  readonly target: EventTarget | null;
  readonly currentTarget: EventTarget | null;
  preventDefault(): void;
}

export interface MessageEventInit<T = unknown> extends EventInit {
  data?: T;
  origin?: string;
  lastEventId?: string;
  source?: unknown;
  ports?: unknown[];
}

export class MessageEvent<T = unknown> extends Event {
  constructor(type: string, init?: MessageEventInit<T>);
  readonly data: T;
  readonly origin: string;
  readonly lastEventId: string;
  readonly source: unknown | null;
  readonly ports: readonly unknown[];
}

export interface EventListenerObject<E extends Event = Event> {
  handleEvent(event: E): void;
}

export type EventListener<E extends Event = Event> = ((event: E) => void) | EventListenerObject<E>;

export interface AddEventListenerOptions {
  once?: boolean;
}

export class EventTarget {
  addEventListener(
    type: string,
    callback: EventListener | null,
    options?: AddEventListenerOptions | boolean,
  ): void;
  removeEventListener(type: string, callback: EventListener | null): void;
  dispatchEvent(event: Event): boolean;
}

export interface RTCConfiguration {
  iceServers?: RTCIceServer[];
  iceTransportPolicy?: "all" | "relay";
  bundlePolicy?: "balanced" | "max-compat" | "max-bundle";
  rtcpMuxPolicy?: "require";
  iceCandidatePoolSize?: number;
  certificates?: RTCCertificate[];
}

export interface RTCIceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface RTCDataChannelInit {
  ordered?: boolean;
  maxPacketLifeTime?: number;
  maxRetransmits?: number;
  protocol?: string;
  negotiated?: boolean;
  id?: number;
}

export interface RTCSessionDescriptionInit {
  type: RTCSdpType;
  sdp?: string;
}

export interface RTCOfferOptions {
  iceRestart?: boolean;
}

export interface RTCIceCandidateInit {
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
  relayProtocol?: string | null;
  url?: string | null;
}

export interface RTCIceParameters {
  usernameFragment: string;
  password: string;
}

export class RTCIceCandidatePair {
  private constructor();
  readonly local: RTCIceCandidate;
  readonly remote: RTCIceCandidate;
}

export interface RTCCertificateKeygenAlgorithm {
  name: string;
  expires?: number;
  hash?: string | { name: string };
  modulusLength?: number;
  publicExponent?: Uint8Array;
  namedCurve?: string;
}

export class RTCSessionDescription {
  constructor(init: RTCSessionDescriptionInit);
  readonly type: RTCSdpType;
  readonly sdp: string;
  toJSON(): RTCSessionDescriptionInit;
}

export class RTCIceCandidate {
  constructor(init?: RTCIceCandidateInit);
  readonly candidate: string;
  readonly sdpMid: string | null;
  readonly sdpMLineIndex: number | null;
  readonly usernameFragment: string | null;
  readonly foundation: string | null;
  readonly component: "rtp" | "rtcp" | null;
  readonly priority: number | null;
  readonly address: string | null;
  readonly protocol: string | null;
  readonly port: number | null;
  readonly type: string | null;
  readonly tcpType: string | null;
  readonly relatedAddress: string | null;
  readonly relatedPort: number | null;
  readonly relayProtocol: string | null;
  readonly url: string | null;
  toJSON(): RTCIceCandidateInit;
}

export interface RTCDtlsFingerprint {
  algorithm: string;
  value: string;
}

export class RTCCertificate {
  readonly expires: number;
  getFingerprints(): RTCDtlsFingerprint[];
}

export class RTCDataChannel extends EventTarget {
  readonly label: string;
  readonly ordered: boolean;
  readonly maxPacketLifeTime: number | null;
  readonly maxRetransmits: number | null;
  readonly protocol: string;
  readonly negotiated: boolean;
  readonly id: number | null;
  readonly readyState: RTCDataChannelState;
  readonly bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  binaryType: "arraybuffer" | "blob";
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: Event) => void) | null;
  onerror: ((event: RTCErrorEvent) => void) | null;
  onclosing: ((event: Event) => void) | null;
  onbufferedamountlow: ((event: Event) => void) | null;
  send(data: string | ArrayBuffer | ArrayBufferView | Blob): void;
  close(): void;
}

export class RTCDataChannelEvent extends Event {
  constructor(type: string, init: EventInit & { channel: RTCDataChannel });
  readonly channel: RTCDataChannel;
}

export class RTCPeerConnectionIceEvent extends Event {
  constructor(
    type: string,
    init?: EventInit & { candidate?: RTCIceCandidate | null; url?: string | null },
  );
  readonly candidate: RTCIceCandidate | null;
  readonly url: string | null;
}

export class RTCPeerConnectionIceErrorEvent extends Event {
  constructor(
    type: string,
    init?: EventInit & {
      address?: string | null;
      port?: number | null;
      url?: string;
      errorCode?: number;
      errorText?: string;
    },
  );
  readonly address: string | null;
  readonly port: number | null;
  readonly url: string;
  readonly errorCode: number;
  readonly errorText: string;
}

export class RTCError extends Error {
  constructor(
    init: {
      errorDetail: string;
      sdpLineNumber?: number | null;
      sctpCauseCode?: number | null;
      receivedAlert?: number | null;
      sentAlert?: number | null;
    },
    message?: string,
  );
  readonly code: 0;
  readonly errorDetail: string;
  readonly sdpLineNumber: number | null;
  readonly sctpCauseCode: number | null;
  readonly receivedAlert: number | null;
  readonly sentAlert: number | null;
}

export class RTCErrorEvent extends Event {
  constructor(type: string, init?: EventInit & { error?: RTCError });
  readonly error: RTCError | undefined;
}

export class RTCDtlsTransport extends EventTarget {
  private constructor();
  readonly state: RTCDtlsTransportState;
  readonly iceTransport: RTCIceTransport;
  onstatechange: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  getRemoteCertificates(): ArrayBuffer[];
}

export class RTCIceTransport extends EventTarget {
  private constructor();
  readonly role: RTCIceRole;
  readonly component: RTCIceComponent;
  readonly state: RTCIceTransportState;
  readonly gatheringState: RTCIceGathererState;
  onstatechange: ((event: Event) => void) | null;
  ongatheringstatechange: ((event: Event) => void) | null;
  onselectedcandidatepairchange: ((event: Event) => void) | null;
  getLocalCandidates(): RTCIceCandidate[];
  getRemoteCandidates(): RTCIceCandidate[];
  getSelectedCandidatePair(): RTCIceCandidatePair | null;
  getLocalParameters(): RTCIceParameters | null;
  getRemoteParameters(): RTCIceParameters | null;
}

export class RTCSctpTransport extends EventTarget {
  private constructor();
  readonly transport: RTCDtlsTransport;
  readonly state: RTCSctpTransportState;
  readonly maxMessageSize: number | null;
  readonly maxChannels: number | null;
  onstatechange: ((event: Event) => void) | null;
}

export class RTCPeerConnection extends EventTarget {
  static generateCertificate(
    algorithm: string | RTCCertificateKeygenAlgorithm,
  ): Promise<RTCCertificate>;
  constructor(configuration?: RTCConfiguration);
  readonly localDescription: RTCSessionDescription | null;
  readonly currentLocalDescription: RTCSessionDescription | null;
  readonly pendingLocalDescription: RTCSessionDescription | null;
  readonly remoteDescription: RTCSessionDescription | null;
  readonly currentRemoteDescription: RTCSessionDescription | null;
  readonly pendingRemoteDescription: RTCSessionDescription | null;
  readonly signalingState:
    | "stable"
    | "have-local-offer"
    | "have-remote-offer"
    | "have-local-pranswer"
    | "have-remote-pranswer"
    | "closed";
  readonly iceGatheringState: "new" | "gathering" | "complete";
  readonly iceConnectionState:
    | "new"
    | "checking"
    | "connected"
    | "completed"
    | "failed"
    | "disconnected"
    | "closed";
  readonly connectionState:
    | "new"
    | "connecting"
    | "connected"
    | "disconnected"
    | "failed"
    | "closed";
  readonly canTrickleIceCandidates: boolean | null;
  readonly sctp: RTCSctpTransport | null;
  ondatachannel: ((event: RTCDataChannelEvent) => void) | null;
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null;
  onicecandidateerror: ((event: RTCPeerConnectionIceErrorEvent) => void) | null;
  onicegatheringstatechange: ((event: Event) => void) | null;
  oniceconnectionstatechange: ((event: Event) => void) | null;
  onconnectionstatechange: ((event: Event) => void) | null;
  onsignalingstatechange: ((event: Event) => void) | null;
  onnegotiationneeded: ((event: Event) => void) | null;
  createDataChannel(label: string, init?: RTCDataChannelInit): RTCDataChannel;
  createOffer(options?: RTCOfferOptions): Promise<RTCSessionDescriptionInit>;
  createAnswer(): Promise<RTCSessionDescriptionInit>;
  setLocalDescription(description?: RTCSessionDescriptionInit): Promise<void>;
  setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void>;
  addIceCandidate(candidate?: RTCIceCandidateInit | RTCIceCandidate | null): Promise<void>;
  getConfiguration(): RTCConfiguration;
  setConfiguration(configuration?: RTCConfiguration): void;
  restartIce(): void;
  close(): void;
}

export namespace nonstandard {
  interface IceUdpMuxRequest {
    ufrag: string;
    localUfrag: string;
    host: string;
    port: number;
  }

  interface IceUdpMuxListener {
    port(): number;
    address(): string | undefined;
    onUnhandledStunRequest(callback: (request: IceUdpMuxRequest) => void): void;
    close(): void;
    stop(): void;
  }

  interface PeerConnectionConfiguration {
    enableIceUdpMux?: boolean;
    disableFingerprintVerification?: boolean;
    maxMessageSize?: number;
  }

  interface LocalIceCredentials {
    iceUfrag: string;
    icePwd: string;
  }

  interface CertificateFingerprint {
    algorithm: string;
    value: string;
  }

  interface ImportedCertificate {
    certificatePem: string;
    privateKeyPem: string;
    expires?: number;
  }

  const IceUdpMuxListener: {
    new (port: number, address?: string): IceUdpMuxListener;
  };
  const configurePeerConnection: (
    peerConnection: RTCPeerConnection,
    configuration: PeerConnectionConfiguration,
  ) => void;
  const setLocalIceCredentials: (
    peerConnection: RTCPeerConnection,
    credentials: LocalIceCredentials,
  ) => void;
  const getRemoteFingerprint: (peerConnection: RTCPeerConnection) => CertificateFingerprint | null;
  const importCertificate: (material: ImportedCertificate) => RTCCertificate;
  const native: unknown;
}
