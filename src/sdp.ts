// @ts-nocheck -- converted from JavaScript; strict typing lands module by module.

const crypto = require("node:crypto");

import { defineReadonly, kInternalConstruct, makeDOMException, RTCError } from "./errors";

export function normalizeDescription(init) {
  return new RTCSessionDescription(init);
}

export function validateSdpType(type) {
  if (!["offer", "answer", "pranswer", "rollback"].includes(type)) {
    throw new TypeError(`Invalid RTCSdpType: ${type}`);
  }
}

export function isNoMediaSdp(description) {
  return (
    typeof description?.sdp === "string" &&
    /^v=0(?:\r?\n|$)/.test(description.sdp) &&
    !/\r?\nm=/.test(description.sdp)
  );
}

export function sdpSyntaxErrorLine(sdp) {
  const lines = String(sdp ?? "").split(/\r\n|\n|\r/);
  if (lines[0] !== "v=0") return 1;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === "" && index === lines.length - 1) continue;
    if (!/^[a-z]=/.test(line)) return index + 1;
  }
  return null;
}

export function assertValidSdpSyntax(description) {
  if (description.type === "rollback") return;
  const line = sdpSyntaxErrorLine(description.sdp);
  if (line === null) return;
  throw new RTCError(
    {
      errorDetail: "sdp-syntax-error",
      sdpLineNumber: line,
    },
    "Invalid SDP syntax",
  );
}

export function hasDataMediaSection(description) {
  return /\r?\nm=application\b/i.test(description?.sdp || "");
}

export function hasTrickleIceOption(description) {
  return /\r?\na=ice-options:[^\r\n]*\btrickle\b/i.test(description?.sdp || "");
}

export function maxMessageSizeFromSdp(description) {
  const match = /\r?\na=max-message-size:(\d+)/i.exec(description?.sdp || "");
  return match ? Number(match[1]) : null;
}

export const ICE_CREDENTIAL_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function randomIceCredential(length) {
  const bytes = crypto.randomBytes(length);
  let value = "";
  for (const byte of bytes) value += ICE_CREDENTIAL_CHARS[byte & 0x3f];
  return value;
}

export function createIceRestartCredentials() {
  return {
    iceUfrag: randomIceCredential(16),
    icePwd: randomIceCredential(32),
  };
}

export function rewriteIceCredentials(sdp, credentials) {
  if (!/^a=ice-ufrag:/m.test(sdp) || !/^a=ice-pwd:/m.test(sdp)) return sdp;
  return sdp
    .replace(/^a=ice-ufrag:.*$/gm, `a=ice-ufrag:${credentials.iceUfrag}`)
    .replace(/^a=ice-pwd:.*$/gm, `a=ice-pwd:${credentials.icePwd}`);
}

export function markJsOnlyIceRestart(description) {
  if (description && typeof description === "object") {
    Object.defineProperty(description, "_webrtcNodeJsOnlyIceRestart", {
      value: true,
      configurable: true,
    });
  }
  return description;
}

export function hasDifferentIceCredentials(left, right) {
  const leftParameters = firstIceParameters(left);
  const rightParameters = firstIceParameters(right);
  if (!leftParameters || !rightParameters) return false;
  return (
    leftParameters.usernameFragment !== rightParameters.usernameFragment ||
    leftParameters.password !== rightParameters.password
  );
}

export class RTCSessionDescription {
  constructor(init) {
    if (!init || typeof init !== "object")
      throw new TypeError("RTCSessionDescriptionInit required");
    this.type = String(init.type || "");
    validateSdpType(this.type);
    this.sdp = String(init.sdp || "");
  }

  toJSON() {
    return { type: this.type, sdp: this.sdp };
  }
}

