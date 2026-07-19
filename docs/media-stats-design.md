# Media and Statistics Design

This document records the experimental mapping from the W3C media and statistics APIs to the
pinned libdatachannel backend. The consumer-facing object model belongs to
`@webrtc-node/webrtc`. Its typed `nonstandard` namespace also owns optional
application-supplied encoded packet I/O so native track lifecycle does not cross a package boundary.

## Specification Mapping

- `MediaStream` and `MediaStreamTrack` identity, cloning, track sets, enabled state, stopping, and
  events are JavaScript facade behavior.
- `RTCRtpSender`, `RTCRtpReceiver`, and `RTCRtpTransceiver` identity, sender reuse, requested and
  current direction, stopping, and negotiation-needed state are JavaScript facade behavior.
- Signaling methods and `replaceTrack()` share the W3C FIFO operations chain. Successful stats
  collection is asynchronous but does not join that chain; selector validation still rejects in
  the initiating task.
- `RTCRtpSender.getParameters()` owns a task-scoped transaction snapshot. `setParameters()` is
  asynchronous and independent of the operations chain, validates all read-only native/SDP facts,
  and applies `encodings[0].active` through an atomic outbound-RTP gate. RTCP remains enabled, so
  activation does not synthesize BYE or renegotiation.
- The application-supplied encoded backend has one real sending encoding. It trims excess initial
  encodings to that capacity and does not expose a RID for the lone encoding. Encoder and pacing
  controls are rejected rather than stored as ineffective state: codec selection, bitrate,
  frame-rate, and resolution scaling are not implemented. The WebRTC Extensions key-frame option
  is not part of the public declarations because the package has no encoder.
- SDP media sections and DTLS-SRTP packet transport are native libdatachannel behavior.
- `RTCStatsReport` is a read-only JavaScript maplike object. Only measurements produced reliably by
  the backend are included.
- Capture, rendering, device selection, codec processing, RTP packet construction, and pacing are
  outside scope. `nonstandard.EncodedMediaSource` and `nonstandard.EncodedMediaSink` accept already
  encoded and packetized RTP/RTCP.

Applicable WPT is added incrementally. Tests whose subject is browser capture, rendering, media
elements, devices, or capture UI are non-applicable to this Node transport runtime. The harness
uses synthetic encoded tracks only to exercise W3C object and lifecycle semantics.

## Libdatachannel Sources Read

- `include/rtc/configuration.hpp`, `include/rtc/peerconnection.hpp`, `src/peerconnection.cpp`, and
  `src/impl/peerconnection.cpp`: `addTrack()` owns one track per media description, `onTrack()`
  delivers remote media, and `initDtlsTransport()` chooses the media-capable DTLS-SRTP transport
  only when the local description already contains media or `forceMediaTransport` is enabled.
- `include/rtc/track.hpp`, `src/track.cpp`, and `src/impl/track.cpp`: tracks expose their media
  description, permit `setDescription()`, enforce send/receive direction, and route callbacks from
  transport threads. `Track::send()` synchronously enters the media-handler/DTLS-SRTP path and
  treats RTCP control independently from RTP direction checks; there is no per-encoding active
  state, browser transceiver, or remove-track object.
- `include/rtc/description.hpp` and `src/description.cpp`: media entries carry mid, direction,
  codecs, SSRCs, arbitrary media-level attributes, and a removed state. Answer generation
  reciprocates direction. `addSSRC()` accepts an explicit CNAME plus one optional media-stream
  association, while
  `addAttribute()` and `removeAttribute()` allow multiple `a=msid` lines without duplicating SSRC
  ownership.
- `include/rtc/rtppacketizer.hpp`, `src/rtppacketizer.cpp`,
  `include/rtc/rtpdepacketizer.hpp`, and `src/rtpdepacketizer.cpp`: optional handlers packetize or
  reassemble codec frames. The current public adapter intentionally transports complete RTP/RTCP
  and does not imply codec processing.
- `src/impl/transport.hpp`, `src/impl/transport.cpp`, `src/impl/dtlssrtptransport.hpp`,
  `src/impl/dtlssrtptransport.cpp`, `src/impl/dtlstransport.cpp`, `src/impl/icetransport.cpp`, and
  `src/impl/sctptransport.cpp`: media uses DTLS-SRTP while data channels use SCTP. The
  DTLS-SRTP transport forwards DTLS records to its base transport, so forcing it from peer
  construction remains compatible with SCTP-only sessions. Aggregate bytes and RTT exposed by
  `PeerConnection` come from SCTP, not a complete per-ICE or per-RTP stats implementation.
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
- A stopped media description can be marked removed, but libdatachannel does not retain rejected
  sections after their weak track entries expire. The facade separates native MID allocation from
  W3C-visible MID assignment, restores newly assigned MIDs on rollback, and reconciles rejected
  section history into later offers. Complete focused WPT covers local and remote m-line recycling,
  MID timing, rollback, removal, and rejected-answer direction.
