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

export type MediaStreamTrackState = "live" | "ended";
export type RTCRtpTransceiverDirection = "sendrecv" | "sendonly" | "recvonly" | "inactive";

export class MediaStreamTrack extends EventTarget {
  private constructor();
  readonly kind: "audio" | "video";
  readonly id: string;
  readonly label: string;
  enabled: boolean;
  readonly muted: boolean;
  readonly readyState: MediaStreamTrackState;
  contentHint: string;
  onended: ((event: Event) => void) | null;
  onmute: ((event: Event) => void) | null;
  onunmute: ((event: Event) => void) | null;
  clone(): MediaStreamTrack;
  stop(): void;
  getCapabilities(): Record<string, never>;
  getConstraints(): Record<string, never>;
  getSettings(): Record<string, never>;
  applyConstraints(constraints?: Record<string, unknown>): Promise<void>;
}

export class MediaStream extends EventTarget {
  constructor(tracks?: MediaStream | Iterable<MediaStreamTrack>);
  readonly id: string;
  readonly active: boolean;
  onactive: ((event: Event) => void) | null;
  oninactive: ((event: Event) => void) | null;
  onaddtrack: ((event: MediaStreamTrackEvent) => void) | null;
  onremovetrack: ((event: MediaStreamTrackEvent) => void) | null;
  getTracks(): MediaStreamTrack[];
  getAudioTracks(): MediaStreamTrack[];
  getVideoTracks(): MediaStreamTrack[];
  getTrackById(id: string): MediaStreamTrack | null;
  addTrack(track: MediaStreamTrack): void;
  removeTrack(track: MediaStreamTrack): void;
  clone(): MediaStream;
}

export class MediaStreamTrackEvent extends Event {
  constructor(type: string, init: { track: MediaStreamTrack });
  readonly track: MediaStreamTrack;
}

export class RTCRtpSender {
  private constructor();
  readonly track: MediaStreamTrack | null;
  readonly transport: RTCDtlsTransport | null;
  replaceTrack(track: MediaStreamTrack | null): Promise<void>;
  setStreams(...streams: MediaStream[]): void;
  getStats(): Promise<RTCStatsReport>;
}

export class RTCRtpReceiver {
  private constructor();
  readonly track: MediaStreamTrack;
  readonly transport: RTCDtlsTransport | null;
  getStats(): Promise<RTCStatsReport>;
}

export class RTCRtpTransceiver {
  private constructor();
  readonly mid: string | null;
  readonly sender: RTCRtpSender;
  readonly receiver: RTCRtpReceiver;
  readonly stopped: boolean;
  readonly stopping: boolean;
  get direction(): RTCRtpTransceiverDirection | "stopped";
  set direction(value: RTCRtpTransceiverDirection);
  readonly currentDirection: RTCRtpTransceiverDirection | "stopped" | null;
  stop(): void;
}

export interface RTCRtpTransceiverInit {
  direction?: RTCRtpTransceiverDirection;
  streams?: Iterable<MediaStream>;
  sendEncodings?: Iterable<{ rid?: string; active?: boolean }>;
}

export interface RTCStats {
  readonly id: string;
  readonly timestamp: number;
  readonly type: string;
}

export interface RTCPeerConnectionStats extends RTCStats {
  readonly type: "peer-connection";
  readonly dataChannelsOpened: number;
  readonly dataChannelsClosed: number;
}

export interface RTCDataChannelStats extends RTCStats {
  readonly type: "data-channel";
  readonly label: string;
  readonly protocol: string;
  readonly dataChannelIdentifier: number;
  readonly state: RTCDataChannelState;
  readonly messagesSent: number;
  readonly bytesSent: number;
  readonly messagesReceived: number;
  readonly bytesReceived: number;
}

export interface RTCTransportStats extends RTCStats {
  readonly type: "transport";
  readonly bytesSent: number;
  readonly bytesReceived: number;
  readonly dtlsState: RTCDtlsTransportState;
  readonly iceState: RTCIceTransportState;
}

export interface RTCInboundRtpStreamStats extends RTCStats {
  readonly type: "inbound-rtp";
  readonly ssrc: number;
  readonly kind: "audio" | "video";
  readonly mid: string;
  readonly packetsReceived: number;
  readonly bytesReceived: number;
}