export class RTCIceCandidate {
  constructor(init = {}) {
    if (init == null || typeof init !== "object")
      throw new TypeError("RTCIceCandidateInit required");
    const sdpMid = init.sdpMid == null ? null : String(init.sdpMid);
    const sdpMLineIndex = init.sdpMLineIndex == null ? null : Number(init.sdpMLineIndex);
    if (sdpMid === null && sdpMLineIndex === null) {
      throw new TypeError("Either sdpMid or sdpMLineIndex must be provided");
    }

    this.candidate = init.candidate === undefined ? "" : String(init.candidate);
    this.sdpMid = sdpMid;
    this.sdpMLineIndex = sdpMLineIndex;
    this.usernameFragment = init.usernameFragment == null ? null : String(init.usernameFragment);
    this.relayProtocol = init.relayProtocol == null ? null : String(init.relayProtocol);
    this.url = init.url == null ? null : String(init.url);

    const parsed = parseCandidate(this.candidate);
    this.foundation = parsed.foundation;
    this.component = parsed.component;
    this.priority = parsed.priority;
    this.address = parsed.address;
    this.protocol = parsed.protocol;
    this.port = parsed.port;
    this.type = parsed.type;
    this.tcpType = parsed.tcpType;
    this.relatedAddress = parsed.relatedAddress;
    this.relatedPort = parsed.relatedPort;
  }

  toJSON() {
    return {
      candidate: this.candidate,
      sdpMid: this.sdpMid,
      sdpMLineIndex: this.sdpMLineIndex,
      usernameFragment: this.usernameFragment,
    };
  }
}

export class RTCIceCandidatePair {
  constructor(token, local, remote) {
    if (token !== kInternalConstruct) throw new TypeError("Illegal constructor");
    defineReadonly(this, "local", local);
    defineReadonly(this, "remote", remote);
  }
}

export function parseCandidate(candidate) {
  const empty = {
    foundation: null,
    component: null,
    priority: null,
    address: null,
    protocol: null,
    port: null,
    type: null,
    tcpType: null,
    relatedAddress: null,
    relatedPort: null,
  };
  if (typeof candidate !== "string" || !candidate.startsWith("candidate:")) return empty;
  const parts = candidate.slice("candidate:".length).trim().split(/\s+/);
  if (parts.length < 8) return empty;
  const result = { ...empty };
  result.foundation = parts[0] || null;
  result.component = parts[1] === "1" ? "rtp" : parts[1] === "2" ? "rtcp" : null;
  result.protocol = parts[2] ? parts[2].toLowerCase() : null;
  result.priority = Number(parts[3]);
  result.address = parts[4] || null;
  result.port = Number(parts[5]);
  const typIndex = parts.indexOf("typ");
  if (typIndex !== -1 && parts[typIndex + 1]) result.type = parts[typIndex + 1];
  const tcpIndex = parts.indexOf("tcptype");
  if (tcpIndex !== -1 && parts[tcpIndex + 1]) result.tcpType = parts[tcpIndex + 1];
  const raddrIndex = parts.indexOf("raddr");
  if (raddrIndex !== -1 && parts[raddrIndex + 1]) result.relatedAddress = parts[raddrIndex + 1];
  const rportIndex = parts.indexOf("rport");
  if (rportIndex !== -1 && parts[rportIndex + 1])
    result.relatedPort = Number(parts[rportIndex + 1]);
  return result;
}

export function normalizeAddIceCandidateInput(init) {
  if (init == null) {
    return {
      candidate: "",
      sdpMid: null,
      sdpMLineIndex: null,
      usernameFragment: null,
      toJSON() {
        return {
          candidate: this.candidate,
          sdpMid: this.sdpMid,
          sdpMLineIndex: this.sdpMLineIndex,
          usernameFragment: this.usernameFragment,
        };
      },
    };
  }
  if (typeof init !== "object") throw new TypeError("RTCIceCandidateInit required");
  const candidate = init.candidate == null ? "" : String(init.candidate);
  const sdpMid = init.sdpMid == null ? null : String(init.sdpMid);
  const sdpMLineIndex = init.sdpMLineIndex == null ? null : Number(init.sdpMLineIndex);
  if (candidate !== "" && sdpMid === null && sdpMLineIndex === null) {
    throw new TypeError("Either sdpMid or sdpMLineIndex must be provided");
  }
  return {
    candidate,
    sdpMid,
    sdpMLineIndex,
    usernameFragment: init.usernameFragment == null ? null : String(init.usernameFragment),
    toJSON() {
      return {
        candidate: this.candidate,
        sdpMid: this.sdpMid,
        sdpMLineIndex: this.sdpMLineIndex,
        usernameFragment: this.usernameFragment,
      };
    },
  };
}

