"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const addonPath = path.join(root, "src", "native", "addon.cc");
const cmakePath = path.join(root, "CMakeLists.txt");
const manifestPath = path.join(root, "wpt-manifest.json");

const addon = fs.readFileSync(addonPath, "utf8");
const cmake = fs.readFileSync(cmakePath, "utf8");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

function fail(message) {
  console.error(`Native integration check failed: ${message}`);
  process.exit(1);
}

function requireMatch(name, value, pattern) {
  if (!pattern.test(value)) fail(`${name} is missing`);
}

function forbidMatch(name, value, pattern) {
  const match = pattern.exec(value);
  if (match) fail(`${name} is forbidden: ${match[0]}`);
}

requireMatch("Node-API include", addon, /#include\s+<napi\.h>/);
requireMatch("Node-API module initializer", addon, /\bNODE_API_MODULE\s*\(/);
forbidMatch("direct V8 namespace usage", addon, /\bv8::/);
forbidMatch("direct V8 include", addon, /#include\s+[<"]v8(?:-[^>"]+)?\.h[>"]/);
forbidMatch("direct Node addon include", addon, /#include\s+[<"]node(?:_object_wrap)?\.h[>"]/);
forbidMatch("NAN include", addon, /#include\s+[<"]nan\.h[>"]/);
forbidMatch("NAN namespace usage", addon, /\bNan::/);
forbidMatch("non-Node-API module initializer", addon, /\bNODE_MODULE\s*\(/);
forbidMatch("direct addon OpenSSL include", addon, /#include\s+[<"]openssl\//);

requireMatch("ThreadSafeFunction creation", addon, /Napi::ThreadSafeFunction::New/);
requireMatch("nonblocking callback dispatch", addon, /\.NonBlockingCall\s*\(/);
requireMatch("dispatcher release", addon, /\.Release\s*\(/);

const cmakePinMatch = /set\s*\(\s*LIBDATACHANNEL_PINNED_COMMIT\s+"([0-9a-f]{40})"/i.exec(cmake);
if (!cmakePinMatch) fail("CMake libdatachannel pin is missing");
const cmakePin = cmakePinMatch[1];
if (cmakePin !== manifest.libdatachannelCommit) {
  fail(
    `CMake libdatachannel pin ${cmakePin} does not match manifest ${manifest.libdatachannelCommit}`,
  );
}

const cmakeRepositoryMatch = /set\s*\(\s*LIBDATACHANNEL_REPOSITORY\s+"([^"]+)"/i.exec(cmake);
if (!cmakeRepositoryMatch) fail("CMake libdatachannel repository is missing");
const cmakeRepository = cmakeRepositoryMatch[1];
if (cmakeRepository !== manifest.libdatachannelRepository) {
  fail(
    `CMake libdatachannel repository ${cmakeRepository} does not match manifest ${manifest.libdatachannelRepository}`,
  );
}

requireMatch(
  "FetchContent libdatachannel fallback",
  cmake,
  /FetchContent_Declare\s*\(\s*libdatachannel_pinned[\s\S]*GIT_TAG\s+"\$\{LIBDATACHANNEL_PINNED_COMMIT\}"/,
);
requireMatch(
  "local checkout pin verification",
  cmake,
  /verify_libdatachannel_pin\s*\(\s*"\$\{LIBDATACHANNEL_RESOLVED_SOURCE_DIR\}"\s*\)/,
);
requireMatch(
  "NO_MEDIA scoped build",
  cmake,
  /set\s*\(\s*NO_MEDIA\s+ON\s+CACHE\s+BOOL\s+""\s+FORCE\s*\)/,
);
requireMatch(
  "NO_WEBSOCKET scoped build",
  cmake,
  /set\s*\(\s*NO_WEBSOCKET\s+ON\s+CACHE\s+BOOL\s+""\s+FORCE\s*\)/,
);
requireMatch("Node-API version definition", cmake, /NAPI_VERSION=\$\{WEBRTC_NODE_NAPI_VERSION\}/);
requireMatch("static libdatachannel target", cmake, /LibDataChannel::LibDataChannelStatic/);

const localLibDataChannel = path.join(root, "libdatachannel");
if (fs.existsSync(path.join(localLibDataChannel, ".git"))) {
  const git = spawnSync("git", ["-C", localLibDataChannel, "rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  });
  if (git.status !== 0)
    fail(`could not read local libdatachannel commit: ${git.stderr || git.error?.message}`);
  const actual = git.stdout.trim();
  if (actual !== cmakePin) {
    fail(`local libdatachannel checkout is ${actual}, expected ${cmakePin}`);
  }
}

console.log(
  `Native integration verified: Node-API-only addon, TSFN dispatch, libdatachannel ${cmakeRepository}@${cmakePin}`,
);