- Native callbacks are reset before teardown. Track events and packet callbacks are dispatched by
  `Napi::ThreadSafeFunction`; no libdatachannel callback invokes JavaScript directly.
- The addon enables `Configuration::forceMediaTransport` at peer construction. Without it, ICE can
  initialize a plain DTLS transport before an answerer adds media during renegotiation, and
  `openTracks()` cannot upgrade that transport to DTLS-SRTP. An independent C++ reproduction against
  the pinned backend failed all four late-track runs with the default and passed all four when the
  option was enabled. This is a required binding configuration, not a missing upstream capability.
- When an answerer turns a remote-created track into a local sender, the addon atomically replaces
  direction, SSRC, and `msid` on one copied media description before generating the answer. Native
  track events are routed to both sender and receiver packet adapters attached to that binding.
  This preserves one backend description revision and lets libdatachannel populate its multi-track
  SSRC demultiplexing cache from the answer.
- libdatachannel exposes one bundled DTLS-SRTP transport for media. The facade presents that as a
  stable `RTCDtlsTransport`/`RTCIceTransport` shared by RTP endpoints and SCTP when both media and
  data are negotiated.
- Native RTP counters count version-2 RTP packets and exclude RTCP packet types. Reports link RTP
  dictionaries to the shared transport and to codec dictionaries derived from negotiated SDP;
  inbound reports also expose the stable receiver track identifier. Unsupported loss, jitter,
  bandwidth, decoded-media, media-source, playout, and remote-report fields are omitted.
- When libdatachannel exposes a selected ICE pair, reports include standardized local-candidate,
  remote-candidate, and succeeded candidate-pair dictionaries derived from the parsed native
  candidates. Candidate-pair byte counts and RTT are omitted because the available aggregate
  transport counters are SCTP-level and cannot be attributed reliably to the pair.
- Reports include the local certificate fingerprint and DER bytes retained by the binding. They
  include a remote certificate dictionary only for in-process peers where the verified peer's
  retained DER is authoritative. Libdatachannel's DTLS callbacks reduce external peer certificates
  to a fingerprint and do not retain or publicly expose their DER, so external remote certificate
  stats are omitted rather than reconstructed.
- Sender stream and track IDs are written as media-level `a=msid` attributes. The facade parses
  those attributes from remote SDP, preserves remote `MediaStream` identity by ID, and dispatches
  `track` only after the remote-description operation resolves.
- A trackless sender can still have stream associations through `setStreams()`. The addon writes
  RFC 9429 stream-only `a=msid:<stream-id>` attributes when no sender track ID exists; it does not
  invent an encoded source, SSRC, or track ID. libdatachannel retains these arbitrary media
  attributes when `Track::setDescription()` produces the next offer.
- Each peer connection creates one stable RTCP CNAME. The addon supplies it to
  `Description::Media::addSSRC()` on creation and description updates, so `getParameters().rtcp`
  reports the same value that libdatachannel serializes for every local SSRC.
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
- The facade retains the otherwise-unobservable creation origin of each transceiver. Per WebRTC-PC
  and RFC 9429, a remote offer may associate a disassociated transceiver created by `addTrack()`,
  but never one created explicitly by `addTransceiver()`. Explicit transceivers that are not
  represented by the remote offer stay unassociated, are omitted from the answer, and keep
  `negotiationneeded` pending for a follow-up local offer.

## Validation Scope

Required coverage includes facade lifecycle tests, Node-to-Node RTP, browser-to-Node RTP, focused
media/stats WPT, native close and forced-process teardown, TypeScript/API checks, the core package
dry run, and remote full conformance. The full WPT suite is not run locally. The selected mandatory stats
WPT coverage declares the stable identities of 37 backend-supported checks because that upstream
file registers its field tests dynamically after media negotiation. Execution still runs the
upstream parent test and each selected field assertion; only list-mode discovery uses the declared
identities so selection integrity and sharding do not require executing the test. The selected
renegotiation coverage also sends synthetic encoded audio and video through a second m-line after
the initial offer/answer exchange.
