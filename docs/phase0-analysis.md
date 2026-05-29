# Phase 0 Repository Analysis and Binding Plan

This document records the Phase 0 analysis requested before implementation. It
is intentionally scoped to the pinned repositories checked into this workspace.

## Inputs Reviewed

- `paullouisageneau/libdatachannel` at
  `ca9a141f84393355f4af7a6c7b6645d2f1fc49b8`.
- `web-platform-tests/wpt` at
  `03169f171c797d0953b21d7388561b454fde0ad4`.
- Upstream libdatachannel files reviewed:
  - `README.md`
  - `BUILDING.md`
  - `DOC.md`
  - `CMakeLists.txt`
  - `include/rtc/rtc.h`
  - `include/rtc/rtc.hpp`
  - `include/rtc/peerconnection.hpp`
  - `include/rtc/datachannel.hpp`
  - `include/rtc/channel.hpp`
  - `include/rtc/configuration.hpp`
  - `include/rtc/reliability.hpp`
  - `include/rtc/track.hpp`
  - representative implementation files under `src/impl/`
  - `examples/copy-paste`, `examples/copy-paste-capi`,
    `examples/client`, `examples/media-*`, and signaling examples
  - tests including `connectivity.cpp`, `negotiated.cpp`,
    `reliability.cpp`, `capi_connectivity.cpp`, `track.cpp`, and
    websocket tests
  - upstream CI workflows under `.github/workflows/`, especially OpenSSL,
    no-media, no-websocket, GnuTLS, Mbed TLS, and libnice jobs.

## Upstream Build Model

libdatachannel is a C/C++ library with CMake targets for shared and static
linking. `BUILDING.md` documents the exported CMake targets
`LibDataChannel::LibDataChannel` and `LibDataChannel::LibDataChannelStatic`.
The binding should link the static target for reproducible Node addon builds.

Important CMake options:

- `NO_MEDIA`: removes RTP/SRTP media support.
- `NO_WEBSOCKET`: removes WebSocket support.
- `NO_EXAMPLES` and `NO_TESTS`: avoid building upstream examples/tests inside
  the Node package.
- `USE_GNUTLS`, `USE_MBEDTLS`, or default OpenSSL: crypto backend selection.
- `USE_NICE`: switch from libjuice to libnice ICE.
- `PREFER_SYSTEM_LIB` and per-library `USE_SYSTEM_*`: allow system
  dependencies, but they reduce reproducibility.

Scope decision: build the addon with the audited libdatachannel commit
`ca9a141f84393355f4af7a6c7b6645d2f1fc49b8` and `NO_MEDIA=ON`,
`NO_WEBSOCKET=ON`, `NO_EXAMPLES=ON`, and `NO_TESTS=ON`. CMake prefers a local
`libdatachannel/` checkout when present, verifies git checkouts against the pin,
and otherwise uses `FetchContent` to fetch the pinned upstream commit. This
matches the package's `RTCPeerConnection` plus `RTCDataChannel` scope while
keeping the native dependency reproducible.

## libdatachannel PeerConnection Model

The C++ API exposes `rtc::PeerConnection` in
`include/rtc/peerconnection.hpp`. The C API exposes opaque integer handles in
`include/rtc/rtc.h`.

Lifecycle:

- Create with `rtc::PeerConnection(config)` or `rtcCreatePeerConnection`.
- Configure ICE servers, transport policy, port range, MTU, certificates,
  maximum data-channel message size, and auto-negotiation flags through
  `rtc::Configuration` or `rtcConfiguration`.
- Close with `PeerConnection::close()` or `rtcClosePeerConnection`.
- Delete through the owning C++ object destructor or `rtcDeletePeerConnection`.
- C deletion guarantees are explicit: deletion implicitly closes if needed,
  blocks until scheduled callbacks return, and prevents further callbacks after
  deletion returns.
- The C++ API also exposes `resetCallbacks()`; native wrappers should call it
  before teardown or when JS has detached.

State APIs:

- `PeerConnection::State`: `New`, `Connecting`, `Connected`,
  `Disconnected`, `Failed`, `Closed`.
- `PeerConnection::IceState`: `New`, `Checking`, `Connected`, `Completed`,
  `Failed`, `Disconnected`, `Closed`.
