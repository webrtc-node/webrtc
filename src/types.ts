// W3C enum strings shared by the facade and the native binding types.

export type RTCSdpType = "offer" | "answer" | "pranswer" | "rollback";
export type RTCPeerConnectionState =
  | "new"
  | "connecting"
  | "connected"
  | "disconnected"
  | "failed"
  | "closed";
export type RTCIceConnectionState =
  | "new"
  | "checking"
  | "connected"
  | "completed"
  | "disconnected"
  | "failed"
  | "closed";
export type RTCIceGatheringState = "new" | "gathering" | "complete";
export type RTCSignalingState =
  | "stable"
  | "have-local-offer"
  | "have-remote-offer"
  | "have-local-pranswer"
  | "have-remote-pranswer"
  | "closed";
export type RTCIceRole = "unknown" | "controlling" | "controlled";
export type RTCIceComponent = "rtp" | "rtcp";
export type RTCIceTransportState = RTCIceConnectionState;
export type RTCDtlsTransportState = "new" | "connecting" | "connected" | "closed" | "failed";
export type RTCSctpTransportState = "connecting" | "connected" | "closed";
