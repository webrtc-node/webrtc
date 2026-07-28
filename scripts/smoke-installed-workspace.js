"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const { spawnSync } = require("node:child_process");

const requireInstalled = createRequire(path.join(process.cwd(), "package.json"));
const packageName = "@webrtc-node/webrtc";
const commonJs = requireInstalled(packageName);
const metadata = requireInstalled(`${packageName}/package.json`);
const { nonstandard, RTCPeerConnection } = commonJs;
const { EncodedMediaSource } = nonstandard;

function verifyModuleFormats() {
  const probe = `
    import webrtc, { RTCPeerConnection } from ${JSON.stringify(packageName)};
    import { createRequire } from "node:module";
    const require = createRequire(import.meta.url);
    const commonJs = require(${JSON.stringify(packageName)});
    if (webrtc !== commonJs) throw new Error("default ESM export does not share the CJS runtime");
    if (RTCPeerConnection !== commonJs.RTCPeerConnection) {
      throw new Error("named ESM exports do not share CJS constructor identity");
    }
    const pc = new RTCPeerConnection();
    pc.close();
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", probe], {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `Packed ESM/CJS probe failed:\n${result.stdout || ""}${result.stderr || ""}`.trim(),
    );
  }
}

function verifyTypeScriptFormats() {
  const fixtureDirectory = fs.mkdtempSync(path.join(process.cwd(), ".webrtc-node-types-"));
  const commonJsFixture = path.join(fixtureDirectory, "consumer.cts");
  const esModuleFixture = path.join(fixtureDirectory, "consumer.mts");
  fs.writeFileSync(
    commonJsFixture,
    `
      import { RTCPeerConnection, type RTCStatsReport } from ${JSON.stringify(packageName)};
      const peer = new RTCPeerConnection();
      const report: Promise<RTCStatsReport> = peer.getStats();
      void report;
    `,
  );
  fs.writeFileSync(
    esModuleFixture,
    `
      import webrtc, { RTCPeerConnection } from ${JSON.stringify(packageName)};
      const namedPeer = new RTCPeerConnection();
      const defaultPeer = new webrtc.RTCPeerConnection();
      const identity: typeof RTCPeerConnection = webrtc.RTCPeerConnection;
      void namedPeer;
      void defaultPeer;
      void identity;
    `,
  );

  try {
    const typeScript = require.resolve("typescript/bin/tsc");
    const result = spawnSync(
      process.execPath,
      [
        typeScript,
        "--noEmit",
        "--strict",
        "--target",
        "ES2022",
        "--module",
        "Node16",
        "--moduleResolution",
        "Node16",
        "--lib",
        "ES2022,DOM",
        commonJsFixture,
        esModuleFixture,
      ],
      {
        cwd: process.cwd(),
        env: process.env,
        encoding: "utf8",
      },
    );
    if (result.status !== 0) {
      throw new Error(
        `Packed TypeScript probe failed:\n${result.stdout || ""}${result.stderr || ""}`.trim(),
      );
    }
  } finally {
    fs.rmSync(fixtureDirectory, { recursive: true, force: true });
  }
}

async function main() {
  if (metadata.name !== packageName) throw new Error("packed package identity mismatch");
  verifyModuleFormats();
  verifyTypeScriptFormats();
  const peer = new RTCPeerConnection();
  const source = new EncodedMediaSource({
    kind: "video",
    codec: { mimeType: "video/VP8", payloadType: 96 },
  });
  try {
    const sender = peer.addTrack(source.track);
    if (sender.track !== source.track) throw new Error("packed encoded track identity mismatch");
    const report = await peer.getStats();
    if (!report.has("peer-connection")) {
      throw new Error("packed core report is missing peer-connection stats");
    }
    console.log(
      "Packed @webrtc-node/webrtc passed CJS, ESM, TypeScript, encoded media, and stats smoke",
    );
  } finally {
    source.close();
    peer.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