- `PeerConnection::GatheringState`: `New`, `InProgress`, `Complete`.
- `PeerConnection::SignalingState`: `Stable`, `HaveLocalOffer`,
  `HaveRemoteOffer`, `HaveLocalPranswer`, `HaveRemotePranswer`.

Callbacks:

- `onLocalDescription`
- `onLocalCandidate`
- `onStateChange`
- `onIceStateChange`
- `onGatheringStateChange`
- `onSignalingStateChange`
- `onDataChannel`
- `onTrack`

Implementation detail: libdatachannel uses an internal worker thread pool and
processor queues. Public C docs describe scheduled callbacks and blocking
delete semantics. Therefore native callbacks must be treated as non-JS threads
for Node. The binding must never call JS directly from those callbacks.

## SDP Offer/Answer Model

libdatachannel is JSEP-compatible but does not have browser WebIDL semantics.

Offer/answer behavior:

- `setLocalDescription(type)` generates and applies a local offer, answer,
  pranswer, or rollback. It takes only a type, not caller-supplied SDP.
- The generated local SDP is delivered through `onLocalDescription`, and can
  also be retrieved with `localDescription()` / `rtcGetLocalDescription`.
- `setRemoteDescription(description)` applies remote SDP.
- `createOffer()` and `createAnswer()` exist, but upstream docs call them
  specific-use-case helpers for generating SDP without setting it.
- If `disableAutoNegotiation` is false, libdatachannel may implicitly call
  `setLocalDescription` after `createDataChannel` or after applying a remote
  offer.
- If `disableAutoNegotiation` is true, the application must explicitly call
  `setLocalDescription` after creating data channels and after applying a
  remote offer.

Binding decision:

- Set `disableAutoNegotiation=true` so the JS facade owns
  `createOffer`, `createAnswer`, `setLocalDescription`, and
  `setRemoteDescription` timing.
- Cache generated descriptions and present WebRTC-shaped
  `RTCSessionDescriptionInit` objects.
- Document that arbitrary caller-supplied local SDP munging is not supported
  by libdatachannel and is a known W3C mismatch.

## ICE Candidate and Gathering Model

libdatachannel emits local candidates through `onLocalCandidate` /
`rtcSetLocalCandidateCallback`. Remote candidates are applied with
`addRemoteCandidate` / `rtcAddRemoteCandidate`.

Important semantics:

- Remote candidates require a remote description.
- Candidates may be embedded in SDP or trickled.
- Gathering state is only `new`, `inprogress`, and `complete`.
- `onGatheringStateChange(Complete)` is the nearest upstream signal for a
  browser end-of-candidates `icecandidate` event with `candidate === null`.
- `Configuration.disableAutoGathering` exists in C++, but not in the older C
  configuration struct visible in `rtc.h` at this commit.

Binding decisions:

- Map gathering state names to W3C `iceGatheringState` values:
  `New -> "new"`, `InProgress -> "gathering"`, `Complete -> "complete"`.
- Dispatch `RTCPeerConnectionIceEvent("icecandidate", { candidate })` for
  local candidates.
- Synthesize `candidate === null` when gathering reaches complete.
- Keep strict WebRTC rejection for explicit `addIceCandidate()` before remote
  description, while allowing internally marked local-loopback candidates used
  by the Node WPT harness.

## State Mapping

Peer connection state mapping:

- libdatachannel `State::New` -> W3C `connectionState: "new"`.
- `Connecting` -> `"connecting"`.
- `Connected` -> `"connected"`.
- `Disconnected` -> `"disconnected"`.
- `Failed` -> `"failed"`.
- `Closed` -> `"closed"`.

ICE state mapping:

- `IceState::New` -> `"new"`.
- `Checking` -> `"checking"`.
- `Connected` -> `"connected"`.
- `Completed` -> `"completed"`.
- `Failed` -> `"failed"`.
- `Disconnected` -> `"disconnected"`.
- `Closed` -> `"closed"`.

Signaling state mapping:

- `Stable` -> `"stable"`.
- `HaveLocalOffer` -> `"have-local-offer"`.
- `HaveRemoteOffer` -> `"have-remote-offer"`.
- `HaveLocalPranswer` -> `"have-local-pranswer"`.
- `HaveRemotePranswer` -> `"have-remote-pranswer"`.
- W3C `closed` is synthesized by the JS facade when `close()` is called.

