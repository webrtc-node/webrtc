"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const libc = require("detect-libc");
const {
  checksumFileName,
  installArchive,
  maxArchiveBytes,
  moduleName,
} = require("./prebuild-integrity");

const root = path.resolve(__dirname, "..");
const packageJson = require("../package.json");
const releaseBaseUrl = "https://github.com/mertushka/webrtc-node/releases/download";

function envFlag(name) {
  return /^(1|true|yes)$/i.test(String(process.env[name] || ""));
}

function isSourceCheckout() {
  return fs.existsSync(path.join(root, ".git")) && !root.split(path.sep).includes("node_modules");
}

function hasNativeAddon() {
  try {
    require("../lib/load-native");
    return true;
  } catch {
    return false;
  }
}

function linuxLibcTag() {
  if (process.platform !== "linux") return null;
  const family = libc.familySync();
  if (family === libc.MUSL) return "musl";
  if (family === libc.GLIBC) return "glibc";
  return null;
}

function targetTuple() {
  return [process.platform, process.arch, linuxLibcTag()].filter(Boolean).join("-");
}

function releaseTag() {
  return process.env.WEBRTC_NODE_PREBUILD_TAG || `v${packageJson.version}`;
}

function prebuildAssetName() {
  return `webrtc-node-${releaseTag()}-napi-v8-${targetTuple()}.tar.gz`;
}

async function download(url, maximumBytes, label) {
  const response = await fetch(url, {
    headers: { "user-agent": "webrtc-node-install" },
  });
  if (!response.ok) {
    throw new Error(`${label} download failed: HTTP ${response.status} ${response.statusText}`);
  }
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    throw new Error(`${label} exceeds the maximum allowed size`);
  }
  if (!response.body) throw new Error(`${label} response body is unavailable`);
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > maximumBytes) throw new Error(`${label} exceeds the maximum allowed size`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, totalBytes);
}

async function downloadPrebuild() {
  const archiveName = prebuildAssetName();
  const checksumName = checksumFileName(archiveName);
  const baseUrl = `${releaseBaseUrl}/${releaseTag()}`;
  const checksumBuffer = await download(`${baseUrl}/${checksumName}`, 4096, "checksum");
  const archiveBuffer = await download(`${baseUrl}/${archiveName}`, maxArchiveBytes, "prebuild");
  const outputDir = path.join(root, "build", "Release");
  fs.mkdirSync(outputDir, { recursive: true });
  const downloadDir = fs.mkdtempSync(path.join(outputDir, ".download-"));
  const archivePath = path.join(downloadDir, archiveName);

  try {
    fs.writeFileSync(archivePath, archiveBuffer);
    await installArchive({
      archivePath,
      checksumContents: checksumBuffer.toString("utf8"),
      archiveName,
      platform: process.platform,
      arch: process.arch,
      libcTag: linuxLibcTag(),
      destinationPath: path.join(outputDir, moduleName),
    });
  } finally {
    fs.rmSync(downloadDir, { recursive: true, force: true });
  }
}

function runBuild() {
  const npm = process.env.npm_execpath
    ? process.execPath
    : process.platform === "win32"
      ? "npm.cmd"
      : "npm";
  const args = process.env.npm_execpath
    ? [process.env.npm_execpath, "run", "build"]
    : ["run", "build"];
  const result = spawnSync(npm, args, {
    cwd: root,
    stdio: "inherit",
  });
  return result.status === 0 && !result.signal;
}

async function main() {
  const buildFromSource = envFlag("npm_config_build_from_source");
  const prebuildOnly = envFlag("WEBRTC_NODE_PREBUILD_ONLY");
  if (!buildFromSource && hasNativeAddon()) return;

  if (isSourceCheckout() && !buildFromSource) {
    console.log("Skipping native install in source checkout. Run npm run build explicitly.");
    return;
  }

  if (!buildFromSource) {
    try {
      await downloadPrebuild();
      if (hasNativeAddon()) return;
      throw new Error(`downloaded archive did not provide ${moduleName}`);
    } catch (error) {
      console.warn(`Prebuilt binary unavailable for ${targetTuple()}: ${error.message}`);
      if (prebuildOnly) {
        console.error("Prebuild-only install requested; refusing to build from source.");
        process.exit(1);
      }
    }
  }

  if (!runBuild()) {
    console.error("No compatible prebuilt binary was found and the cmake-js source build failed.");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
