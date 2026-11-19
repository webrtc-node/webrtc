# Architecture

`@webrtc-node/webrtc` is intentionally split between a thin native layer and a
browser-compatible JavaScript facade.

## Native Addon

`src/native/addon.cc` owns `libdatachannel` handles and exposes a small
Node-API surface to JavaScript. It must remain ABI-stable and must not use
direct V8 or NAN APIs.

Native callbacks never call JavaScript directly from `libdatachannel` callback
threads. They dispatch back to Node through a thread-safe function.

The native ICE UDP mux wrapper follows the same rule and unregisters its
callback before releasing the dispatcher. Environment cleanup closes remaining
listeners before libdatachannel global cleanup.

Each Node environment owns its constructor references, peers, and UDP mux
listeners. Worker shutdown closes only that environment's resources; global
libdatachannel cleanup waits until the last environment exits. The typed
thread-safe dispatcher also reclaims queued payloads when Node can no longer
run JavaScript. A `napi_closing` result retires the dispatcher handle immediately,
including its release operation, because Node has consumed that acquisition.
The build enables node-addon-api's
`NODE_API_SWALLOW_UNTHROWABLE_EXCEPTIONS` handling for callbacks interrupted by
Worker termination.

Environment cleanup runs before Node's thread-safe function cleanup hooks, so
native producers stop while their dispatcher handles are still valid. Peer close
retains each teardown thread until it has been joined, including thread-local
destruction. Environment cleanup joins that work before releasing the final
libdatachannel environment.

A lazy native send worker belongs to each environment. It processes string and
binary payloads in FIFO order and never calls JavaScript directly. Environment
cleanup cancels unstarted work and joins the worker before closing the remaining
native peers. Explicit peer close disables callbacks and new sends immediately.
The peer's teardown thread gives already admitted sends up to 50 ms from close
to reach libdatachannel before continuing transport teardown. The shared worker
keeps FIFO order and skips expired jobs. The peer's wait ends as soon as its
own jobs finish or are discarded. GC and environment cleanup cancel unstarted
work without granting a handoff window. Individual channel close is queued
behind previously accepted sends, including empty messages.

Native peer methods reject calls after shutdown, and failed peer construction
surfaces a JavaScript error. The facade aborts queued offer/answer creation and
candidate additions when the peer closes, leaving those promises pending as
required by WebRTC.

## JavaScript Facade

`lib/index.js` implements the W3C-facing behavior:

- WebIDL-style conversions
- DOM-style `EventTarget` behavior
- promise timing and operations-chain behavior
- WebRTC state mapping
- `DOMException`-style errors
- data-channel message, open, close, and buffered amount semantics

Keep browser-compatible behavior in JavaScript unless native behavior is
required for correctness.

Offer/answer creation, description application, and ICE candidate additions share
a per-peer operations queue. Each operation validates signaling state when its
turn begins, using arguments converted when the method was called. A failed
operation releases the next one; closing the peer leaves active and queued
promises pending. Internal replay of buffered same-process ICE candidates stays
within the active operation to avoid waiting on its own queue.

Configuration conversion snapshots dictionary members and consumes iterable
sequences once, closing iterators when element conversion fails. Validation
finishes before the stored configuration changes. Candidate SDP insertion rejects
embedded control characters and writes a single canonical candidate line, so a
candidate string cannot inject additional SDP attributes.

Event dispatch reports listener exceptions asynchronously through Node so they
do not unwind cleanup or message-delivery code. Binary input conversion uses
intrinsic buffer/view metadata across JavaScript realms. Detached inputs produce
empty messages; shared and resizable inputs fail before queue admission,
following WebIDL buffer-source conversion.

String and binary sends validate their state and size, copy the JavaScript
payload, and enqueue native work before returning. SCTP, DTLS, and socket sends
run on the native send worker. Payload conversion and copying still consume
JavaScript-thread time. This addresses the synchronous transport work described
in [the send-burst latency report](https://github.com/webrtc-node/webrtc/issues/46).

The native backlog is limited to 64 MiB and 65,536 jobs per environment,
including in-flight work. State, size, and queue capacity are checked before
allocating the native payload copy. An immediate send that exceeds either limit
throws `OperationError` without increasing the public `bufferedAmount`. Close jobs can
still enter a full queue. Native `bufferedAmount` includes pending send payloads
until their handoff to SCTP completes, so the facade's drain polling cannot
mistake an unprocessed send for an empty transport. Later transport failures
are dispatched through the existing data-channel error event path.

The queue implementation lives in `src/native/send_queue.hpp`. Its native
regression tests hold the worker behind a gate to verify capacity limits,
payload admission, close ordering, and shutdown without timing-dependent load.

The typed `nonstandard` namespace is the boundary for the small set of
libdatachannel-specific operations exposed for advanced integrations. It does
not change the standard facade and does not expose the complete native API.

## Type Declarations

`index.d.ts` describes the public API. Any runtime API change must update the
declarations and `scripts/check-api-surface.js` as needed.

## Scope Boundary

The public scope is `RTCPeerConnection` plus `RTCDataChannel` for the WebRTC
data-channel profile. Media tracks, transceivers, RTP sender/receiver APIs,
stats, DTMF, and capture devices are not implemented.
