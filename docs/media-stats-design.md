# Media and Statistics Design

This document records the experimental mapping from the W3C media and statistics APIs to the
pinned libdatachannel backend. The consumer-facing object model belongs to
`@webrtc-node/webrtc`; companion packages only provide optional encoded packet I/O and report
sampling.

## Specification Mapping

- `MediaStream` and `MediaStreamTrack` identity, cloning, track sets, enabled state, stopping, and
  events are JavaScript facade behavior.
- `RTCRtpSender`, `RTCRtpReceiver`, and `RTCRtpTransceiver` identity, sender reuse, requested and
  current direction, stopping, and negotiation-needed state are JavaScript facade behavior.
- SDP media sections and DTLS-SRTP packet transport are native libdatachannel behavior.
- `RTCStatsReport` is a read-only JavaScript maplike object. Only measurements produced reliably by
  the backend are included.
- Capture, rendering, device selection, codec processing, RTP packet construction, and pacing are
  outside scope. `@webrtc-node/media` accepts already encoded and packetized RTP/RTCP.

Applicable WPT is added incrementally. Tests whose subject is browser capture, rendering, media
elements, devices, or capture UI are non-applicable to this Node transport runtime. The harness
uses synthetic encoded tracks only to exercise W3C object and lifecycle semantics.

## Libdatachannel Sources Read

- `include/rtc/peerconnection.hpp`, `src/peerconnection.cpp`, and
  `src/impl/peerconnection.cpp`: `addTrack()` owns one track per media description, `onTrack()`
  delivers remote media, and ICE creates DTLS followed by DTLS-SRTP and SCTP transports.
- `include/rtc/track.hpp`, `src/track.cpp`, and `src/impl/track.cpp`: tracks expose their media
  description, permit `setDescription()`, enforce send/receive direction, and route callbacks from
  transport threads. There is no browser transceiver or remove-track object.
- `include/rtc/description.hpp` and `src/description.cpp`: media entries carry mid, direction,
  codecs, SSRCs, arbitrary media-level attributes, and a removed state. Answer generation
  reciprocates direction. `addSSRC()` accepts one optional media-stream association, while
  `addAttribute()` and `removeAttribute()` allow multiple `a=msid` lines without duplicating SSRC
  ownership.
- `include/rtc/rtppacketizer.hpp`, `src/rtppacketizer.cpp`,
  `include/rtc/rtpdepacketizer.hpp`, and `src/rtpdepacketizer.cpp`: optional handlers packetize or
  reassemble codec frames. The current public adapter intentionally transports complete RTP/RTCP
  and does not imply codec processing.
- `src/impl/dtlssrtptransport.cpp`, `src/impl/dtlstransport.cpp`,
  `src/impl/icetransport.cpp`, and `src/impl/sctptransport.cpp`: media uses DTLS-SRTP while data
  channels use SCTP. Aggregate bytes and RTT exposed by `PeerConnection` come from SCTP, not a
  complete per-ICE or per-RTP stats implementation.
- `include/rtc/channel.hpp`, `src/channel.cpp`, and `src/impl/channel.cpp`: callbacks may arrive from
  backend threads and ownership uses shared/weak handles. JavaScript delivery must continue through
  a Node-API thread-safe dispatcher.
- `examples/media-sender/main.cpp`, `examples/media-receiver/main.cpp`, and `test/track.cpp`: local
  media descriptions are created before offers, remote tracks arrive from `onTrack()`, and raw RTP
  can be sent and received without a browser capture pipeline.

## Backend Constraints

Temporary facade and addon workarounds in this section are mapped to source-backed removal
criteria in [libdatachannel Upstream Candidates](libdatachannel-upstream-candidates.md).

- Direction changes and stopping are applied by replacing a track's media description before the
  next offer. JavaScript keeps stable transceiver/sender/receiver identity.
- A stopped media description can be marked removed, but libdatachannel does not expose the full
  JSEP transceiver recycling algorithm. Reuse and rollback behavior require focused conformance
  coverage before promotion.
- Native callbacks are reset before teardown. Track events and packet callbacks are dispatched by
  `Napi::ThreadSafeFunction`; no libdatachannel callback invokes JavaScript directly.
- libdatachannel exposes one bundled DTLS-SRTP transport for media. The facade presents that as a
  stable `RTCDtlsTransport`/`RTCIceTransport` shared by RTP endpoints and SCTP when both media and
  data are negotiated.
- Native RTP counters count version-2 RTP packets and exclude RTCP packet types. Unsupported loss,
  jitter, codec, bandwidth, media-source, playout, and remote-report fields are omitted.
- Sender stream and track IDs are written as media-level `a=msid` attributes. The facade parses
  those attributes from remote SDP, preserves remote `MediaStream` identity by ID, and dispatches
  `track` only after the remote-description operation resolves.
- libdatachannel does not invoke `onTrack()` again when renegotiation only changes `a=msid` on an
  existing track. The facade detects changed remote associations from SDP, updates stream
  membership, preserves the encoded packet listener source, and queues the W3C-required repeated
  `track` event without duplicating native callbacks.
- A bidirectional m-line may have multiple libdatachannel track handles for the locally created
  sender and remotely announced receiver even though all use the same `mid`. The facade retains
  separate send ownership plus every announced receive handle under one JavaScript transceiver.
  Packet callbacks route to the stable receiver source, and inbound stats select the retained
  receive view with authoritative packet counters without summing duplicate views. Focused package
  flow and `RTCRtpReceiver-getStats.https.html` cover answerer-started RTP, teardown, and filtering.
- Negotiation-needed state is revision-based: an applied local offer suppresses changes it
  represents, rollback restores unrepresented changes, and mutations made after offer creation are
  queued until signaling returns to stable.

## Validation Scope

Required coverage includes facade lifecycle tests, Node-to-Node RTP, browser-to-Node RTP, focused
media/stats WPT, native close and forced-process teardown, TypeScript/API checks, package dry runs,
and remote full conformance. The full WPT suite is not run locally.
