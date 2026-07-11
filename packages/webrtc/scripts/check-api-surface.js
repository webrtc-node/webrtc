"use strict";

const fs = require("node:fs");
const path = require("node:path");
const api = require("..");

const root = path.resolve(__dirname, "..");
const declarations = fs.readFileSync(path.join(root, "index.d.ts"), "utf8");

function fail(message) {
  console.error(`API surface check failed: ${message}`);
  process.exit(1);
}

function parseDeclaredClasses(source) {
  const classes = new Map();
  const pattern = /^export class (\w+)(?:[^{]*)\{\n([\s\S]*?)^}/gm;
  let match;
  while ((match = pattern.exec(source))) {
    const [, name, body] = match;
    const staticMembers = new Set();
    const instanceMembers = new Set();
    let skippingSignature = false;
    for (const rawLine of body.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (skippingSignature) {
        if (line.endsWith(";")) skippingSignature = false;
        continue;
      }
      if (!line) continue;
      if (line.startsWith("constructor(")) {
        if (!line.endsWith(";")) skippingSignature = true;
        continue;
      }
      if (line.endsWith(",")) continue;
      let memberMatch = /^static\s+(\w+)\s*\(/.exec(line);
      if (memberMatch) {
        staticMembers.add(memberMatch[1]);
        if (!line.endsWith(";")) skippingSignature = true;
        continue;
      }
      memberMatch = /^(?:readonly\s+)?(\w+)\s*(?:\(|:)/.exec(line);
      if (memberMatch) {
        instanceMembers.add(memberMatch[1]);
        if (line.includes("(") && !line.endsWith(";")) skippingSignature = true;
      }
    }
    classes.set(name, { staticMembers, instanceMembers });
  }
  return classes;
}

function parseNonstandardNamespace(source) {
  const namespaceMatch = /^export namespace nonstandard \{\n([\s\S]*?)^}/m.exec(source);
  if (!namespaceMatch) return new Set();
  const members = new Set();
  for (const rawLine of namespaceMatch[1].split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = /^const\s+(\w+)\s*:/.exec(line);
    if (match) members.add(match[1]);
  }
  return members;
}

function createInstances() {
  const peerConnection = new api.RTCPeerConnection();
  const channel = peerConnection.createDataChannel("surface-check");
  const candidate = new api.RTCIceCandidate({ sdpMid: "0" });
  const candidatePair = Object.assign(Object.create(api.RTCIceCandidatePair.prototype), {
    local: candidate,
    remote: candidate,
  });
  const iceTransport = Object.assign(Object.create(api.RTCIceTransport.prototype), {
    onstatechange: null,
    ongatheringstatechange: null,
    onselectedcandidatepairchange: null,
  });
  const dtlsTransport = Object.assign(Object.create(api.RTCDtlsTransport.prototype), {
    iceTransport,
    onstatechange: null,
    onerror: null,
  });
  const sctpTransport = Object.assign(Object.create(api.RTCSctpTransport.prototype), {
    onstatechange: null,
  });
  const instances = {
    Event: new api.Event("surface-check"),
    MessageEvent: new api.MessageEvent("message", { data: "surface-check" }),
    EventTarget: new api.EventTarget(),
    RTCSessionDescription: new api.RTCSessionDescription({ type: "offer", sdp: "v=0\r\n" }),
    RTCIceCandidate: candidate,
    RTCIceCandidatePair: candidatePair,
    RTCCertificate: new api.RTCCertificate(),
    RTCDataChannel: channel,
    RTCDataChannelEvent: new api.RTCDataChannelEvent("datachannel", { channel }),
    RTCPeerConnectionIceEvent: new api.RTCPeerConnectionIceEvent("icecandidate"),
    RTCPeerConnectionIceErrorEvent: new api.RTCPeerConnectionIceErrorEvent("icecandidateerror"),
    RTCError: new api.RTCError({ errorDetail: "data-channel-failure" }),
    RTCErrorEvent: new api.RTCErrorEvent("error"),
    RTCDtlsTransport: dtlsTransport,
    RTCIceTransport: iceTransport,
    RTCSctpTransport: sctpTransport,
    RTCPeerConnection: peerConnection,
  };
  return { instances, cleanup: () => peerConnection.close() };
}

const declaredClasses = parseDeclaredClasses(declarations);
const declaredNonstandardMembers = parseNonstandardNamespace(declarations);
const declaredExports = new Set([...declaredClasses.keys(), "nonstandard"]);
const runtimeExports = new Set(Object.keys(api));

for (const name of declaredExports) {
  if (!runtimeExports.has(name)) fail(`declared export ${name} is missing at runtime`);
}

for (const name of runtimeExports) {
  if (!declaredExports.has(name)) fail(`runtime export ${name} is missing from index.d.ts`);
}

const { instances, cleanup } = createInstances();
try {
  for (const [className, members] of declaredClasses) {
    const ctor = api[className];
    if (typeof ctor !== "function") fail(`${className} is not a constructor at runtime`);
    for (const member of members.staticMembers) {
      if (!(member in ctor)) fail(`${className}.${member} is declared but missing at runtime`);
    }
    const instance = instances[className];
    if (!instance) fail(`no runtime sample for ${className}`);
    for (const member of members.instanceMembers) {
      if (!(member in instance)) fail(`${className}#${member} is declared but missing at runtime`);
    }
  }

  if (typeof api.nonstandard !== "object" || api.nonstandard === null) {
    fail("nonstandard namespace is missing at runtime");
  }
  for (const member of declaredNonstandardMembers) {
    if (!(member in api.nonstandard))
      fail(`nonstandard.${member} is declared but missing at runtime`);
  }
} finally {
  cleanup();
}

console.log(
  `API surface verified: ${declaredClasses.size} classes, ${declaredNonstandardMembers.size} nonstandard members`,
);
