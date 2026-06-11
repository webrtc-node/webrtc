# Maintainer Checklist

Use this checklist before publishing a public release or claiming a new
conformance milestone.

## Before Pushing

```sh
git status --short
npm run check
npm run native:check
npm run build
npm test
npm run api:check
npm run types:check
npm run pack:check
npm run e2e:chrome
npm run wpt:selection:check
npm run wpt:smoke
npm run wpt:smoke:check
```

Run the full selected WPT suite when changing WebRTC behavior:

```sh
npm run wpt:test
npm run wpt:check:strict
npm run wpt:report -- --output wpt-report.md
```

For native transport and teardown diagnostics, set
`WEBRTC_NODE_LIBDATACHANNEL_LOG` to `error`, `warning`, `info`, `debug`, or
`verbose` before running the focused test. Logging is disabled by default.

## Public Repository Settings

- enable GitHub Actions;
- enable Dependabot alerts and security updates;
- keep private vulnerability reporting enabled;
- keep CodeQL enabled for JavaScript/TypeScript and the manually built C++ addon;
- configure npm trusted publishing for `.github/workflows/release.yml`, with
  GitHub environment `npm` if release approvals are required;
- protect `main` and require pull requests;
- require `CI required`, `CodeQL JavaScript/TypeScript`, and `CodeQL C/C++`
  before merging;
- keep the release workflow's tag Conformance gate enabled.

## Release Readiness

Before npm publication:

- confirm package contents with `npm run pack:check`;
- keep `publishConfig.access` set to `public` for the scoped npm package;
- publish through the GitHub `Release` workflow so Linux, macOS, and Windows
  Node-API prebuilds are attached to the GitHub Release before npm publication;
- ensure the GitHub Release tag matches `v<package.json version>`;
- push the version tag so the `Conformance` workflow runs; the release workflow
  waits for its strict result before publishing to npm;
- confirm both CodeQL language checks are green with no unresolved new high or
  critical alerts;
- confirm the CI `Package artifact` job is green so the packed source builds
  outside the working tree;
- confirm `prebuild-linux-*`, `prebuild-macos`, `prebuild-windows`, and
  `Publish npm package` are green for the release workflow;
- confirm every prebuild archive has a sibling `.sha256` release asset and
  `npm run prebuild:check` validates the complete set;
- confirm the `Published Install` workflow is green for Linux glibc, Linux musl,
  macOS x64, macOS arm64, Windows x64, and Windows arm64;
- for asset-only rebuilds of an already-published version, manually dispatch
  the `Release` workflow with `publish_npm` disabled;
- do not create or store an `NPM_TOKEN`; the release workflow publishes through
  npm trusted publishing and GitHub Actions OIDC;
- tag a versioned release;
- publish current WPT conformance results;
- keep all intentional divergences in `docs/divergences.md`.

Claim conformance only for the selected `RTCPeerConnection` plus
`RTCDataChannel` WPT scope until broader WPT results support more.
