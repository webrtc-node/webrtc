# Experimental Workspace Migration

This branch is an experimental workspace migration branch. The stable package
remains `@webrtc-node/webrtc`, and its package root remains the repository root
until the release, prebuild, install, WPT, and published-install paths are
rewired and validated for a moved package.

## Current State

The repository declares a root npm workspace pattern for future packages:

```text
packages/*
```

No child workspace package is currently present. That is intentional. Empty
public packages such as `@webrtc-node/media`, `@webrtc-node/stats`,
`@webrtc-node/native`, and `@webrtc-node/test-utils` must not be added until
they have real code, package metadata, tests, documentation, and package-local
validation.

`@webrtc-node/webrtc` keeps its current package identity, root package files,
native install script, prebuild asset naming, WPT selection, and public API.

## Validation Guardrails

`npm run workspace:check` validates that:

- the root package is still named `@webrtc-node/webrtc`
- the root package remains publishable
- the workspace pattern is `packages/*`
- native install and package file entries remain present
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

## Migration Blockers

Moving the current package to `packages/webrtc` is not a mechanical rename. The
current release path expects `package.json`, `CMakeLists.txt`, `lib/`, `src/`,
`scripts/`, `index.d.ts`, WPT files, and prebuild artifacts at the repository
root. Before that move is safe, the migration needs workspace-aware handling for
the source build, prebuild packaging, prebuild download and integrity checks,
packed-source rebuilds, WPT smoke/full runs, CodeQL C++ tracing, and published
install verification.
