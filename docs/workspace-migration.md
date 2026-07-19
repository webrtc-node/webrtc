# Experimental Workspace Migration

This branch is an experimental workspace migration branch. The stable package
identity remains `@webrtc-node/webrtc`, with its package root at
`packages/webrtc`. The repository root is a private npm workspace that delegates
runtime commands to that package.

## Current State

The root declares `packages/*`, but only `packages/webrtc` intentionally exists.
The workspace shape is not a quota: packages are added only when they represent
independently maintainable products.

Standard peer connection, data channel, media, RTP, transport, and statistics
APIs all live in `@webrtc-node/webrtc`. Node-specific application-supplied
encoded RTP/RTCP uses `nonstandard.EncodedMediaSource` and
`nonstandard.EncodedMediaSink` from the same package. This keeps source, track,
sender, native callback, clone, stop, GC, and teardown ownership together.

The former `@webrtc-node/media` package was folded into core because it saved no
dependency and relied on private core source state. The former
`@webrtc-node/stats` package was removed because its generic sampler/delta API
was not a substantial independent product. The architectural criteria and
rejected alternatives are recorded in [Package Boundaries and Roadmap](package-roadmap.md).

`@webrtc-node/webrtc` preserves its package name, native install script,
prebuild asset naming, integrity validation, source-build fallback, and selected
WPT contract.

## Validation Guardrails

`npm run workspace:check` verifies that:

- the root package is `webrtc-node-workspace`, private, and not publishable;
- `packages/webrtc` retains the `@webrtc-node/webrtc` identity;
- no unapproved workspace package or placeholder directory exists;
- package metadata, scripts, documentation, license, native sources, and install
  files are present;
- dependencies do not use unpublished local-path specifiers.

Root build, test, type, API, package, WPT selection, and WPT smoke commands
delegate to the intentional package set. CI packs the core tarball, installs it
in an isolated project, and exercises W3C stats plus the encoded-media adapter
through the packed public API.

## Future Package Criteria

A child package can be introduced only after it has:

- a distinct optional purpose and accurate name;
- a stable public integration contract instead of private core state;
- meaningful dependency or lifecycle isolation;
- working package-local build, check, test, type, and packed-content commands;
- documented scope and non-goals;
- independent version and release semantics;
- no local-path dependency or empty public API;
- compatible CI, release, and published-install validation.

Potential native or test-helper packages remain absent until real duplication or
reuse justifies them.

## Remaining Experimental Scope

The branch remains experimental while in-scope WebRTC gaps remain. Current
promotion blockers include strict exact-head Conformance stability, native
worker exits, backend-authoritative RTP/RTCP loss, jitter, RTT and remote reports,
fresh-credential native ICE restart, candidate-gathering errors, remaining
transceiver/media-section lifecycle gaps, and applicable non-browser WPT.

Browser capture, devices, rendering, media elements, and capture UI are
intentional non-goals and are not promotion blockers.

Release and Published Install workflows must remain capable of validating the
single package without publishing. Manual release dispatch keeps asset upload
and npm publication behind explicit opt-in inputs. No package may be published
from this experimental branch during validation.
