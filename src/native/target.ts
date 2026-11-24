import * as libc from "detect-libc";

export type LinuxLibc = "glibc" | "musl";

export interface PrebuiltTarget {
  target: string;
  os: NodeJS.Platform;
  cpu: NodeJS.Architecture;
  libc?: LinuxLibc;
}

// Every target with a prebuilt binary. Each one is published as its own npm
// package that declares os, cpu, and libc, so package managers install only
// the matching binary and no install script is needed.
export const PREBUILT_TARGETS: readonly PrebuiltTarget[] = [
  { target: "linux-x64-glibc", os: "linux", cpu: "x64", libc: "glibc" },
  { target: "linux-x64-musl", os: "linux", cpu: "x64", libc: "musl" },
  { target: "linux-arm64-glibc", os: "linux", cpu: "arm64", libc: "glibc" },
  { target: "linux-arm64-musl", os: "linux", cpu: "arm64", libc: "musl" },
  { target: "darwin-x64", os: "darwin", cpu: "x64" },
  { target: "darwin-arm64", os: "darwin", cpu: "arm64" },
  { target: "win32-x64", os: "win32", cpu: "x64" },
  { target: "win32-arm64", os: "win32", cpu: "arm64" },
];

export function linuxLibc(): LinuxLibc | null {
  if (process.platform !== "linux") return null;
  const family = libc.familySync();
  if (family === libc.MUSL) return "musl";
  if (family === libc.GLIBC) return "glibc";
  return null;
}

export function currentTarget(): string {
  return [process.platform, process.arch, linuxLibc()].filter(Boolean).join("-");
}

export function platformPackageName(target: string): string {
  return `@webrtc-node/webrtc-${target}`;
}
