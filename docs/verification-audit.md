# Verification Audit

This document records authoritative hosted evidence and the limits of local
validation. Generated artifacts and local checkouts are not committed.

## Hosted Conformance Evidence

GitHub Actions Conformance run `27392464467` completed successfully on
2026-06-12. It tested PR #11 head
`f4c9edf438291e432fcc024cea80198abfe08717`, which was squash-merged as
`e6a3cfca4beee3163806908c433807354f384c42`.

The run completed:

- the Quality job;
- Linux, macOS, and Windows on Node.js 20, 22, and 24;
- all 620 selected WPT subtests with strict retry rejection;
- the final `Verify CI evidence` job.

The run is available at:
`https://github.com/mertushka/webrtc-node/actions/runs/27392464467`.

This evidence applies to the tested commit. Later WebRTC semantic, native,
lifecycle, SDP, ICE, buffering, or event-timing changes require new applicable
conformance evidence.

## Conformance Contract

`wpt-manifest.json` is the selected compatibility contract. It pins:

- the libdatachannel commit;
- the WPT commit;
- the expected selected subtest count;
- a SHA-256 digest of the sorted `{file, name}` test identities.

`npm run wpt:selection:check` discovers the selected tests without executing
them and rejects count, identity, duplicate, or digest changes. Updating the
digest requires deliberate review of the changed selection.

## Workflow Evidence

`.github/workflows/conformance.yml` runs the full matrix separately from normal
push and pull-request CI. Each matrix job produces:

- `ci-evidence.json`;
- `wpt-results.json`;
- `wpt-report.md`;
- `wpt-manifest.json`;
- `wpt-manifest.txt`.

The final evidence verifier requires every OS and Node.js matrix entry,
recomputes WPT status and retry counts, rejects duplicate or inconsistent test
identities, verifies manifest equality, and binds all artifacts to one GitHub
workflow run and commit.

After downloading artifacts into `ci-artifacts/`, maintainers can run:

```sh
npm run ci:evidence:check
```

## Local Validation Boundary

Focused local tests and Docker runs are useful for development and
reproduction. They do not replace hosted macOS and Windows evidence. The full
selected WPT suite is intentionally separate from ordinary local and push CI
because of its runtime cost.
