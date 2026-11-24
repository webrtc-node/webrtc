import { loadNative } from "./load";

// Types for the Node-API addon in addon.cc. Keep them in sync with the methods,
// accessors, and event objects registered there.

export type NativeDescriptionType = "offer" | "answer" | "pranswer" | "rollback";

export interface NativeDescription {
  type: NativeDescriptionType;
  sdp: string;
}

export interface NativeCandidate {
  candidate: string;
  sdpMid?: string;
}

export interface NativeCandidatePair {
  local: NativeCandidate;
  remote: NativeCandidate;
}

export interface NativeFingerprint {
  algorithm: string;
  value: string;
}

export interface NativeIceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

// Keys read by ParseConfiguration. The certificate is passed as PEM strings.
export interface NativePeerConnectionConfiguration {
  iceServers?: NativeIceServer[];
  iceTransportPolicy?: "all" | "relay";
  enableIceUdpMux?: boolean;
  disableFingerprintVerification?: boolean;
  maxMessageSize?: number | null;
  certificatePem?: string;
  keyPem?: string;
}

// Keys read by ParseChannelOptions.
export interface NativeDataChannelOptions {
  ordered?: boolean;
  negotiated?: boolean;
  protocol?: string | null;
  id?: number | null;
  maxPacketLifeTime?: number | null;
  maxRetransmits?: number | null;
}

export interface NativeLocalDescriptionInit {
  iceUfrag?: string;
  icePwd?: string;
}

export interface NativeDataChannel {
  sendString(data: string): boolean;
  sendBinary(data: Uint8Array): boolean;
  close(): void;
  setBufferedAmountLowThreshold(threshold: number): void;
  readonly bindingId: number;
  readonly id: number | null;
  readonly label: string;
  readonly protocol: string;
  readonly ordered: boolean;
  readonly negotiated: boolean;
  readonly maxPacketLifeTime: number | null;
  readonly maxRetransmits: number | null;
  readonly bufferedAmount: number;
  readonly isOpen: boolean;
  readonly isClosed: boolean;
  readonly maxMessageSize: number;
}

export type NativePeerState =
  | "new"
  | "connecting"
  | "connected"
  | "disconnected"
  | "failed"
  | "closed";

export type NativePeerEvent =
  | { target: "peerconnection"; type: "localdescription"; description: NativeDescription }
  | { target: "peerconnection"; type: "localcandidate"; candidate: NativeCandidate }
  | {
      target: "peerconnection";
      type:
        | "connectionstatechange"
        | "iceconnectionstatechange"
        | "icegatheringstatechange"
        | "signalingstatechange";
      state: string;
    }
  | {
      target: "peerconnection";
      type: "datachannel";
      channel: NativeDataChannel;
      channelId: number;
      channelReadyState: "open";
    };

export type NativeDataChannelEvent =
  | {
      target: "datachannel";
      type: "open" | "close" | "bufferedamountlow" | "senddrain";
      channelId: number;
    }
  | { target: "datachannel"; type: "error"; channelId: number; error: string }
  | {
      target: "datachannel";
      type: "message";
      channelId: number;
      binary: boolean;
      data: string | ArrayBuffer;
    };

export type NativeEvent = NativePeerEvent | NativeDataChannelEvent;

// Events arrive one at a time, as a batch of events, or as a message batch of
// channel ids with their payloads.
export type NativeEventCallback = (
  event: NativeEvent | NativeEvent[] | Uint32Array,
  payloads?: Array<string | ArrayBuffer>,
) => void;

export interface NativePeerConnection {
  createDataChannel(label: string, options?: NativeDataChannelOptions): NativeDataChannel;
  createOffer(): NativeDescription;
  createAnswer(): NativeDescription;
  setLocalDescription(type?: NativeDescriptionType | null, init?: NativeLocalDescriptionInit): void;
  setRemoteDescription(description: NativeDescription): void;
  addRemoteCandidate(candidate: NativeCandidate): void;
  gatherLocalCandidates(): void;
  localDescription(): NativeDescription | null;
  remoteDescription(): NativeDescription | null;
  remoteFingerprint(): NativeFingerprint | null;
  selectedCandidatePair(): NativeCandidatePair | null;
  close(): void;
  readonly connectionState: NativePeerState;
  readonly iceConnectionState: string;
  readonly iceGatheringState: string;
  readonly signalingState: string;
  readonly remoteMaxMessageSize: number;
  readonly maxDataChannelId: number;
}

export interface NativeIceUdpMuxRequest {
  ufrag: string;
  localUfrag: string;
  host: string;
  port: number;
}

export interface NativeIceUdpMuxListener {
  port(): number;
  address(): string | undefined;
  close(): void;
  stop(): void;
}

export interface NativeCertificateMaterial {
  certificatePem: string;
  keyPem: string;
  expires: number;
  fingerprints: Array<{ algorithm: "sha-256"; value: string }>;
}

export interface NativeModule {
  NativePeerConnection: new (
    configuration: NativePeerConnectionConfiguration,
    callback: NativeEventCallback,
  ) => NativePeerConnection;
  NativeDataChannel: new (...args: never[]) => NativeDataChannel;
  NativeIceUdpMuxListener: new (
    port: number,
    callback: (request: NativeIceUdpMuxRequest) => void,
    address?: string | null,
  ) => NativeIceUdpMuxListener;
  generateCertificate(options: {
    algorithm: string;
    modulusLength?: number;
    expiresMs?: number;
  }): NativeCertificateMaterial;
  takeDefaultCertificate(): NativeCertificateMaterial;
  importCertificate(options: { certificatePem: string; keyPem: string }): NativeCertificateMaterial;
  cleanup(): void;
}

// Loading happens once, when this module is first imported.
export const native = loadNative() as NativeModule;
