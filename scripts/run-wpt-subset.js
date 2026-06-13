const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const vm = require("node:vm");
const webrtc = require("..");
const { ensureWpt } = require("./ensure-wpt");

const root = path.resolve(__dirname, "..");
const wptDir = path.resolve(process.env.WPT_DIR || path.join(root, "wpt"));
const workerSpecFile = process.env.WPT_WORKER_SPEC_FILE;
const workerResultsFile = process.env.WPT_WORKER_RESULTS;
const isWorker = Boolean(workerSpecFile);
const runInProcess = isWorker || process.env.WPT_IN_PROCESS === "1";
const cleanupDelayMs = Number(process.env.WPT_CLEANUP_DELAY_MS || 1000);
const testTimeoutMs = Number(process.env.WPT_TEST_TIMEOUT_MS || 120000);
const workerDelayMs = Number(process.env.WPT_WORKER_DELAY_MS || 200);
const workerRetries = Math.max(0, Number(process.env.WPT_WORKER_RETRIES || 0));
const workerTimeoutMs = Number(process.env.WPT_WORKER_TIMEOUT_MS || 300000);
const listTestsOnly = process.env.WPT_LIST_TESTS === "1";
const listTestIdentities = !isWorker && process.env.WPT_LIST_IDENTITIES === "1";
const shardCount = Number(process.env.WPT_SHARD_COUNT || 1);
const shardIndex = Number(process.env.WPT_SHARD_INDEX || 0);
const logPrefix = process.env.WPT_LOG_PREFIX || "";

if (!Number.isInteger(shardCount) || shardCount < 1) {
  throw new Error("WPT_SHARD_COUNT must be a positive integer");
}
if (!Number.isInteger(shardIndex) || shardIndex < 0 || shardIndex >= shardCount) {
  throw new Error("WPT_SHARD_INDEX must identify an existing shard");
}

if (!isWorker) ensureWpt({ quiet: true });

const { assignWptSpecGroups, shardForTest, validateWptSelectionTotal } = require("./wpt-sharding");

const perTestIsolatedFiles = new Set([
  "webrtc/RTCPeerConnection-createDataChannel.html",
  "webrtc/RTCIceTransport.html",
  "webrtc/RTCDataChannel-id.html",
  "webrtc/RTCDataChannel-send.html",
  "webrtc/RTCDataChannel-send-blob-order.html",
  "webrtc/RTCDataChannel-send-close-string.window.js",
  "webrtc/RTCDataChannel-send-close-string-negotiated.window.js",
  "webrtc/RTCDataChannel-send-close-array-buffer.window.js",
  "webrtc/RTCDataChannel-send-close-array-buffer-negotiated.window.js",
  "webrtc/RTCDataChannel-send-close-blob.window.js",
  "webrtc/RTCDataChannel-send-close-blob-negotiated.window.js",
  "webrtc/RTCDataChannel-bufferedAmount.html",
  "webrtc/RTCDataChannel-close.html",
  "webrtc/RTCDataChannel-GC.html",
  "webrtc/RTCSctpTransport-events.html",
  "webrtc/RTCSctpTransport-maxChannels.html",
  "webrtc/RTCPeerConnection-ondatachannel.html",
]);

