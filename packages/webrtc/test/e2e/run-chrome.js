"use strict";

const { spawnSync } = require("node:child_process");
const path = require("node:path");

const testFile = path.join(__dirname, "chrome.test.js");
const scenarios = [
  "Node offerer interoperates with Chrome for text, binary, and close",
  "Chrome offerer interoperates with Node for text, binary, and close",
  "negotiated channels and reliability options match Chrome",
  "Unicode and ordered bursts preserve message contents",
  "Node enforces and Chrome interoperates at the negotiated message-size boundary",
  "Blob conversion, bufferedAmount drain, and send-then-close interoperate",
  "multiple channels keep matching stream identifiers",
  "ICE restart remains live when initiated by either peer",
  "Chrome closure propagates to Node",
  "mixed channel modes remain stable in one Node process",
  "candidate-by-candidate trickle ICE interoperates in both offerer directions",
  "20 alternating offerer negotiations remain stable",
];

for (const scenario of scenarios) {
  console.log(`\nChrome E2E scenario: ${scenario}`);
  const result = spawnSync(
    process.execPath,
    [
      "--test",
      "--test-force-exit",
      "--test-timeout=120000",
      `--test-name-pattern=^${scenario.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
      testFile,
    ],
    {
      env: process.env,
      stdio: "inherit",
    },
  );

  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
