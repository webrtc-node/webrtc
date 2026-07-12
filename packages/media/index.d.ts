import type { MediaStreamTrack } from "@webrtc-node/webrtc";

export interface EncodedMediaSourceInit {
  kind: "audio" | "video";
  codec: { mimeType: string; payloadType: number; profile?: string };
  label?: string;
  ssrc?: number;
}

export class EncodedMediaSource extends EventTarget {
  constructor(init: EncodedMediaSourceInit);
  readonly track: MediaStreamTrack;
  readonly codec: Readonly<EncodedMediaSourceInit["codec"]>;
  readonly ssrc: number | null;
  readonly maxPacketSize: number | null;
  readonly readyState: "new" | "connecting" | "open" | "closed";
  onopen: ((event: Event) => void) | null;
  onclose: ((event: Event) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  send(packet: ArrayBuffer | ArrayBufferView): boolean;
  close(): void;
}

export class EncodedMediaSink extends EventTarget {
  constructor(track: MediaStreamTrack);
  readonly track: MediaStreamTrack;
  onpacket: ((event: MessageEvent<ArrayBuffer>) => void) | null;
  close(): void;
}
