# Intentional W3C Divergences

This package targets W3C-style `RTCPeerConnection` and `RTCDataChannel`
behavior for Node.js. It intentionally does not expose browser media APIs. The
current implementation diverges from W3C WebRTC in the following places.

## Nonstandard libdatachannel extensions

The typed `nonstandard` namespace exposes ICE UDP muxing, pre-construction
libdatachannel options, explicit initial local ICE credentials, observed remote
fingerprints, and PEM certificate import for advanced integrations. These
operations are implementation-specific and excluded from W3C compatibility
claims.

Fingerprint verification remains enabled unless
`disableFingerprintVerification: true` is explicitly configured before native
peer construction. That option is intended only for protocols that authenticate
the observed fingerprint through a separate verified identity exchange.

## Local SDP application

`libdatachannel` generates local SDP inside `setLocalDescription()`. It does not
provide a public API that applies arbitrary caller-supplied local SDP. The JS
facade accepts `setLocalDescription(description)` for browser compatibility, but
currently uses the description type and lets libdatachannel generate the actual
local SDP.

Impact: WPT cases that mutate local SDP between `createOffer()` and
`setLocalDescription()` are expected to fail until the binding grows a validated
SDP-munging strategy or native support.

## Media APIs

This package intentionally excludes media tracks, transceivers, RTP
senders/receivers, stats, DTMF, capture devices, and `ontrack`. libdatachannel
has RTP/SRTP track primitives, but they do not map directly to the exposed
`RTCPeerConnection` plus `RTCDataChannel` scope.

Impact: media-oriented WPT files are marked not applicable in
`wpt-manifest.json`.

The selected `historical.html` subset excludes only the legacy
`RTCRtpTransceiver` member check because `RTCRtpTransceiver` is not exposed.

## RTCConfiguration

The JS facade validates and stores W3C-shaped `RTCConfiguration` dictionaries,
including `iceServers`, `iceTransportPolicy`, `bundlePolicy`, `rtcpMuxPolicy`,
`iceCandidatePoolSize`, and `certificates`. `getConfiguration()` returns a
clone of that JS-visible configuration and `setConfiguration()` applies W3C
validation and immutable-field checks.

libdatachannel consumes ICE servers and transport policy at peer-connection
construction time. The current binding does not reconfigure the native ICE
transport after construction, so `setConfiguration()` is a W3C-compatible facade
operation for validation and JS-visible state rather than a native ICE restart
or transport reconfiguration mechanism.

Authenticated TURN credentials from the W3C `username` and `credential` fields
are forwarded to libdatachannel. The bundled libjuice ICE backend supports TURN
over UDP only. `stuns:` URLs, `turn:` URLs with `transport=tcp`, and `turns:`
URLs are accepted by WebIDL validation but cannot produce candidates with this
build.

Impact: the selected WPT suite covers constructor, `getConfiguration()`, and
`setConfiguration()` validation for ICE servers, ICE candidate pool size,
certificates, bundle policy, RTCP mux policy, and ICE transport policy. Media
candidate-gathering and media SDP RTCP-mux validation cases remain outside the
expected-pass set. Hosted peers behind managed NAT should configure a reachable
TURN UDP endpoint in the constructor before native candidate gathering starts.

## Certificates

`RTCPeerConnection.generateCertificate()` and `RTCCertificate` are implemented
as native-backed WebRTC objects with generated PEM/key material, expiration,
and fingerprint accessors. `RTCPeerConnection` validates expired certificates,
rejects `setConfiguration()` calls that change the certificate set, and passes
the first configured certificate into libdatachannel's `rtc::Configuration` so
the generated DTLS fingerprint appears in local SDP.

libdatachannel accepts one certificate/key pair for a peer connection. The W3C
configuration dictionary allows a sequence of certificates, and WPT has a case
that expects all configured certificate fingerprints to appear in SDP. The
current binding preserves the JS-visible certificate set for W3C
`getConfiguration()`/`setConfiguration()` behavior but uses only the first
certificate for native DTLS identity.