const defaultSpecs = [
  { file: "webrtc/RTCPeerConnection-constructor.html" },
  { file: "webrtc/RTCError.html", search: "?interop-2026" },
  { file: "webrtc/RTCError.html", search: "?rest" },
  { file: "webrtc/RTCDataChannelEvent-constructor.html" },
  { file: "webrtc/RTCPeerConnectionIceEvent-constructor.html" },
  { file: "webrtc/RTCPeerConnectionIceErrorEvent.html" },
  { file: "webrtc/RTCIceCandidate-constructor.html" },
  { file: "webrtc/toJSON.html" },
  { file: "webrtc/RTCPeerConnection-plan-b-is-not-supported.html" },
  {
    file: "webrtc/historical.html",
    exclude: ["RTCRtpTransceiver member setDirection should not exist"],
  },
  { file: "webrtc/RTCPeerConnection-generateCertificate.html" },
  {
    file: "webrtc/RTCCertificate.html",
    exclude: ["all provided certificates"],
  },
  { file: "webrtc/RTCConfiguration-certificates.html" },
  { file: "webrtc/RTCConfiguration-validation.html" },
  { file: "webrtc/RTCConfiguration-iceCandidatePoolSize.html" },
  { file: "webrtc/RTCConfiguration-iceServers.html", search: "?rest" },
  { file: "webrtc/RTCConfiguration-iceServers.html", search: "?interop-2026" },
  {
    file: "webrtc/RTCConfiguration-bundlePolicy.html",
    exclude: ["should gather ICE candidates"],
  },
  {
    file: "webrtc/RTCConfiguration-rtcpMuxPolicy.html",
    exclude: ["setRemoteDescription throws"],
  },
  {
    file: "webrtc/RTCConfiguration-iceTransportPolicy.html",
    search: "?rest",
    exclude: ["prevent candidate gathering", "Changing iceTransportPolicy"],
  },
  { file: "webrtc/RTCConfiguration-iceTransportPolicy.html", search: "?interop-2026" },
  { file: "webrtc/RTCSctpTransport-constructor.html" },
  { file: "webrtc/RTCSctpTransport-events.html" },
  { file: "webrtc/RTCSctpTransport-maxChannels.html", search: "?interop-2026" },
  { file: "webrtc/RTCSctpTransport-maxChannels.html", search: "?rest" },
  { file: "webrtc/RTCSctpTransport-maxMessageSize.html" },
  {
    file: "webrtc/RTCIceTransport.html",
    search: "?rest",
    include: [
      "Two connected iceTransports should have matching local/remote candidates returned",
      "Unconnected iceTransport should have empty remote candidates and selected pair",
      'RTCIceTransport should transition to "disconnected" if packets stop flowing (DataChannel case)',
      "Local ICE restart should not result in a different ICE transport (DataChannel case)",
      "Remote ICE restart should not result in a different ICE transport (DataChannel case)",
    ],
  },
  { file: "webrtc/RTCDataChannelInit-maxRetransmits-enforce-range.html" },
  { file: "webrtc/RTCDataChannelInit-maxPacketLifeTime-enforce-range.html" },
  { file: "webrtc/RTCDataChannel-binaryType.window.js" },
  {
    file: "webrtc/RTCPeerConnection-createDataChannel.html",
    include: [
      "createDataChannel with no argument",
      "createDataChannel with closed connection",
      "createDataChannel attribute default values",
      "createDataChannel with provided parameters",
      "createDataChannel with label",
      "createDataChannel with ordered",
      "createDataChannel with maxPacketLifeTime 0",
      "createDataChannel with maxRetransmits 0",
      "createDataChannel with both maxPacketLifeTime",
      "createDataChannel with protocol",
      "createDataChannel with id 0 and negotiated true",
      "createDataChannel with id 1 and negotiated true",
      "createDataChannel with id 65534 and negotiated true",
      "createDataChannel with id -1",
      "createDataChannel with id 65535 should throw",
      "createDataChannel with id 65536",
      "createDataChannel with too long",
      "createDataChannel with same label",
      "createDataChannel with negotiated true and id should succeed",
      "createDataChannel with maximum length",
      "createDataChannel with negotiated false",
      "createDataChannel with negotiated true and id not defined",
      "Channels created (after SCTP connected) should have id assigned",
      "Reusing a data channel id that is in use should throw OperationError",
      "Reusing a data channel id that is in use (after setRemoteDescription) should throw OperationError",
      "Reusing a data channel id that is in use (after setRemoteDescription, negotiated via DCEP) should throw OperationError",
      "New datachannel should be in the connecting state after creation",
      "New negotiated datachannel should be in the connecting state after creation",
    ],
  },
  {
    file: "webrtc/RTCPeerConnection-createDataChannel.html",
    search: "?interop-2026",
    include: ["createDataChannel with id"],
  },
  { file: "webrtc/RTCDataChannel-id.html" },
  {
    file: "webrtc/RTCDataChannel-send.html",
    include: [
      "Calling send() when data channel is in connecting state should throw InvalidStateError",
      "should be able to send",
      "should ignore binaryType",
      "binaryType should receive",
      "sending multiple messages with different types",
      "Sending before the other side is open should work",
      "Sending in onopen should work",
      "Sending in ondatachannel should work",
    ],
    exclude: ["unordered mode works reliably"],
  },
  { file: "webrtc/RTCDataChannel-send-blob-order.html" },
  { file: "webrtc/RTCDataChannel-send-close-string.window.js" },
  { file: "webrtc/RTCDataChannel-send-close-string-negotiated.window.js" },
  { file: "webrtc/RTCDataChannel-send-close-array-buffer.window.js" },
  { file: "webrtc/RTCDataChannel-send-close-array-buffer-negotiated.window.js" },
  { file: "webrtc/RTCDataChannel-send-close-blob.window.js" },
  { file: "webrtc/RTCDataChannel-send-close-blob-negotiated.window.js" },
  {
    file: "webrtc/RTCDataChannel-bufferedAmount.html",
    include: [
      "initial value",
      "bufferedAmount should increase",
      "bufferedAmount should stay",
      "bufferedamount is data.length",
      "bufferedamount returns the same amount",
      "bufferedamountlow event fires",
      "not decrease immediately",
      "not decrease after closing",
    ],
  },
  { file: "webrtc/RTCDataChannel-close.html" },
  { file: "webrtc/RTCDataChannel-GC.html" },
  { file: "webrtc/RTCDataChannel-iceRestart.html" },
  { file: "webrtc/promises-call.html" },
  {
    file: "webrtc/RTCPeerConnection-restartIce.https.html",
    include: ["restartIce() has no effect on a closed peer connection"],
  },
  {
    file: "webrtc/RTCPeerConnection-createOffer.html",
    include: [
      "createOffer() returns RTCSessionDescriptionInit",
      "createOffer() and then setLocalDescription() should succeed",
      "createOffer() after connection is closed",
    ],
  },
  {
    file: "webrtc/RTCPeerConnection-createOffer.html",
    search: "?interop-2026",
    include: ["createOffer() should fail when signaling state is not stable or have-local-offer"],
  },
  {
    file: "webrtc/RTCPeerConnection-operations.https.html",
    search: "?interop-2026",
    include: [
      "createOffer must detect InvalidStateError synchronously",
      "createAnswer must detect InvalidStateError synchronously",
      "isOperationsChainEmpty detects empty in stable",
      "isOperationsChainEmpty detects empty in have-local-offer",
      "isOperationsChainEmpty detects empty in have-remote-offer",
      "createAnswer uses operations chain",
      "setLocalDescription uses operations chain",
      "setRemoteDescription uses operations chain",
    ],
  },
  {
    file: "webrtc/RTCPeerConnection-operations.https.html",
    include: [
      "SLD(rollback) must detect InvalidStateError synchronously",
      "addIceCandidate must detect InvalidStateError synchronously",
      "createOffer uses operations chain",
    ],
  },
  { file: "webrtc/RTCPeerConnection-createAnswer.html" },
  {
    file: "webrtc/RTCPeerConnection-setLocalDescription.html",
    include: [
      "Calling createOffer() and setLocalDescription() again after one round of local-offer/remote-answer should succeed",
      "onsignalingstatechange fires before setLocalDescription resolves",
    ],
  },
  {
    file: "webrtc/RTCPeerConnection-setLocalDescription-offer.html",
    include: [
      "setLocalDescription with valid offer should succeed",
      "setLocalDescription with type offer and null sdp should use lastOffer generated from createOffer",
    ],
  },
  {
    file: "webrtc/RTCPeerConnection-setLocalDescription-offer.html",
    search: "?interop-2026",
    include: [
      "setLocalDescription() with offer not created by own createOffer() should reject with InvalidModificationError",
    ],
  },
  {
    file: "webrtc/RTCPeerConnection-setLocalDescription-answer.html",
    include: [
      "setLocalDescription() with valid answer should succeed",
      "setLocalDescription() with type answer and null sdp should use lastAnswer generated from createAnswer",
      "setLocalDescription() with answer not created by own createAnswer() should reject with InvalidModificationError",
      "Calling setLocalDescription(answer) from stable state should reject with InvalidStateError",
      "Calling setLocalDescription(answer) from have-local-offer state should reject with InvalidStateError",
    ],
  },
  { file: "webrtc/RTCPeerConnection-setLocalDescription-pranswer.html" },
  {
    file: "webrtc/RTCPeerConnection-setLocalDescription-rollback.html",
    include: [
      "setLocalDescription(rollback) from have-local-offer state should reset back to stable state",
      "setLocalDescription(rollback) from stable state should reject with InvalidStateError",
      "setLocalDescription(rollback) after setting answer description should reject with InvalidStateError",
      "setLocalDescription(rollback) after setting a remote offer should reject with InvalidStateError",
      "setLocalDescription(rollback) should ignore invalid sdp content and succeed",
    ],
  },
  { file: "webrtc/RTCPeerConnection-description-attributes-timing.https.html" },
  {
    file: "webrtc/RTCPeerConnection-setLocalDescription-parameterless.https.html",
    include: [
      "Parameterless SLD() in 'stable' goes to 'have-local-offer'",
      "Parameterless SLD() in 'stable' sets pendingLocalDescription",
      "Parameterless SLD() in 'have-remote-offer' goes to 'stable'",
      "Parameterless SLD() in 'have-remote-offer' sets currentLocalDescription",
      "Parameterless SLD() uses [[LastCreatedOffer]] if it is still valid",
      "Parameterless SLD() uses [[LastCreatedAnswer]] if it is still valid",
      "Parameterless SLD() rejects with InvalidStateError if already closed",
      "Parameterless SLD() never settles if closed while pending",
      "Parameterless SLD() in a full O/A exchange succeeds",
      "Parameterless SRD() rejects with TypeError.",
    ],
  },
  {
    file: "webrtc/RTCPeerConnection-setLocalDescription-parameterless.https.html",
    search: "?interop-2026",
    include: ["RTCSessionDescription constructed without type throws TypeError"],
  },
  {
    file: "webrtc/RTCPeerConnection-setRemoteDescription.html",
    include: [
      "invalid type and invalid SDP",
      "invalid SDP and stable state",
      "Negotiation should fire signalingsstate events",
      "Switching role from offerer to answerer after going back to stable state should succeed",
      "Closing on setRemoteDescription() neither resolves nor rejects",
      "Closing on rollback neither resolves nor rejects",
    ],
  },
  {
    file: "webrtc/RTCPeerConnection-setRemoteDescription-offer.html",
    include: [
      "setRemoteDescription with valid offer should succeed",
      "setRemoteDescription multiple times should succeed",
      "setRemoteDescription(offer) with invalid SDP should reject with RTCError",
      "setRemoteDescription(offer) from have-local-offer should roll back and succeed",
      "Naive rollback approach is not glare-proof (control)",
      "setRemoteDescription(offer) from have-local-offer is glare-proof",
    ],
  },
  {
    file: "webrtc/RTCPeerConnection-setRemoteDescription-offer.html",
    search: "?interop-2026",
    include: ["setRemoteDescription(offer) from have-local-offer fires signalingstatechange twice"],
  },
  { file: "webrtc/RTCPeerConnection-setRemoteDescription-answer.html" },
  { file: "webrtc/RTCPeerConnection-setRemoteDescription-pranswer.html" },
  {
    file: "webrtc/RTCPeerConnection-setRemoteDescription-rollback.html",
    include: [
      "setRemoteDescription(rollback) in have-remote-offer state should revert to stable state",
      "setRemoteDescription(rollback) from stable state should reject with InvalidStateError",
      "setRemoteDescription(rollback) after setting a local offer should reject with InvalidStateError",
      "setRemoteDescription(rollback) should ignore invalid sdp content and succeed",
    ],
  },
  { file: "webrtc/RTCPeerConnection-addIceCandidate.html" },
  {
    file: "webrtc/RTCPeerConnection-addIceCandidate.html",
    search: "?interop-2026",
    include: [
      "addIceCandidate after close",
      "addIceCandidate should not recognize relayProtocol or url",
    ],
  },
  { file: "webrtc/RTCPeerConnection-canTrickleIceCandidates.html" },
  {
    file: "webrtc/RTCPeerConnection-iceGatheringState.html",
    include: [
      "Initial iceGatheringState should be new",
      "setLocalDescription() with no transports should not cause iceGatheringState to change",
    ],
  },
  {
    file: "webrtc/RTCPeerConnection-iceGatheringState.html",
    search: "?interop-2026",
    include: ["connection with one data channel should eventually have connected connection state"],
  },
  {
    file: "webrtc/RTCPeerConnection-explicit-rollback-iceGatheringState.html",
    include: [
      "rolling back an ICE restart when gathering is complete should not result in iceGatheringState changes (DataChannel case)",
      'setLocalDescription(rollback) of original offer should cause iceGatheringState to reach "new" when starting in "complete" (DataChannel case)',
      'setLocalDescription(rollback) of original offer should cause iceGatheringState to reach "new" when starting in "gathering" (DataChannel case)',
    ],
  },
  {
    file: "webrtc/RTCPeerConnection-iceConnectionState.https.html",
    include: [
      "Initial iceConnectionState should be new",
      "Closing the connection should set iceConnectionState to closed",
      "connection with one data channel should eventually have connected or completed connection state",
      "connection with one data channel should eventually have connected connection state",
    ],
  },
  {
    file: "webrtc/RTCPeerConnection-connectionState.https.html",
    include: [
      "Initial connectionState should be new",
      "Closing the connection should set connectionState to closed",
      "connection with one data channel should eventually have connected connection state",
      "connection with one data channel should eventually have transports in connected state",
    ],
  },
  { file: "webrtc/RTCPeerConnection-ondatachannel.html" },
  {
    file: "webrtc/RTCPeerConnection-onnegotiationneeded.html",
    include: [
      "Creating first data channel should fire negotiationneeded event",
      "calling createDataChannel twice should fire negotiationneeded event once",
    ],
  },
];

