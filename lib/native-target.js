"use strict";

const libc = require("detect-libc");

// Every target with a prebuilt binary. Each one is published as its own npm
// package that declares os, cpu, and libc, so package managers install only
// the matching binary and no install script is needed.
const PREBUILT_TARGETS = [
  { target: "linux-x64-glibc", os: "linux", cpu: "x64", libc: "glibc" },
  { target: "linux-x64-musl", os: "linux", cpu: "x64", libc: "musl" },
  { target: "linux-arm64-glibc", os: "linux", cpu: "arm64", libc: "glibc" },
  { target: "linux-arm64-musl", os: "linux", cpu: "arm64", libc: "musl" },
  { target: "darwin-x64", os: "darwin", cpu: "x64" },
  { target: "darwin-arm64", os: "darwin", cpu: "arm64" },
  { target: "win32-x64", os: "win32", cpu: "x64" },
  { target: "win32-arm64", os: "win32", cpu: "arm64" },
];

function linuxLibc() {
  if (process.platform !== "linux") return null;
  const family = libc.familySync();
  if (family === libc.MUSL) return "musl";
  if (family === libc.GLIBC) return "glibc";
  return null;
}

function currentTarget() {
  return [process.platform, process.arch, linuxLibc()].filter(Boolean).join("-");
}

function platformPackageName(target) {
  return `@webrtc-node/webrtc-${target}`;
}

module.exports = { PREBUILT_TARGETS, currentTarget, linuxLibc, platformPackageName };
