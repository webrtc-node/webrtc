"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const libc = require("detect-libc");
const { validateArchiveFile } = require("./prebuild-integrity");

const root = path.resolve(__dirname, "..");
const packageJson = require("../package.json");
const sourceFallback = process.argv.includes("--source-fallback");
const libcTag = process.platform === "linux" ? libc.familySync() : null;
const tuple = [process.platform, process.arch, libcTag].filter(Boolean).join("-");
const archiveName = `webrtc-node-v${packageJson.version}-napi-v8-${tuple}.tar.gz`;
const artifacts = path.join(root, "prebuild-artifacts");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "webrtc-install-validation-"));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: scratch,
    stdio: "inherit",
    timeout: 600000,
    ...options,
  });
  if (result.error) throw result.error;
  assert.equal(result.signal, null, `unexpected signal from ${command}`);
  assert.equal(result.status, 0, `${command} failed`);
}

function npm(args, options) {
  assert.ok(process.env.npm_execpath, "invoke this check through npm exec");
  run(process.execPath, [process.env.npm_execpath, ...args], options);
}

async function main() {
  if (sourceFallback) {
    assert.equal(tuple, "linux-arm64-musl");
  } else {
    const archivePath = path.join(artifacts, archiveName);
    const options = {
      archivePath,
      archiveName,
      checksumContents: fs.readFileSync(`${archivePath}.sha256`, "utf8"),
      platform: process.platform,
      arch: process.arch,
      libcTag,
    };
    const addon = await validateArchiveFile(options);
    fs.rmSync(path.dirname(addon), { recursive: true, force: true });
    await assert.rejects(
      validateArchiveFile({ ...options, arch: process.arch === "arm64" ? "x64" : "arm64" }),
      /target mismatch|unsupported Linux libc target/,
    );
    if (libcTag) {
      await assert.rejects(
        validateArchiveFile({ ...options, libcTag: libcTag === "glibc" ? "musl" : "glibc" }),
        /target mismatch|unsupported Linux libc target/,
      );
    }
  }

  npm(["pack", "--pack-destination", scratch], { cwd: root });
  const tarball = fs.readdirSync(scratch).find((file) => file.endsWith(".tgz"));
  assert.ok(tarball);
  fs.writeFileSync(path.join(scratch, "package.json"), '{"private":true}\n');
  npm(["install", path.join(scratch, tarball), "--ignore-scripts"]);
  const installedRoot = path.join(scratch, "node_modules", "@webrtc-node", "webrtc");
  const installedAddon = path.join(installedRoot, "build", "Release", "webrtc_node.node");
  assert.equal(fs.existsSync(installedAddon), false);

  // Serve the unpublished archive locally while exercising the real downloader,
  // checksum validation, extraction, target checks, and install lifecycle script.
  const preload = path.join(scratch, "prebuild-fetch.cjs");
  fs.writeFileSync(
    preload,
    `const fs = require('node:fs');
const expected = ${JSON.stringify(archiveName)};
globalThis.fetch = async (url) => {
  const parsed = new URL(url);
  if (parsed.origin !== 'https://github.com' || !parsed.pathname.startsWith('/webrtc-node/webrtc/releases/download/v${packageJson.version}/')) throw new Error('unexpected download URL ' + url);
  const name = parsed.pathname.split('/').pop();
  if (name !== expected && name !== expected + '.sha256') throw new Error('unexpected asset ' + name);
  console.log('Installer requested ' + name);
  ${sourceFallback ? "return new Response('', {status: 404, statusText: 'Not Found'});" : `return new Response(fs.readFileSync(require('node:path').join(${JSON.stringify(artifacts)}, name)));`}
};
`,
  );
  run(process.execPath, ["--require", preload, "scripts/install-native.js"], {
    cwd: installedRoot,
    env: {
      ...process.env,
      WEBRTC_NODE_PREBUILD_ONLY: sourceFallback ? "0" : "1",
      npm_config_build_from_source: "false",
      WEBRTC_NODE_NATIVE_PATH: "",
    },
  });
  assert.ok(fs.existsSync(installedAddon));
  assert.equal(require(path.join(installedRoot, "package.json")).version, packageJson.version);
  run(process.execPath, [
    "-e",
    "const { RTCPeerConnection } = require('@webrtc-node/webrtc'); const pc = new RTCPeerConnection(); pc.close(); console.log('cjs ok');",
  ]);
  run(process.execPath, [
    "--input-type=module",
    "-e",
    "import { RTCPeerConnection } from '@webrtc-node/webrtc'; const pc = new RTCPeerConnection(); pc.close(); console.log('esm ok');",
  ]);
  const smoke = fs
    .readFileSync(path.join(root, "examples", "datachannel.js"), "utf8")
    .replace('require("..")', 'require("@webrtc-node/webrtc")');
  fs.writeFileSync(path.join(scratch, "smoke.cjs"), smoke);
  run(process.execPath, ["smoke.cjs"], { timeout: 30000 });
  console.log(
    `${sourceFallback ? "Source fallback" : "Prebuild-only installation"} verified for ${tuple}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
