# Conformance

The compatibility target is the selected WPT subset in `wpt-manifest.json`.
Real-browser wire interoperability is checked separately with
`npm run e2e:chrome`; WPT remains the API semantics contract.
This project targets the WebRTC data-channel profile exposed through
`RTCPeerConnection` and `RTCDataChannel`.

The current selected suite contains **620 expected-passing WPT subtests**. CI
validates this suite on Linux, macOS, and Windows across Node 20, 22, and 24 in
the Conformance workflow. Ordinary push and pull-request CI runs a faster WPT
smoke check.

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

This project should not be described as fully browser/WebRTC compliant. The
supported claim is: W3C-style peer-connection and data-channel behavior for
Node.js, backed by a selected WPT conformance suite.

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

Hosted Conformance uses `npm run wpt:test:sharded` with three deterministic
weighted shards running concurrently inside each OS/Node job. Ordinary WPT
files stay within one process so file-level setup and ordering are preserved;
files already marked for per-test isolation distribute those isolated tests
individually. The shard outputs are merged into the same complete
`wpt-results.json`; the strict checker still requires all 620 unique subtests
with no failures or retries.
