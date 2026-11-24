import type { RTCCertificate } from "./certificate";
import { certificateMaterial } from "./certificate";
import { makeDOMException } from "./errors";
import {
  byteLength,
  enforceRange,
  isObject,
  normalizeEnum,
  normalizeSequence,
  sequenceFromIterator,
  toDOMString,
} from "./webidl";

export interface NormalizedIceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

export interface NormalizedConfiguration {
  iceServers: NormalizedIceServer[];
  iceTransportPolicy: "all" | "relay";
  bundlePolicy: "balanced" | "max-compat" | "max-bundle";
  rtcpMuxPolicy: "require";
  iceCandidatePoolSize: number;
  certificates: RTCCertificate[];
}

type Dictionary = Record<string | symbol, unknown>;

export function validateIceServerUrl(url: unknown): void {
  if (typeof url !== "string") throw new TypeError("RTCIceServer.urls must contain strings");
  const match = /^([a-z][a-z0-9+.-]*):(.*)$/i.exec(url);
  if (!match) throw makeDOMException("Invalid ICE server URL", "SyntaxError");
  const scheme = match[1].toLowerCase();
  const rest = match[2];
  if (!["stun", "stuns", "turn", "turns"].includes(scheme)) {
    throw makeDOMException("Unsupported ICE server URL scheme", "SyntaxError");
  }
  if (!rest || rest.startsWith("//") || /[/\\#@]/.test(rest)) {
    throw makeDOMException("Invalid ICE server URL", "SyntaxError");
  }

  const [hostPort, query = ""] = rest.split("?");
  const hasQuery = rest.includes("?");
  if (rest.split("?").length > 2 || !hostPort) {
    throw makeDOMException("Invalid ICE server URL", "SyntaxError");
  }
  if ((scheme === "stun" || scheme === "stuns") && hasQuery) {
    throw makeDOMException("STUN URL must not contain a query", "SyntaxError");
  }
  if (
    (scheme === "turn" || scheme === "turns") &&
    hasQuery &&
    !/^transport=(udp|tcp)$/i.test(query)
  ) {
    throw makeDOMException("Invalid TURN transport", "SyntaxError");
  }

  let host = hostPort;
  let port = "";
  let hasPort = false;
  if (hostPort.startsWith("[")) {
    const end = hostPort.indexOf("]");
    if (end <= 1) throw makeDOMException("Invalid ICE server host", "SyntaxError");
    host = hostPort.slice(1, end);
    const suffix = hostPort.slice(end + 1);
    if (suffix) {
      if (!suffix.startsWith(":")) throw makeDOMException("Invalid ICE server port", "SyntaxError");
      hasPort = true;
      port = suffix.slice(1);
    }
  } else {
    const colonCount = (hostPort.match(/:/g) || []).length;
    if (colonCount > 1) throw makeDOMException("Invalid ICE server host", "SyntaxError");
    if (colonCount === 1) {
      hasPort = true;
      const index = hostPort.lastIndexOf(":");
      host = hostPort.slice(0, index);
      port = hostPort.slice(index + 1);
    }
  }
  if (!host || /\s/.test(host)) throw makeDOMException("Invalid ICE server host", "SyntaxError");
  if (hasPort) {
    const number = Number(port);
    if (!/^\d+$/.test(port) || !Number.isInteger(number) || number < 0 || number > 65535) {
      throw makeDOMException("Invalid ICE server port", "SyntaxError");
    }
  }
}

export function normalizeIceServers(iceServers: unknown): NormalizedIceServer[] {
  if (iceServers === undefined) return [];
  return normalizeSequence(
    iceServers,
    (server) => {
      if (!isObject(server)) throw new TypeError("RTCIceServer must be an object");
      const entry = server as Dictionary;
      const credentialValue = entry.credential;
      const credential = credentialValue === undefined ? undefined : toDOMString(credentialValue);
      const urlsValue = entry.urls;
      if (urlsValue === undefined) {
        throw new TypeError("RTCIceServer.urls is required");
      }
      let urls: string[];
      const iterator = isObject(urlsValue) ? (urlsValue as Dictionary)[Symbol.iterator] : undefined;
      if (iterator != null) {
        if (typeof iterator !== "function")
          throw new TypeError("RTCIceServer.urls iterator must be callable");
        urls = sequenceFromIterator(
          urlsValue,
          iterator as (...args: unknown[]) => Iterator<unknown>,
          toDOMString,
        );
      } else {
        urls = [toDOMString(urlsValue)];
      }
      const usernameValue = entry.username;
      const username = usernameValue === undefined ? undefined : toDOMString(usernameValue);
      if (urls.length === 0)
        throw makeDOMException("RTCIceServer.urls must not be empty", "SyntaxError");
      for (const url of urls) validateIceServerUrl(url);

      const requiresCredentials = urls.some((url) => /^turns?:/i.test(url));
      if (requiresCredentials) {
        if (username === undefined || credential === undefined || credential === "") {
          throw makeDOMException(
            "TURN servers require username and credential",
            "InvalidAccessError",
          );
        }
        if (byteLength(username) > 509) {
          throw makeDOMException("TURN username exceeds 509 bytes", "InvalidAccessError");
        }
      }

      const normalized: NormalizedIceServer = { urls };
      if (username !== undefined) normalized.username = username;
      if (credential !== undefined) normalized.credential = credential;
      return normalized;
    },
    "iceServers",
  );
}

export function normalizePeerConnectionConfiguration(
  configuration: unknown,
  previous: NormalizedConfiguration | null = null,
): NormalizedConfiguration {
  if (configuration == null) configuration = {};
  if (!isObject(configuration)) throw new TypeError("RTCConfiguration must be an object");
  const input = configuration as Dictionary;
  const bundlePolicy = normalizeEnum(
    input.bundlePolicy,
    "bundlePolicy",
    ["balanced", "max-compat", "max-bundle"],
    "balanced",
  );
  const certificatesValue = input.certificates;
  const certificates =
    certificatesValue === undefined
      ? previous?.certificates || []
      : normalizeSequence(
          certificatesValue,
          (certificate) => {
            if (!certificateMaterial.has(certificate as RTCCertificate)) {
              throw new TypeError(
                "certificates must contain generated or imported RTCCertificate objects",
              );
            }
            return certificate as RTCCertificate;
          },
          "certificates",
        );
  const poolSizeValue = input.iceCandidatePoolSize;
  const iceCandidatePoolSize =
    poolSizeValue === undefined ? 0 : enforceRange(poolSizeValue, "iceCandidatePoolSize", 255);
  const iceServers = normalizeIceServers(input.iceServers);
  const iceTransportPolicy = normalizeEnum(
    input.iceTransportPolicy,
    "iceTransportPolicy",
    ["all", "relay"],
    "all",
  );
  const rtcpMuxPolicy = normalizeEnum(input.rtcpMuxPolicy, "rtcpMuxPolicy", ["require"], "require");
  for (const certificate of certificates) {
    if (
      (certificatesValue !== undefined || previous === null) &&
      certificate.expires <= Date.now()
    ) {
      throw makeDOMException("RTCCertificate has expired", "InvalidAccessError");
    }
  }
  return {
    iceServers,
    iceTransportPolicy,
    bundlePolicy,
    rtcpMuxPolicy,
    iceCandidatePoolSize,
    certificates,
  };
}

export function cloneConfiguration(
  configuration: NormalizedConfiguration,
): NormalizedConfiguration {
  return {
    iceServers: configuration.iceServers.map((server) => ({ ...server, urls: [...server.urls] })),
    iceTransportPolicy: configuration.iceTransportPolicy,
    bundlePolicy: configuration.bundlePolicy,
    rtcpMuxPolicy: configuration.rtcpMuxPolicy,
    iceCandidatePoolSize: configuration.iceCandidatePoolSize,
    certificates: [...configuration.certificates],
  };
}
