"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

test("native send queue enforces admission, preserves close order, and joins during shutdown", () => {
  const root = path.resolve(__dirname, "..");
  const build = spawnSync(
    "cmake",
    [
      "--build",
      path.join(root, "build"),
      "--config",
      "Release",
      "--target",
      "webrtc_node_send_queue_test",
    ],
    { encoding: "utf8", timeout: 20000, windowsHide: true },
  );
  assert.equal(build.error, undefined);
  assert.equal(build.status, 0, build.stdout + build.stderr);
  const name = `webrtc_node_send_queue_test${process.platform === "win32" ? ".exe" : ""}`;
  const executable = [
    path.join(root, "build", "Release", name),
    path.join(root, "build", name),
  ].find((candidate) => fs.existsSync(candidate));
  assert.ok(executable, "Native send queue test executable is missing");
  const run = spawnSync(executable, [], { encoding: "utf8", timeout: 10000, windowsHide: true });
  assert.equal(run.error, undefined);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /10 cases passed/);
});
