"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const tar = require("tar");

const moduleName = "webrtc_node.node";
const maxArchiveBytes = 64 * 1024 * 1024;
const maxAddonBytes = 128 * 1024 * 1024;

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function checksumFileName(archiveName) {
  return `${archiveName}.sha256`;
}

function checksumFileContents(archiveName, digest) {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("invalid SHA-256 digest");
  return `${digest}  ${archiveName}\n`;
}

function parseChecksumFile(contents, archiveName) {
  if (Buffer.byteLength(contents, "utf8") > 4096) throw new Error("checksum file is too large");
  const lines = contents.trimEnd().split(/\r?\n/);
  if (lines.length !== 1) throw new Error("checksum file must contain exactly one entry");
  const match = /^([a-fA-F0-9]{64}) {2}([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(lines[0]);
  if (!match) throw new Error("checksum file has an invalid format");
  if (match[2] !== archiveName) throw new Error(`checksum file names unexpected asset ${match[2]}`);
  return match[1].toLowerCase();
}

function verifyArchiveChecksum(archiveBuffer, checksumContents, archiveName) {
  if (archiveBuffer.length === 0) throw new Error("prebuild archive is empty");
  if (archiveBuffer.length > maxArchiveBytes) throw new Error("prebuild archive is too large");
  const expected = Buffer.from(parseChecksumFile(checksumContents, archiveName), "hex");
  const actual = Buffer.from(sha256(archiveBuffer), "hex");
  if (!crypto.timingSafeEqual(actual, expected)) throw new Error("prebuild SHA-256 mismatch");
}

function expectedBinary(platform, arch, libcTag) {
  if (platform === "linux" && arch === "x64") {
    if (libcTag !== "glibc" && libcTag !== "musl") {
      throw new Error(`unsupported Linux libc target ${libcTag || "unknown"}`);
    }
    return { format: "ELF", machine: 62, libcTag };
  }
  if (platform === "win32" && arch === "x64") {
    return { format: "PE", machine: 0x8664 };
  }
  if (platform === "win32" && arch === "arm64") {
    return { format: "PE", machine: 0xaa64 };
  }
  if (platform === "darwin" && arch === "x64") {
    return { format: "Mach-O", machine: 0x01000007 };
  }
  if (platform === "darwin" && arch === "arm64") {
    return { format: "Mach-O", machine: 0x0100000c };
  }
  throw new Error(`unsupported prebuild target ${platform}-${arch}`);
}

function readBinaryIdentity(buffer) {
  if (buffer.length >= 20 && buffer.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    if (buffer[4] !== 2) throw new Error("prebuild ELF binary is not 64-bit");
    const byteOrder = buffer[5];
    if (byteOrder !== 1 && byteOrder !== 2) throw new Error("prebuild ELF byte order is invalid");
    return {
      format: "ELF",
      machine: byteOrder === 1 ? buffer.readUInt16LE(18) : buffer.readUInt16BE(18),
    };
  }

  if (buffer.length >= 64 && buffer.subarray(0, 2).toString("ascii") === "MZ") {
    const headerOffset = buffer.readUInt32LE(0x3c);
    if (
      headerOffset > buffer.length - 6 ||
      !buffer.subarray(headerOffset, headerOffset + 4).equals(Buffer.from("PE\0\0", "binary"))
    ) {
      throw new Error("prebuild PE header is invalid");
    }
    return { format: "PE", machine: buffer.readUInt16LE(headerOffset + 4) };
  }

  if (buffer.length >= 8 && buffer.subarray(0, 4).equals(Buffer.from([0xcf, 0xfa, 0xed, 0xfe]))) {
    return { format: "Mach-O", machine: buffer.readUInt32LE(4) };
  }

  throw new Error("prebuild binary format is not recognized");
}

function verifyBinaryTarget(buffer, platform, arch, libcTag = null) {
  if (buffer.length === 0) throw new Error("prebuild addon is empty");
  if (buffer.length > maxAddonBytes) throw new Error("prebuild addon is too large");
  const expected = expectedBinary(platform, arch, libcTag);
  const actual = readBinaryIdentity(buffer);
  if (actual.format !== expected.format || actual.machine !== expected.machine) {
    throw new Error(
      `prebuild binary target mismatch: expected ${platform}-${arch}, found ${actual.format} machine 0x${actual.machine.toString(16)}`,
    );
  }
  if (expected.libcTag === "glibc" && !buffer.includes(Buffer.from("libc.so.6"))) {
    throw new Error("prebuild binary target mismatch: expected glibc linkage");
  }
  if (expected.libcTag === "musl" && !buffer.includes(Buffer.from("libc.musl-x86_64.so.1"))) {
    throw new Error("prebuild binary target mismatch: expected musl linkage");
  }
}

async function inspectArchive(archivePath) {
  const entries = [];
  let validationError = null;
  await tar.t({
    file: archivePath,
    strict: true,
    onReadEntry(entry) {
      const archiveEntry = {
        path: entry.path,
        size: entry.size,
        type: entry.type,
      };
      entries.push(archiveEntry);
      const invalidEntry =
        entries.length > 1 ||
        archiveEntry.path !== moduleName ||
        archiveEntry.type !== "File" ||
        !Number.isSafeInteger(archiveEntry.size) ||
        archiveEntry.size <= 0 ||
        archiveEntry.size > maxAddonBytes;
      if (!validationError && invalidEntry) {
        validationError = new Error(
          `prebuild archive contains invalid entry ${archiveEntry.path} (${archiveEntry.type})`,
        );
      }
      entry.resume();
    },
  });

  if (validationError) throw validationError;
  if (entries.length !== 1) {
    throw new Error(`prebuild archive must contain exactly ${moduleName}`);
  }
  const [entry] = entries;
  if (entry.path !== moduleName || entry.type !== "File") {
    throw new Error(`prebuild archive contains unexpected entry ${entry.path} (${entry.type})`);
  }
  if (!Number.isSafeInteger(entry.size) || entry.size <= 0 || entry.size > maxAddonBytes) {
    throw new Error("prebuild archive addon size is invalid");
  }
  return entry;
}

async function validateArchiveFile({
  archivePath,
  checksumContents,
  archiveName = path.basename(archivePath),
  platform,
  arch,
  libcTag = null,
}) {
  const archiveBuffer = fs.readFileSync(archivePath);
  verifyArchiveChecksum(archiveBuffer, checksumContents, archiveName);
  const entry = await inspectArchive(archivePath);
  const extractionRoot = fs.mkdtempSync(path.join(path.dirname(archivePath), ".verified-"));

  try {
    await tar.x({
      file: archivePath,
      cwd: extractionRoot,
      strict: true,
      filter(entryPath, tarEntry) {
        return entryPath === moduleName && tarEntry.type === "File";
      },
    });
    const addonPath = path.join(extractionRoot, moduleName);
    const stat = fs.lstatSync(addonPath);
    if (!stat.isFile() || stat.size !== entry.size) {
      throw new Error("extracted prebuild addon does not match the archive entry");
    }
    verifyBinaryTarget(fs.readFileSync(addonPath), platform, arch, libcTag);
    return addonPath;
  } catch (error) {
    fs.rmSync(extractionRoot, { recursive: true, force: true });
    throw error;
  }
}

async function installArchive(options) {
  const addonPath = await validateArchiveFile(options);
  const extractionRoot = path.dirname(addonPath);
  const destinationPath = options.destinationPath;
  const temporaryPath = `${destinationPath}.verified-${process.pid}`;

  try {
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    fs.copyFileSync(addonPath, temporaryPath);
    fs.rmSync(destinationPath, { force: true });
    fs.renameSync(temporaryPath, destinationPath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
    fs.rmSync(extractionRoot, { recursive: true, force: true });
  }
}

function writeChecksumFile(archivePath) {
  const archiveName = path.basename(archivePath);
  const digest = sha256(fs.readFileSync(archivePath));
  const checksumPath = `${archivePath}.sha256`;
  fs.writeFileSync(checksumPath, checksumFileContents(archiveName, digest), "utf8");
  return checksumPath;
}

module.exports = {
  checksumFileContents,
  checksumFileName,
  installArchive,
  maxArchiveBytes,
  moduleName,
  parseChecksumFile,
  sha256,
  validateArchiveFile,
  verifyArchiveChecksum,
  verifyBinaryTarget,
  writeChecksumFile,
};