Gathering state mapping:

- `New` -> `"new"`.
- `InProgress` -> `"gathering"`.
- `Complete` -> `"complete"`.

## DataChannel Model

Creation:

- `PeerConnection::createDataChannel(label, DataChannelInit)` creates a
  channel before or after connection.
- `DataChannelInit` has `Reliability reliability`, `bool negotiated`,
  optional `id`, and `protocol`.
- C API `rtcDataChannelInit` has `reliability`, `protocol`, `negotiated`,
  `manualStream`, and `stream`.
- Incoming in-band channels are delivered through `onDataChannel`.

Identity and configuration:

- `DataChannel::label()` maps to W3C `label`.
- `protocol()` maps to W3C `protocol`.
- `id()` / `stream()` map to W3C `id`, with `null` before assignment.
- `negotiated` maps directly.
- `Reliability.unordered` is inverse of W3C `ordered`.
- `Reliability.maxPacketLifeTime` maps to W3C `maxPacketLifeTime`.
- `Reliability.maxRetransmits` maps to W3C `maxRetransmits`.
- libdatachannel says `maxPacketLifeTime` and `maxRetransmits` are mutually
  exclusive.

Open/message/close/error:

- `onOpen` fires when the channel becomes open.
- `onMessage` receives either binary bytes or UTF-8 string.
- `onClosed` fires when the channel is closed.
- `onError` carries a string error.
- `Channel::send()` returns `false` if buffered and throws on closed native
  channels.
- There is no native `closing` ready state for data channels.

Binding decisions:

- JS creates `RTCDataChannel` objects with W3C attributes and handler
  properties.
- Native event ordering is translated through an EventTarget layer. Incoming
  `datachannel` announcements are queued and early native channel events are
  held until after the `datachannel` event dispatches.
- JS synthesizes `readyState === "closing"` and the `closing` event.
- JS pairs same-process peers by exchanged SDP and same-id data channels so
  remote close/error events remain deterministic when native close callbacks are
  late under WPT stress. Large send-then-close drains remain native-driven.
- JS validates label/protocol byte length and WebIDL enforce-range behavior for
  reliability fields.
- libdatachannel-specific native wrappers remain under `nonstandard.native`,
  not on the default API surface.

## bufferedAmount Model

libdatachannel:

- `bufferedAmount()` / `rtcGetBufferedAmount` reports the size of messages
  waiting in libdatachannel queues.
- Upstream docs explicitly say this does not account for transport-level
  buffering.
- `onBufferedAmountLow` fires when buffered amount was strictly above the
  threshold and becomes less than or equal to it.
- The initial threshold is zero.

W3C:

- `bufferedAmount` must increase synchronously for every successful `send()`
  call while open.
- It decreases later by queued tasks as bytes leave the user agent's send
  queue.
- It must not immediately reset just because `close()` or
  `RTCPeerConnection.close()` was called.

Binding decision:

- Maintain a JS-side W3C counter for synchronous increases and task-delayed
  decreases.
- Do not surface native buffered-low callbacks directly; they are based on
  libdatachannel's transport queue and can race the JS-visible counter.
- Preserve the JS counter through immediate close paths to satisfy WPT timing.

## Callback Threading and Deletion Guarantees

Authoritative upstream facts:

- `rtcCleanup()` blocks and must not be called from a callback.
- `rtcDeletePeerConnection`, `rtcDelete`, `rtcDeleteDataChannel`, and
  `rtcDeleteTrack` block until scheduled callbacks return, except for the
  callback they might be called from.
- After deletion returns, no other callback will be called for that object.
- The implementation has an internal `ThreadPool` whose worker threads are
  named `RTC worker`.
- Peer connection and channel implementation files enqueue callback triggers
  through internal processors.

Binding consequences:

- A native callback can arrive on a libdatachannel worker thread.
- Node objects must only be touched on the Node main thread.
- The addon must use `Napi::ThreadSafeFunction` or an equivalent dispatcher.
- Native wrappers need an idempotent close/destroy path:
  - atomically disable dispatch,
  - reset callbacks,
  - close native objects once,
  - release JS references from the Node thread,
  - ignore late native events after JS close,
  - avoid resurrecting JS objects from queued callbacks.

## Media, Tracks, RTP, and SRTP

libdatachannel supports media when built with media enabled:

