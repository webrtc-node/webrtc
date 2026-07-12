import type {
  RTCPeerConnection,
  RTCRtpReceiver,
  RTCRtpSender,
  RTCStatsReport,
} from "@webrtc-node/webrtc";

export type RTCStatsTarget = RTCPeerConnection | RTCRtpSender | RTCRtpReceiver;
export type RTCStatsDelta = ReadonlyMap<string, Readonly<Record<string, unknown>>>;
export interface RTCStatsSample {
  readonly report: RTCStatsReport;
  readonly delta: RTCStatsDelta | null;
}

export function diffStatsReports(
  previous: ReadonlyMap<string, Record<string, unknown>>,
  current: ReadonlyMap<string, Record<string, unknown>>,
): RTCStatsDelta;

export class RTCStatsSampler {
  constructor(target: RTCStatsTarget, options?: { interval?: number });
  readonly target: RTCStatsTarget;
  readonly interval: number;
  sample(): Promise<RTCStatsSample>;
  start(callback: (sample: RTCStatsSample) => void | Promise<void>): this;
  stop(): void;
}
