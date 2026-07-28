# Architecture

This document records the architecture audit performed on
`experiment/monorepo-workspace` at `f044cf97d3de9f73b63ee8e34cda3e4c47949fc9`
and the migration direction selected from that evidence.

## Current State

- The repository root is a private npm workspace. `packages/webrtc` is the only
  intentional public package and preserves the `@webrtc-node/webrtc` identity.
- The package ships one Node-API v8 addon, a CommonJS JavaScript facade,
  handwritten TypeScript declarations, and a source-build fallback.
- The facade is about 8,000 lines. `RTCPeerConnection` owns roughly one hundred
  mutable fields covering signaling, ICE, SCTP, data channels, media, stats,
  event timing, and same-process repair behavior.
- The addon is about 2,300 lines in one translation unit. It combines Node-API
  wrappers, event conversion, callback dispatch, registries, media counters,
  teardown, and module initialization.
- The selected WPT contract has 1,061 subtests. Focused Node tests and Chrome
  interoperability tests add media flow, stats, install, and teardown coverage.
- A dry-run package contains 13 files and about 450 KB unpacked. Native
  prebuilds cover Linux x64 glibc/musl, macOS x64/arm64, and Windows x64/arm64.

The split between native transport facts and JavaScript W3C policy is sound.
The concentration of unrelated state, untyped bridge protocol, global native
environment state, and incompletely tested distribution conditions are not.

## Target Architecture

### Repository and Packages

Keep the private workspace root and one public package:

- `@webrtc-node/webrtc` owns the complete applicable W3C object graph, native
  addon, install path, prebuilds, encoded-media adapters, and authoritative
  backend-supported stats.
- Application-supplied encoded RTP/RTCP remains under the typed `nonstandard`
  namespace because its source, track, sender, callback, and teardown ownership
  is inseparable from core.
- Do not recreate media, stats, native, or test-helper packages without an
  independent consumer purpose, stable public contract, and release lifecycle.

Repository-only WPT runners, examples, and release tooling may remain at the
root. Package-local commands that call them are development commands, not files
promised in the npm artifact.

### JavaScript and Module Formats

Keep one canonical CommonJS runtime and expose ESM through a thin explicit
adapter. Both formats must return the same constructors, module state, addon
instance, and `nonstandard` object.

Do not compile separate CommonJS and ESM runtime copies. This facade has
module-level task queues, peer-pairing registries, finalizers, and constructor
identity. Loading two copies would create observable state and lifecycle bugs.
Do not move to ESM-only while supported consumers and native tooling still use
CommonJS.

Keep runtime files unbundled. There is no browser payload, tree-shaking, or
single-file deployment requirement that offsets bundle debugging and native
loading complexity.

### Source Language and Declarations

Retain JavaScript while behavior is being characterized and modules are being
separated. A whole-facade TypeScript rewrite would combine semantic changes
with a new emit, source-map, pack, and source-install pipeline. That cost is not
justified before the existing state boundaries are made explicit.

Extract pure WebIDL, event, SDP, RTP-parameter, and stats helpers into internal
modules first. Add checked JSDoc to new boundaries where it catches protocol or
state errors without changing runtime output.

Keep the public `index.d.ts` deliberate and handwritten for now. Declarations
generated from the current implementation would expose underscore internals
and still require manual WebIDL dictionary and overload design. Strengthen
runtime/export/descriptor checks and CJS/ESM type-resolution fixtures. Revisit
generated declarations only after a stable public schema or typed facade exists.

### Native Addon

Keep one addon binary, but split its implementation by ownership:

- per-environment addon state and runtime lease;
- event protocol and thread-safe dispatch;
- peer, data-channel, and track bindings;
- media-description conversion and stats facts;
- module initialization and certificate support.

The first native migration must remove process-global constructor references
and binding registries. Cleanup for one Node Worker must not close bindings
owned by another environment; global `rtc::Cleanup()` must run only after the
last environment releases its runtime lease.

Native callbacks continue to cross into JavaScript only through
`Napi::ThreadSafeFunction`. Lifecycle events must be non-droppable. Packet and
message delivery need measured count/byte limits or backpressure; the current
shared queue can drop track lifecycle events at 1,024 entries while data-channel
messages remain unbounded.

Use a documented discriminated bridge contract. Keep conversion code
handwritten until duplicated schemas demonstrate that generation would reduce
drift rather than introduce another build step.

