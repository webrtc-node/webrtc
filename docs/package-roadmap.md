# Package and Organization Roadmap

`webrtc-node` is the GitHub and npm organization for WebRTC APIs and tooling
for Node.js. The organization should support a complete WebRTC stack over time
without putting low-level media APIs into the browser-compatible core facade.

## Current Packages

`@webrtc-node/webrtc` is the W3C-facing runtime package. Its current scope is
W3C-style `RTCPeerConnection` and `RTCDataChannel` APIs backed by
libdatachannel. In the experimental workspace branch its package root is
`packages/webrtc`; the package name, exports, install behavior, prebuild asset
names, and WPT conformance scope stay unchanged.

The experimental workspace also contains two implemented companion packages:

- `@webrtc-node/media` provides explicit encoded RTP/RTCP tracks over
  libdatachannel DTLS-SRTP. It does not implement browser capture, codecs, or
  the `MediaStreamTrack`/transceiver object model.
- `@webrtc-node/stats` provides immutable SCTP transport snapshots, selected
  ICE endpoint context, deltas, and interval sampling. It does not claim to be
  the browser `RTCStatsReport` object graph.

These packages share a coordinated version because both consume a typed
native companion capability supplied by `@webrtc-node/webrtc`.

## Package Boundaries

Packages start only when they have a real implementation and a clear user story.

- `@webrtc-node/webrtc`: stable WebRTC runtime package and default install.
- `@webrtc-node/media`: encoded RTP/RTCP transport and media SDP negotiation.
- `@webrtc-node/stats`: transport counter snapshots, deltas, and sampling.
- `@webrtc-node/native`: shared native/build layer, only if duplication becomes
  a real maintenance problem.
- `@webrtc-node/test-utils`: internal or development-only WPT, interop, and
  peer-pair helpers, only if tests outgrow the main package.

Media and stats remain companion packages because their APIs are deliberately
not browser facade APIs.

## Repository Layout

Keep separate repositories for different products or independently maintained
efforts:

- `webrtc-node/webrtc`: runtime package repository.
- `webrtc-node/website`: documentation and project site, if the website grows
  beyond the README and docs in this repo.
- `webrtc-node/examples`: larger examples, if examples grow beyond small
  package smoke examples.
- `webrtc-node/benchmarks`: repeatable benchmarks and historical performance
  results, if benchmark infrastructure becomes substantial.

Do not create one repository per tightly coupled runtime package by default.
`webrtc`, `media`, and `stats` will likely share native build logic, WPT
helpers, interop tests, prebuild workflows, and release checks. Once there is a
second real runtime package, the `webrtc-node/webrtc` repository can become a
workspace repository for related runtime packages.

## Workspace Migration Trigger

Do not create additional workspace packages just for structure. Add a package
only when it has real code, stable metadata, tests, documentation, packed
content validation, and a clear maintenance owner.

A future workspace layout can look like this:

```text
packages/
  webrtc/
  media/
  stats/
  native/
  test-utils/
examples/
docs/
scripts/
```

Experimental workspace migration branches may add root-level workspace
metadata and move the existing runtime package under `packages/webrtc`, but
they must not publish empty package placeholders. See
[Experimental Workspace Migration](workspace-migration.md) for the current
guardrails and blockers.

## Release Model

The three runtime packages use lockstep versions while media and stats depend
on the companion native capability in `@webrtc-node/webrtc`. Release publishes
the native package first, followed by media and stats, and validates all three
packed artifacts together before publishing.

Every public package should eventually use trusted publishing, provenance,
prebuild validation when native artifacts are involved, and package-specific
published-install smoke tests.

## Promotion Rule

Experimental APIs can incubate in companion packages. Promote APIs into
`@webrtc-node/webrtc` only when they are compatible with the W3C-facing model,
covered by local and interoperability tests, and stable enough that users can
depend on them without tracking internal libdatachannel behavior.
