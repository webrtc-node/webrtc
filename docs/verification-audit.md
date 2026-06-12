# Verification Audit

This audit maps the original goal and success criteria to current repository
evidence. It is intentionally conservative: stale local artifacts and targeted
checks do not prove the full Linux/macOS/Windows matrix.

## Current Local Evidence

Audited from `C:\Users\mertu\Desktop\webrtc-node` on 2026-05-28.

| Gate | Evidence |
| --- | --- |
| Quality gate | `npm run check`, `npm run types:check`, `npm run api:check`, and `npm run pack:check` passed after Biome was added and the API surface checker was fixed for multiline TypeScript declarations. |
| Native integration | `npm run native:check` passed; it verifies Node-API/node-addon-api usage, TSFN dispatch, and the pinned libdatachannel commit. |
| Native build | `npm run build` passed on Windows with Visual Studio 2022 Build Tools. |
| Unit tests | `npm test` passed 20/20 Node `node:test` tests. The remote-close data-channel test also passed 20 serial stress iterations after one parallel-load timeout. |
| API surface | `npm run api:check` passed for 17 classes and 1 nonstandard member. |
| Types | `npm run types:check` passed. |
| WPT checkout | `npm run wpt:ensure` verified WPT commit `03169f171c797d0953b21d7388561b454fde0ad4`. |
| WPT selection | `npm run wpt:selection:check` verified 620 selected subtests. |
| Targeted WPT | The current Windows build passed `webrtc/RTCDataChannel-close.html`, the selected `RTCDataChannel-send.html` subset, and `RTCPeerConnection-ondatachannel.html` together as 46/46 subtests after the remote-close message-grace change. |
| Docker Linux smoke | `scripts/run-docker-linux-ci.ps1 -NodeImage node:20-bookworm -SkipWpt` passed build/unit/API/types/WPT-selection using the snapshot-backed Docker helper. Docker helpers now exist for PowerShell and POSIX shells, but remain optional local reproduction only. |
| Docker Linux targeted stress | Node 24 Docker passed 20 repeated runs of `webrtc/RTCDataChannel-close.html#Repeated open/send/echo/close datachannel works` with retries=0 after the remote-close message-grace change. |
| Superseded full WPT artifacts | Earlier Docker Linux Node 20 and Node 22 artifacts reached 620/620 with retries=0, and a later Node 24 full run reached 619/620 before the close-race fix. These predate the current close-path change and must not be treated as current full-suite evidence. |
| Local Docker CI | `scripts/run-docker-linux-ci.ps1` documents a reproducible Linux CI slice for Docker Desktop/WSL and rewrites Debian image apt sources to pinned snapshot URLs to reduce mirror instability. |

## Requirement Status

| Requirement | Current status |
| --- | --- |
| Phase 0 analysis before coding | Satisfied by `docs/phase0-analysis.md`, including upstream files reviewed, lifecycle/state/callback analysis, mismatch analysis, binding design, and WPT subset plan. |
| Data-channel-first WebRTC package | Implemented in `lib/index.js`, `src/native/addon.cc`, `index.d.ts`, and tested by local/WPT gates. |
| Node-API/N-API, no direct V8 addon API | Locally verified by `npm run native:check`; native source uses node-addon-api and `NODE_API_MODULE`. |
| Reproducible libdatachannel integration | Implemented in `CMakeLists.txt` with upstream commit `502ae351495792192ef21788e093b48e34ab393e`, including the OpenSSL DTLS and TLS input BIO synchronization fixes from upstream PRs #1584 and #1585; repository and commit are verified by `native:check`. |
| W3C-compatible JS facade | Covered by API/type checks, local tests, targeted WPT, and targeted Docker stress. Fresh full selected-WPT evidence is still pending after the latest close-path change. |
| RTCDataChannel selected WPT coverage | Targeted close/send/datachannel coverage is green locally; Node 24 Docker close-race stress is green. Fresh full 620-subtest evidence is still required. |
| RTCPeerConnection selected WPT coverage | Targeted datachannel and state coverage is green locally. Fresh full 620-subtest evidence is still required. |
| Safe callback dispatch | Locally verified by `native:check`; native callbacks dispatch through a thread-safe function. |
| Safe object lifetime | Covered by local tests and selected WPT close/GC cases; still needs continued stress coverage as the API expands. |
| TypeScript declarations | `index.d.ts` checked by `npm run types:check` and API surface verification. |
| CI builds/tests/WPT/report | Workflow exists in `.github/workflows/ci.yml` for Linux, macOS, and Windows on Node 20/22/24. Each matrix job writes `ci-evidence.json` and uploads it with WPT artifacts. A final `verify-ci-evidence` job downloads all matrix artifacts and runs `npm run ci:evidence:check`. |

## Current Known Gap

Fresh hosted selected-WPT evidence is still pending after the latest close-path
message-grace change. GitHub Actions is the authoritative conformance gate for
the public repository. Docker Linux runs are useful for local reproduction, but
they are no longer treated as release-blocking evidence because they cannot
prove macOS or Windows behavior.

## Remaining Completion Evidence

The active goal should not be marked complete until hosted CI or equivalent
authoritative logs prove the full matrix:

- `ubuntu-latest` on Node 20, 22, and 24
- `macos-latest` on Node 20, 22, and 24
- `windows-latest` on Node 20, 22, and 24

The Quality job must pass `npm ci`, `check`, `types:check`, and `pack:check`.
Each matrix job must pass `npm ci`, `native:check`, `build`, `test`, `api:check`,
`types:check`, `wpt:ensure`, `wpt:selection:check`, `wpt:test:sharded`,
`wpt:check:strict`, `wpt:report`, and `ci:evidence`.

After downloading all workflow artifacts into `ci-artifacts/`, run
`npm run ci:evidence:check`. The verifier requires `ci-evidence.json`,
`wpt-results.json`, `wpt-report.md`, `wpt-manifest.json`, and
`wpt-manifest.txt` for each OS/Node matrix entry and rejects missing jobs,
pin mismatches, WPT failures, and WPT retries.

The GitHub Actions workflow also runs this verifier automatically in the
`verify-ci-evidence` job. That job uses `always()` so failed or incomplete
matrix runs are reported as missing or non-green evidence instead of leaving the
final conformance verifier skipped.

Local Docker evidence is useful before pushing, but it only proves the Linux
Node image used by `scripts/run-docker-linux-ci.ps1`. It does not replace the
required macOS and Windows hosted matrix evidence.
