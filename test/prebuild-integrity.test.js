"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const tar = require("tar");
const {
  checksumFileContents,
  installArchive,
  moduleName,
  parseChecksumFile,
  sha256,
  validateArchiveFile,
} = require("../scripts/prebuild-integrity");

function peBinary(machine) {
  const buffer = Buffer.alloc(256);
  buffer.write("MZ", 0, "ascii");
  buffer.writeUInt32LE(128, 0x3c);
  buffer.write("PE\0\0", 128, "binary");
  buffer.writeUInt16LE(machine, 132);
  return buffer;
}

function elfBinary(libcName) {
  const buffer = Buffer.alloc(256);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(buffer);
  buffer.writeUInt16LE(62, 18);
  buffer.write(libcName, 64, "ascii");
  return buffer;
}

function machOBinary(machine) {
  const buffer = Buffer.alloc(256);
  Buffer.from([0xcf, 0xfa, 0xed, 0xfe]).copy(buffer);
  buffer.writeUInt32LE(machine, 4);
  return buffer;
}

async function archiveFixture(t, binary, extraFiles = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "webrtc-node-prebuild-test-"));
  const staging = path.join(root, "staging");
  const archiveName = "webrtc-node-v0.0.0-napi-v8-win32-x64.tar.gz";
  const archivePath = path.join(root, archiveName);
  fs.mkdirSync(staging);
  fs.writeFileSync(path.join(staging, moduleName), binary);
  for (const [name, contents] of Object.entries(extraFiles)) {
    fs.writeFileSync(path.join(staging, name), contents);
  }
  await tar.c({ gzip: true, file: archivePath, cwd: staging }, fs.readdirSync(staging));
  const archiveBuffer = fs.readFileSync(archivePath);
  const checksumContents = checksumFileContents(archiveName, sha256(archiveBuffer));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { archiveName, archivePath, checksumContents, root };
}

test("prebuild validator accepts one checksummed target-matching addon", async (t) => {
  const fixture = await archiveFixture(t, peBinary(0x8664));
  const addonPath = await validateArchiveFile({
    ...fixture,
    platform: "win32",
    arch: "x64",
  });
  assert.deepEqual(fs.readFileSync(addonPath), peBinary(0x8664));
  fs.rmSync(path.dirname(addonPath), { recursive: true, force: true });
});

test("prebuild validator rejects checksum mismatches", async (t) => {
  const fixture = await archiveFixture(t, peBinary(0x8664));
  await assert.rejects(
    validateArchiveFile({
      ...fixture,
      checksumContents: checksumFileContents(fixture.archiveName, "0".repeat(64)),
      platform: "win32",
      arch: "x64",
    }),
    /SHA-256 mismatch/,
  );
});

test("checksum parser rejects a checksum for another release asset", () => {
  assert.throws(
    () =>
      parseChecksumFile(
        `${"a".repeat(64)}  webrtc-node-v0.0.0-napi-v8-linux-x64-glibc.tar.gz\n`,
        "webrtc-node-v0.0.0-napi-v8-win32-x64.tar.gz",
      ),
    /names unexpected asset/,
  );
});

test("checksum parser rejects multiple entries", () => {
  const archiveName = "webrtc-node-v0.0.0-napi-v8-win32-x64.tar.gz";
  const line = `${"a".repeat(64)}  ${archiveName}`;
  assert.throws(() => parseChecksumFile(`${line}\n${line}\n`, archiveName), /exactly one/);
});

test("prebuild validator rejects unexpected archive entries", async (t) => {
  const fixture = await archiveFixture(t, peBinary(0x8664), {
    "unexpected.dll": Buffer.from("unexpected"),
  });
  await assert.rejects(
    validateArchiveFile({
      ...fixture,
      platform: "win32",
      arch: "x64",
    }),
    /invalid entry|exactly webrtc_node\.node/,
  );
});

test("prebuild validator rejects a wrong-architecture addon", async (t) => {
  const fixture = await archiveFixture(t, peBinary(0xaa64));
  await assert.rejects(
    validateArchiveFile({
      ...fixture,
      platform: "win32",
      arch: "x64",
    }),
    /target mismatch/,
  );
});

test("prebuild validator distinguishes glibc and musl binaries", async (t) => {
  const glibc = await archiveFixture(t, elfBinary("libc.so.6"));
  const glibcAddon = await validateArchiveFile({
    ...glibc,
    platform: "linux",
    arch: "x64",
    libcTag: "glibc",
  });
  fs.rmSync(path.dirname(glibcAddon), { recursive: true, force: true });

  const musl = await archiveFixture(t, elfBinary("libc.musl-x86_64.so.1"));
  const muslAddon = await validateArchiveFile({
    ...musl,
    platform: "linux",
    arch: "x64",
    libcTag: "musl",
  });
  fs.rmSync(path.dirname(muslAddon), { recursive: true, force: true });

  await assert.rejects(
    validateArchiveFile({
      ...musl,
      platform: "linux",
      arch: "x64",
      libcTag: "glibc",
    }),
    /expected glibc linkage/,
  );
});

test("prebuild validator accepts supported macOS architectures", async (t) => {
  const x64 = await archiveFixture(t, machOBinary(0x01000007));
  const x64Addon = await validateArchiveFile({
    ...x64,
    platform: "darwin",
    arch: "x64",
  });
  fs.rmSync(path.dirname(x64Addon), { recursive: true, force: true });

  const arm64 = await archiveFixture(t, machOBinary(0x0100000c));
  const arm64Addon = await validateArchiveFile({
    ...arm64,
    platform: "darwin",
    arch: "arm64",
  });
  fs.rmSync(path.dirname(arm64Addon), { recursive: true, force: true });
});

test("failed validation does not replace an existing addon", async (t) => {
  const fixture = await archiveFixture(t, peBinary(0xaa64));
  const destinationPath = path.join(fixture.root, "installed", moduleName);
  fs.mkdirSync(path.dirname(destinationPath));
  fs.writeFileSync(destinationPath, "existing-addon");

  await assert.rejects(
    installArchive({
      ...fixture,
      platform: "win32",
      arch: "x64",
      destinationPath,
    }),
    /target mismatch/,
  );
  assert.equal(fs.readFileSync(destinationPath, "utf8"), "existing-addon");
});

test("validated installation replaces the addon and removes temporary files", async (t) => {
  const expected = peBinary(0x8664);
  const fixture = await archiveFixture(t, expected);
  const destinationPath = path.join(fixture.root, "installed", moduleName);
  fs.mkdirSync(path.dirname(destinationPath));
  fs.writeFileSync(destinationPath, "existing-addon");

  await installArchive({
    ...fixture,
    platform: "win32",
    arch: "x64",
    destinationPath,
  });

  assert.deepEqual(fs.readFileSync(destinationPath), expected);
  assert.deepEqual(
    fs.readdirSync(fixture.root).filter((name) => name.startsWith(".verified-")),
    [],
  );
  assert.deepEqual(
    fs
      .readdirSync(path.dirname(destinationPath))
      .filter((name) => name.startsWith(`${moduleName}.verified-`)),
    [],
  );
});
