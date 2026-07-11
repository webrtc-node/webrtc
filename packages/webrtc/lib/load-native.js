"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const moduleName = "webrtc_node.node";

function existing(file) {
  return fs.existsSync(file) ? file : null;
}

function localBuildCandidates() {
  return [
    path.join(root, "build", "Release", moduleName),
    path.join(root, "build", "Debug", moduleName),
  ];
}

function loadNative() {
  const override = process.env.WEBRTC_NODE_NATIVE_PATH;
  const candidates = [...(override ? [path.resolve(override)] : []), ...localBuildCandidates()];

  for (const candidate of candidates) {
    if (!existing(candidate)) continue;
    try {
      return require(candidate);
    } catch (error) {
      error.message = `Failed to load native addon at ${candidate}: ${error.message}`;
      throw error;
    }
  }

  const searched = candidates.map((candidate) => `  - ${candidate}`).join("\n");
  throw new Error(
    `Native addon not found for ${process.platform}-${process.arch}.\n` +
      `Searched:\n${searched}\n` +
      'Install a package with a matching prebuild or run "npm run build".',
  );
}

module.exports = loadNative();
