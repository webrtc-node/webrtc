# Package and Organization Roadmap

`webrtc-node` is the GitHub and npm organization for WebRTC APIs and tooling
for Node.js. The organization should support a complete WebRTC stack over time
without putting low-level media APIs into the browser-compatible core facade.

## Current Packages

`@webrtc-node/webrtc` is the W3C-facing runtime package. Its experimental scope
includes peer connections, data channels, encoded media tracks, RTP
sender/receiver/transceiver objects, and standards-shaped statistics backed by
libdatachannel. In the experimental workspace branch its package root is
`packages/webrtc`; the package name, exports, install behavior, prebuild asset
names, and WPT conformance scope stay unchanged.

The experimental workspace also contains two implemented companion packages:

- `@webrtc-node/media` provides optional encoded RTP packet sources and sinks
  behind standard core `MediaStreamTrack` values. It does not implement browser
  capture, rendering, codecs, RTP packet construction, or pacing.
- `@webrtc-node/stats` provides scheduling and delta utilities over standard
  core `RTCStatsReport` values. It does not define a separate stats model.

These packages share a coordinated version because both consume a typed
native companion capability supplied by `@webrtc-node/webrtc`.

## Package Boundaries

Packages start only when they have a real implementation and a clear user story.

- `@webrtc-node/webrtc`: stable WebRTC runtime package and default install.
- `@webrtc-node/media`: optional encoded RTP source/sink adapters.
- `@webrtc-node/stats`: standard stats report sampling and deltas.
- `@webrtc-node/native`: shared native/build layer, only if duplication becomes
  a real maintenance problem.
- `@webrtc-node/test-utils`: internal or development-only WPT, interop, and
  peer-pair helpers, only if tests outgrow the main package.

Media and stats remain companion packages because encoded packet I/O and report
sampling are optional utilities. Standard negotiation and statistics APIs live
in `@webrtc-node/webrtc`.

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

Standard APIs belong in `@webrtc-node/webrtc`. Companion packages may expose
optional backend adapters, but normal media negotiation and stats inspection
must not require a custom object model.
