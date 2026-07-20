# libdatachannel upstream candidates

This register tracks backend capabilities that may belong in
[`paullouisageneau/libdatachannel`](https://github.com/paullouisageneau/libdatachannel)
rather than in the Node facade. Evidence applies to pinned commit
`188ec93f6a0b01c2032ddb4c8c013118f7f30232`, with media enabled and libjuice
unless stated otherwise.

No entry authorizes filing an upstream issue or pull request. An item becomes
`upstream-ready` only after a focused C++ reproduction independent of this
binding validates the source finding and proposed contract. Request explicit
approval before filing.

WebIDL conversion, DOMException shape, event task timing, stable JavaScript
object identity, and `negotiationneeded` policy remain in JavaScript. Native
transport facts, media-section state, and lifecycle signals should come from
libdatachannel when they are useful to general C++ consumers.

Normative references used by the entries are the
[WebRTC Recommendation](https://www.w3.org/TR/webrtc/),
[WebRTC Statistics Recommendation](https://www.w3.org/TR/webrtc-stats/),
[JSEP (RFC 8829)](https://www.rfc-editor.org/rfc/rfc8829), and
[WebRTC media transport and RTP usage (RFC 8834)](https://www.rfc-editor.org/rfc/rfc8834).
The named WPT files are from pinned WPT commit
`03169f171c797d0953b21d7388561b454fde0ad4`.

## Statuses

- `unverified`: source evidence is incomplete.
- `confirmed-absent`: source inspection proves the API or signal is absent, but
  an upstream-quality reproduction or contract is still missing.
- `upstream-ready`: source evidence, C++ reproduction, API contract, and native
  test plan are ready. Approval is still required before filing.
- `filed`, `in-progress`, `resolved`, `declined`: upstream disposition.

| Candidate | Status | Existing upstream link |
| --- | --- | --- |
| Existing-track description and `msid` notifications | `confirmed-absent` | None found |
| Reliable transport and RTP/RTCP statistics | `confirmed-absent` | None found |
| Explicit track removal and stopping lifecycle | `confirmed-absent` | None found |
| Transceiver-like media-section lifecycle and m-line reuse | `confirmed-absent` | None found |
| Observable media DTLS-SRTP/ICE state and pair statistics | `confirmed-absent` | None found |
| DTLS startup after remote-description commit | `confirmed-absent` | None found |
| Native ICE restart with fresh credentials | `filed` | [#545](https://github.com/paullouisageneau/libdatachannel/issues/545) |
| Candidate-gathering error callbacks | `confirmed-absent` | None found |
| First-class multiple media-stream associations | `confirmed-absent` | None found |
| Codec-preference-consistent RTP-map serialization | `confirmed-absent` | None found |

### Evaluated integration constraint: late media transport initialization

**Disposition:** existing upstream configuration; not an upstream candidate.

- **Requirement and WPT.** A second audio or video transceiver added by
  renegotiation must carry RTP whether the first m-line sends or is inactive.
  Applicable WPT:
  `webrtc/RTCPeerConnection-addTransceiver-renegotiation.https.html`.
- **Source inspected.** `include/rtc/configuration.hpp`,
  `include/rtc/peerconnection.hpp`, `src/peerconnection.cpp`,
  `src/impl/peerconnection.hpp`, `src/impl/peerconnection.cpp`,
  `src/impl/transport.hpp`, `src/impl/transport.cpp`,
  `src/impl/dtlstransport.cpp`, `src/impl/dtlssrtptransport.hpp`,
  `src/impl/dtlssrtptransport.cpp`, `src/impl/track.hpp`,
  `src/impl/track.cpp`, and `test/track.cpp`.
- **Evidence and reproduction.** `initDtlsTransport()` selects
  `DtlsSrtpTransport` only when the current local description has audio/video or
  `Configuration::forceMediaTransport` is true. `openTracks()` reports an error
  when later media reaches a plain `DtlsTransport`; there is no in-place
  upgrade. A standalone C++ two-peer reproduction against the pinned checkout
  failed 4/4 late-track runs with the default configuration and passed 4/4 with
  `forceMediaTransport`.
- **Binding action.** The addon enables `forceMediaTransport` before peer
  construction. `DtlsSrtpTransport::demuxMessage()` consumes SRTP/SRTCP and
  forwards DTLS records to the base transport, preserving SCTP/data-channel
  setup. This uses the backend's intended public option and needs no upstream
  issue. Native integration checks pin the option, while Node and selected WPT
  tests cover late media and ordinary data-channel behavior.

### Evaluated integration constraint: sender activation and RTCP CNAME

**Disposition:** binding/facade policy using existing upstream primitives; not
an upstream candidate.

- **Requirement and WPT.** WebRTC-PC requires task-scoped
  `getParameters()`/`setParameters()` transactions, a stable sender RTCP CNAME,
  and `encodings[].active` changes that stop RTP without renegotiation or an
  RTCP BYE. Applicable WPT: `webrtc/RTCRtpSender-setParameters.html`,
  `webrtc/RTCRtpParameters-transactionId.html`,
  `webrtc/RTCRtpParameters-rtcp.html`,
  `webrtc/RTCRtpParameters-encodings.html`, and the `setParameters` cases in
  `webrtc/RTCPeerConnection-operations.https.html`.
- **Source inspected.** `include/rtc/track.hpp`, `src/track.cpp`,
  `src/impl/track.hpp`, `src/impl/track.cpp`, `include/rtc/mediahandler.hpp`,
  `src/mediahandler.cpp`, `src/impl/dtlssrtptransport.cpp`,
  `include/rtc/description.hpp`, and `src/description.cpp`.
- **Evidence.** `Track::send()` synchronously enters `impl::Track::outgoing()`.
  With no media handler it classifies RTCP as control, applies media direction
  only to non-control packets, and then calls the DTLS-SRTP transport. This is a
  packet transport API, not a W3C sender-encoding state machine, so a general
  C++ `active` property would duplicate caller policy. Separately,
  `Description::Media::addSSRC()` already accepts and serializes the CNAME; the
  binding had incorrectly supplied each media-section MID instead of one
  peer-level value.
- **Binding action.** JavaScript owns transaction IDs, WebIDL conversion,
  immutable-field checks, task timing, and unsupported encoder-control errors.
  `TrackBinding` has an atomic gate immediately before `Track::send()` that
  drops only outbound RTP while inactive; RTCP still enters libdatachannel.
  Peer construction creates one CNAME and supplies it to `addSSRC()` on track
  creation and every description update. Focused WPT plus Node-to-Node packet
  flow and SDP tests cover suppression, resumption, RTCP metadata, close, and
  asynchronous completion. No upstream issue is warranted.

### Evaluated integration constraint: encoded sources shared across peer connections

**Disposition:** Node adapter ownership; not an upstream candidate.

- **Requirement and WPT.** WebRTC-PC restricts duplicate use of one track only
  within a single peer connection; the same `MediaStreamTrack` may be sent by
  separate peer connections. The applicable
  `webrtc/RTCPeerConnection-mandatory-getStats.https.html` fixture attaches
  each synthetic audio and video track to both peers while validating reports.
- **Source inspected.** `include/rtc/track.hpp`, `src/track.cpp`,
  `src/impl/track.hpp`, `src/impl/track.cpp`,
  `src/impl/peerconnection.cpp`, and `src/impl/dtlssrtptransport.cpp`.
- **Evidence.** Each `rtc::Track` is created and retained by one
  `PeerConnection`, and `impl::Track` holds a weak reference to that peer's
  `DtlsSrtpTransport`. `Track::send()` synchronously locks and uses that one
  transport, throwing when it is no longer open. libdatachannel intentionally
  has no application media-source object spanning independent peer
  connections.
- **Binding action.** One JavaScript encoded source owns a set of native track
  bindings and sends each packet through every currently open binding. Close,
  replace, remove, and stop paths detach by binding identity; callback routing
  resolves the sender's current source instead of retaining the source present
  when the native track was created. The source remains usable until explicitly
  closed or its final JavaScript track ends. Focused Node-to-Node coverage sends
  one source to two independent peers, closes one, and verifies the other keeps
  receiving. This is a Node-specific producer-adapter contract and would not be
  useful in libdatachannel's per-peer `Track` API, so no upstream issue is
  warranted.

### Evaluated integration constraint: RTP capabilities, header extensions, and source reporting

**Disposition:** existing upstream media-description API; not an upstream
candidate.

- **Requirement and WPT.** WebRTC-PC requires static sender/receiver
  capabilities and receiver parameters derived from the negotiated codecs,
  RTP header extensions, and RTCP mode. It also requires transceiver codec
  preferences to control offer/answer codec filtering and order, plus recent
  SSRC/CSRC source dictionaries derived from delivered RTP. Applicable WPT:
  `webrtc/RTCRtpSender-getCapabilities.html`,
  `webrtc/RTCRtpReceiver-getCapabilities.html`,
  `webrtc/RTCRtpReceiver-getParameters.html`,
  `webrtc/RTCRtpTransceiver-setCodecPreferences.html`,
  `webrtc/RTCRtpReceiver-getSynchronizationSources.https.html`, and
  `webrtc/RTCRtpReceiver-getContributingSources.https.html`.
- **Source inspected.** `include/rtc/description.hpp`, `src/description.cpp`,
  `include/rtc/rtp.hpp`, `src/rtp.cpp`, `src/impl/track.cpp`, and
  `src/impl/peerconnection.cpp`, and `src/impl/dtlssrtptransport.cpp`.
- **Evidence.** `Description::Entry::ExtMap` parses, stores, serializes, and
  reciprocates extension direction. Audio/video descriptions expose the exact
  RTP maps used by the addon. With no media handler, `impl::Track` accepts a
  complete RTP packet and DTLS-SRTP protects or unprotects it without rewriting
  its extension header. `DtlsSrtpTransport::recvMedia()` authenticates and
  unprotects SRTP before forwarding the original clear RTP header through the
  track callback.
- **Binding action.** Static JavaScript capabilities report only codecs the raw
  packet adapter can describe and transport. New native media descriptions add
  MID on audio/video and standardized SSRC/CSRC audio levels on audio through
  `addExtMap()`; receiver parameters are reconstructed from the committed
  answer. Codec preferences are converted and validated in JavaScript, then
  applied as complete RTP maps through `Track::setDescription()` before native
  offer/answer generation. The facade derives the W3C ten-second source
  dictionaries from authenticated clear packets and negotiated extension IDs;
  their WebIDL shape and task visibility are JavaScript policy. The binding does
  not claim an encoder, decoder, packetizer, or any extension it does not
  negotiate. Native build coverage, SDP assertions, Node-to-Node flow, and the
  focused WPT files exercise the contract. Existing upstream primitives are
  sufficient for this ownership split, so no capability issue is warranted.

## Codec-preference-consistent RTP-map serialization

**Status:** `confirmed-absent`

1. **Requirement and WPT.** WebRTC-PC and JSEP use m-line payload order as codec
   preference order. WPT additionally checks that generated RTP-map lines expose
   the selected first codec in `webrtc/RTCRtpTransceiver-setCodecPreferences.html`.
2. **Source inspected.** `include/rtc/description.hpp` and
   `src/description.cpp`, especially `Media::description()`, `addRtpMap()`,
   `removeRtpMap()`, and `generateSdpLines()`.
3. **Absence evidence.** `Media::description()` emits payload types from
   `mOrderedPayloadTypes`, but `generateSdpLines()` emits `a=rtpmap`,
   payload-specific `a=rtcp-fb`, and `a=fmtp` attributes by iterating the
   numerically ordered `mRtpMaps` map. A preference such as H264 payload 102
   before VP8 payload 96 is therefore represented correctly in the m-line but
   serialized with the VP8 RTP-map first. An independent minimal C++
   reproduction has not yet been retained, so this item is not
   `upstream-ready`.
4. **Current workaround.** `packages/webrtc/lib/index.js` groups codec
   attributes by payload type and reorders those groups to match each generated
   audio/video m-line before exposing a session description. The native media
   description remains authoritative for mappings and preference order.
5. **Why insufficient.** The facade duplicates SDP serialization policy, and
   non-Node libdatachannel consumers still observe contradictory textual order.
   The workaround must run again after candidate-driven local-description
   refreshes.
6. **Proposed upstream behavior.** Make `Media::generateSdpLines()` iterate
   `mOrderedPayloadTypes`, look up each immutable `RtpMap`, and emit each codec's
   RTP-map/feedback/fmtp group in that order. This changes no API, ownership, or
   callback contract and runs under the description owner's existing thread
   synchronization.
7. **Required native tests.** Construct media with numerically non-monotonic
   payload types, assert m-line and attribute-group order, remove/re-add a map,
   verify RTX `apt` groups remain adjacent to their ordered primary, and
   parse/serialize a remote description without changing preference order.
8. **Compatibility/build options.** Preserve existing SDP content and payload
   mappings; only attribute order changes. Exercise media enabled/disabled,
   bundled/system dependencies, and all supported compilers because this is
   core description code independent of TLS, ICE, and SCTP backends.
9. **Upstream links.** No matching issue, pull request, or released fix found as
   of 2026-07-19.

## Existing-track description and msid notifications

**Status:** `confirmed-absent`

1. **Requirement and WPT.** JSEP renegotiation updates an existing m-section,
   direction, and `a=msid` associations without replacing receiver identity.
   Applicable WPT: `webrtc/RTCRtpSender-setStreams.https.html`,
   `webrtc/RTCPeerConnection-ontrack.https.html`, and
   `webrtc/RTCPeerConnection-addTransceiver-renegotiation.https.html`, plus
   `webrtc/RTCTrackEvent-fire.html` for same-track association changes.
2. **Source inspected.** `include/rtc/track.hpp`, `src/track.cpp`,
   `src/impl/track.hpp`, `src/impl/track.cpp`,
   `src/impl/peerconnection.hpp`, `src/impl/peerconnection.cpp`,
   `include/rtc/description.hpp`, `src/description.cpp`, `test/track.cpp`.
3. **Absence evidence.** `Track::setDescription()` replaces
   `mMediaDescription` and invokes only the media-handler chain. There is no
   description-change callback. `processRemoteDescription()` skips an existing
   `mid` except for RTX disabling; `onTrack()` is emitted only for a new track.
4. **Current workaround.** `packages/webrtc/lib/index.js` diffs SDP, owns stream
   associations, and synthesizes repeated `track` events.
   `NativeTrack::UpdateDescription`/`UpdateStreams` in the addon mutate copied
   media descriptions before offer/answer generation. The addon uses
   libdatachannel's arbitrary media attributes to retain media-level `a=msid`
   lines, including stable sender identity when no encoded source is attached.
5. **Why insufficient.** Native and JavaScript description state can diverge,
   backend changes have no authoritative revision signal, and candidate-driven
   local SDP refresh requires direction realignment. The SDP diff is removable.
6. **Proposed upstream API.** Add per-track
   `onDescriptionChange(function<void(Description::Media)>)`, dispatched by the
   peer `Processor` after commit and outside track/peer locks. The callback owns
   a copy, distinguishes local from remote updates, and resets on close.
7. **Required native tests.** Same-`mid` direction and `msid` renegotiation,
   zero/one/multiple associations, no duplicate for identical SDP, commit order,
   callback reset, and close during callback in `test/track.cpp`.
8. **Compatibility/build options.** Keep `setDescription()` source compatible.
   Preserve removed-track behavior with `RTC_ENABLE_MEDIA=OFF`.
9. **Upstream links.** No matching issue or released API found as of 2026-07-13.

## Reliable transport and RTP/RTCP statistics

**Status:** `confirmed-absent`

1. **Requirement and WPT.** W3C stats need consistent `candidate-pair`,
   `transport`, `inbound-rtp`, `outbound-rtp`, `remote-inbound-rtp`, and
   `remote-outbound-rtp` dictionaries when reliable facts exist. Applicable WPT:
   `webrtc/RTCPeerConnection-mandatory-getStats.https.html`,
   `webrtc/RTCPeerConnection-transport-stats.https.html`,
   `webrtc/RTCRtpSender-getStats.https.html`, and
   `webrtc/RTCRtpReceiver-getStats.https.html`.
2. **Source inspected.** `include/rtc/peerconnection.hpp`,
   `src/peerconnection.cpp`, `src/impl/sctptransport.hpp`,
   `src/impl/sctptransport.cpp`, `include/rtc/rtcpreceivingsession.hpp`,
   `src/rtcpreceivingsession.cpp`, `include/rtc/rtp.hpp`, `src/rtp.cpp`,
   `include/rtc/rtcpsrreporter.hpp`, `src/rtcpsrreporter.cpp`.
3. **Absence evidence.** Public peer stats are SCTP bytes and SCTP RTT only.
   `RtcpReceivingSession` maintains sequence, received, loss-interval, transit,
   and jitter state and parses SR/RR, but exposes only sync timestamps. RTCP
   report blocks decode loss, jitter, LSR, and DLSR without a retained public
   per-SSRC snapshot. `Track` exposes no RTP counters.
4. **Current workaround.** `TrackBinding` counts RTP packets/bytes at the addon
   boundary. The facade combines those with SCTP counters and omits loss, jitter,
   media RTT, and remote reports. Core omits facts the backend cannot support.
5. **Why insufficient.** Boundary counters miss native handler traffic and
   cannot classify retransmission or padding. They cannot produce remote RTCP
   views, and fabricated zeros would be misleading. Addon counters are removable.
6. **Proposed upstream API.** Add immutable per-SSRC `TrackStats` snapshots with
   monotonic packet/octet counters, extended sequence/loss, RTP-unit jitter,
   latest local/remote SR/RR fields, optional RTT, and sample timestamp. Snapshot
   reads copy under short locks; polling needs no callback.
7. **Required native tests.** Deterministic RTP gaps, wraparound, duplicates,
   reordering, jitter, SR/RR, LSR/DLSR RTT, reset policy, concurrent reads, RTX
   accounting, and connected-track assertions.
8. **Compatibility/build options.** Return unsupported/empty media stats with
   `RTC_ENABLE_MEDIA=OFF`; use fixed-width counters. System/bundled SRTP and all
   TLS backends must report the same cleartext RTP/RTCP facts.
9. **Upstream links.** No matching issue or released API found as of 2026-07-13.

## Explicit track removal and stopping lifecycle

**Status:** `confirmed-absent`

1. **Requirement and WPT.** `removeTrack()` detaches sending without destroying
   the sender. Transceiver stop rejects an m-section through negotiation and
   completes at the specified answer transition. Applicable WPT:
   `webrtc/RTCPeerConnection-removeTrack.https.html` and
   `webrtc/RTCPeerConnection-addTransceiver-renegotiation.https.html`.
2. **Source inspected.** `include/rtc/peerconnection.hpp`,
   `include/rtc/track.hpp`, `src/peerconnection.cpp`, `src/track.cpp`,
   `src/impl/track.cpp`, `src/impl/peerconnection.cpp`, `test/track.cpp`.
3. **Absence evidence.** Public peer API has `addTrack()` but no removal or
   stop-negotiation operation. `Track::close()` immediately closes callbacks.
   Rejection occurs only through a manually removed copied description or weak
   track disappearance, with no negotiated-completion signal.
4. **Current workaround.** JavaScript retains sender/transceiver objects,
   changes direction, marks media removed through native `updateDescription()`,
   and derives stopping/stopped state from applied SDP.
5. **Why insufficient.** JavaScript duplicates native m-section lifecycle and
   directly closes tracks on rejection paths. Close/removal/replacement/teardown
   have no common owner-level transition. This native mutation is removable.
6. **Proposed upstream API.** Add `removeTrack(track)` to detach sending while
   retaining the section, and `stopTrack(track)` to reject it on the next
   negotiation. Emit committed lifecycle changes after answer application via
   `Processor`; operations are peer-owned and idempotent.
7. **Required native tests.** Remove before offer and after connection, re-add,
   stop offer/answer, rollback, remote rejection, repeated calls, send during
   transition, close races, and media-disabled behavior.
8. **Compatibility/build options.** Keep `Track::close()` and weak-track cleanup
   behavior. Define equivalent C handle semantics without breaking current API.
9. **Upstream links.** No matching issue or released API found as of 2026-07-13.

## Transceiver-like media-section lifecycle and m-line reuse

**Status:** `confirmed-absent`

1. **Requirement and WPT.** Unified Plan/JSEP requires ordered m-sections,
   stable `mid`, direction negotiation, rejection, and eligible m-line reuse.
   Applicable WPT: `webrtc/RTCPeerConnection-addTrack.https.html`,
   `webrtc/RTCPeerConnection-addTransceiver.https.html`,
   `webrtc/RTCPeerConnection-addTransceiver-renegotiation.https.html`,
   `webrtc/RTCPeerConnection-removeTrack.https.html`,
   `webrtc/RTCPeerConnection-setDescription-transceiver.html`,
   `webrtc/RTCRtpTransceiver-stop.html`, and
   `webrtc/protocol/transceiver-mline-recycling.html`.
2. **Source inspected.** `src/impl/peerconnection.hpp`,
   `src/impl/peerconnection.cpp`, `include/rtc/description.hpp`,
   `src/description.cpp`, `test/track.cpp`.
3. **Absence evidence.** Media state is an `mTracks` map by `mid` plus ordered
   weak `mTrackLines`. `emplaceTrack()` reuses only an open track with that exact
   `mid`; otherwise it appends. There is no transceiver, sender/receiver split,
   reusable rejected-slot query, negotiated direction, or stopping state.
4. **Current workaround.** The facade owns sender/receiver/transceiver identity,
   direction/currentDirection, stop state, generated `mid`, answer intersection,
   and reuse policy, then maps each object to a native track. It separately tracks
   native and W3C-visible MID assignment and reconciles rejected historical
   sections into generated offers after weak native track entries disappear.
5. **Why insufficient.** SDP and native track state can diverge, requiring
   `alignMediaDirections()` after backend SDP refresh. Native resource release
   for rejected sections is not observable. JavaScript identity remains, but
   duplicated native section state is removable.
6. **Proposed upstream API.** Add a peer-owned media-section handle with stable
   index/`mid`, kind, local/remote/negotiated direction, rejected/stopping state,
   optional send/receive tracks, explicit allocation, and eligible-slot reuse.
   Publish copied snapshots through `Processor`, never under `mTracksMutex`.
7. **Required native tests.** Ordered audio/video allocation, same-kind and
   rejected-slot reuse, incompatible-kind append, remote-offer race, rollback,
   direction intersection, BUNDLE stability, stop completion, and teardown.
8. **Compatibility/build options.** Keep `addTrack(Description::Media)` as a
   wrapper and avoid browser event policy. Media-disabled builds should still
   parse/reciprocate sections and consistently reject active media.
9. **Upstream links.** No matching issue or released API found as of 2026-07-13.

## Observable media DTLS-SRTP/ICE state and pair statistics

**Status:** `confirmed-absent`

1. **Requirement and WPT.** RTP endpoints expose a shared DTLS transport, ICE
   state, and selected candidate-pair stats. Applicable WPT:
   `webrtc/RTCRtpSender-transport.https.html`,
   `webrtc/RTCPeerConnection-transport-stats.https.html`, and
   `webrtc/RTCIceConnectionState-candidate-pair.https.html`.
2. **Source inspected.** `src/impl/transport.hpp`,
   `src/impl/icetransport.hpp`, `src/impl/icetransport.cpp`,
   `src/impl/dtlstransport.hpp`, `src/impl/dtlstransport.cpp`,
   `src/impl/dtlssrtptransport.hpp`,
   `src/impl/dtlssrtptransport.cpp`, `src/impl/peerconnection.hpp`,
   `src/impl/peerconnection.cpp`, `include/rtc/peerconnection.hpp`.
3. **Absence evidence.** ICE, DTLS, and DTLS-SRTP have internal state callbacks,
   but public peer API exposes only aggregate peer/ICE state. It provides selected
   candidates and addresses, but no public transport handles, DTLS-SRTP state,
   selected-pair change callback, pair counters, consent state, or ICE RTT. The
   TLS-specific certificate verification callbacks receive the peer certificate
   but retain only its fingerprint; the public API does not expose the verified
   DER certificate chain.
4. **Current workaround.** The facade creates stable `RTCDtlsTransport` and
   `RTCIceTransport` objects, maps aggregate events, and polls selected pairs.
   SCTP bytes stand in for pair traffic; media-only traffic cannot be represented.
   Local certificate stats use binding-retained DER. Remote certificate stats
   are complete only for paired in-process peers, where the remote binding owns
   authoritative DER; external peers expose only their verified fingerprint.
5. **Why insufficient.** Aggregate state loses layer transitions and SCTP
   counters are wrong for media-only/mixed traffic. JavaScript object identity
   stays, but inferred facts and counters are removable.
6. **Proposed upstream API.** Expose value-only `IceTransportSnapshot` and
   `DtlsTransportSnapshot` with state, role, selected pair/generation,
   packet/octet counters, optional RTT, and a copied verified peer certificate
   chain in DER form. Dispatch state/pair callbacks on `Processor`; do not expose
   internal pointers across teardown threads.
7. **Required native tests.** ICE and DTLS transitions, selected-pair change,
   media-only and mixed counters, copied remote certificate lifetime and chain
   order, close during callback, libjuice/libnice, and TLS/SRTP backend matrices.
8. **Compatibility/build options.** Preserve aggregate APIs and make unavailable
   backend fields optional. SRTP counters require `RTC_ENABLE_MEDIA`.
9. **Upstream links.** No matching issue or released API found as of 2026-07-13.

## DTLS startup after remote-description commit

**Status:** `confirmed-absent`

1. **Requirement and WPT.** Applying a valid remote answer must commit its ICE
   credentials and DTLS fingerprint before connectivity can start a DTLS
   handshake. A correct fingerprint must connect, while an incorrect fingerprint
   must fail authentication rather than racing an empty description. Applicable
   WPT: `webrtc/RTCPeerConnection-setRemoteDescription-answer.html` and
   `webrtc/protocol/dtls-fingerprint-validation.html`. The Chrome interoperability
   suite additionally exchanges fully gathered offers and answers.
2. **Source inspected.** `src/peerconnection.cpp`,
   `src/impl/peerconnection.hpp`, `src/impl/peerconnection.cpp`,
   `src/impl/icetransport.cpp`, `src/impl/dtlstransport.cpp`,
   `src/impl/dtlssrtptransport.cpp`, `deps/libjuice/src/agent.c`,
   `test/connectivity.cpp`, and `test/negotiated.cpp`.
3. **Absence evidence.** `PeerConnection::setRemoteDescription()` passes ICE
   credentials to `IceTransport::setRemoteDescription()` before
   `processRemoteDescription()` stores `mRemoteDescription`. Already received ICE
   checks can therefore change ICE to `Connected` in that interval. The connected
   callback unconditionally calls `initDtlsTransport()`, while
   `checkFingerprint()` returns false when `mRemoteDescription` or its fingerprint
   is absent. DTLS failure queues `remoteClose()`, which atomically clears the ICE
   transport. The later inline-candidate loop can then throw `Got a remote
   candidate without ICE transport`. The Ubuntu Chrome mixed-channel
   interoperability scenario observed that exact failure while applying a valid
   full answer. The pinned source and upstream master
   `d5d31c7d794345d7aa536c074a9e17cbec95089d` have the same ordering. Exact-head
   CI run [29751712216](https://github.com/webrtc-node/webrtc/actions/runs/29751712216)
   also produced one empty native `setRemoteDescription(answer)` rejection on
   macOS Node 22 during immediate media-stop renegotiation; the failed job's
   retry passed, so this is phase-sensitive binding-level evidence rather than
   the independent C++ reproduction required for upstream filing.
4. **Current workaround.** There is no correctness-preserving facade workaround.
   The facade can defer inline candidate insertion, but it cannot prevent buffered
   connectivity checks from firing when native ICE credentials are installed, and
   a closed native transport cannot be reconstructed without changing candidates,
   identity, and object lifetime. Any downstream backend patch must be temporary
   and removable with this entry.
5. **Why insufficient.** Catching the candidate exception would report a committed
   JavaScript description over a closed native transport. Omitting gathered offer
   candidates hides the race by changing signaling behavior and does not cover
   ordinary full-SDP exchange. JavaScript cannot make the native ICE credential
   update and remote-fingerprint commit atomic.
6. **Proposed upstream behavior.** Gate DTLS initialization on a committed remote
   description containing a fingerprint. After remote-description commit, start
   DTLS if ICE is already `Connected` or `Completed`; otherwise let the ICE state
   callback start it. Serialize the two paths so exactly one peer-owned transport
   is created. Keep ICE and DTLS callbacks on their existing backend threads and
   retain the existing `Processor` dispatch for peer close and public state
   callbacks. No new public API is required.
7. **Required native tests.** The binding now carries the public-API-only
   `packages/webrtc/test/native/dtls-startup-race.cpp` regression, built through
   the opt-in `WEBRTC_NODE_BUILD_NATIVE_TESTS` CMake option. It lets a full
   offer's candidates produce checks before the offerer applies the full answer,
   then asserts a valid fingerprint connects and an invalid fingerprint fails.
   Stress the commit/connected ordering, multiple inline candidates, trickle ICE,
   close during the delayed start, and repeated construction and teardown.
8. **Compatibility/build options.** Exercise libjuice and libnice, OpenSSL,
   GnuTLS, and Mbed TLS, and media-enabled and media-disabled builds. Preserve
   `forceMediaTransport`, explicit fingerprint-verification policy, candidate
   ordering, and current public ABI. The change should only defer premature DTLS;
   it must not accept an absent or mismatched fingerprint.
9. **Upstream links.** No matching issue, pull request, or released fix found as
   of 2026-07-20. An independent C++ reproduction is still required before this
   item can become `upstream-ready`. Public-API-only Windows and exact-head
   Ubuntu Node 24 harness runs applied 500 delayed full answers after answer-side
   ICE checks had started; all valid fingerprints connected, while 10
   corrupted-fingerprint controls failed authentication. The Ubuntu runs passed
   in both [CI](https://github.com/webrtc-node/webrtc/actions/runs/29751712216)
   and [Conformance](https://github.com/webrtc-node/webrtc/actions/runs/29751714459),
   so they did not reproduce the earlier Ubuntu binding race. CI and Conformance
   now also exercise the harness on macOS Node 22. A failing native run remains
   required rather than treating source inspection or the flaky binding failure
   alone as filing-ready.

## Native ICE restart with fresh credentials

**Status:** `filed`

1. **Requirement and WPT.** JSEP ICE restart creates fresh credentials,
   regathers candidates, and reconnects existing transports. Applicable WPT:
   `webrtc/RTCPeerConnection-restartIce.https.html` and
   `webrtc/RTCPeerConnection-restartIce-onnegotiationneeded.https.html`.
2. **Source inspected.** `include/rtc/peerconnection.hpp`,
   `src/peerconnection.cpp`, `src/impl/icetransport.hpp`,
   `src/impl/icetransport.cpp`, `src/impl/peerconnection.cpp`.
3. **Absence evidence.** `LocalDescriptionInit` can set initial credentials with
   libjuice, but gathering refuses once state leaves `New`. There is no restart,
   agent reset, generation reset, or DTLS restart. The libnice path explicitly
   does not support custom local ICE attributes.
4. **Current workaround.** The facade emits fresh SDP credentials and uses a
   JavaScript-only restart path after native gathering starts; native ICE and
   candidates remain unchanged.
5. **Why insufficient.** SDP claims a new generation without native restart, so
   it cannot recover failed paths or yield fresh pair stats. The workaround is
   removable when native restart exists.
6. **Proposed upstream API.** Issue #545 tracks ICE and DTLS restart. A compatible
   API should atomically install credentials, reset/create ICE generation, clear
   generation candidates, regather, and restart DTLS after ICE selection.
   Callbacks carry generation IDs to reject late candidates.
7. **Required native tests.** Connected restart with changed credentials,
   regathering, late old candidates, failure recovery, SCTP/RTP continuity,
   repeated restart, close race, libjuice/libnice, and DTLS role/fingerprint.
8. **Compatibility/build options.** Preserve initial custom credentials and
   auto-gathering. Upstream notes dependency on
   [libjuice #130](https://github.com/paullouisageneau/libjuice/issues/130);
   libnice needs parity or an explicit unsupported result.
9. **Upstream links.** [libdatachannel #545](https://github.com/paullouisageneau/libdatachannel/issues/545)
   is open; no released implementation was identified.

## Candidate-gathering error callbacks

**Status:** `confirmed-absent`

1. **Requirement and WPT.** `icecandidateerror` reports URL, address, port,
   STUN/TURN code, and text when available. Applicable WPT:
   `webrtc/RTCPeerConnection-onicecandidateerror.https.html`.
2. **Source inspected.** `include/rtc/peerconnection.hpp`,
   `src/peerconnection.cpp`, `src/impl/peerconnection.hpp`,
   `src/impl/peerconnection.cpp`, `src/impl/icetransport.hpp`, and both backend
   paths in `src/impl/icetransport.cpp`.
3. **Absence evidence.** ICE construction accepts candidate, transport-state,
   and gathering-state callbacks only. Public peer callbacks match those three.
   Immediate gather failure throws; asynchronous failures become aggregate failed
   state/logging, with no structured server error retained or emitted.
4. **Current workaround.** The facade exposes the W3C event class/handler but
   dispatches only errors available synchronously from binding operations. It
   does not fabricate STUN/TURN details.
5. **Why insufficient.** Operational gathering failures are silent at the event
   surface, and failed state cannot identify URL/code. JavaScript cannot recover
   facts discarded by the backend.
6. **Proposed upstream API.** Add value-only `IceGatheringError` and
   `onLocalCandidateError()`, with optional URL/address/port, backend code/text,
   and generation. Dispatch on `Processor`, reset on close, tolerate late events.
7. **Required native tests.** Invalid server, DNS failure, authentication failure,
   timeout, IPv4/IPv6 fields, ordering, close race, and libjuice/libnice parity
   where backend data permits.
8. **Compatibility/build options.** Additive callback; preserve synchronous
   exceptions and leave unavailable fields optional rather than inventing data.
9. **Upstream links.** No matching issue or released API found as of 2026-07-13.

## First-class multiple media-stream associations

**Status:** `confirmed-absent`

1. **Requirement and WPT.** A sender associates a track with zero, one, or many
   streams; renegotiation updates membership while track identity stays stable.
   Applicable WPT: `webrtc/RTCRtpSender-setStreams.https.html`,
   `webrtc/RTCPeerConnection-addTrack.https.html`, and
   `webrtc/RTCPeerConnection-ontrack.https.html`,
   `webrtc/protocol/msid-generate.html`, `webrtc/protocol/msid-parse.html`, and
   `webrtc/RTCTrackEvent-fire.html`.
2. **Source inspected.** `include/rtc/description.hpp`, `src/description.cpp`,
   `include/rtc/track.hpp`, `src/impl/track.cpp`,
   `src/impl/peerconnection.cpp`.
3. **Absence evidence.** `Description::Entry` stores untyped attribute strings.
   `Description::Media::addSSRC()` accepts one optional `msid` and appends one
   media-level `a=msid`. There is no association-set parser/accessor. Extra lines
   can be manually added but peer/track APIs cannot observe structured changes.
4. **Current workaround.** Addon `SetMediaStreamIds()` removes/rebuilds raw
   `msid:` attributes. JavaScript owns stream arrays, SDP parsing, remote stream
   identity/membership, the no-MSID default stream, legacy SSRC-level fallback,
   and repeated `track` events.
5. **Why insufficient.** Raw rewriting duplicates state and can discard attribute
   details. Remote updates are inferred because native same-`mid` processing has
   no callback. Raw rewrite/parsing is removable; JavaScript identity remains.
6. **Proposed upstream API.** Add structured
   `MediaStreamAssociation { streamId, trackId }` vectors with parse, replace,
   add/remove, deduplication, and SDP generation while preserving unknown attrs.
   Publish association changes through the description callback above.
7. **Required native tests.** Zero/one/multiple media-level `a=msid`, legacy
   SSRC-level input, duplicates, round trip, replacement, same-`mid`
   renegotiation, invalid tokens, and association without SSRC.
8. **Compatibility/build options.** Keep `addSSRC()` and raw attributes. Structured
   SDP methods should compile with media disabled.
9. **Upstream links.** No matching issue or released API found as of 2026-07-13.

## Promotion checklist

Before changing a `confirmed-absent` entry to `upstream-ready`:

1. Add a minimal C++ reproduction against the pinned commit without this addon.
2. Check relevant media, ICE, TLS, and platform build options.
3. Reduce the proposal to a general C++ contract with focused native tests.
4. Identify exact removable facade/addon code and migration compatibility.
5. Recheck upstream issues, pull requests, and the latest released version.
6. Request explicit approval before opening an issue or pull request.