Impact: the selected WPT suite covers certificate generation, unsupported
algorithm rejection, expiration validation, fingerprint object shape, and
certificate immutability in `setConfiguration()`, plus single-certificate SDP
fingerprint generation. The multi-certificate SDP fingerprint case remains
outside expected-pass until the binding has a defensible multi-certificate
strategy.

## Transport object surface

`RTCPeerConnection.sctp` is implemented as a data-channel-backed
`RTCSctpTransport` facade, with a minimal `RTCDtlsTransport` object available at
`sctp.transport`. The facade is created only when SDP contains an
`m=application` data section. It tracks `connecting`, `connected`, and `closed`
from peer/data-channel state, exposes same-process remote certificates through
`getRemoteCertificates()` after connection, and exposes negotiated
`maxMessageSize` and post-connect `maxChannels` where the current native
binding can support them.
As in browsers, these transport facade objects are exposed from
`RTCPeerConnection.sctp` and related attributes rather than being publicly
constructible. The data-channel DTLS facade reports `"new"` until both local and
remote descriptions are present, then `"connecting"` until the data transport is
connected.

Impact: the selected WPT suite covers SCTP transport creation, state events,
`maxChannels`, and `maxMessageSize`. A minimal `RTCIceTransport` facade is
available at `sctp.transport.iceTransport`; it exposes ICE role, component,
state, gathering state, candidate accessors, selected candidate pair, and ICE
parameters from the data-channel peer-connection state.
`getSelectedCandidatePair()` returns a WebIDL-shaped `RTCIceCandidatePair`
object, not a plain object, when libdatachannel exposes a connected local/remote
candidate pair.

Impact: the selected WPT suite covers connected data-channel selected candidate
pairs, unconnected SCTP ICE transport behavior, data-channel disconnected
transport behavior after peer close, ICE restart transport-object identity for
data channels, and data-channel SCTP ICE transport gathering-state and
connected-state consistency. The pinned `RTCIceTransport.html?rest`
candidate-pair test has a runner shim for its `"completed"`/`"complete"`
gathering-state typo; the runtime keeps the WebRTC enum value `"complete"`.
Disconnected timing and media transport graph cases remain outside the current
expected-pass set.

## Data channel closing

libdatachannel does not expose a native `closing` ready state. The JS facade
synthesizes `readyState === "closing"` and a `closing` event when
`RTCDataChannel.close()` is called. If application data was queued in the same
task, the facade marks the channel as closing immediately but briefly delays the
native SCTP close so the just-queued message can be delivered before reset.

Impact: local close behavior is browser-shaped in the JS layer. The current WPT
runner passes `RTCDataChannel-close.html`, including remote `closing`, repeated
open/send/close, and peer-close `RTCErrorEvent` cases.

For same-process peers that have exchanged SDP through this facade, the JS layer
also pairs peer connections and data channels by SDP/stream id. That pairing
synthesizes remote data-channel close/error events when native close callbacks
are late or uneven under stress. During ICE restart, it also permits one
healthy-state native close callback to be ignored within a bounded window,
avoiding the known restart race without suppressing later closes indefinitely.
Send-drain closes still wait for native delivery so queued messages are not
truncated.

## Incoming data channel event timing

libdatachannel can report an incoming data channel and its first channel events
from native callbacks before browser-style JS event handlers have been attached.
The JS facade queues incoming `datachannel` announcements and holds early
`open`/`message`/`close` events for that channel until after the
`datachannel` event has been dispatched.

Impact: this is the EventTarget timing layer required for WPT-compatible
ordering. The current runner passes full `RTCPeerConnection-ondatachannel.html`,
including the cases that close or send from inside the `datachannel` handler.

## Worker-transferable data channels

Browser WebRTC exposes worker transfer behavior for `RTCDataChannel` through the
structured clone/transfer machinery. The current Node facade does not implement
transferable `RTCDataChannel` objects or a Worker-backed channel owner model.

Impact: worker and transferable data-channel WPT files remain outside
expected-pass, including `RTCDataChannel-worker*.js`,
`RTCDataChannel-worker-GC.html`, and `transfer-datachannel.html`.

