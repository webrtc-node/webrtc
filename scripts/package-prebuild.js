"use strict";

const fs = require("node:fs");
const path = require("node:path");
const libc = require("detect-libc");
const tar = require("tar");
const { moduleName, writeChecksumFile } = require("./prebuild-integrity");

const root = path.resolve(__dirname, "..");
const packageJson = require("../package.json");

function option(name, defaultValue = undefined) {
  const prefix = `--${name}=`;
  const arg = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return arg
    ? arg.slice(prefix.length)
    : process.env[`PREBUILD_${name.toUpperCase()}`] || defaultValue;
}

function fail(message) {
  console.error(`Prebuild package failed: ${message}`);
  process.exit(1);
}

function detectLibcTag(platform) {
  if (platform !== "linux") return null;
  const family = libc.familySync();
  if (family === libc.MUSL) return "musl";
  if (family === libc.GLIBC) return "glibc";
  return option("libc", null);
}

const platform = option("platform", process.platform);
const arch = option("arch", process.arch);
const libcTag = option("libc", detectLibcTag(platform));
const source = path.resolve(option("source", path.join(root, "build", "Release", moduleName)));
const releaseTag = option("tag", `v${packageJson.version}`);

async function main() {
  if (!fs.existsSync(source)) fail(`native addon not found at ${source}`);

  const tuple = [platform, arch, libcTag].filter(Boolean).join("-");
  const artifactDir = path.join(root, "prebuild-artifacts");
  const stagingDir = path.join(artifactDir, tuple);
  const archiveName = `webrtc-node-${releaseTag}-napi-v8-${tuple}.tar.gz`;
  const archivePath = path.join(artifactDir, archiveName);

  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.mkdirSync(stagingDir, { recursive: true });
  fs.copyFileSync(source, path.join(stagingDir, moduleName));

  await tar.c({ gzip: true, file: archivePath, cwd: stagingDir }, [moduleName]);
  fs.rmSync(stagingDir, { recursive: true, force: true });
  const checksumPath = writeChecksumFile(archivePath);

  console.log(`Packaged ${path.relative(root, archivePath).replace(/\\/g, "/")}`);
  console.log(`Checksummed ${path.relative(root, checksumPath).replace(/\\/g, "/")}`);
}

main().catch((error) => fail(error.message || String(error)));
