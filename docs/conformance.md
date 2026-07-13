# Conformance

The compatibility target for `@webrtc-node/webrtc` is the selected WPT subset
in `wpt-manifest.json`. Real-browser wire interoperability is checked
separately with `npm run e2e:chrome`; WPT remains the API semantics contract.
This experimental branch targets the WebRTC peer-connection, data-channel,
encoded-media, and reliable-statistics surfaces exposed through
`@webrtc-node/webrtc`.

The current selected suite contains **714 expected-passing WPT subtests**. CI
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
- media stream and track identity, sender/receiver/transceiver construction,
  direction and stopping semantics, and media negotiation lifecycle
- `RTCStatsReport` maplike behavior and reliable peer, data-channel,
  transport, and encoded RTP counters

Out-of-scope WPT areas are grouped in the manifest as `notApplicable`,
`needsShim`, or `expectedFail`. Browser device capture, rendering, media
elements, capture UI, and codec processing are intentional non-goals and are
non-applicable to readiness. They are not implementation debt or blockers.
Statistics unavailable from the backend remain omitted rather than fabricated.
The Node WPT harness supplies encoded synthetic audio/video tracks for media API
semantics tests such as `addTrack` and `setStreams`; this is test infrastructure
and does not expose `navigator.mediaDevices` or capture APIs from the package.

Readiness still requires stable Node transport and teardown, application-supplied
encoded media flow, W3C media object and transceiver lifecycle semantics,
backend-supported standardized statistics, fresh-credential ICE restart,
candidate-gathering errors, and every remaining applicable non-browser WPT.

This project should not be described as fully browser/WebRTC compliant. The
supported claim is: experimental W3C-style peer-connection, data-channel,
encoded-media, and reliable-statistics behavior for Node.js, backed by a
selected WPT conformance suite.

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
`wpt-results.json`; the strict checker still requires all 691 unique subtests
with no failures or retries.
