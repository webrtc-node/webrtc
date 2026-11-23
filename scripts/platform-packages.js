"use strict";

// Turns validated prebuild archives into one npm package per target, and links
// the main package to them as exact-version optional dependencies.
//
//   node scripts/platform-packages.js pack [--target=win32-x64] [--out=npm-packages]
//   node scripts/platform-packages.js link
//
// The release workflow runs `pack`, publishes every package under the output
// directory, then runs `link` before publishing the main package. `link` edits
// package.json, so it runs only in the release checkout.

const fs = require("node:fs");
const path = require("node:path");
const { parseArgs } = require("node:util");
const { PREBUILT_TARGETS, platformPackageName } = require("../lib/native-target");
const { moduleName, validateArchiveFile } = require("./prebuild-integrity");

const root = path.resolve(__dirname, "..");
const packageJsonPath = path.join(root, "package.json");
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    artifacts: { type: "string", default: path.join(root, "prebuild-artifacts") },
    out: { type: "string", default: path.join(root, "npm-packages") },
    target: { type: "string" },
  },
});

function archiveName(target) {
  return `webrtc-node-v${packageJson.version}-napi-v8-${target}.tar.gz`;
}

function platformManifest({ target, os, cpu, libc }) {
  return {
    name: platformPackageName(target),
    version: packageJson.version,
    description: `Prebuilt ${target} native addon for @webrtc-node/webrtc`,
    license: packageJson.license,
    homepage: packageJson.homepage,
    repository: packageJson.repository,
    bugs: packageJson.bugs,
    os: [os],
    cpu: [cpu],
    ...(libc ? { libc: [libc] } : {}),
    main: moduleName,
    files: [moduleName],
    engines: packageJson.engines,
  };
}

async function pack() {
  const targets = PREBUILT_TARGETS.filter(
    ({ target }) => !values.target || target === values.target,
  );
  if (targets.length === 0) throw new Error(`unknown target ${values.target}`);
  const out = path.resolve(values.out);
  for (const entry of targets) {
    const archivePath = path.join(path.resolve(values.artifacts), archiveName(entry.target));
    const [platform, arch, libcTag] = entry.target.split("-");
    const addonPath = await validateArchiveFile({
      archivePath,
      archiveName: archiveName(entry.target),
      checksumContents: fs.readFileSync(`${archivePath}.sha256`, "utf8"),
      platform,
      arch,
      libcTag: libcTag || null,
    });
    const directory = path.join(out, entry.target);
    fs.rmSync(directory, { recursive: true, force: true });
    fs.mkdirSync(directory, { recursive: true });
    fs.copyFileSync(addonPath, path.join(directory, moduleName));
    fs.rmSync(path.dirname(addonPath), { recursive: true, force: true });
    fs.copyFileSync(path.join(root, "LICENSE"), path.join(directory, "LICENSE"));
    fs.writeFileSync(
      path.join(directory, "package.json"),
      `${JSON.stringify(platformManifest(entry), null, 2)}\n`,
    );
    fs.writeFileSync(
      path.join(directory, "README.md"),
      `# ${platformPackageName(entry.target)}\n\n` +
        `The prebuilt ${entry.target} native addon for ` +
        "[@webrtc-node/webrtc](https://www.npmjs.com/package/@webrtc-node/webrtc). " +
        "Install `@webrtc-node/webrtc` instead; it selects this package automatically.\n",
    );
    console.log(`Prepared ${platformPackageName(entry.target)}@${packageJson.version}`);
  }
}

function link() {
  packageJson.optionalDependencies = Object.fromEntries(
    PREBUILT_TARGETS.map(({ target }) => [platformPackageName(target), packageJson.version]),
  );
  fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
  console.log(`Linked ${PREBUILT_TARGETS.length} platform packages at ${packageJson.version}`);
}

const command = positionals[0];
if (command === "pack") {
  pack().catch((error) => {
    console.error(`Platform packaging failed: ${error.message}`);
    process.exit(1);
  });
} else if (command === "link") {
  link();
} else {
  console.error("Usage: node scripts/platform-packages.js <pack|link> [options]");
  process.exit(1);
}
