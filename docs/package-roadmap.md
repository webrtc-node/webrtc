# Package and Organization Roadmap

`webrtc-node` is the GitHub and npm organization for WebRTC APIs and tooling
for Node.js. The organization should support a complete WebRTC stack over time
without making data-channel-only users pay for media complexity.

## Current Package

`@webrtc-node/webrtc` is the stable runtime package. Its current scope is
W3C-style `RTCPeerConnection` and `RTCDataChannel` APIs backed by
libdatachannel.

Keep this package focused until additional APIs are mature enough to justify
the dependency, testing, and maintenance cost. Do not add media, stats, or
browser device APIs to the stable surface as placeholders.

## Package Boundaries

Future packages should start as separate npm packages when they have a real
implementation and a clear user story.

- `@webrtc-node/webrtc`: stable WebRTC runtime package and default install.
- `@webrtc-node/media`: optional media APIs and heavier media dependencies.
- `@webrtc-node/stats`: stats collection, normalization, and report helpers.
- `@webrtc-node/native`: shared native/build layer, only if duplication becomes
  a real maintenance problem.
- `@webrtc-node/test-utils`: internal or development-only WPT, interop, and
  peer-pair helpers, only if tests outgrow the main package.

Media and stats should incubate outside the stable core until their APIs are
standards-shaped, tested, and ready for long-term compatibility support.

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

Do not convert this repository into a workspace just for structure. Convert it
when at least one additional runtime package exists and shares enough
infrastructure with `@webrtc-node/webrtc` that separate repositories would
create meaningful duplication.

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

Until then, keep the current single-package repository layout.

## Release Model

Use independent package versions unless a shared native ABI or coordinated
compatibility change requires lockstep releases. A patch release of
`@webrtc-node/media` should not force a version bump of `@webrtc-node/webrtc`
when the stable runtime package did not change.

Every public package should eventually use trusted publishing, provenance,
prebuild validation when native artifacts are involved, and package-specific
published-install smoke tests.

## Promotion Rule

Experimental APIs can incubate in companion packages. Promote APIs into
`@webrtc-node/webrtc` only when they are compatible with the W3C-facing model,
covered by local and interoperability tests, and stable enough that users can
depend on them without tracking internal libdatachannel behavior.