const specs = isWorker
  ? [JSON.parse(fs.readFileSync(workerSpecFile, "utf8"))]
  : process.argv.length > 2
    ? process.argv.slice(2).map(parseSpec)
    : defaultSpecs;
const results = [];
let streamedResults = false;

function parseSpec(value) {
  const [fileAndSearch, filter] = value.split("#", 2);
  const queryIndex = fileAndSearch.indexOf("?");
  const file = queryIndex === -1 ? fileAndSearch : fileAndSearch.slice(0, queryIndex);
  const search = queryIndex === -1 ? undefined : fileAndSearch.slice(queryIndex);
  if (filter) {
    return {
      file,
      search,
      include: [filter],
    };
  }

  return cloneDefaultSpecForExplicitFile(file, search) || { file, search };
}

function cloneDefaultSpecForExplicitFile(file, search) {
  const defaultSpec = defaultSpecs.find(
    (spec) => spec.file === file && (spec.search || undefined) === search,
  );
  if (!defaultSpec) return null;
  return {
    ...defaultSpec,
    include: defaultSpec.include ? [...defaultSpec.include] : undefined,
    includeExact: defaultSpec.includeExact ? [...defaultSpec.includeExact] : undefined,
    exclude: defaultSpec.exclude ? [...defaultSpec.exclude] : undefined,
  };
}

