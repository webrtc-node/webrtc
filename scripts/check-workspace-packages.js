"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const workspacePattern = "packages/*";
const rootPackageName = "webrtc-node-workspace";
const runtimePackageName = "@webrtc-node/webrtc";
const allowedWorkspacePackages = new Map([
  ["webrtc", runtimePackageName],
  ["media", "@webrtc-node/media"],
  ["stats", "@webrtc-node/stats"],
  ["native", "@webrtc-node/native"],
  ["test-utils", "@webrtc-node/test-utils"],
]);
const requiredRootScripts = [
  "build",
  "check",
  "native:check",
  "test",
  "api:check",
  "types:check",
  "wpt:selection:check",
  "wpt:smoke",
  "wpt:smoke:check",
  "workspace:check",
];
const requiredRuntimePackageEntries = [
  "lib",
  "scripts/install-native.js",
  "scripts/prebuild-integrity.js",
  "src/native/addon.cc",
  "src/native/certificate.cc",
  "src/native/certificate.hpp",
  "CMakeLists.txt",
  "index.d.ts",
];
const requiredRuntimePackageFiles = [
  "lib/index.js",
  "lib/load-native.js",
  "scripts/install-native.js",
  "scripts/prebuild-integrity.js",
  "src/native/addon.cc",
  "src/native/certificate.cc",
  "src/native/certificate.hpp",
  "CMakeLists.txt",
  "index.d.ts",
  "README.md",
  "LICENSE",
];
const requiredRuntimeScripts = [
  "build",
  "check",
  "native:check",
  "test",
  "api:check",
  "types:check",
  "prebuild:package",
  "prebuild:check",
];
const requiredWorkspaceScripts = ["build", "check", "test", "types:check"];

function fail(message) {
  console.error(`Workspace package check failed: ${message}`);
  process.exit(1);
}

function readJson(relativePath) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
  } catch (error) {
    fail(`could not read ${relativePath}: ${error.message}`);
  }
}

function sameArray(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") fail(`${label} must be a non-empty string`);
}

function requireScript(packageJson, scriptName, label) {
  if (typeof packageJson.scripts?.[scriptName] !== "string") {
    fail(`${label} is missing script ${scriptName}`);
  }
}

function validateRootPackage(packageJson) {
  if (packageJson.name !== rootPackageName) {
    fail(`root package name must be ${rootPackageName}`);
  }
  if (packageJson.private !== true) {
    fail("root workspace package must be private");
  }
  if (!sameArray(packageJson.workspaces, [workspacePattern])) {
    fail(`package.json workspaces must be exactly ["${workspacePattern}"]`);
  }
  if (packageJson.dependencies) {
    fail("root workspace must not own runtime dependencies");
  }
  for (const scriptName of requiredRootScripts) {
    requireScript(packageJson, scriptName, "root package");
  }
}

function validateLockfile(packageLock) {
  if (packageLock.name !== rootPackageName) {
    fail(`package-lock.json package name must be ${rootPackageName}`);
  }
  const lockRoot = packageLock.packages?.[""];
  if (!lockRoot) fail("package-lock.json is missing the root package entry");
  if (!sameArray(lockRoot.workspaces, [workspacePattern])) {
    fail(`package-lock.json root workspaces must be exactly ["${workspacePattern}"]`);
  }
  const runtimeLock = packageLock.packages?.["packages/webrtc"];
  if (!runtimeLock) fail("package-lock.json is missing packages/webrtc");
  if (runtimeLock.name !== runtimePackageName) {
    fail(`package-lock.json packages/webrtc name must be ${runtimePackageName}`);
  }
}

function validateRuntimePackage(packageJson) {
  if (packageJson.name !== runtimePackageName) {
    fail(`packages/webrtc package name must remain ${runtimePackageName}`);
  }
  if (packageJson.private === true) {
    fail(`${runtimePackageName} must remain publishable`);
  }
  if (packageJson.main !== "lib/index.js") fail(`${runtimePackageName} main must be lib/index.js`);
  if (packageJson.types !== "index.d.ts") fail(`${runtimePackageName} types must be index.d.ts`);
  if (packageJson.scripts?.install !== "node scripts/install-native.js") {
    fail(
      `${runtimePackageName} install script must preserve native prebuild/source-build behavior`,
    );
  }
  for (const scriptName of requiredRuntimeScripts) {
    requireScript(packageJson, scriptName, runtimePackageName);
  }
  for (const entry of requiredRuntimePackageEntries) {
    if (!packageJson.files?.includes(entry)) {
      fail(`${runtimePackageName} files list is missing ${entry}`);
    }
  }
  for (const file of requiredRuntimePackageFiles) {
    if (!fs.existsSync(path.join(root, "packages", "webrtc", file))) {
      fail(`${runtimePackageName} file is missing packages/webrtc/${file}`);
    }
  }
}

function validateWorkspacePackage(dirname, packageJson) {
  const expectedName = allowedWorkspacePackages.get(dirname);
  if (!expectedName) {
    fail(`packages/${dirname} is not an approved workspace package`);
  }
  if (packageJson.name !== expectedName) {
    fail(`packages/${dirname}/package.json name must be ${expectedName}`);
  }
  requireString(packageJson.description, `${expectedName} description`);
  if (packageJson.license !== "MPL-2.0") fail(`${expectedName} must use MPL-2.0`);
  if (!packageJson.repository?.url) fail(`${expectedName} must declare repository metadata`);
  if (!packageJson.main && !packageJson.exports) {
    fail(`${expectedName} must declare main or exports`);
  }
  for (const scriptName of requiredWorkspaceScripts) {
    requireScript(packageJson, scriptName, expectedName);
  }
  const readmePath = path.join(root, "packages", dirname, "README.md");
  if (!fs.existsSync(readmePath)) {
    fail(`${expectedName} must document scope and non-goals in packages/${dirname}/README.md`);
  }
}

function workspacePackageDirs() {
  const packagesDir = path.join(root, "packages");
  if (!fs.existsSync(packagesDir)) return [];
  return fs
    .readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

const packageJson = readJson("package.json");
const packageLock = readJson("package-lock.json");

validateRootPackage(packageJson);
validateLockfile(packageLock);

const packageDirs = workspacePackageDirs();
if (!packageDirs.includes("webrtc")) fail("packages/webrtc is required");

for (const dirname of packageDirs) {
  const packagePath = path.join("packages", dirname, "package.json");
  if (!fs.existsSync(path.join(root, packagePath))) {
    fail(`packages/${dirname} exists without a package.json`);
  }
  const workspacePackage = readJson(packagePath);
  validateWorkspacePackage(dirname, workspacePackage);
  if (dirname === "webrtc") validateRuntimePackage(workspacePackage);
}

console.log(
  `Workspace packages verified: root ${rootPackageName} plus ${packageDirs.length} child package(s)`,
);