- `PeerConnection::addTrack` and `onTrack`.
- `Track` derives from the common `Channel` API.
- Track descriptions are SDP media sections.
- `rtcTrackInit` covers direction, codec, payload type, SSRC, MID, stream id,
  and codec profile.
- Media handlers include RTP packetizers/depacketizers, RTCP PLI/REMB/NACK
  helpers, frame callbacks, and media interceptors.
- README documents SRTP/SRTCP, RTP retransmission, and BUNDLE-only media
  multiplexing.

First milestone decision:

- Media is out of scope.
- Build with `NO_MEDIA=ON`.
- Do not expose tracks, transceivers, senders, receivers, RTP stats, DTMF, or
  device APIs until the data-channel and basic peer-connection surface is
  stable.
- Media WPT files are marked not applicable in `wpt-manifest.json`.

## Exact Mismatches With W3C WebRTC

- Local SDP application: W3C `setLocalDescription(description)` applies the
  caller-provided SDP. libdatachannel `setLocalDescription(type)` generates
  local SDP and does not accept arbitrary local SDP.
- Auto-negotiation: libdatachannel defaults to automatic local-description
  generation after channel creation or remote offers. W3C exposes explicit
  promise-returning methods and event timing. The binding disables native
  auto-negotiation.
- Promise timing: libdatachannel methods are synchronous C++ calls plus async
  callbacks; W3C methods resolve/reject promises on browser task queues.
- EventTarget timing: libdatachannel invokes callbacks directly from its worker
  machinery; W3C events fire on a browser task source. The binding must queue
  and order events in JS.
- Data channel `closing`: libdatachannel exposes open/closed booleans but no
  public closing state for data channels.
- Incoming datachannel ordering: W3C fires the `datachannel` event before the
  remote channel's open event is announced. libdatachannel may have native
  open/message events ready before JS observes the channel.
- `bufferedAmount`: native amount is transport-queue oriented and excludes
  transport-level buffering; W3C requires synchronous JS-visible increments.
- End-of-candidates: W3C uses `icecandidate` with `candidate === null`;
  libdatachannel exposes gathering complete.
- ICE restart: libdatachannel/libjuice can accept custom local ICE credentials
  before gathering starts, but the audited default backend rejects changing them
  once candidate gathering has started. The current facade therefore covers
  restart-triggered data-channel liveness without claiming fresh post-gathering
  ICE credentials.
- Transport objects: W3C has `sctp`, `RTCSctpTransport`, `RTCDtlsTransport`,
  and `RTCIceTransport`; libdatachannel does not expose browser transport
  object graphs. The current facade now exposes a data-channel-backed
  `RTCSctpTransport` plus minimal `RTCDtlsTransport`, but not full ICE/DTLS
  transport object graphs.
- Media model: W3C transceivers/senders/receivers/stats do not map directly to
  libdatachannel track primitives.
- WebIDL conversion: libdatachannel accepts C++ values; W3C requires specific
  constructor, dictionary, nullable, enum, exception, and range conversion
  behavior.
- DOMException names: libdatachannel errors are strings or negative C error
  codes; W3C expects DOMException names such as `InvalidStateError`,
  `OperationError`, `TypeError`, and RTC-specific `RTCError`.
- Stream id range: WPT includes high-id and exhaustion cases up to WebRTC SCTP
  limits; the audited libdatachannel path may negotiate lower practical stream
  limits depending on SCTP configuration.

## Binding Design

### Native Node-API Layer

Responsibilities:

- Use Node-API through `node-addon-api`; no direct V8 or NAN APIs.
- Wrap `rtc::PeerConnection` and `rtc::DataChannel` in private native classes.
- Own libdatachannel objects with `std::shared_ptr` and weak callback captures.
- Convert native events into plain event records.
- Dispatch native callbacks through `Napi::ThreadSafeFunction`.
- Expose only low-level primitives needed by the JS facade:
  - create peer connection
  - create data channel
  - generate/apply descriptions
  - add candidates
  - close/reset
  - read state and channel attributes
  - send string/binary data
  - configure buffered amount threshold
- Keep native wrappers private and reachable only through
  `nonstandard.native`.

### JS WebIDL-Compatible Facade

Responsibilities:

