import fs = require("node:fs");
import path = require("node:path");

import { currentTarget, platformPackageName } from "./target";

// Compiled to dist/native, two levels below the package root.
const root = path.resolve(__dirname, "..", "..");
const moduleName = "webrtc_node.node";
const { version } = require("../../package.json") as { version: string };

function localBuildCandidates(): string[] {
  return [
    path.join(root, "build", "Release", moduleName),
    path.join(root, "build", "Debug", moduleName),
  ];
}

// The prebuilt binary comes from the optional dependency matching this platform.
function platformPackageCandidate(name: string): string | null {
  let manifest: string;
  try {
    manifest = require.resolve(`${name}/package.json`, { paths: [root] });
  } catch {
    return null;
  }
  const installed = (require(manifest) as { version: string }).version;
  if (installed !== version) {
    throw new Error(
      `${name}@${installed} does not match @webrtc-node/webrtc@${version}. ` +
        "Reinstall so both packages have the same version.",
    );
  }
  return path.join(path.dirname(manifest), moduleName);
}

// Loads the first native addon found; see docs/development.md for the order.
export function loadNative(): unknown {
  const target = currentTarget();
  const packageName = platformPackageName(target);
  const override = process.env.WEBRTC_NODE_NATIVE_PATH;
  const candidates = [
    ...(override ? [path.resolve(override)] : []),
    ...localBuildCandidates(),
    platformPackageCandidate(packageName),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    try {
      return require(candidate);
    } catch (error) {
      (error as Error).message =
        `Failed to load native addon at ${candidate}: ${(error as Error).message}`;
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