function extractScripts(relativePath) {
  if (relativePath.endsWith(".js")) {
    return extractJsScripts(relativePath);
  }

  const absolutePath = path.join(wptDir, relativePath);
  const html = fs.readFileSync(absolutePath, "utf8");
  const baseDir = path.dirname(relativePath);
  const scripts = [];
  const pattern = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = pattern.exec(html))) {
    const srcMatch = match[1].match(/\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i);
    if (srcMatch) {
      const src = srcMatch[1] || srcMatch[2] || srcMatch[3];
      if (/testharness(?:report)?\.js$/.test(src)) continue;
      const scriptPath = src.startsWith("/")
        ? src.slice(1)
        : path.join(baseDir, src).replace(/\\/g, "/");
      scripts.push(...extractJsScripts(scriptPath));
      continue;
    }
    scripts.push({ code: transformScriptSource(relativePath, match[2]), filename: relativePath });
  }
  return scripts;
}

function transformScriptSource(relativePath, code) {
  if (relativePath === "webrtc/RTCIceTransport.html") {
    // The pinned WPT revision has a typo in one legacy helper assertion:
    // RTCIceTransport.gatheringState is "complete", not "completed".
    return code.replace(
      "gatheringState === 'gathering' || gatheringState === 'completed'",
      "gatheringState === 'gathering' || gatheringState === 'complete'",
    );
  }
  return code;
}

function extractJsScripts(relativePath, seen = new Set()) {
  const normalizedPath = relativePath.replace(/\\/g, "/");
  if (seen.has(normalizedPath)) return [];
  seen.add(normalizedPath);

  const code = transformScriptSource(
    normalizedPath,
    fs.readFileSync(path.join(wptDir, normalizedPath), "utf8"),
  );
  const scripts = [];
  const baseDir = path.dirname(normalizedPath);
  const pattern = /^\s*\/\/\s*META:\s*script=(.+?)\s*$/gm;
  let match;
  while ((match = pattern.exec(code))) {
    const src = match[1].trim();
    if (/testharness(?:report)?\.js$/.test(src)) continue;
    const scriptPath = src.startsWith("/")
      ? src.slice(1)
      : path.join(baseDir, src).replace(/\\/g, "/");
    scripts.push(...extractJsScripts(scriptPath, seen));
  }
  scripts.push({ code, filename: normalizedPath });
  return scripts;
}