### State Authority

libdatachannel remains authoritative for ICE, DTLS-SRTP, SCTP, RTP transport,
candidate, and native lifecycle facts. JavaScript remains authoritative for
WebIDL conversion, DOMException shape, event task timing, stable JavaScript
identity, operations chaining, and `negotiationneeded` policy.

The same-process SDP pairing and repair channel must not be treated as proof of
real interoperability. Characterize critical behavior with pairing disabled,
across child processes, and with Chrome before removing or narrowing it.

The raw `nonstandard.native` escape hatch contradicts the intended narrow
boundary. Replace internal test use with a private loader, then remove or
replace the raw export with explicitly typed operations.

### Media and Statistics

Standard media streams, tracks, RTP endpoints, transceivers, transports,
`getStats()`, and `RTCStatsReport` remain in core. Native code supplies
transport facts and counters it can attribute reliably; JavaScript shapes and
links standardized dictionaries. Unsupported loss, jitter, remote reports, and
candidate-pair measurements remain absent rather than inferred.

Browser capture, devices, rendering, media elements, codec processing, and
capture UI remain intentional non-goals.

### Build, Test, and Release

Retain CMake, `cmake-js`, Node-API v8, Biome, and `tsc --noEmit`. The existing
toolchain directly matches the native source-build and prebuild problem; a
bundler or JavaScript build framework does not.

Organize focused tests by ownership as modules are extracted. Preserve selected
WPT as the semantics contract, run focused and smoke WPT locally, and reserve
the full selected suite for remote Conformance.

Release side effects must eventually require an immutable exact-version tag.
The current manual workflow can derive the already-published `v0.2.1` name from
an experimental checkout and upload assets with `--clobber`; this must be
hardened before any release.

## Rejected Alternatives

- **Separate media and stats packages:** lifecycle and standards ownership
  cross the native peer connection, while the removed packages had no
  independent dependency or substantial product boundary.
- **Return to a single-package repository root:** it would mix publishable
  contents with WPT, CI, and release tooling without reducing runtime
  complexity.
- **ESM-only:** unnecessary compatibility break for native Node consumers and
  tooling.
- **Independently compiled dual output:** duplicates observable module and
  native state.
- **Bundled runtime output:** adds debugging and native-loader complexity
  without a browser distribution requirement.
- **Immediate TypeScript rewrite:** couples a risky state-machine rewrite to a
  new release artifact pipeline.
- **Generated WebIDL or native bridge now:** the source schema is not yet
  stable, and generation would not solve current ownership defects.
- **Platform-specific npm binary packages now:** potentially useful for
  provenance later, but it multiplies package/release ownership before the
  current release path is safe.

## Migration Risks

- Extracting lifecycle-owning classes can change event ordering or stable
  object identity even when APIs look unchanged.
- Native environment cleanup changes can expose libdatachannel shutdown races.
- Removing same-process repair behavior before process/browser characterization
  can regress WPT while leaving real interoperability unchanged.
- New emitted JavaScript or generated declarations could break source installs
  or omit required files from the tarball.
- Release changes must preserve prebuild names, integrity checks, N-API
  compatibility, and source fallback.

## Staged Plan

1. Align contributor scope, make CJS/ESM package conditions explicit, and
   validate one shared runtime from both source and a clean packed consumer.
2. Derive duplicated conformance metadata and harden exact-tag release side
   effects and staged-prebuild install tests.
3. Add process-boundary/no-pairing characterization and stronger WebIDL
   descriptor/API checks.
4. Introduce per-environment addon state and Worker teardown tests.
5. Split native dispatch from bindings, define the event contract, and fix
   lifecycle-versus-payload queue policy.
6. Extract pure JavaScript WebIDL/event, SDP, RTP, and stats modules with
   checked internal contracts.
7. Narrow the raw native escape hatch and modularize peer/data/media ownership
   only under focused WPT, teardown, and interoperability coverage.
8. Consolidate WPT selection metadata and complete the remaining applicable
   conformance/backend work.

## First Slice

Stage 1 adds `lib/index.mjs` as an explicit adapter over `lib/index.js`, changes
the package `import` condition to that adapter, declares the default ESM export,
and validates named/default export parity and identity. The packed-consumer
smoke exercises both module formats, the package metadata entry, encoded media,
and standard stats without creating a second runtime implementation.
