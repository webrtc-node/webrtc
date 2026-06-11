"use strict";

const { spawnSync } = require("node:child_process");

function fail(message) {
  console.error(`Package artifact check failed: ${message}`);
  process.exit(1);
}

const npmCommand = process.env.npm_execpath ? process.execPath : "npm";
const npmArgs = process.env.npm_execpath
  ? [process.env.npm_execpath, "pack", "--dry-run", "--json"]
  : ["pack", "--dry-run", "--json"];
const result = spawnSync(npmCommand, npmArgs, {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});

if (result.error) fail(result.error.message);
if (result.status !== 0 || result.signal) {
  fail(result.stderr.trim() || result.stdout.trim() || `npm pack exited with ${result.status}`);
}

let payload;
try {
  payload = JSON.parse(result.stdout);
} catch (error) {
  fail(`could not parse npm pack JSON: ${error.message}`);
}

const artifact = payload?.[0];
if (!artifact || !Array.isArray(artifact.files)) fail("npm pack did not return file metadata");

const files = new Set(artifact.files.map((file) => file.path.replace(/\\/g, "/")));
const expectedFiles = new Set([
  "package.json",
  "README.md",
  "LICENSE",
  "CMakeLists.txt",
  "index.d.ts",
  "lib/index.js",
  "lib/load-native.js",
  "src/native/addon.cc",
  "src/native/certificate.cc",
  "src/native/certificate.hpp",
  "scripts/install-native.js",
  "scripts/prebuild-integrity.js",
]);

for (const file of expectedFiles) {
  if (!files.has(file)) fail(`missing required file ${file}`);
}

for (const file of files) {
  if (!expectedFiles.has(file)) fail(`unexpected file included: ${file}`);
}

const forbiddenPrefixes = [
  ".github/",
  "build/",
  "ci-artifacts/",
  "coverage/",
  "libdatachannel/",
  "node_modules/",
  "prebuild-artifacts/",
  "prebuilds/",
  "test/",
  "wpt/",
];
const forbiddenFiles = new Set([
  "AGENTS.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "ci-evidence.json",
  "wpt-results.json",
  "wpt-report.md",
  "wpt-manifest.txt",
]);

for (const file of files) {
  if (forbiddenFiles.has(file)) fail(`forbidden file included: ${file}`);
  const forbiddenPrefix = forbiddenPrefixes.find((prefix) => file.startsWith(prefix));
  if (forbiddenPrefix) fail(`forbidden path included: ${file}`);
}

console.log(
  `Package artifact verified: ${artifact.files.length} files, ${artifact.unpackedSize} bytes unpacked`,
);
