# Security Policy

`@mertushka/webrtc-node` is a data-channel-first native WebRTC binding for
Node.js. It is published, but it should not be treated as a security boundary
for untrusted traffic without validating the selected WPT suite, native
lifetime behavior, and cross-platform CI evidence against your use case.

## Reporting

For security-sensitive issues, use the repository's private vulnerability
reporting form under GitHub Security Advisories. Do not open a public issue or
publish exploit details before the report is reviewed.

Include:

- affected commit or version,
- operating system and Node.js version,
- reproduction steps,
- whether the issue involves native memory safety, callback threading,
  certificate handling, SDP/ICE input, or data-channel message handling.

## Supported Versions

The current `0.1.x` release line receives security fixes while it remains the
published `latest` line on npm. Prerelease versions published under non-latest
distribution tags receive security fixes only when explicitly announced.