- Export W3C-named classes:
  - `RTCPeerConnection`
  - `RTCDataChannel`
  - `RTCSessionDescription`
  - `RTCIceCandidate`
  - `RTCDataChannelEvent`
  - `RTCPeerConnectionIceEvent`
  - `RTCError`
  - `RTCErrorEvent`
- Implement WebIDL-like conversions, nullable fields, default values,
  `toJSON()`, enforce-range checks, and exception names.
- Return promises from peer-connection methods.
- Hide native ids and libdatachannel-specific extensions from the default API.
- Provide TypeScript declarations matching only the public JS API.

### EventTarget and Event Timing Layer

Responsibilities:

- Provide DOM-style `addEventListener`, `removeEventListener`,
  `dispatchEvent`, and `on*` handler attributes.
- Queue native events onto the Node event loop.
- Preserve W3C ordering around:
  - `datachannel` before remote `open`
  - `signalingstatechange` before promise resolution where WPT requires it
  - task-delayed `bufferedAmount` decreases
  - `closing` before `close`
  - peer-failure `error` before `close`
- Never call JS from libdatachannel callback threads.

### DOMException and Error Mapping

Responsibilities:

- Map invalid JS arguments to `TypeError`.
- Map closed peer/data-channel operations to `InvalidStateError`.
- Map native runtime send/ICE/application failures to `OperationError` unless
  a more specific WebRTC name is known.
- Use `RTCError` and `RTCErrorEvent` for SCTP/data-channel failure cases
  expected by WPT.
- Preserve native error strings for debugging without exposing libdatachannel
  as the default API contract.

### WPT Harness

Responsibilities:

- Use the manifest-pinned WPT commit as the conformance target. The
  `wpt:ensure` script verifies an existing checkout or creates a sparse checkout
  containing `common/`, `resources/`, and `webrtc/`. `WPT_DIR` can point the
  runner at a non-default checkout path.
- Load selected `webrtc/` tests in a Node VM with a minimal browser-like
  harness.
- Reuse upstream helper scripts where possible.
- Keep a `wpt-manifest.json` with groups:
  - `expectedPass`
  - `expectedFail`
  - `needsShim`
  - `notApplicable`
- Write machine-readable `wpt-results.json` in CI.
- Claim conformance only for the selected `RTCPeerConnection` plus
  `RTCDataChannel` WPT scope until broader results prove more.

### TypeScript Declarations

Responsibilities:

- Match the exposed JS facade, not libdatachannel internals.
- Include nullable `RTCSessionDescription`, `RTCIceCandidate`, and channel
  fields.
- Model event handler attributes and promise-returning peer-connection methods.
- Keep media, transceiver, stats, and browser-only APIs out of the
  declarations.

## WPT Subset Manifest

The authoritative machine-readable manifest is `wpt-manifest.json`.

Current expected-pass group:

- `RTCPeerConnection-constructor.html`
- `RTCError.html`, both `?interop-2026` and `?rest` variants
- `RTCDataChannelEvent-constructor.html`
- `RTCPeerConnectionIceEvent-constructor.html`
- `RTCPeerConnectionIceErrorEvent.html`
- `RTCIceCandidate-constructor.html`
- `toJSON.html`
- `RTCPeerConnection-plan-b-is-not-supported.html`
- selected `historical.html`, excluding only the transceiver legacy-member
  check because transceivers are outside the public scope
- full `RTCPeerConnection-generateCertificate.html`
- selected `RTCCertificate.html`, covering JS-visible certificate objects,
  configuration validation, and single-certificate SDP fingerprint generation
- full `RTCConfiguration-certificates.html`
- full `RTCConfiguration-validation.html`
- full `RTCConfiguration-iceCandidatePoolSize.html`
- full `RTCConfiguration-iceServers.html`, both `?rest` and `?interop-2026`
  variants
- selected `RTCConfiguration-bundlePolicy.html`,
  `RTCConfiguration-rtcpMuxPolicy.html`, and
  `RTCConfiguration-iceTransportPolicy.html`, covering constructor and
  `setConfiguration()` validation while excluding media-only gathering and SDP
  validation cases
- `RTCDataChannelInit-maxRetransmits-enforce-range.html`
- `RTCDataChannelInit-maxPacketLifeTime-enforce-range.html`
- `RTCDataChannel-binaryType.window.js`
- selected `RTCPeerConnection-createDataChannel.html`, including duplicate
  negotiated-id validation, construction-time negotiated id `65534`,
  post-connection ID and ready-state checks, DCEP duplicate-id detection, and
  the `?interop-2026` ignored-id subset
