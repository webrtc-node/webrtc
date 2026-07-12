import { EncodedMediaSink, EncodedMediaSource } from "@webrtc-node/media";
import { RTCPeerConnection } from "@webrtc-node/webrtc";

const peer = new RTCPeerConnection();
const source = new EncodedMediaSource({
  kind: "video",
  codec: { mimeType: "video/VP8", payloadType: 96 },
});
peer.addTrack(source.track);
peer.addEventListener("track", (event) => {
  const sink = new EncodedMediaSink((event as unknown as { track: typeof source.track }).track);
  sink.addEventListener("packet", () => {});
});
