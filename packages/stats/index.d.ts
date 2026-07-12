import type {
  RTCPeerConnection,
  RTCRtpReceiver,
  RTCRtpSender,
  RTCStatsEntry,
  RTCStatsReport,
} from "@webrtc-node/webrtc";

export type RTCStatsTarget = RTCPeerConnection | RTCRtpSender | RTCRtpReceiver;
export type RTCStatsDelta = ReadonlyMap<string, Readonly<Record<string, unknown>>>;
export interface RTCStatsSample {
  readonly report: RTCStatsReport;
  readonly delta: RTCStatsDelta | null;
}

export function diffStatsReports(
  previous: ReadonlyMap<string, RTCStatsEntry>,
  current: ReadonlyMap<string, RTCStatsEntry>,
): RTCStatsDelta;

export class RTCStatsSampler {
  constructor(target: RTCStatsTarget, options?: { interval?: number });
  readonly target: RTCStatsTarget;
  readonly interval: number;
  sample(): Promise<RTCStatsSample>;
  start(callback: (sample: RTCStatsSample) => void | Promise<void>): this;
  stop(): void;
}
