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
  activation does not synthesize BYE or renegotiation. Transaction expiry, update completion, and
  `negotiationneeded` use one FIFO WebRTC task source so cross-peer task ordering is deterministic.
- Static sender and receiver capabilities describe every encoded RTP codec that the backend can
  carry through its raw packet track API. They do not claim codec processing. Audio advertises MID
  plus the RFC 6464 SSRC and RFC 6465 CSRC audio-level extensions; video advertises MID. Every
  extension is represented natively in SDP and transported unchanged.
- `RTCRtpTransceiver.setCodecPreferences()` conversion and validation remain JavaScript policy.
  The addon receives the resulting complete ordered codec list and replaces one copied native
  track description before libdatachannel creates an offer or answer. Answers preserve remote
  payload types, intersect supported codecs, retain valid RTX `apt` associations, and apply the
  answerer's preference order. Committed answer mappings seed later offers from the same
  transceiver. RTP packet bytes are not rewritten, so offer/answer generation rejects an attached
  encoded source whose fixed codec/payload mapping is absent or conflicts with the media section.
- `RTCRtpReceiver.getParameters()` derives fresh codec, negotiated-header-extension, and RTCP
  dictionaries from the committed answer. It stays empty before answer application and has no
  sender transaction, encoding, or CNAME fields.
- `RTCRtpReceiver.getSynchronizationSources()` and `getContributingSources()` derive SSRC, CSRC,
  RTP timestamp, and negotiated audio-level facts from authenticated clear RTP delivered by the
  backend. The facade retains one latest dictionary per source for ten seconds, rejects older RTP
  timestamps with wraparound-aware ordering, returns fresh copies in descending delivery-time
  order, and excludes RTCP. Because this runtime intentionally has no decoder, delivery time is the
  encoded packet's Node event-loop arrival rather than decoded-frame playout.
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
  codecs, SSRCs, arbitrary media-level attributes, RTP `ExtMap` values, and a removed state.
  `mOrderedPayloadTypes` preserves m-line preference order, while RTP-map attributes are currently
  serialized by numeric payload type from `mRtpMaps`. Answer generation reciprocates media and
  extension direction. `addSSRC()` accepts an explicit CNAME plus one optional media-stream
  association, while
  `addAttribute()` and `removeAttribute()` allow multiple `a=msid` lines without duplicating SSRC
  ownership.
- `include/rtc/rtppacketizer.hpp`, `src/rtppacketizer.cpp`,
  `include/rtc/rtpdepacketizer.hpp`, and `src/rtpdepacketizer.cpp`: optional handlers packetize or
  reassemble codec frames. The current public adapter intentionally transports complete RTP/RTCP
  and does not imply codec processing.
- `include/rtc/rtp.hpp`, `src/rtp.cpp`, `src/impl/track.cpp`, and
  `src/impl/dtlssrtptransport.cpp`: the backend can parse RTP extension headers when a packetizer
  requests it, while the raw track path preserves the caller's complete RTP header through SRTP
  protection and unprotection. Incoming media is authenticated and unprotected before the complete
  clear packet reaches the track callback. The addon therefore negotiates MID and audio-level
  extensions but does not synthesize them in application packets.
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
  direction, codecs, SSRC, and `msid` on one copied media description before generating the
  answer. Native track events are routed to both sender and receiver packet adapters attached to
  that binding. This preserves one backend description revision and lets libdatachannel populate
  its multi-track SSRC demultiplexing cache from the answer.
- libdatachannel stores m-line codec preference order correctly but serializes `a=rtpmap`,
  `a=fmtp`, and payload-specific `a=rtcp-fb` groups in numeric payload-type order. The facade
  normalizes those attribute groups to m-line order for W3C-visible descriptions. This workaround
  is removable if the source-backed upstream candidate is resolved.
- libdatachannel exposes one bundled DTLS-SRTP transport for media. The facade presents that as a
  stable `RTCDtlsTransport`/`RTCIceTransport` shared by RTP endpoints and SCTP when both media and
  data are negotiated.
- Native RTP counters count version-2 RTP packets and exclude RTCP packet types. Reports link RTP
  dictionaries to the shared transport and to codec dictionaries derived from negotiated SDP;
  inbound reports also expose the stable receiver track identifier. Unsupported loss, jitter,
  bandwidth, decoded-media, media-source, playout, and remote-report fields are omitted.
- Receiver source snapshots parse only authenticated clear RTP emitted by the track callback. They
  use the extension IDs from the committed answer, support RFC 8285 one-byte and two-byte header
  forms, expose audio levels only when the matching extension is present, and never infer source
  facts from SDP or packet counters. This needs no upstream state cache because libdatachannel's raw
  callback and `Description::Media::ExtMap` already provide the authoritative packet and negotiated
  mapping.
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
- One application-supplied encoded source may back tracks sent by multiple peer connections.
  Because each libdatachannel `Track` belongs to one peer connection and one DTLS-SRTP transport,
  the Node adapter retains a binding set and fans each packet out to every open sender. Sender
  replacement, removal, transceiver stopping, and peer close detach only their own binding; late
  callbacks are matched by binding identity and cannot close or retarget the shared source.
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
