"use strict";

// Publishes the platform packages under npm-packages/ and then the main
// package, so the main package never points at a missing binary.
//
//   node scripts/publish-npm.js [--tag=latest] [--dry-run [--ignore-mismatch]]
//
// Run `platform-packages.js pack` and `link` first. A version already on the
// registry is skipped when its tarball matches the local one and is an error
// when it differs, so a failed release can be rerun without republishing.
// Every package is checked before anything is published. --ignore-mismatch
// turns a mismatch into a warning for dry runs of an already released version.

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { parseArgs } = require("node:util");

const root = path.resolve(__dirname, "..");
const { values } = parseArgs({
  options: {
    "dry-run": { type: "boolean", default: false },
    "ignore-mismatch": { type: "boolean", default: false },
    tag: { type: "string", default: "latest" },
    packages: { type: "string", default: path.join(root, "npm-packages") },
    registry: { type: "string", default: "https://registry.npmjs.org" },
  },
});
const dryRun = values["dry-run"];
if (values["ignore-mismatch"] && !dryRun) throw new Error("--ignore-mismatch requires --dry-run");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function runNpm(args, options = {}) {
  return execFileSync(npm, args, {
    cwd: root,
    encoding: "utf8",
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "inherit"],
    ...options,
  });
}

function localShasum(directory) {
  // Scripts are skipped so lifecycle output cannot mix into the JSON; the
  // release job has already built dist/.
  const [entry] = JSON.parse(
    runNpm(["pack", directory, "--dry-run", "--json", "--ignore-scripts"]),
  );
  return entry.shasum;
}

async function remoteShasum(name, version) {
  const url = `${values.registry}/${encodeURIComponent(name)}/${version}`;
  const response = await fetch(url);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`${name}@${version}: registry returned ${response.status}`);
  return (await response.json()).dist.shasum;
}

async function main() {
  const platformDirectories = fs
    .readdirSync(path.resolve(values.packages), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(path.resolve(values.packages), entry.name))
    .sort();
  if (platformDirectories.length === 0) throw new Error(`no packages under ${values.packages}`);
  const rootManifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  if (!rootManifest.optionalDependencies) {
    throw new Error("package.json has no optionalDependencies; run platform-packages.js link");
  }

  const plan = [];
  for (const directory of [...platformDirectories, root]) {
    const { name, version } = JSON.parse(
      fs.readFileSync(path.join(directory, "package.json"), "utf8"),
    );
    const local = localShasum(directory);
    const remote = await remoteShasum(name, version);
    if (remote !== null && remote !== local) {
      if (values["ignore-mismatch"]) {
        console.warn(`${name}@${version} differs from the registry; ignored for this dry run`);
      } else {
        throw new Error(
          `${name}@${version} is already published with different contents ` +
            `(registry ${remote}, local ${local}); inspect it before retrying`,
        );
      }
    }
    plan.push({
      directory,
      name,
      version,
      published: remote !== null,
      identical: remote === local,
    });
  }

  for (const { directory, name, version, published, identical } of plan) {
    if (published) {
      const contents = identical ? "identical" : "different";
      console.log(`${name}@${version} is already published with ${contents} contents; skipping`);
      continue;
    }
    const args = ["publish", directory, "--access", "public", "--tag", values.tag];
    if (dryRun) args.push("--dry-run");
    else args.push("--provenance");
    runNpm(args, { stdio: "inherit" });
    console.log(`${dryRun ? "Would publish" : "Published"} ${name}@${version}`);
  }
}

main().catch((error) => {
  console.error(`npm publish failed: ${error.message}`);
  process.exit(1);
});
