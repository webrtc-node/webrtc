# Security Policy

`@mertushka/webrtc-node` is a data-channel-first native WebRTC binding for
Node.js. It is published, but it should not be treated as a security boundary
for untrusted traffic without validating the selected WPT suite, native
lifetime behavior, and cross-platform behavior against your use case.

## Reporting

For security-sensitive issues, use GitHub Security Advisories. Do not open a
public issue or publish exploit details before the report is reviewed.

Include:

- affected commit or version,
- operating system and Node.js version,
- reproduction steps,
- whether the issue involves native memory safety, callback threading,
  certificate handling, SDP/ICE input, or data-channel message handling.

## Supported Versions

The release line published under the npm `latest` distribution tag receives
security fixes. Prerelease versions published under non-latest distribution
tags receive security fixes only when explicitly announced.
