"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { validateArchiveFile } = require("./prebuild-integrity");

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

function targetParts(target) {
  const [platform, arch, libcTag] = target.split("-");
  return { platform, arch, libcTag: libcTag || null };
}

async function main() {
  if (!fs.existsSync(prebuildsDir)) fail("prebuild-artifacts directory is missing");

  const expectedAssets = new Set(
    requiredTargets.flatMap((target) => {
      const archiveName = `webrtc-node-v${packageJson.version}-napi-v8-${target}.tar.gz`;
      return [archiveName, `${archiveName}.sha256`];
    }),
  );
  const actualAssets = fs.readdirSync(prebuildsDir, { withFileTypes: true });
  for (const asset of actualAssets) {
    if (!asset.isFile() || !expectedAssets.has(asset.name)) {
      fail(`unexpected prebuild release asset ${asset.name}`);
    }
    expectedAssets.delete(asset.name);
  }
  if (expectedAssets.size > 0) {
    fail(`missing prebuild release assets: ${Array.from(expectedAssets).join(", ")}`);
  }

  for (const target of requiredTargets) {
    const file = path.join(
      prebuildsDir,
      `webrtc-node-v${packageJson.version}-napi-v8-${target}.tar.gz`,
    );
    const checksumFile = `${file}.sha256`;
    if (!fs.existsSync(file)) fail(`missing ${path.relative(root, file).replace(/\\/g, "/")}`);
    if (!fs.existsSync(checksumFile)) {
      fail(`missing ${path.relative(root, checksumFile).replace(/\\/g, "/")}`);
    }
    try {
      const addonPath = await validateArchiveFile({
        archivePath: file,
        checksumContents: fs.readFileSync(checksumFile, "utf8"),
        ...targetParts(target),
      });
      fs.rmSync(path.dirname(addonPath), { recursive: true, force: true });
    } catch (error) {
      fail(`${path.basename(file)}: ${error.message}`);
    }
  }

  console.log(`Prebuild release assets verified: ${requiredTargets.join(", ")}`);
}

main().catch((error) => fail(error.message || String(error)));