export function splitSdpLines(sdp) {
  return String(sdp || "")
    .split(/\r?\n/)
    .filter((line) => line !== "");
}

export function parseSdpMediaSections(sdp) {
  const sessionLines = [];
  const mediaSections = [];
  let sessionIceUfrag = null;
  let sessionIcePwd = null;
  let current = null;
  for (const line of splitSdpLines(sdp)) {
    if (line.startsWith("m=")) {
      current = { startLine: line, lines: [line], mid: null, iceUfrag: null, icePwd: null };
      mediaSections.push(current);
    } else if (current) {
      current.lines.push(line);
      if (line.startsWith("a=mid:")) current.mid = line.slice("a=mid:".length);
      if (line.startsWith("a=ice-ufrag:")) current.iceUfrag = line.slice("a=ice-ufrag:".length);
      if (line.startsWith("a=ice-pwd:")) current.icePwd = line.slice("a=ice-pwd:".length);
    } else {
      sessionLines.push(line);
      if (line.startsWith("a=ice-ufrag:")) sessionIceUfrag = line.slice("a=ice-ufrag:".length);
      if (line.startsWith("a=ice-pwd:")) sessionIcePwd = line.slice("a=ice-pwd:".length);
    }
  }
  for (const section of mediaSections) {
    if (section.iceUfrag === null) section.iceUfrag = sessionIceUfrag;
    if (section.icePwd === null) section.icePwd = sessionIcePwd;
  }
  return { sessionLines, mediaSections };
}

export function serializeSdp(sessionLines, mediaSections) {
  const lines = [...sessionLines];
  for (const section of mediaSections) lines.push(...section.lines);
  return `${lines.join("\r\n")}\r\n`;
}

export function validateCandidateSyntax(candidate) {
  if (candidate === "") return true;
  if (
    typeof candidate !== "string" ||
    !candidate.startsWith("candidate:") ||
    /[^\x20-\x7e]/.test(candidate)
  )
    return false;
  const parts = candidate.slice("candidate:".length).trim().split(/\s+/);
  const typIndex = parts.indexOf("typ");
  return parts.length >= 8 && typIndex >= 6 && Boolean(parts[typIndex + 1]);
}

export function selectCandidateSections(description, candidate) {
  const parsed = parseSdpMediaSections(description?.sdp || "");
  const sections = parsed.mediaSections;
  if (sections.length === 0) return { parsed, targets: [] };

  let targets;
  if (candidate.sdpMid !== null) {
    const section = sections.find((entry) => entry.mid === candidate.sdpMid);
    if (!section)
      throw makeDOMException("sdpMid does not match a remote media section", "OperationError");
    targets = [section];
  } else if (candidate.sdpMLineIndex !== null) {
    const index = Number(candidate.sdpMLineIndex);
    if (!Number.isInteger(index) || index < 0 || index >= sections.length) {
      throw makeDOMException(
        "sdpMLineIndex does not match a remote media section",
        "OperationError",
      );
    }
    targets = [sections[index]];
  } else if (candidate.usernameFragment !== null) {
    targets = sections.filter((entry) => entry.iceUfrag === candidate.usernameFragment);
    if (targets.length === 0) {
      throw makeDOMException(
        "usernameFragment does not match a remote ICE generation",
        "OperationError",
      );
    }
  } else {
    targets = sections;
  }

  if (candidate.usernameFragment !== null) {
    const matches = targets.some((entry) => entry.iceUfrag === candidate.usernameFragment);
    if (!matches) {
      throw makeDOMException(
        "usernameFragment does not match the selected media section",
        "OperationError",
      );
    }
  }

  return { parsed, targets };
}

