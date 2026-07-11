import type { RTCPeerConnection } from "@webrtc-node/webrtc";

export type MediaKind = "audio" | "video";
export type MediaDirection = "sendonly" | "recvonly" | "sendrecv" | "inactive";
export interface CodecInit {
  mimeType: string;
  payloadType: number;
  profile?: string;
}
export interface EncodedTrackInit {
  kind: MediaKind;
  mid: string;
  direction?: MediaDirection;
  codec: CodecInit;
  ssrc?: number;
}
export class MediaErrorEvent extends Event {
  readonly message: string;
}
export class EncodedTrack extends EventTarget {
  readonly kind: MediaKind;
  readonly mid: string;
  readonly direction: MediaDirection;
  readonly codec: Readonly<CodecInit>;
  readonly ssrc: number | null;
  readonly maxPacketSize: number;
  readonly readyState: "connecting" | "open" | "closed";
  onopen: ((event: Event) => void) | null;
  onclose: ((event: Event) => void) | null;
  onerror: ((event: MediaErrorEvent) => void) | null;
  onmessage: ((event: MessageEvent<ArrayBuffer>) => void) | null;
  send(data: ArrayBuffer | ArrayBufferView): boolean;
  close(): void;
}
export class MediaSession {
  constructor(peerConnection: RTCPeerConnection);
  readonly peerConnection: RTCPeerConnection;
  addTrack(init: EncodedTrackInit): EncodedTrack;
  getTracks(): EncodedTrack[];
  close(): void;
}