export interface RTCOutboundRtpStreamStats extends RTCStats {
  readonly type: "outbound-rtp";
  readonly ssrc: number;
  readonly kind: "audio" | "video";
  readonly mid: string;
  readonly packetsSent: number;
  readonly bytesSent: number;
}

export type RTCStatsEntry =
  | RTCPeerConnectionStats
  | RTCDataChannelStats
  | RTCTransportStats
  | RTCInboundRtpStreamStats
  | RTCOutboundRtpStreamStats;

export class RTCStatsReport implements ReadonlyMap<string, RTCStatsEntry> {
  private constructor();
  readonly size: number;
  get(id: string): RTCStatsEntry | undefined;
  has(id: string): boolean;
  keys(): MapIterator<string>;
  values(): MapIterator<RTCStatsEntry>;
  entries(): MapIterator<[string, RTCStatsEntry]>;
  forEach(
    callback: (value: RTCStatsEntry, key: string, report: RTCStatsReport) => void,
    thisArg?: unknown,
  ): void;
  [Symbol.iterator](): MapIterator<[string, RTCStatsEntry]>;
}

export class RTCTrackEvent extends Event {
  constructor(
    type: string,
    init: EventInit & {
      receiver: RTCRtpReceiver;
      track: MediaStreamTrack;
      streams: MediaStream[];
      transceiver: RTCRtpTransceiver;
    },
  );
  readonly receiver: RTCRtpReceiver;
  readonly track: MediaStreamTrack;
  readonly streams: readonly MediaStream[];
  readonly transceiver: RTCRtpTransceiver;
}

export class RTCPeerConnection extends EventTarget {
  static generateCertificate(algorithm: RTCCertificateKeygenAlgorithm): Promise<RTCCertificate>;
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
  ontrack: ((event: Event) => void) | null;
  createDataChannel(label: string, init?: RTCDataChannelInit): RTCDataChannel;
  addTrack(track: MediaStreamTrack, ...streams: MediaStream[]): RTCRtpSender;
  removeTrack(sender: RTCRtpSender): void;
  addTransceiver(
    trackOrKind: MediaStreamTrack | "audio" | "video",
    init?: RTCRtpTransceiverInit,
  ): RTCRtpTransceiver;
  getSenders(): RTCRtpSender[];
  getReceivers(): RTCRtpReceiver[];
  getTransceivers(): RTCRtpTransceiver[];
  getStats(
    selector?: MediaStreamTrack | RTCRtpSender | RTCRtpReceiver | null,
  ): Promise<RTCStatsReport>;
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
  interface MediaStreamTrackInit {
    kind: "audio" | "video";
    label?: string;
    source?: { stop?(track: MediaStreamTrack): void };
  }
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

  interface NativePeerConnectionExtension {
    createTrack(
      options: {
        kind: "audio" | "video";
        mid: string;
        direction: "sendonly" | "recvonly" | "sendrecv" | "inactive";
        codec: string;
        payloadType: number;
        profile?: string;
        ssrc?: number;
      },
      callback: (event: unknown) => void,
    ): {
      readonly bindingId: number;
      readonly mid: string;
      readonly kind: "audio" | "video";
      readonly direction: RTCRtpTransceiverDirection;
      readonly ssrc: number | null;
      readonly isOpen: boolean;
      readonly isClosed: boolean;
      readonly maxMessageSize: number;
      send(packet: Uint8Array): boolean;
      stats(): {
        packetsSent: number;
        bytesSent: number;
        packetsReceived: number;
        bytesReceived: number;
      };
      updateDescription(direction: RTCRtpTransceiverDirection, stopped: boolean): void;
      close(): void;
    };
    transportStats(): {
      bytesSent: number;
      bytesReceived: number;
      roundTripTime: number | null;
      localAddress: string | null;
      remoteAddress: string | null;
    };
    clearTransportStats(): void;
  }

  type EncodedPacket = ArrayBuffer | ArrayBufferView;

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
  const getNativePeerConnection: (
    peerConnection: RTCPeerConnection,
  ) => NativePeerConnectionExtension;
  const createMediaStreamTrack: (init: MediaStreamTrackInit) => MediaStreamTrack;
  const sendEncodedPacket: (track: MediaStreamTrack, packet: EncodedPacket) => boolean;
  const onEncodedPacket: (
    track: MediaStreamTrack,
    callback: (packet: ArrayBuffer) => void,
  ) => () => void;
  const native: unknown;
}