export function appendRemoteCandidateToDescription(description, candidate) {
  if (!description?.sdp || isNoMediaSdp(description)) return description;
  const rawCandidate = candidate.candidate;
  let end = rawCandidate.length;
  if (rawCandidate.charCodeAt(end - 1) === 10) {
    end--;
    if (rawCandidate.charCodeAt(end - 1) === 13) end--;
  } else if (rawCandidate.charCodeAt(end - 1) === 13) {
    end--;
  }
  while (end > 0 && rawCandidate.charCodeAt(end - 1) === 32) end--;
  const candidateLine = rawCandidate.slice(0, end);
  if ((rawCandidate !== "" && candidateLine === "") || !validateCandidateSyntax(candidateLine)) {
    throw makeDOMException("Invalid ICE candidate syntax", "OperationError");
  }

  const { parsed, targets } = selectCandidateSections(description, candidate);
  if (targets.length === 0) return description;

  const line = candidateLine === "" ? "a=end-of-candidates" : `a=${candidateLine}`;
  for (const section of targets) {
    if (!section.lines.includes(line)) section.lines.push(line);
  }
  return new RTCSessionDescription({
    type: description.type,
    sdp: serializeSdp(parsed.sessionLines, parsed.mediaSections),
  });
}

export function isIceCandidateLine(line) {
  return line.startsWith("a=candidate:") || line === "a=end-of-candidates";
}

export function stripIceCandidateLinesFromDescription(description) {
  if (!description?.sdp || isNoMediaSdp(description)) return description;
  const parsed = parseSdpMediaSections(description.sdp);
  let stripped = false;
  for (const section of parsed.mediaSections) {
    section.lines = section.lines.filter((line) => {
      if (!isIceCandidateLine(line)) return true;
      stripped = true;
      return false;
    });
  }
  if (!stripped) return description;
  const result = new RTCSessionDescription({
    type: description.type,
    sdp: serializeSdp(parsed.sessionLines, parsed.mediaSections),
  });
  if (description._webrtcNodeJsOnlyIceRestart) markJsOnlyIceRestart(result);
  return result;
}

export function extractIceCandidatesFromDescription(description) {
  if (!description?.sdp || isNoMediaSdp(description)) return [];
  const parsed = parseSdpMediaSections(description.sdp);
  const candidates = [];
  for (let index = 0; index < parsed.mediaSections.length; index += 1) {
    const section = parsed.mediaSections[index];
    for (const line of section.lines) {
      if (!line.startsWith("a=candidate:")) continue;
      candidates.push(
        new RTCIceCandidate({
          candidate: line.slice("a=".length),
          sdpMid: section.mid,
          sdpMLineIndex: index,
          usernameFragment: section.iceUfrag,
        }),
      );
    }
  }
  return candidates;
}

export function resolveCandidateMid(description, candidate) {
  if (candidate.sdpMid !== null) return candidate.sdpMid;
  if (candidate.sdpMLineIndex === null) return null;
  const index = Number(candidate.sdpMLineIndex);
  const section = parseSdpMediaSections(description?.sdp || "").mediaSections[index];
  return section?.mid || null;
}

export function firstIceParameters(description) {
  const section = parseSdpMediaSections(description?.sdp || "").mediaSections.find(
    (entry) => entry.iceUfrag && entry.icePwd,
  );
  if (!section) return null;
  return {
    usernameFragment: section.iceUfrag,
    password: section.icePwd,
  };
}

export function dtlsSetupFromDescription(description) {
  const parsed = parseSdpMediaSections(description?.sdp || "");
  const section =
    parsed.mediaSections.find((entry) => /^m=application\b/i.test(entry.startLine)) ||
    parsed.mediaSections[0];
  const setupLine =
    section?.lines.find((line) => /^a=setup:/i.test(line)) ||
    parsed.sessionLines.find((line) => /^a=setup:/i.test(line));
  return setupLine ? setupLine.slice("a=setup:".length).toLowerCase() : null;
}

export function sameCandidate(left, right) {
  return (
    left.candidate === right.candidate &&
    left.sdpMid === right.sdpMid &&
    left.sdpMLineIndex === right.sdpMLineIndex &&
    left.usernameFragment === right.usernameFragment
  );
}

export function sameCandidateEndpoint(left, right) {
  if (!left || !right) return false;
  return (
    left.component === right.component &&
    left.protocol === right.protocol &&
    left.address === right.address &&
    left.port === right.port &&
    left.address !== null &&
    left.port !== null
  );
}

export function selectKnownCandidateByEndpoint(candidates, selectedCandidate) {
  return (
    candidates.find((candidate) => sameCandidateEndpoint(candidate, selectedCandidate)) ||
    selectedCandidate
  );
}
