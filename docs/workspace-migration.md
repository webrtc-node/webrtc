# Experimental Workspace Migration

This branch is an experimental workspace migration branch. The stable package
remains `@webrtc-node/webrtc`, but its package root is now `packages/webrtc`.
The repository root is a private npm workspace that delegates runtime package
commands to that workspace.

## Current State

The repository declares a root npm workspace pattern:

```text
packages/*
```

The only workspace package is currently `packages/webrtc`. Empty public
packages such as `@webrtc-node/media`, `@webrtc-node/stats`,
`@webrtc-node/native`, and `@webrtc-node/test-utils` must not be added until
they have real code, package metadata, tests, documentation, and package-local
validation.

`@webrtc-node/webrtc` keeps its package identity, native install script,
prebuild asset naming, WPT selection, and public API. Package-local build,
test, type, API, native integration, and prebuild scripts live under
`packages/webrtc`.

## Validation Guardrails

`npm run workspace:check` validates that:

- the root package is named `webrtc-node-workspace`
- the root package is private and cannot be published by accident
- `packages/webrtc` is the only publishable package
- the workspace pattern is `packages/*`
- native install and package file entries remain present in `packages/webrtc`
- any future child package is one of the approved package names
- future child packages declare metadata, scripts, exports or main, and README
  documentation

The guard is also included in `npm run check`.

## Future Package Criteria

A child package can be created only when it has a maintainable purpose and is
ready to own its surface:

- correct package metadata and repository identity
- working package-local `build`, `check`, `test`, and `types:check` scripts
- documented scope and non-goals
- no empty public API placeholders
- no dependency on unpublished local paths
- package-specific packed-content validation
- compatible CI, release, prebuild, and published-install paths

## Remaining Experimental Scope

This branch remains experimental after local validation until GitHub CI and
release/prebuild workflows run successfully from the workspace layout. The
sensitive paths are source builds, prebuild packaging, prebuild download and
integrity checks, packed-source rebuilds, WPT smoke/full runs, CodeQL C++
tracing, release asset upload, npm publish targeting, and published-install
verification. Manual release workflow dispatches keep asset upload and npm
publish behind explicit opt-in inputs so prebuild validation can run without
creating release artifacts.

Future packages remain intentionally absent. Creating `packages/media`,
`packages/stats`, `packages/native`, or `packages/test-utils` would be a
separate package stabilization project, not a workspace placeholder change.
