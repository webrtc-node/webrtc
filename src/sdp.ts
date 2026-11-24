import crypto = require("node:crypto");

import { defineReadonly, kInternalConstruct, makeDOMException, RTCError } from "./errors";
import type { RTCSdpType } from "./types";

// Any object with SDP, such as RTCSessionDescription or a plain description.
export interface SdpDescriptionLike {
  type?: string;
  sdp?: string;
  _webrtcNodeJsOnlyIceRestart?: boolean;
}

export interface CandidateInitLike {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
  usernameFragment: string | null;
}

export interface NormalizedCandidateInit extends CandidateInitLike {
  toJSON(): CandidateInitLike;
}

export interface ParsedCandidate {
  foundation: string | null;
  component: "rtp" | "rtcp" | null;
  priority: number | null;
  address: string | null;
  protocol: string | null;
  port: number | null;
  type: string | null;
  tcpType: string | null;
  relatedAddress: string | null;
  relatedPort: number | null;
}

export interface SdpMediaSection {
  startLine: string;
  lines: string[];
  mid: string | null;
  iceUfrag: string | null;
  icePwd: string | null;
}

export interface ParsedSdp {
  sessionLines: string[];
  mediaSections: SdpMediaSection[];
}

export interface IceCredentials {
  iceUfrag: string;
  icePwd: string;
}

type Dictionary = Record<string, unknown>;
type MaybeDescription = SdpDescriptionLike | null | undefined;

export function normalizeDescription(init: unknown): RTCSessionDescription {
  return new RTCSessionDescription(init);
}

export function validateSdpType(type: string): asserts type is RTCSdpType {
  if (!["offer", "answer", "pranswer", "rollback"].includes(type)) {
    throw new TypeError(`Invalid RTCSdpType: ${type}`);
  }
}

export function isNoMediaSdp(description: MaybeDescription): boolean {
  return (
    typeof description?.sdp === "string" &&
    /^v=0(?:\r?\n|$)/.test(description.sdp) &&
    !/\r?\nm=/.test(description.sdp)
  );
}

export function sdpSyntaxErrorLine(sdp: unknown): number | null {
  const lines = String(sdp ?? "").split(/\r\n|\n|\r/);
  if (lines[0] !== "v=0") return 1;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === "" && index === lines.length - 1) continue;
    if (!/^[a-z]=/.test(line)) return index + 1;
  }
  return null;
}

