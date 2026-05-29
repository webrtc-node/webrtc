# Conformance

The compatibility target is the selected WPT subset in `wpt-manifest.json`.
This project targets the WebRTC data-channel profile exposed through
`RTCPeerConnection` and `RTCDataChannel`.

## Selected Scope

Expected-pass coverage currently includes:

- `RTCPeerConnection` construction, descriptions, signaling state, ICE state,
  ICE candidates, and data-channel negotiation
- `RTCDataChannel` construction, id assignment, negotiated channels, ready
  state, open/message/close/error behavior, send variants, binary type, and
  buffered amount behavior
- WebRTC-shaped constructors and events such as `RTCSessionDescription`,
  `RTCIceCandidate`, `RTCDataChannelEvent`, and ICE events

Out-of-scope WPT areas are grouped in the manifest as `notApplicable`,
`needsShim`, or `expectedFail`. Media and RTP APIs are outside this package's
public scope.

## Running WPT

```sh
npm run wpt:ensure
npm run wpt:selection:check
npm run wpt:test
npm run wpt:check:strict
npm run wpt:report -- --output wpt-report.md
```

`wpt:test` writes `wpt-results.json`. `wpt:check:strict` requires every selected
subtest to pass and fails if a worker retry was needed.

## CI Evidence

Each CI matrix job writes:

- `ci-evidence.json`
- `wpt-results.json`
- `wpt-report.md`
- `wpt-manifest.json`
- `wpt-manifest.txt`

After downloading CI artifacts into `ci-artifacts/`, validate the full matrix:

```sh
npm run ci:evidence:check -- --artifacts ci-artifacts
```

The verifier checks Linux, macOS, and Windows artifacts across Node 20, 22, and
24. It rejects missing jobs, pin mismatches, WPT failures, and WPT retries.
