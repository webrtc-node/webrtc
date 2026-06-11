"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const tls = require("node:tls");
const { spawnSync } = require("node:child_process");
const { RTCPeerConnection } = require("..");

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "webrtc-node-tls-"));
const keyPath = path.join(temporaryDirectory, "key.pem");
const certificatePath = path.join(temporaryDirectory, "certificate.pem");

function fail(message) {
  throw new Error(message);
}

function generateCertificate() {
  const result = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certificatePath,
      "-subj",
      "/CN=localhost",
      "-days",
      "1",
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    fail(result.stderr || result.error?.message || "OpenSSL certificate generation failed");
  }
}

function waitForEcho(socket, expected) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${expected}`)), 5000);
    socket.once("data", (data) => {
      clearTimeout(timeout);
      const actual = data.toString("utf8");
      if (actual !== expected) {
        reject(new Error(`Expected TLS echo ${expected}, received ${actual}`));
        return;
      }
      resolve();
    });
    socket.write(expected);
  });
}

async function main() {
  generateCertificate();
  const server = tls.createServer(
    {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certificatePath),
    },
    (socket) => socket.on("data", (data) => socket.write(data)),
  );
  let socket;
  let peerConnection;

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    const address = server.address();
    if (!address || typeof address === "string") fail("TLS server address is unavailable");

    socket = tls.connect({
      host: "127.0.0.1",
      port: address.port,
      ca: fs.readFileSync(certificatePath),
      servername: "localhost",
    });
    await new Promise((resolve, reject) => {
      socket.once("secureConnect", resolve);
      socket.once("error", reject);
    });

    await waitForEcho(socket, "before-peer");
    peerConnection = new RTCPeerConnection();
    peerConnection.createDataChannel("tls-coexistence");
    await waitForEcho(socket, "after-peer");

    console.log("Node TLS connection survived libdatachannel initialization.");
  } finally {
    peerConnection?.close();
    socket?.destroy();
    if (server.listening) {
      await new Promise((resolve) => server.close(resolve));
    }
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));