function sameException(error, ctor) {
  return error instanceof ctor || error?.name === ctor.name;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runGarbageCollection() {
  if (typeof global.gc !== "function") return;
  for (let index = 0; index < 2; ++index) global.gc();
}

function shouldRun(spec, name) {
  const includeExact = spec.includeExact || [];
  const includes = spec.include || [];
  const excludes = spec.exclude || [];
  if (includeExact.length && !includeExact.includes(name)) return false;
  if (
    !includeExact.length &&
    includes.length &&
    !includes.some((pattern) => name.includes(pattern))
  )
    return false;
  return !excludes.some((pattern) => name.includes(pattern));
}

class FileReaderShim extends webrtc.EventTarget {
  constructor() {
    super();
    this.result = null;
    this.error = null;
  }

  async readAsArrayBuffer(blob) {
    try {
      this.result = await blob.arrayBuffer();
      this.dispatchEvent({ type: "load" });
    } catch (error) {
      this.error = error;
      this.dispatchEvent({ type: "error" });
    }
  }
}

class EventWatcher {
  constructor(test, target, events) {
    this.target = target;
    this.events = Array.isArray(events) ? events : [events];
    this.queue = [];
    this.waiters = [];
    this.handlers = new Map();

    for (const type of this.events) {
      const handler = (event) => {
        this.queue.push(event);
        this.pump();
      };
      this.handlers.set(type, handler);
      this.target.addEventListener(type, handler);
    }

    if (test && typeof test.add_cleanup === "function") {
      test.add_cleanup(() => this.stop());
    }
  }

  wait_for(events) {
    const expected = Array.isArray(events) ? events : [events];
    return new Promise((resolve) => {
      this.waiters.push({ expected, resolve });
      this.pump();
    });
  }

  pump() {
    while (this.waiters.length) {
      const waiter = this.waiters[0];
      if (this.queue.length < waiter.expected.length) return;
      if (!waiter.expected.every((name, index) => this.queue[index].type === name)) return;
      const events = this.queue.splice(0, waiter.expected.length);
      this.waiters.shift();
      waiter.resolve(events[events.length - 1]);
    }
  }

  stop() {
    for (const [type, handler] of this.handlers) this.target.removeEventListener(type, handler);
    this.handlers.clear();
    this.waiters.length = 0;
    this.queue.length = 0;
  }
}

class Resolver extends Promise {
  constructor() {
    let resolve;
    let reject;
    super((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.resolve = resolve;
    this.reject = reject;
  }
}

async function runFile(spec) {
  const relativePath = spec.file;
  const resultPath = `${relativePath}${spec.search || ""}`;
  const pending = [];
  const selectedTests = [];
  const trackedPeerConnections = new Set();

  class HarnessRTCPeerConnection extends webrtc.RTCPeerConnection {
    constructor(...args) {
      super(...args);
      trackedPeerConnections.add(this);
    }

    close() {
      trackedPeerConnections.delete(this);
      return super.close();
    }
  }

  async function cleanupAfterTest(cleanups) {
    for (const cleanup of cleanups.splice(0).reverse()) {
      try {
        cleanup();
      } catch {
        // Keep focused WPT cleanup best-effort.
      }
    }
    for (const pc of Array.from(trackedPeerConnections)) {
      if (isRetainedByGlobal(pc)) continue;
      try {
        pc.close();
      } catch {
        // Keep harness auto-cleanup best-effort.
      }
    }
    runGarbageCollection();
    await delay(cleanupDelayMs);
  }

  function isRetainedByGlobal(pc) {
    return Object.values(sandbox).some((value) => value === pc);
  }

  async function cleanupAfterFile() {
    for (const pc of Array.from(trackedPeerConnections)) {
      try {
        pc.close();
      } catch {
        // Keep harness auto-cleanup best-effort.
      }
    }
    runGarbageCollection();
    await delay(cleanupDelayMs);
  }

  const documentElements = new Map();
  const documentShim = {
    getElementById(id) {
      const key = String(id);
      if (!documentElements.has(key)) {
        documentElements.set(key, { id: key, innerHTML: "" });
      }
      return documentElements.get(key);
    },
  };

  const sandbox = {
    ...webrtc,
    RTCPeerConnection: HarnessRTCPeerConnection,
    console,
    setTimeout,
    clearTimeout,
    Promise,
    TypeError,
    Error,
    Array,
    ArrayBuffer,
    Uint8Array,
    Int8Array,
    Int16Array,
    Int32Array,
    Uint16Array,
    Uint32Array,
    Uint8ClampedArray,
    Float32Array,
    Float64Array,
    DataView,
    Blob: globalThis.Blob,
    DOMException: globalThis.DOMException,
    gc: globalThis.gc,
    FileReader: FileReaderShim,
    EventWatcher,
    Resolver,
    structuredClone: globalThis.structuredClone,
    performance: globalThis.performance,
    TextDecoder: globalThis.TextDecoder,
    TextEncoder: globalThis.TextEncoder,
    JSON,
    Number,
    String,
    Boolean,
    document: documentShim,
    Math,
    RegExp,
    URL,
    URLSearchParams,
    location: { search: spec.search || "?rest" },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;

  sandbox.assert_equals = (actual, expected, message = "") => {
    if (!Object.is(actual, expected)) {
      throw new Error(`${message} expected ${expected}, got ${actual}`.trim());
    }
  };
  sandbox.assert_true = (actual, message = "") => {
    if (actual !== true) throw new Error(`${message} expected true, got ${actual}`.trim());
  };
  sandbox.assert_false = (actual, message = "") => {
    if (actual !== false) throw new Error(`${message} expected false, got ${actual}`.trim());
  };
  sandbox.assert_throws_js = (ctor, fn, message = "") => {
    try {
      fn();
    } catch (error) {
      if (sameException(error, ctor)) return;
      throw new Error(`${message} expected ${ctor.name}, got ${error?.name || error}`.trim());
    }
    throw new Error(`${message} expected ${ctor.name} to be thrown`.trim());
  };
  sandbox.assert_throws_dom = (name, fn, message = "") => {
    try {
      fn();
    } catch (error) {
      if (error?.name === name) return;
      throw new Error(`${message} expected ${name}, got ${error?.name || error}`.trim());
    }
    throw new Error(`${message} expected ${name} to be thrown`.trim());
  };
  sandbox.promise_rejects_dom = async (test, name, promise, message = "") => {
    try {
      await promise;
    } catch (error) {
      if (error?.name === name) return;
      throw new Error(`${message} expected ${name}, got ${error?.name || error}`.trim());
    }
    throw new Error(`${message} expected ${name} rejection`.trim());
  };
  sandbox.promise_rejects_js = async (test, ctor, promise, message = "") => {
    try {
      await promise;
    } catch (error) {
      if (sameException(error, ctor)) return;
      throw new Error(`${message} expected ${ctor.name}, got ${error?.name || error}`.trim());
    }
    throw new Error(`${message} expected ${ctor.name} rejection`.trim());
  };
  sandbox.assert_not_equals = (actual, expected, message = "") => {
    if (Object.is(actual, expected)) {
      throw new Error(`${message} expected values to differ`.trim());
    }
  };
  sandbox.assert_array_equals = (actual, expected, message = "") => {
    sandbox.assert_equals(actual.length, expected.length, `${message} length`);
    for (let i = 0; i < actual.length; ++i) {
      sandbox.assert_equals(actual[i], expected[i], `${message} index ${i}`);
    }
  };
  sandbox.assert_in_array = (actual, expected, message = "") => {
    if (!expected.includes(actual)) {
      throw new Error(`${message} expected ${actual} in ${expected.join(",")}`.trim());
    }
  };
  sandbox.assert_idl_attribute = (object, attribute, message = "") => {
    if (!(attribute in Object(object))) {
      throw new Error(`${message} expected ${attribute} IDL attribute`.trim());
    }
  };
  sandbox.assert_less_than = (actual, expected, message = "") => {
    if (!(actual < expected)) throw new Error(`${message} expected ${actual} < ${expected}`.trim());
  };
  sandbox.assert_less_than_equal = (actual, expected, message = "") => {
    if (!(actual <= expected))
      throw new Error(`${message} expected ${actual} <= ${expected}`.trim());
  };
  sandbox.assert_approx_equals = (actual, expected, epsilon, message = "") => {
    if (Math.abs(actual - expected) > epsilon) {
      throw new Error(`${message} expected ${actual} within ${epsilon} of ${expected}`.trim());
    }
  };
  sandbox.assert_greater_than = (actual, expected, message = "") => {
    if (!(actual > expected)) throw new Error(`${message} expected ${actual} > ${expected}`.trim());
  };
  sandbox.assert_greater_than_equal = (actual, expected, message = "") => {
    if (!(actual >= expected))
      throw new Error(`${message} expected ${actual} >= ${expected}`.trim());
  };
  sandbox.assert_unreached = (message = "unreached") => {
    throw new Error(message);
  };

  sandbox.test = (fn, name = "unnamed test") => {
    if (!shouldRun(spec, name)) return;
    selectedTests.push(name);
    if (listTestsOnly) return;
    pending.push(async () => {
      const cleanups = [];
      const t = makeTestContext(cleanups);
      try {
        fn(t);
        results.push({ file: resultPath, name, status: "PASS" });
      } catch (error) {
        results.push({ file: resultPath, name, status: "FAIL", message: error.message });
      } finally {
        await cleanupAfterTest(cleanups);
      }
    });
  };

  sandbox.promise_test = (fn, name = "unnamed promise_test") => {
    if (!shouldRun(spec, name)) return;
    selectedTests.push(name);
    if (listTestsOnly) return;
    pending.push(async () => {
      const cleanups = [];
      let rejectStepFailure;
      let stepFailureRecorded = false;
      const stepFailure = new Promise((_, reject) => {
        rejectStepFailure = reject;
      });
      const t = makeTestContext(cleanups, {
        fail: (error) => {
          if (stepFailureRecorded) return;
          stepFailureRecorded = true;
          rejectStepFailure(error instanceof Error ? error : new Error(String(error)));
        },
      });
      try {
        await withTimeout(
          Promise.race([Promise.resolve().then(() => fn(t)), stepFailure]),
          testTimeoutMs,
          name,
        );
        results.push({ file: resultPath, name, status: "PASS" });
      } catch (error) {
        results.push({ file: resultPath, name, status: "FAIL", message: error.message });
      } finally {
        await cleanupAfterTest(cleanups);
      }
    });
  };

  sandbox.async_test = (fn, name = "unnamed async_test") => {
    const body = typeof fn === "function" ? fn : null;
    const testName = typeof fn === "string" ? fn : name;
    if (!shouldRun(spec, testName)) return makeListOnlyTestContext();
    selectedTests.push(testName);
    if (listTestsOnly) return makeListOnlyTestContext();
    const cleanups = [];
    let settled = false;
    let resolveDone;
    let rejectDone;
    const donePromise = new Promise((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    const t = makeTestContext(cleanups, {
      done: () => settle(resolveDone),
      fail: (error) => settle(rejectDone, error),
    });
    pending.push(async () => {
      try {
        if (body) body(t);
        await withTimeout(donePromise, testTimeoutMs, testName);
        results.push({ file: resultPath, name: testName, status: "PASS" });
      } catch (error) {
        results.push({ file: resultPath, name: testName, status: "FAIL", message: error.message });
      } finally {
        await delay(cleanupDelayMs);
        await cleanupAfterTest(cleanups);
      }
    });
    return t;
  };

  const context = vm.createContext(sandbox);
  for (const script of extractScripts(relativePath)) {
    vm.runInContext(script.code, context, { filename: script.filename });
  }
  if (listTestsOnly) return selectedTests;
  for (const run of pending) {
    await run();
  }
  await cleanupAfterFile();
  return selectedTests;
}

function withTimeout(promise, timeout, name) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${name}`)), timeout);
    }),
  ]).finally(() => clearTimeout(timer));
}

function makeTestContext(cleanups, hooks = {}) {
  const fail =
    hooks.fail ||
    ((error) => {
      throw error;
    });
  const wrapStep =
    (fn, finish = false) =>
    (...args) => {
      try {
        const result = fn(...args);
        if (finish && typeof hooks.done === "function") hooks.done();
        return result;
      } catch (error) {
        fail(error);
        return undefined;
      }
    };
  return {
    add_cleanup: (cleanup) => cleanups.push(cleanup),
    step: (fn, thisArg = undefined, ...args) => wrapStep(fn).apply(thisArg, args),
    step_func: (fn) => wrapStep(fn),
    step_func_done: (fn = () => {}) => wrapStep(fn, true),
    unreached_func:
      (message = "unexpected callback") =>
      () => {
        fail(new Error(message));
      },
    step_timeout: (fn, timeout, ...args) =>
      setTimeout(() => {
        try {
          fn(...args);
        } catch (error) {
          fail(error);
        }
      }, timeout),
    done: () => {
      if (typeof hooks.done === "function") hooks.done();
    },
  };
}

function makeListOnlyTestContext() {
  return {
    add_cleanup: () => {},
    step: () => undefined,
    step_func: () => () => undefined,
    step_func_done: () => () => undefined,
    unreached_func: () => () => undefined,
    step_timeout: () => undefined,
    done: () => {},
    fail: () => {},
  };
}

function makeTempJsonPath(name) {
  const unique = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return path.join(os.tmpdir(), `webrtc-node-${name}-${unique}.json`);
}

async function runIsolated(specsToRun) {
  if (shardCount > 1) {
    await runSharded(specsToRun);
    return;
  }

  for (let index = 0; index < specsToRun.length; ++index) {
    const spec = specsToRun[index];
    if (perTestIsolatedFiles.has(spec.file)) {
      const tests = runListWorker(spec, index);
      if (tests.length === 0) continue;
      for (let testIndex = 0; testIndex < tests.length; ++testIndex) {
        runSpecWorker(
          {
            ...spec,
            include: undefined,
            includeExact: [tests[testIndex]],
          },
          `${index}-${testIndex}`,
        );
        await delay(workerDelayMs);
      }
    } else {
      runSpecWorker(spec, String(index));
      await delay(workerDelayMs);
    }
  }
}

async function runSharded(specsToRun) {
  const unshardedEnv = {
    WPT_SHARD_COUNT: "1",
    WPT_SHARD_INDEX: "0",
  };
  const discoveries = specsToRun.map((spec, index) => ({
    spec,
    index,
    ...discoverSpecTests(spec, index, unshardedEnv),
  }));
  const initialLoads = Array.from({ length: shardCount }, () => 0);
  const specGroups = [];

  for (const discovery of discoveries) {
    if (discovery.failure) {
      if (shardIndex === 0) recordResult(discovery.failure);
      continue;
    }
    if (perTestIsolatedFiles.has(discovery.spec.file)) {
      for (const name of discovery.tests) {
        initialLoads[
          shardForTest(`${discovery.spec.file}${discovery.spec.search || ""}`, name, shardCount)
        ] += 1;
      }
      continue;
    }
    specGroups.push({
      key: specGroupKey(discovery.spec, discovery.index),
      weight: discovery.tests.length,
    });
  }

  const { assignments } = assignWptSpecGroups(specGroups, shardCount, initialLoads);
  for (const discovery of discoveries) {
    if (discovery.failure || discovery.tests.length === 0) continue;
    if (perTestIsolatedFiles.has(discovery.spec.file)) {
      const selectedTests = discovery.tests.filter(
        (name) =>
          shardForTest(`${discovery.spec.file}${discovery.spec.search || ""}`, name, shardCount) ===
          shardIndex,
      );
      for (let testIndex = 0; testIndex < selectedTests.length; ++testIndex) {
        runSpecWorker(
          {
            ...discovery.spec,
            include: undefined,
            includeExact: [selectedTests[testIndex]],
          },
          `${discovery.index}-${testIndex}`,
          unshardedEnv,
        );
        await delay(workerDelayMs);
      }
      continue;
    }
    if (assignments.get(specGroupKey(discovery.spec, discovery.index)) !== shardIndex) continue;
    runSpecWorker(discovery.spec, String(discovery.index), unshardedEnv);
    await delay(workerDelayMs);
  }
}

function specGroupKey(spec, index) {
  return `${spec.file}${spec.search || ""}\0${index}`;
}

function listIsolatedTests(specsToRun) {
  const tests = [];
  for (let index = 0; index < specsToRun.length; ++index) {
    const spec = specsToRun[index];
    const names = runListWorker(spec, index);
    tests.push(...formatListedTests(spec, names));
  }
  return tests;
}

function formatListedTests(spec, names) {
  if (!listTestIdentities) return names;
  const file = `${spec.file}${spec.search || ""}`;
  return names.map((name) => ({ file, name }));
}

function runListWorker(spec, index) {
  const discovery = discoverSpecTests(spec, index);
  if (!discovery.failure) return discovery.tests;
  recordResult(discovery.failure);
  return [];
}

function discoverSpecTests(spec, index, extraEnv = {}) {
  const outcome = runWorker(spec, `list-${index}`, {
    ...extraEnv,
    WPT_LIST_TESTS: "1",
  });
  if (outcome.payload?.tests) return { tests: outcome.payload.tests, failure: null };
  const resultPath = `${spec.file}${spec.search || ""}`;
  const output = [outcome.child.stderr, outcome.child.stdout].filter(Boolean).join("\n").trim();
  return {
    tests: [],
    failure: {
      file: resultPath,
      name: "worker test discovery",
      status: "FAIL",
      message:
        output ||
        outcome.child.error?.message ||
        `worker exited with status ${outcome.child.status}`,
    },
  };
}

function runSpecWorker(spec, index, extraEnv = {}) {
  const attempts = [];
  for (let attempt = 0; attempt <= workerRetries; ++attempt) {
    const suffix = attempt === 0 ? `run-${index}` : `run-${index}-retry-${attempt}`;
    const outcome = runWorker(spec, suffix, extraEnv);
    attempts.push(outcome);
    if (!workerOutcomeFailed(outcome)) break;
  }

  const outcome = attempts[attempts.length - 1];
  const retryCount = attempts.length - 1;
  const retryAttempts =
    retryCount > 0 ? attempts.slice(0, -1).map(describeFailedWorkerAttempt) : null;
  const childSummary = outcome.payload;
  if (childSummary?.results) {
    const workerResults = childSummary.results.map((result) =>
      retryCount > 0 ? { ...result, retries: retryCount, retryAttempts } : result,
    );
    for (const result of workerResults) recordResult(result);
  }

  if (!childSummary?.results) {
    const resultPath = `${spec.file}${spec.search || ""}`;
    const output = [outcome.child.stderr, outcome.child.stdout].filter(Boolean).join("\n").trim();
    recordResult({
      file: resultPath,
      name: "worker process",
      status: "FAIL",
      message:
        output ||
        outcome.child.error?.message ||
        `worker exited with status ${outcome.child.status}`,
      ...(retryCount > 0 ? { retries: retryCount, retryAttempts } : {}),
    });
  } else if ((outcome.child.status !== 0 || outcome.child.signal) && childSummary.fail === 0) {
    const resultPath = `${spec.file}${spec.search || ""}`;
    recordResult({
      file: resultPath,
      name: "worker process",
      status: "FAIL",
      message: outcome.child.signal
        ? `worker terminated by ${outcome.child.signal}`
        : `worker exited with status ${outcome.child.status}`,
      ...(retryCount > 0 ? { retries: retryCount, retryAttempts } : {}),
    });
  }
}

function recordResult(result) {
  results.push(result);
  if (!isWorker && !runInProcess && !listTestsOnly) {
    streamedResults = true;
    console.log(formatResultLine(result));
  }
}

function formatResultLine(result) {
  const suffix = result.status === "FAIL" ? ` - ${result.message}` : "";
  const retrySuffix = result.retries ? ` (retried ${result.retries})` : "";
  return `${logPrefix}${result.status} ${result.file} :: ${result.name}${retrySuffix}${suffix}`;
}

function workerOutcomeFailed(outcome) {
  const childSummary = outcome.payload;
  if (!childSummary?.results) return true;
  if (childSummary.results.some((result) => result.status !== "PASS")) return true;
  return (outcome.child.status !== 0 || outcome.child.signal) && childSummary.fail === 0;
}

function describeFailedWorkerAttempt(outcome) {
  const childSummary = outcome.payload;
  const failedResults = childSummary?.results
    ? childSummary.results
        .filter((result) => result.status !== "PASS")
        .slice(0, 5)
        .map((result) => ({
          file: result.file,
          name: result.name,
          status: result.status,
          message: result.message,
        }))
    : [];
  const output = [outcome.child.stderr, outcome.child.stdout].filter(Boolean).join("\n").trim();
  return {
    exitCode: outcome.child.status,
    signal: outcome.child.signal,
    error: outcome.child.error?.message,
    failures: failedResults,
    output: output ? truncateForArtifact(output) : undefined,
  };
}

function truncateForArtifact(value, limit = 4000) {
  if (value.length <= limit) return value;
  return `${value.slice(0, 1000)}\n...<truncated>...\n${value.slice(-Math.max(0, limit - 1018))}`;
}

function runWorker(spec, index, extraEnv = {}) {
  const specFile = makeTempJsonPath(`wpt-spec-${index}`);
  const resultsFile = makeTempJsonPath(`wpt-results-${index}`);
  fs.writeFileSync(specFile, `${JSON.stringify(spec)}\n`);
  try {
    const child = spawnSync(process.execPath, ["--expose-gc", __filename], {
      cwd: root,
      env: {
        ...process.env,
        ...extraEnv,
        WPT_WORKER_SPEC_FILE: specFile,
        WPT_WORKER_RESULTS: resultsFile,
      },
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
      timeout: workerTimeoutMs,
    });

    let payload = null;
    if (fs.existsSync(resultsFile)) {
      payload = JSON.parse(fs.readFileSync(resultsFile, "utf8"));
    }
    return { child, payload };
  } finally {
    for (const file of [specFile, resultsFile]) {
      try {
        fs.unlinkSync(file);
      } catch {
        // Best-effort temp cleanup.
      }
    }
  }
}

function writeTestList(tests) {
  const outputFile = workerResultsFile || path.join(root, "wpt-results.json");
  fs.writeFileSync(outputFile, `${JSON.stringify({ tests }, null, 2)}\n`);
  if (!isWorker) validateWptSelectionTotal(tests.length);
}

function writeSummary({ quiet = false } = {}) {
  const summary = {
    total: results.length,
    pass: results.filter((result) => result.status === "PASS").length,
    fail: results.filter((result) => result.status === "FAIL").length,
    results,
  };

  const outputFile = workerResultsFile || path.join(root, "wpt-results.json");
  fs.writeFileSync(outputFile, `${JSON.stringify(summary, null, 2)}\n`);

  if (!quiet) {
    if (!streamedResults) {
      for (const result of results) {
        console.log(formatResultLine(result));
      }
    }
    console.log(`${logPrefix}WPT subset: ${summary.pass}/${summary.total} passed`);
  }

  if (summary.fail > 0) process.exitCode = 1;
  if (!isWorker && shardCount === 1) {
    try {
      validateWptSelectionTotal(summary.total);
    } catch (error) {
      console.error(`${logPrefix}WPT subset failed: ${error.message}`);
      process.exitCode = 1;
    }
  }
}

(async () => {
  if (runInProcess) {
    if (listTestsOnly) {
      const tests = [];
      for (const spec of specs) {
        tests.push(...formatListedTests(spec, await runFile(spec)));
      }
      writeTestList(tests);
      return;
    }

    for (const spec of specs) {
      await runFile(spec);
    }
    writeSummary({ quiet: isWorker });
    return;
  }

  if (listTestsOnly) {
    writeTestList(listIsolatedTests(specs));
    if (results.length) writeSummary();
    return;
  }

  await runIsolated(specs);
  writeSummary();
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
