"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { currentTarget, platformPackageName } = require("../dist/native/target");

const root = path.resolve(__dirname, "..");
const { version } = require("../package.json");
const builtAddon = path.join(root, "build", "Release", "webrtc_node.node");

// Lays out node_modules as a package manager would after installing the main
// package and, optionally, its platform package.
function installedLayout(t, platformVersion) {
  const project = fs.mkdtempSync(path.join(root, "build", "loader-test-"));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const main = path.join(project, "node_modules", "@webrtc-node", "webrtc");
  const compiled = path.join("dist", "native");
  fs.mkdirSync(path.join(main, compiled), { recursive: true });
  for (const file of ["load.js", "target.js"]) {
    fs.copyFileSync(path.join(root, compiled, file), path.join(main, compiled, file));
  }
  fs.writeFileSync(
    path.join(main, "package.json"),
    JSON.stringify({ name: "@webrtc-node/webrtc", version }),
  );
  const name = platformPackageName(currentTarget());
  if (platformVersion) {
    const platform = path.join(project, "node_modules", ...name.split("/"));
    fs.mkdirSync(platform, { recursive: true });
    fs.copyFileSync(builtAddon, path.join(platform, "webrtc_node.node"));
    fs.writeFileSync(
      path.join(platform, "package.json"),
      JSON.stringify({ name, version: platformVersion }),
    );
  }
  return { loader: path.join(main, "dist", "native", "load.js"), name };
}

function load(loader) {
  return spawnSync(
    process.execPath,
    [
      "-e",
      `const native = require(${JSON.stringify(loader)}); console.log(typeof native.generateCertificate);`,
    ],
    { encoding: "utf8", env: { ...process.env, WEBRTC_NODE_NATIVE_PATH: "" }, windowsHide: true },
  );
}

test("the loader uses the platform package that matches the main package version", (t) => {
  const { loader } = installedLayout(t, version);
  const result = load(loader);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "function");
});

test("the loader rejects a platform package with a different version", (t) => {
  const { loader, name } = installedLayout(t, "0.0.0-mismatch");
  const result = load(loader);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, new RegExp(`${name}@0\\.0\\.0-mismatch does not match`));
});

test("a missing platform package names the optional dependency to install", (t) => {
  const { loader, name } = installedLayout(t, null);
  const result = load(loader);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /No native addon found/);
  assert.ok(result.stderr.includes(name), result.stderr);
});