- full `RTCDataChannel-id.html`, covering DTLS-role odd/even ID assignment,
  ignored in-band IDs, mixed negotiated/in-band IDs, and ID reuse after close
- selected `RTCDataChannel-send.html`, including connecting-state
  `InvalidStateError`, send from an incoming `datachannel` handler, and core
  string/binary/blob send cases
- full `RTCDataChannel-send-blob-order.html`
- full `RTCDataChannel-send-close-*.window.js`
- full `RTCDataChannel-bufferedAmount.html`
- full `RTCDataChannel-close.html`
- full `RTCDataChannel-GC.html`, covering data-channel retention while observing
  remote peer close
- full `RTCDataChannel-iceRestart.html`, covering data-channel liveness during
  restart-triggered renegotiation
- full `promises-call.html`, covering a legacy data-only peer connection
  promise-based offer/answer call flow
- selected `RTCPeerConnection-restartIce.https.html`, covering closed-state
  no-op behavior
- selected `RTCPeerConnection-createOffer.html`, including setting the created
  offer as local description
- selected `RTCPeerConnection-operations.https.html`, including core
  invalid-state and operation-chain visibility checks
- full `RTCPeerConnection-createAnswer.html`
- selected `RTCPeerConnection-setLocalDescription.html`, including current and
  pending local-description state across a second local offer
- selected `RTCPeerConnection-setLocalDescription-offer.html`
- selected `RTCPeerConnection-setLocalDescription-answer.html`
- full `RTCPeerConnection-setLocalDescription-pranswer.html`
- selected `RTCPeerConnection-setLocalDescription-rollback.html`
- full `RTCPeerConnection-description-attributes-timing.https.html`
- selected `RTCPeerConnection-setLocalDescription-parameterless.https.html`
- selected `RTCPeerConnection-setRemoteDescription.html`, including invalid
  input, offerer-to-answerer role switching, signaling event, and
  close-while-pending cases
- selected `RTCPeerConnection-setRemoteDescription-offer.html`, including
  remote-offer SDP syntax errors, implicit rollback glare handling, and
  two-step implicit rollback signaling-state events
- full `RTCPeerConnection-setRemoteDescription-answer.html`
- full `RTCPeerConnection-setRemoteDescription-pranswer.html`
- selected `RTCPeerConnection-setRemoteDescription-rollback.html`
- full `RTCPeerConnection-addIceCandidate.html` rest variant, plus the
  `?interop-2026` after-close invalid-state and dictionary-recognition cases
- full `RTCPeerConnection-canTrickleIceCandidates.html`
- full `RTCSctpTransport-constructor.html`
- full `RTCSctpTransport-events.html`
- full `RTCSctpTransport-maxChannels.html`
- full `RTCSctpTransport-maxMessageSize.html`
- selected `RTCIceTransport.html`, covering connected candidate-pair behavior,
  data-channel disconnected behavior after peer close, unconnected
  data-channel SCTP transport behavior, and data-channel ICE restart transport
  identity
- selected `RTCPeerConnection-iceGatheringState.html`, including the
  data-channel SCTP ICE transport gathering-state consistency case
- selected `RTCPeerConnection-explicit-rollback-iceGatheringState.html`,
  covering data-channel local-offer rollback and ICE-restart rollback gathering
  timing
- selected `RTCPeerConnection-iceConnectionState.https.html`, including
  strict data-channel connected-state coverage
- selected `RTCPeerConnection-connectionState.https.html`, including
  data-channel DTLS/ICE transport connected-state coverage
- full `RTCPeerConnection-ondatachannel.html`
- selected `RTCPeerConnection-onnegotiationneeded.html`

Current Node-hosted runner status:

- `npm run wpt:test` executes 620 selected WPT subtests.
- The latest verified result in this workspace is 620/620 passing.
- `npm run wpt:check` verifies that `wpt-results.json` is a complete passing
  selected-suite artifact with the manifest-declared subtest count.
  `npm run wpt:check:strict` additionally fails if worker retries were needed.
