"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const addonPath = path.join(root, "src", "native", "addon.cc");
const certificatePath = path.join(root, "src", "native", "certificate.cc");
const cmakePath = path.join(root, "CMakeLists.txt");
const manifestPath = path.join(root, "wpt-manifest.json");
const packagePath = path.join(root, "package.json");
const setupNativeBuildPath = path.join(
  root,
  ".github",
  "actions",
  "setup-native-build",
  "action.yml",
);
const ciWorkflowPath = path.join(root, ".github", "workflows", "ci.yml");
const codeqlWorkflowPath = path.join(root, ".github", "workflows", "codeql.yml");
const publishedInstallWorkflowPath = path.join(
  root,
  ".github",
  "workflows",
  "published-install.yml",
);
const releaseWorkflowPath = path.join(root, ".github", "workflows", "release.yml");
const prebuildCheckPath = path.join(root, "scripts", "check-prebuilds.js");
const vcpkgManifestPath = path.join(root, "vcpkg.json");

const addon = fs.readFileSync(addonPath, "utf8");
const certificate = fs.readFileSync(certificatePath, "utf8");
const cmake = fs.readFileSync(cmakePath, "utf8");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
const setupNativeBuild = fs.readFileSync(setupNativeBuildPath, "utf8");
const ciWorkflow = fs.readFileSync(ciWorkflowPath, "utf8");
const codeqlWorkflow = fs.readFileSync(codeqlWorkflowPath, "utf8");
const publishedInstallWorkflow = fs.readFileSync(publishedInstallWorkflowPath, "utf8");
const releaseWorkflow = fs.readFileSync(releaseWorkflowPath, "utf8");
const prebuildCheck = fs.readFileSync(prebuildCheckPath, "utf8");
const vcpkgManifest = JSON.parse(fs.readFileSync(vcpkgManifestPath, "utf8"));

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

