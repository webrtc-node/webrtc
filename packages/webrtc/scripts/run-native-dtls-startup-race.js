"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const target = "webrtc_node_dtls_startup_race";

function fail(message) {
  console.error(`Native DTLS startup regression failed: ${message}`);
  process.exit(1);
}

function positiveInteger(value, name, fallback) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) fail(`${name} must be a positive integer`);
  return number;
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error) fail(result.error.message);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const cmakeJs = require.resolve("cmake-js/bin/cmake-js");
run(process.execPath, [
  cmakeJs,
  "configure",
  "--config",
  "Release",
  "--CDWEBRTC_NODE_BUILD_NATIVE_TESTS=ON",
]);
run(process.execPath, [cmakeJs, "build", "--config", "Release", "--target", target]);

const executableNames =
  process.platform === "win32"
    ? [
        path.join(root, "build", "Release", `${target}.exe`),
        path.join(root, "build", `${target}.exe`),
      ]
    : [path.join(root, "build", target), path.join(root, "build", "Release", target)];
const executable = executableNames.find((candidate) => fs.existsSync(candidate));
if (!executable) fail(`could not find ${target} under ${path.join(root, "build")}`);

const validIterations = positiveInteger(
  process.env.WEBRTC_NODE_DTLS_RACE_ITERATIONS,
  "WEBRTC_NODE_DTLS_RACE_ITERATIONS",
  200,
);
const invalidIterations = positiveInteger(
  process.env.WEBRTC_NODE_DTLS_RACE_INVALID_ITERATIONS,
  "WEBRTC_NODE_DTLS_RACE_INVALID_ITERATIONS",
  10,
);

run(executable, [String(validIterations)]);
run(executable, [String(invalidIterations), "invalid"]);
