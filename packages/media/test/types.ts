import { MediaSession } from "@webrtc-node/media";
import { RTCPeerConnection } from "@webrtc-node/webrtc";

const session = new MediaSession(new RTCPeerConnection());
const track = session.addTrack({
  kind: "video",
  mid: "video",
  codec: { mimeType: "video/VP8", payloadType: 96 },
  ssrc: 42,
});
track.send(new Uint8Array(12));
track.addEventListener("message", (event) => event.type);
session.close();