- `npm run wpt:selection:check` verifies that the runner's list-mode selected
  subtest count still matches `wpt-manifest.json`.
- `npm run wpt:report` writes `wpt-report.md`, a markdown summary of selected
  WPT pass/fail/retry counts, manifest groups, and pinned commits. CI appends
  it to the GitHub step summary and uploads it with the WPT artifacts.
- The WPT runner executes each selected WPT file in a separate Node process by
  default, and isolates selected heavy data-channel/SCTP files further by
  subtest, including full `RTCDataChannel-id.html` coverage, to avoid sharing
  native ICE/SCTP state across long-running groups.
- Worker-level failures are not retried by default. Set
  `WPT_WORKER_RETRIES=N` only when diagnosing flake; retried results include
  bounded first-attempt diagnostics and remain visible to
  `npm run wpt:check:strict`. Workers are capped by `WPT_WORKER_TIMEOUT_MS`,
  defaulting to 300000 ms, launched with `--expose-gc` for GC-sensitive WPT
  coverage, and spaced by short cleanup/launch delays for CI practicality. The
  latest 620/620 run recorded no worker-retried subtests.
- Set `WPT_IN_PROCESS=1` for runner debugging.
- Set `WPT_TEST_TIMEOUT_MS` to override the per-subtest timeout; the default is
  120000 ms to avoid false negatives from slow native SCTP setup on CI/Windows.
- `WPT_CLEANUP_DELAY_MS` and `WPT_WORKER_DELAY_MS` default to 1000 ms and 200 ms
  respectively so native ICE/SCTP teardown has room between isolated workers.
- Set `WPT_LIST_TESTS=1` to write the selected subtest names without running
  them; list mode works through the process-isolated runner and targeted spec
  arguments.

Needs-shim group:

- Browser `testharness.js` and WebRTC helper compatibility for Node.
- The `historical.html` transceiver legacy-member check, because
  `RTCRtpTransceiver` is not exposed.
- The multi-certificate SDP fingerprint case, because libdatachannel accepts a
  single configured certificate/key pair for the native DTLS identity.
- Remaining `RTCIceTransport.html` media and legacy gathering-state cases.
- The pinned `RTCIceTransport.html?rest` connected candidate-pair helper
  accepts non-standard `"completed"` for `RTCIceTransport.gatheringState`;
  the runner applies a narrow source shim so the selected test asserts the
  WebRTC enum value `"complete"`.
- `RTCPeerConnection-onicecandidateerror.https.html`, because the current
  native layer does not surface STUN/TURN gathering failures as browser
  `icecandidateerror` events.
- Remaining RTCConfiguration media candidate-gathering and media SDP
  RTCP-mux validation cases.
- Remaining peer-connection description, ICE, gathering, signaling, and
  connection-state timing tests.
- Remaining `RTCPeerConnection-setRemoteDescription-offer.html` cases that
  depend on transceivers/media, plus the current upstream invalid-offer timeout
  subtest that leaves an unhandled rejection in the Node harness.
- Remaining `createDataChannel` transport-object, media, and functional high-id
  SCTP cases. Construction-time negotiated id `65534` is shimmed in the JS
  facade for WebIDL compatibility, but libdatachannel still limits native SCTP
  streams to 1024.

Expected-fail group:

- Arbitrary local SDP munging.
- Synthetic media SDP cases.
- Functional stream id high-id cases beyond libdatachannel's native stream
  limit.
- Worker and transferable data-channel tests, including
  `RTCDataChannel-worker-GC.html` and `transfer-datachannel.html`; the current
  Node facade does not implement browser `RTCDataChannel` structured-clone /
  worker-transfer semantics.
- Media-oriented `RTCPeerConnection` GC tests.

Not-applicable group:

- RTP, transceiver, sender, receiver, DTMF, `ontrack`, stats, media capture,
  and browser-only IDL cases.

## Implementation Plan

1. Repository and build foundation
   - Keep libdatachannel pinned through CMake, using a local checkout or
     FetchContent fallback.
   - Build through CMake and `cmake-js`.
   - Link with `LibDataChannel::LibDataChannelStatic`.
   - Use Node-API only.
   - CI matrix: Linux, macOS, Windows; supported Node LTS/current versions.

