import type { RTCPeerConnection } from "@webrtc-node/webrtc";

export interface CandidateSnapshot {
  readonly candidate: string;
  readonly sdpMid: string | null;
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
}

export interface TransportStatsSnapshot {
  readonly timestamp: number;
  readonly type: "transport";
  readonly connectionState: RTCPeerConnection["connectionState"];
  readonly iceConnectionState: RTCPeerConnection["iceConnectionState"];
  readonly bytesSent: number;
  readonly bytesReceived: number;
  readonly roundTripTime: number | null;
  readonly localAddress: string | null;
  readonly remoteAddress: string | null;
  readonly localCandidate: CandidateSnapshot | null;
  readonly remoteCandidate: CandidateSnapshot | null;
}

export interface TransportStatsDelta {
  readonly timestamp: number;
  readonly elapsedMs: number;
  readonly bytesSent: number;
  readonly bytesReceived: number;
  readonly sendBitrate: number;
  readonly receiveBitrate: number;
}

export interface StatsSample {
  readonly current: TransportStatsSnapshot;
  readonly delta: TransportStatsDelta | null;
}

export function snapshot(peerConnection: RTCPeerConnection): TransportStatsSnapshot;
export function delta(
  previous: TransportStatsSnapshot,
  current: TransportStatsSnapshot,
): TransportStatsDelta;
export function clear(peerConnection: RTCPeerConnection): void;

export class StatsSampler {
  constructor(peerConnection: RTCPeerConnection, options?: { interval?: number });
  readonly peerConnection: RTCPeerConnection;
  readonly interval: number;
  sample(): StatsSample;
  start(callback: (sample: StatsSample) => void): this;
  stop(): void;
}