requireMatch(
  "node-addon-api dependency",
  JSON.stringify(pkg.dependencies || {}),
  /"node-addon-api"\s*:/,
);
requireMatch(
  "detect-libc runtime dependency",
  JSON.stringify(pkg.dependencies || {}),
  /"detect-libc"\s*:/,
);
requireMatch(
  "cmake-js source-build dependency",
  JSON.stringify(pkg.dependencies || {}),
  /"cmake-js"\s*:/,
);
requireMatch("native install script", JSON.stringify(pkg.scripts || {}), /install-native\.js/);
requireMatch("prebuild package script", JSON.stringify(pkg.scripts || {}), /package-prebuild\.js/);
requireMatch("prebuild check script", JSON.stringify(pkg.scripts || {}), /check-prebuilds\.js/);
requireMatch(
  "prebuild symbol check script",
  JSON.stringify(pkg.scripts || {}),
  /check-linux-addon-symbols\.js/,
);
requireMatch(
  "TLS coexistence check script",
  JSON.stringify(pkg.scripts || {}),
  /check-tls-coexistence\.js/,
);
requireMatch("native <napi.h> include", addon, /#include\s+<napi\.h>/);
forbidMatch("direct addon OpenSSL include", addon, /#include\s+[<"]openssl\//);
requireMatch("isolated certificate OpenSSL include", certificate, /#include\s+<openssl\/evp\.h>/);
requireMatch("Node-API module initializer", addon, /\bNODE_API_MODULE\s*\(/);
requireMatch("ThreadSafeFunction dispatcher", addon, /Napi::ThreadSafeFunction::New/);
requireMatch("nonblocking callback dispatch", addon, /\.NonBlockingCall\s*\(/);
requireMatch("dispatcher release on close", addon, /\.Release\s*\(/);
requireMatch("weak callback captures", addon, /\[weak\]/);
requireMatch("peer callback reset", addon, /peerConnection->resetCallbacks\s*\(\)/);
requireMatch("channel callback reset", addon, /->resetCallbacks\s*\(\)/);
requireMatch(
  "closed channel map removal",
  addon,
  /void\s+RemoveChannel[\s\S]*channels\.erase\s*\(/,
);
requireMatch(
  "unsigned buffered amount threshold conversion",
  addon,
  /SetBufferedAmountLowThreshold[\s\S]*Uint32Value\s*\(\)/,
);
requireMatch(
  "nonzero channel id allocator",
  addon,
  /AllocateChannelId[\s\S]*while\s*\(\s*id\s*==\s*0\s*\)/,
);
requireMatch(
  "TURN username forwarding",
  addon,
  /iceServer\.username\s*=\s*server\.Get\("username"\)/,
);
requireMatch(
  "TURN credential forwarding",
  addon,
  /iceServer\.password\s*=\s*server\.Get\("credential"\)/,
);
forbidMatch("forced transport MTU", addon, /config\.mtu\s*=/);

forbidMatch("direct V8 namespace usage", addon, /\bv8::/);
forbidMatch("direct V8 include", addon, /#include\s+[<"]v8(?:-[^>"]+)?\.h[>"]/);
forbidMatch("direct Node addon include", addon, /#include\s+[<"]node(?:_object_wrap)?\.h[>"]/);
forbidMatch("NAN include", addon, /#include\s+[<"]nan\.h[>"]/);
forbidMatch("NAN namespace usage", addon, /\bNan::/);
forbidMatch("non-Node-API module initializer", addon, /\bNODE_MODULE\s*\(/);
forbidMatch(
  "signed buffered amount threshold conversion",
  addon,
  /SetBufferedAmountLowThreshold[\s\S]{0,300}Int64Value\s*\(\)/,
);

const callbackCallMatches = [...addon.matchAll(/\bcallback\.Call\s*\(/g)];
if (callbackCallMatches.length !== 3) {
  fail(
    `expected exactly three callback.Call sites inside EventDispatcher dispatch paths, found ${callbackCallMatches.length}`,
  );
}
requireMatch(
  "single native event callback dispatch",
  addon,
  /callback\.Call\s*\(\s*\{\s*EventToObject/,
);
requireMatch(
  "batched native event callback dispatch",
  addon,
  /callback\.Call\s*\(\s*\{\s*batch\s*\}\s*\)/,
);
requireMatch(
  "direct native event callback dispatch",
  addon,
  /DispatchDirect[\s\S]*callback\.Call\s*\(\s*\{\s*EventToObject/,
);

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
requireMatch("prebuild napi build version", cmake, /napi_build_version/);
requireMatch("release static OpenSSL option", cmake, /WEBRTC_NODE_STATIC_OPENSSL/);
requireMatch(
  "environment CMake toolchain forwarding",
  cmake,
  /ENV\{CMAKE_TOOLCHAIN_FILE\}[\s\S]*set\s*\(\s*CMAKE_TOOLCHAIN_FILE/,
);
requireMatch(
  "environment vcpkg triplet forwarding",
  cmake,
  /ENV\{VCPKG_TARGET_TRIPLET\}[\s\S]*set\s*\(\s*VCPKG_TARGET_TRIPLET/,
);
requireMatch(
  "environment vcpkg install directory forwarding",
  cmake,
  /ENV\{VCPKG_INSTALLED_DIR\}[\s\S]*set\s*\(\s*VCPKG_INSTALLED_DIR/,
);
requireMatch("Linux hidden symbol visibility", cmake, /-fvisibility=hidden/);
requireMatch("Linux hidden inline visibility", cmake, /-fvisibility-inlines-hidden/);
requireMatch("Linux static symbol hiding", cmake, /"LINKER:--exclude-libs,ALL"/);
requireMatch(
  "static certificate helper",
  cmake,
  /add_library\s*\(\s*webrtc_node_certificate\s+STATIC/,
);
requireMatch(
  "certificate helper OpenSSL linkage",
  cmake,
  /target_link_libraries\s*\(\s*webrtc_node_certificate\s+PRIVATE\s+OpenSSL::Crypto/,
);
requireMatch("node-addon-api include discovery", cmake, /require\('node-addon-api'\)\.include_dir/);
requireMatch("static libdatachannel target", cmake, /LibDataChannel::LibDataChannelStatic/);

if (!/^[0-9a-f]{40}$/.test(vcpkgManifest["builtin-baseline"] || "")) {
  fail("vcpkg builtin baseline must be a pinned 40-character commit");
}
const opensslDependency = (vcpkgManifest.dependencies || []).find(
  (dependency) =>
    dependency === "openssl" ||
    (dependency && typeof dependency === "object" && dependency.name === "openssl"),
);
if (!opensslDependency) fail("vcpkg OpenSSL dependency is missing");
if (
  typeof opensslDependency !== "object" ||
  !Array.isArray(opensslDependency.features) ||
  !opensslDependency.features.includes("tools")
) {
  fail("vcpkg OpenSSL tools feature is missing");
}
requireMatch("Windows x64 static vcpkg triplet", setupNativeBuild, /x64-windows-static/);
requireMatch("Windows ARM64 static vcpkg triplet", setupNativeBuild, /arm64-windows-static/);
requireMatch(
  "pinned vcpkg baseline checkout",
  setupNativeBuild,
  /git -C \$vcpkgRoot checkout --force \$baseline/,
);
requireMatch(
  "vcpkg manifest installation",
  setupNativeBuild,
  /vcpkg\.exe"\) install[\s\S]*--x-manifest-root=/,
);
forbidMatch("Chocolatey OpenSSL installation", setupNativeBuild, /choco install openssl/);
requireMatch("Windows ARM64 CI runner", ciWorkflow, /os:\s*windows-11-arm/);
requireMatch("stable required CI gate", ciWorkflow, /ci-required:[\s\S]*name:\s*CI required/);
requireMatch(
  "CodeQL JavaScript and TypeScript analysis",
  codeqlWorkflow,
  /languages:\s*javascript-typescript/,
);
requireMatch("CodeQL C++ analysis", codeqlWorkflow, /languages:\s*c-cpp/);
requireMatch("CodeQL manual native build", codeqlWorkflow, /build-mode:\s*manual/);
requireMatch("CodeQL native addon compilation", codeqlWorkflow, /npm run build/);
requireMatch("CodeQL security event permission", codeqlWorkflow, /security-events:\s*write/);
requireMatch(
  "release conformance gate",
  releaseWorkflow,
  /conformance-gate:[\s\S]*conformance\.yml\/runs/,
);
requireMatch(
  "release publication dependency on conformance",
  releaseWorkflow,
  /publish:[\s\S]*needs:[\s\S]*-\s*conformance-gate/,
);
requireMatch("Windows ARM64 release target", releaseWorkflow, /target:\s*win32-arm64/);
requireMatch("Windows ARM64 release runner", releaseWorkflow, /os:\s*windows-11-arm/);
requireMatch(
  "Windows static OpenSSL release build",
  releaseWorkflow,
  /prebuild-windows:[\s\S]*--CDWEBRTC_NODE_STATIC_OPENSSL=ON/,
);
forbidMatch("Windows release OpenSSL DLL collection", releaseWorkflow, /OPENSSL_BIN_DIR/);
requireMatch(
  "Windows ARM64 published install target",
  publishedInstallWorkflow,
  /target:\s*win32-arm64[\s\S]*os:\s*windows-11-arm/,
);
requireMatch("Windows ARM64 required prebuild", prebuildCheck, /"win32-arm64"/);

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
  `Native integration verified: Node-API addon, TSFN dispatch, libdatachannel ${cmakeRepository}@${cmakePin}`,
);