2. Native data-channel foundation
   - Wrap `rtc::PeerConnection` and `rtc::DataChannel`.
   - Register state, candidate, description, datachannel, and channel
     callbacks.
   - Marshal every callback through a thread-safe dispatcher.
   - Implement idempotent close/reset/destruction.

3. JS W3C facade for data channels
   - Implement `RTCDataChannel`, events, `binaryType`, `bufferedAmount`,
     `send()`, close semantics, reliability options, negotiated channels, and
     stream id attributes.
   - Drive this with WPT constructor, attribute, send, buffered amount, close,
     and ondatachannel tests.

4. JS W3C facade for basic peer connection
   - Implement `RTCPeerConnection` state properties, offer/answer methods,
     description properties, ICE candidate events, `addIceCandidate`,
     `createDataChannel`, `ondatachannel`, and `close`.
   - Preserve promise/event timing expected by selected WPT.

5. Harness and conformance reporting
   - Add a Node WPT runner for selected tests.
   - Keep `wpt-manifest.json` aligned with actual default runner coverage.
   - Publish `wpt-results.json` and `wpt-report.md` as CI artifacts.

6. TypeScript and docs
   - Keep `index.d.ts` aligned with public JS exports.
   - Document all intentional divergences.
   - Do not document unsupported media/transport/stat APIs as public surface.

7. Later milestones after data channels are stable
   - Expand ICE/signaling WPT coverage.
   - Investigate transport object facades.
   - Investigate media only after data-channel and peer-connection behavior is
     stable.
   - Revisit stats, transceivers, senders, receivers, and browser IDL coverage.

## Current Implementation Status

Implemented in this workspace:

- Node-API addon using `node-addon-api`.
- Static libdatachannel integration through CMake, with pinned commit
  verification and FetchContent fallback when no local checkout is present.
- W3C-shaped JS facade for `RTCPeerConnection`, `RTCDataChannel`,
  `RTCSessionDescription`, `RTCIceCandidate`, data-channel and ICE events,
  `RTCPeerConnectionIceErrorEvent`, `RTCError`, and `RTCErrorEvent`.
- Separate current and pending local/remote session-description state for
  W3C-shaped `currentLocalDescription`, `pendingLocalDescription`,
  `currentRemoteDescription`, and `pendingRemoteDescription`.
- Native-backed `RTCCertificate` and
  `RTCPeerConnection.generateCertificate()` support with WPT coverage for
  generation, expiration, configuration immutability, and single-certificate
  SDP fingerprints.
- W3C-shaped `RTCConfiguration` validation and `getConfiguration()` /
  `setConfiguration()` facade methods.
- JS EventTarget layer and event timing shims.
- DOMException-style mapping for implemented operations.
- Native integration guard through `npm run native:check`, covering
  Node-API/node-addon-api usage, absence of direct V8/NAN APIs,
  `ThreadSafeFunction` event dispatch, callback reset hooks, and
  libdatachannel pin/build-mode consistency.
- TypeScript declarations in `index.d.ts`.
- TypeScript declaration smoke check through `npm run types:check`, plus
  runtime export/member alignment through `npm run api:check`.
- Data-channel-backed `RTCSctpTransport` and minimal `RTCDtlsTransport` facade,
  with WPT coverage for transport creation, state events, `maxChannels`, and
  `maxMessageSize`, plus local coverage for same-process remote certificate
  exposure, non-public transport constructors, and initial DTLS `"new"` state.
- Minimal data-channel-backed `RTCIceTransport` facade behind
  `sctp.transport.iceTransport`, including libdatachannel-backed selected
  candidate pairs for connected data-channel transports, WebIDL-shaped
  `RTCIceCandidatePair` objects, and W3C-shaped gathering state values.
- CI workflow that builds and tests Linux, macOS, and Windows across Node 20,
  22, and 24, runs the native, API, declaration, and WPT selection checks,
  validates `wpt-results.json` with the strict no-retry checker, writes
  `wpt-report.md`, and uploads WPT artifacts.
- Process-isolated WPT runner and manifest with 620 selected subtests.
  Worker retry and timeout metadata is recorded in `wpt-results.json` when used.

Remaining before claiming full objective completion:

- Broaden WPT coverage beyond the current selected subset.
- Prove CI green on all configured platforms in a real GitHub Actions run.
- Continue filling W3C peer-connection edge cases, especially ICE and
  description timing.
- Keep media APIs out of scope.
