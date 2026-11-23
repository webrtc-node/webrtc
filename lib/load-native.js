"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { currentTarget, platformPackageName } = require("./native-target");

const root = path.resolve(__dirname, "..");
const moduleName = "webrtc_node.node";
const { version } = require("../package.json");

function localBuildCandidates() {
  return [
    path.join(root, "build", "Release", moduleName),
    path.join(root, "build", "Debug", moduleName),
  ];
}

// The prebuilt binary comes from the optional dependency matching this platform.
function platformPackageCandidate(name) {
  let manifest;
  try {
    manifest = require.resolve(`${name}/package.json`, { paths: [root] });
  } catch {
    return null;
  }
  const installed = require(manifest).version;
  if (installed !== version) {
    throw new Error(
      `${name}@${installed} does not match @webrtc-node/webrtc@${version}. ` +
        "Reinstall so both packages have the same version.",
    );
  }
  return path.join(path.dirname(manifest), moduleName);
}

function loadNative() {
  const target = currentTarget();
  const packageName = platformPackageName(target);
  const override = process.env.WEBRTC_NODE_NATIVE_PATH;
  const candidates = [
    ...(override ? [path.resolve(override)] : []),
    ...localBuildCandidates(),
    platformPackageCandidate(packageName),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    try {
      return require(candidate);
    } catch (error) {
      error.message = `Failed to load native addon at ${candidate}: ${error.message}`;
      throw error;
    }
  }

  const searched = candidates.map((candidate) => `  - ${candidate}`).join("\n");
  throw new Error(
    `No native addon found for ${target}.\n` +
      `Searched:\n${searched}\n` +
      `The prebuilt binary is the optional dependency ${packageName}. Make sure your ` +
      "package manager installs optional dependencies (do not use --omit=optional or " +
      "--no-optional). For other platforms, build from a source checkout and set " +
      "WEBRTC_NODE_NATIVE_PATH; see docs/development.md.",
  );
}

module.exports = loadNative();
