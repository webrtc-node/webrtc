# Security Policy

## Reporting a vulnerability

Report vulnerabilities privately through
[GitHub Security Advisories](https://github.com/webrtc-node/webrtc/security/advisories/new).
Please do not open a public issue or publish details before a fix is available.

Include the affected version, your operating system and Node.js version, and
steps to reproduce. Mention whether the issue involves native memory safety,
callback threading, certificate handling, SDP or ICE input, or data-channel
message handling.

## Supported versions

| Version                          | Supported |
| -------------------------------- | --------- |
| Latest release on npm (`latest`) | ✅        |
| Older releases                   | ❌        |

Fixes ship in a new patch release. Prereleases receive fixes only when
announced.

## Scope

Remote peers send SDP, ICE candidates, DTLS, and SCTP data that this package
processes. Transport parsing and cryptography are handled by
[libdatachannel](https://github.com/paullouisageneau/libdatachannel),
[usrsctp](https://github.com/sctplab/usrsctp), and OpenSSL, which are pinned in
`CMakeLists.txt` and statically linked into the prebuilds. Vulnerabilities in
those projects are in scope when they affect this package; we update the pinned
versions and publish a release.

## Safeguards

- CodeQL analysis for C++ and JavaScript on every pull request and on `main`.
- Native lifetime tests for close and teardown races, garbage collection,
  failed construction, and Worker termination.
- Releases are published from CI with npm provenance. Prebuilt binaries are
  verified with SHA-256 checksums and target checks before installation.
