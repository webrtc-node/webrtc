"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const packageJson = require("../package.json");
const prebuildsDir = path.join(root, "prebuild-artifacts");
const requiredTargets = [
  "linux-x64-glibc",
  "linux-x64-musl",
  "darwin-x64",
  "darwin-arm64",
  "win32-x64",
  "win32-arm64",
];

function fail(message) {
  console.error(`Prebuild check failed: ${message}`);
  process.exit(1);
}

for (const target of requiredTargets) {
  const file = path.join(
    prebuildsDir,
    `webrtc-node-v${packageJson.version}-napi-v8-${target}.tar.gz`,
  );
  if (!fs.existsSync(file)) fail(`missing ${path.relative(root, file).replace(/\\/g, "/")}`);
  if (fs.statSync(file).size === 0) fail(`empty ${path.relative(root, file).replace(/\\/g, "/")}`);
}

console.log(`Prebuild release assets verified: ${requiredTargets.join(", ")}`);
