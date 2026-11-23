"use strict";

// Validates this machine's prebuild archive, then installs the main package and
// its platform package from local tarballs with install scripts disabled, as a
// package manager that blocks lifecycle scripts would.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { currentTarget, linuxLibc, platformPackageName } = require("../lib/native-target");
const { validateArchiveFile } = require("./prebuild-integrity");

const root = path.resolve(__dirname, "..");
const packageJson = require("../package.json");
const target = currentTarget();
const libcTag = linuxLibc();
const archiveName = `webrtc-node-v${packageJson.version}-napi-v8-${target}.tar.gz`;
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

function packInto(directory, packageDirectory) {
  const before = new Set(fs.readdirSync(directory));
  npm(["pack", packageDirectory, "--pack-destination", directory], { cwd: root });
  const created = fs.readdirSync(directory).filter((file) => !before.has(file));
  assert.equal(created.length, 1, `npm pack ${packageDirectory} created ${created.length} files`);
  return path.join(directory, created[0]);
}

async function main() {
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

  const packages = path.join(scratch, "npm-packages");
  run(process.execPath, [
    path.join(root, "scripts", "platform-packages.js"),
    "pack",
    `--target=${target}`,
    `--artifacts=${artifacts}`,
    `--out=${packages}`,
  ]);
  const tarballs = path.join(scratch, "tarballs");
  fs.mkdirSync(tarballs);
  const mainTarball = packInto(tarballs, root);
  const platformTarball = packInto(tarballs, path.join(packages, target));

  const project = path.join(scratch, "project");
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, "package.json"), '{"private":true}\n');
  npm(["install", mainTarball, platformTarball, "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: project,
  });
  const installedRoot = path.join(project, "node_modules", "@webrtc-node", "webrtc");
  assert.equal(fs.existsSync(path.join(installedRoot, "build")), false, "no local build expected");
  assert.equal(
    fs.existsSync(path.join(installedRoot, "scripts")),
    false,
    "installer scripts must not be published",
  );
  const platformRoot = path.join(
    project,
    "node_modules",
    ...platformPackageName(target).split("/"),
  );
  assert.ok(fs.existsSync(path.join(platformRoot, "webrtc_node.node")));
  assert.equal(require(path.join(platformRoot, "package.json")).version, packageJson.version);

  const env = { ...process.env, WEBRTC_NODE_NATIVE_PATH: "" };
  run(
    process.execPath,
    [
      "-e",
      "const { RTCPeerConnection } = require('@webrtc-node/webrtc'); const pc = new RTCPeerConnection(); pc.close(); console.log('cjs ok');",
    ],
    { cwd: project, env },
  );
  run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "import { RTCPeerConnection } from '@webrtc-node/webrtc'; const pc = new RTCPeerConnection(); pc.close(); console.log('esm ok');",
    ],
    { cwd: project, env },
  );
  const smoke = fs
    .readFileSync(path.join(root, "examples", "datachannel.js"), "utf8")
    .replace('require("..")', 'require("@webrtc-node/webrtc")');
  fs.writeFileSync(path.join(project, "smoke.cjs"), smoke);
  run(process.execPath, ["smoke.cjs"], { cwd: project, env, timeout: 30000 });
  console.log(`Installation without lifecycle scripts verified for ${target}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => fs.rmSync(scratch, { recursive: true, force: true }));