export function assertValidSdpSyntax(description: SdpDescriptionLike): void {
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

export function hasDataMediaSection(description: MaybeDescription): boolean {
  return /\r?\nm=application\b/i.test(description?.sdp || "");
}

export function hasTrickleIceOption(description: MaybeDescription): boolean {
  return /\r?\na=ice-options:[^\r\n]*\btrickle\b/i.test(description?.sdp || "");
}

export function maxMessageSizeFromSdp(description: MaybeDescription): number | null {
  const match = /\r?\na=max-message-size:(\d+)/i.exec(description?.sdp || "");
  return match ? Number(match[1]) : null;
}

export const ICE_CREDENTIAL_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function randomIceCredential(length: number): string {
  const bytes = crypto.randomBytes(length);
  let value = "";
  for (const byte of bytes) value += ICE_CREDENTIAL_CHARS[byte & 0x3f];
  return value;
}

export function createIceRestartCredentials(): IceCredentials {
  return {
    iceUfrag: randomIceCredential(16),
    icePwd: randomIceCredential(32),
  };
}

export function rewriteIceCredentials(sdp: string, credentials: IceCredentials): string {
  if (!/^a=ice-ufrag:/m.test(sdp) || !/^a=ice-pwd:/m.test(sdp)) return sdp;
  return sdp
    .replace(/^a=ice-ufrag:.*$/gm, `a=ice-ufrag:${credentials.iceUfrag}`)
    .replace(/^a=ice-pwd:.*$/gm, `a=ice-pwd:${credentials.icePwd}`);
}

export function markJsOnlyIceRestart<T>(description: T): T {
  if (description && typeof description === "object") {
    Object.defineProperty(description, "_webrtcNodeJsOnlyIceRestart", {
      value: true,
      configurable: true,
    });
  }
  return description;
}

export function hasDifferentIceCredentials(
  left: MaybeDescription,
  right: MaybeDescription,
): boolean {
  const leftParameters = firstIceParameters(left);
  const rightParameters = firstIceParameters(right);
  if (!leftParameters || !rightParameters) return false;
  return (
    leftParameters.usernameFragment !== rightParameters.usernameFragment ||
    leftParameters.password !== rightParameters.password
  );
}

export class RTCSessionDescription {
  type: RTCSdpType;
  sdp: string;

  constructor(init: unknown) {
    if (!init || typeof init !== "object")
      throw new TypeError("RTCSessionDescriptionInit required");
    const input = init as Dictionary;
    const type = String(input.type || "");
    validateSdpType(type);
    this.type = type;
    this.sdp = String(input.sdp || "");
  }

  toJSON(): { type: RTCSdpType; sdp: string } {
    return { type: this.type, sdp: this.sdp };
  }
}

export class RTCIceCandidate implements CandidateInitLike, ParsedCandidate {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
  usernameFragment: string | null;
  relayProtocol: string | null;
  url: string | null;
  foundation: string | null;
  component: "rtp" | "rtcp" | null;
  priority: number | null;
  address: string | null;
  protocol: string | null;
  port: number | null;
  type: string | null;
  tcpType: string | null;
  relatedAddress: string | null;
  relatedPort: number | null;
  // Marks candidates this process gathered; set with defineProperty.
  declare _webrtcNodeLocalCandidate?: boolean;

  constructor(init: unknown = {}) {
    if (init == null || typeof init !== "object")
      throw new TypeError("RTCIceCandidateInit required");
    const input = init as Dictionary;
    const sdpMid = input.sdpMid == null ? null : String(input.sdpMid);
    const sdpMLineIndex = input.sdpMLineIndex == null ? null : Number(input.sdpMLineIndex);
    if (sdpMid === null && sdpMLineIndex === null) {
      throw new TypeError("Either sdpMid or sdpMLineIndex must be provided");
    }

    this.candidate = input.candidate === undefined ? "" : String(input.candidate);
    this.sdpMid = sdpMid;
    this.sdpMLineIndex = sdpMLineIndex;
    this.usernameFragment = input.usernameFragment == null ? null : String(input.usernameFragment);
    this.relayProtocol = input.relayProtocol == null ? null : String(input.relayProtocol);
    this.url = input.url == null ? null : String(input.url);

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

  toJSON(): CandidateInitLike {
    return {
      candidate: this.candidate,
      sdpMid: this.sdpMid,
      sdpMLineIndex: this.sdpMLineIndex,
      usernameFragment: this.usernameFragment,
    };
  }
}

export class RTCIceCandidatePair {
  // Set as read-only own properties in the constructor.
  declare readonly local: RTCIceCandidate;
  declare readonly remote: RTCIceCandidate;

  constructor(token: unknown, local: RTCIceCandidate, remote: RTCIceCandidate) {
    if (token !== kInternalConstruct) throw new TypeError("Illegal constructor");
    defineReadonly(this, "local", local);
    defineReadonly(this, "remote", remote);
  }
}

export function parseCandidate(candidate: unknown): ParsedCandidate {
  const empty: ParsedCandidate = {
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

export function normalizeAddIceCandidateInput(init: unknown): NormalizedCandidateInit {
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
  const input = init as Dictionary;
  const candidate = input.candidate == null ? "" : String(input.candidate);
  const sdpMid = input.sdpMid == null ? null : String(input.sdpMid);
  const sdpMLineIndex = input.sdpMLineIndex == null ? null : Number(input.sdpMLineIndex);
  if (candidate !== "" && sdpMid === null && sdpMLineIndex === null) {
    throw new TypeError("Either sdpMid or sdpMLineIndex must be provided");
  }
  return {
    candidate,
    sdpMid,
    sdpMLineIndex,
    usernameFragment: input.usernameFragment == null ? null : String(input.usernameFragment),
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

export function splitSdpLines(sdp: unknown): string[] {
  return String(sdp || "")
    .split(/\r?\n/)
    .filter((line) => line !== "");
}

export function parseSdpMediaSections(sdp: unknown): ParsedSdp {
  const sessionLines: string[] = [];
  const mediaSections: SdpMediaSection[] = [];
  let sessionIceUfrag: string | null = null;
  let sessionIcePwd: string | null = null;
  let current: SdpMediaSection | null = null;
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

export function serializeSdp(
  sessionLines: readonly string[],
  mediaSections: readonly SdpMediaSection[],
): string {
  const lines = [...sessionLines];
  for (const section of mediaSections) lines.push(...section.lines);
  return `${lines.join("\r\n")}\r\n`;
}

export function validateCandidateSyntax(candidate: unknown): boolean {
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

export function selectCandidateSections(
  description: MaybeDescription,
  candidate: CandidateInitLike,
): { parsed: ParsedSdp; targets: SdpMediaSection[] } {
  const parsed = parseSdpMediaSections(description?.sdp || "");
  const sections = parsed.mediaSections;
  if (sections.length === 0) return { parsed, targets: [] };

  let targets: SdpMediaSection[];
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

export function appendRemoteCandidateToDescription<D extends MaybeDescription>(
  description: D,
  candidate: CandidateInitLike,
): D | RTCSessionDescription {
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

export function isIceCandidateLine(line: string): boolean {
  return line.startsWith("a=candidate:") || line === "a=end-of-candidates";
}

export function stripIceCandidateLinesFromDescription<D extends MaybeDescription>(
  description: D,
): D | RTCSessionDescription {
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

export function extractIceCandidatesFromDescription(
  description: MaybeDescription,
): RTCIceCandidate[] {
  if (!description?.sdp || isNoMediaSdp(description)) return [];
  const parsed = parseSdpMediaSections(description.sdp);
  const candidates: RTCIceCandidate[] = [];
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

export function resolveCandidateMid(
  description: MaybeDescription,
  candidate: CandidateInitLike,
): string | null {
  if (candidate.sdpMid !== null) return candidate.sdpMid;
  if (candidate.sdpMLineIndex === null) return null;
  const index = Number(candidate.sdpMLineIndex);
  const section = parseSdpMediaSections(description?.sdp || "").mediaSections[index];
  return section?.mid || null;
}

export function firstIceParameters(
  description: MaybeDescription,
): { usernameFragment: string; password: string } | null {
  const section = parseSdpMediaSections(description?.sdp || "").mediaSections.find(
    (entry) => entry.iceUfrag && entry.icePwd,
  );
  if (!section) return null;
  return {
    // find() above only matches sections with both values.
    usernameFragment: section.iceUfrag as string,
    password: section.icePwd as string,
  };
}

export function dtlsSetupFromDescription(description: MaybeDescription): string | null {
  const parsed = parseSdpMediaSections(description?.sdp || "");
  const section =
    parsed.mediaSections.find((entry) => /^m=application\b/i.test(entry.startLine)) ||
    parsed.mediaSections[0];
  const setupLine =
    section?.lines.find((line) => /^a=setup:/i.test(line)) ||
    parsed.sessionLines.find((line) => /^a=setup:/i.test(line));
  return setupLine ? setupLine.slice("a=setup:".length).toLowerCase() : null;
}

export function sameCandidate(left: CandidateInitLike, right: CandidateInitLike): boolean {
  return (
    left.candidate === right.candidate &&
    left.sdpMid === right.sdpMid &&
    left.sdpMLineIndex === right.sdpMLineIndex &&
    left.usernameFragment === right.usernameFragment
  );
}

export function sameCandidateEndpoint(
  left: ParsedCandidate | null | undefined,
  right: ParsedCandidate | null | undefined,
): boolean {
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

export function selectKnownCandidateByEndpoint<T extends ParsedCandidate>(
  candidates: readonly T[],
  selectedCandidate: T,
): T {
  return (
    candidates.find((candidate) => sameCandidateEndpoint(candidate, selectedCandidate)) ||
    selectedCandidate
  );
}