## bufferedAmount

libdatachannel reports bytes buffered in its SCTP transport queue. W3C
`bufferedAmount` increases synchronously for every `send()` call and decreases
later. The JS facade maintains its own W3C-style counter and does not surface
native buffered-amount-low callbacks directly because they are based on
libdatachannel's transport queue and can race the JS-visible counter. When
libdatachannel has queued bytes, the facade uses native `bufferedAmount` as a
drain guard before reducing the JS counter, so high-throughput send loops see
backpressure while preserving synchronous W3C increases.

Impact: this is intentionally shimmed in JS. The current WPT runner passes
`RTCDataChannel-bufferedAmount.html`.

## End-of-candidates

libdatachannel candidate callbacks do not directly match browser
`icecandidate` event end-of-candidates semantics. The JS facade synthesizes a
final `icecandidate` event with `candidate === null` when gathering reaches
`complete`.

Impact: the selected WPT suite now covers candidate target validation, SDP
candidate insertion, and end-of-candidates mutation in
`RTCPeerConnection-addIceCandidate.html`. Operations-chain timing and
media-transceiver connection setup remain outside the selected scope.

## ICE candidate errors

`RTCPeerConnectionIceErrorEvent` and the `onicecandidateerror` handler
attribute are exposed for WebRTC API shape compatibility. The current
libdatachannel binding does not surface STUN/TURN candidate-gathering failures
as browser `icecandidateerror` events.

Impact: constructor and handler-attribute behavior are covered locally, while
`RTCPeerConnection-onicecandidateerror.https.html` remains outside the selected
expected-pass WPT set until native ICE-server error events are available.

## ICE restart

The default libdatachannel/libjuice path only accepts custom local ICE
credentials before candidate gathering starts. After gathering has started, the
facade treats `restartIce()` as a W3C-shaped renegotiation request and preserves
existing data channels through the offer/answer exchange. It keeps the existing
ICE ufrag/password because advertising credentials that the native transport did
not adopt would disconnect browser peers.

Impact: the selected suite covers data-channel liveness with
`RTCDataChannel-iceRestart.html`, closed-state no-op behavior from
`RTCPeerConnection-restartIce.https.html`, and data-channel explicit rollback
gathering timing from
`RTCPeerConnection-explicit-rollback-iceGatheringState.html`. When native
gathering is already complete, the JS facade replays browser-shaped
`gathering`/`complete` events for the restart offer so WPT-visible task timing
matches the WebRTC API, but this does not imply fresh native ICE credentials.
Chrome E2E verifies that this fallback remains connected. Browser-initiated ICE
restart is applied natively and uses fresh remote credentials. WPT cases that
assert fresh local ICE credentials, media behavior, or detailed restart
signaling remain outside the current expected-pass set.

## SCTP stream limit

The audited libdatachannel commit negotiates up to 1024 SCTP streams internally.
The JS facade exposes that connected-state `RTCSctpTransport.maxChannels` limit
even if the native limit read arrives slightly after the SCTP connected event.
Browser WebRTC/WPT includes cases around stream ids up to 65534.
For WebIDL construction compatibility, negotiated channels with ids above the
native limit can be constructed and keep their requested `id` while remaining in
the `"connecting"` state. They are not backed by a native SCTP stream and are
not expected to become usable until libdatachannel can negotiate that stream
range.

Impact: the selected WPT suite covers the construction-time negotiated id
`65534` case. Functional high-id transport cases remain outside expected-pass
unless libdatachannel is configured or changed to support the larger range.
Full `RTCDataChannel-id.html` coverage now passes; the JS facade assigns
browser-visible IDs when a remote answer determines the DTLS role before
libdatachannel exposes a native stream id.

## Event and promise timing

Native libdatachannel callbacks run on internal worker threads. The addon uses a
Node-API thread-safe function and the JS facade dispatches DOM-style events on
the Node thread. Some exact browser task-source ordering is still being aligned
with WPT.

Impact: high-level negotiation and data-channel messaging work; precise timing
tests remain gated by the WPT harness.
