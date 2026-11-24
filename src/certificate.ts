import crypto = require("node:crypto");

import { makeDOMException } from "./errors";
import { native } from "./native/binding";

export interface CertificateFingerprint {
  algorithm: string;
  value: string;
}

export interface CertificatePemMaterial {
  certificatePem: string;
  keyPem: string;
}

export interface NormalizedCertificateAlgorithm {
  name: string;
  modulusLength?: number;
}

export const certificateMaterial = new WeakMap<RTCCertificate, CertificatePemMaterial>();

export function fingerprintFromBytes(bytes: Iterable<number>): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(":");
}

export interface RTCCertificateInit {
  expires?: number;
  algorithm?: string;
  fingerprints?: ReadonlyArray<{ algorithm: unknown; value: unknown }>;
  certificatePem?: string | null;
  keyPem?: string | null;
}

export class RTCCertificate {
  // Internal callers always pass expires; it is a timestamp in milliseconds.
  expires: number;
  _algorithm: string;
  _fingerprints: CertificateFingerprint[];

  constructor({
    expires,
    algorithm = "ECDSA",
    fingerprints,
    certificatePem = null,
    keyPem = null,
  }: RTCCertificateInit = {}) {
    this.expires = expires as number;
    this._algorithm = algorithm;
    this._fingerprints =
      Array.isArray(fingerprints) && fingerprints.length
        ? fingerprints.map((fingerprint) => ({
            algorithm: String(fingerprint.algorithm),
            value: String(fingerprint.value).toLowerCase(),
          }))
        : [
            {
              algorithm: "sha-256",
              value: fingerprintFromBytes(crypto.randomBytes(32)),
            },
          ];
    if (typeof certificatePem === "string" && typeof keyPem === "string") {
      certificateMaterial.set(this, { certificatePem, keyPem });
    }
  }

  getFingerprints(): CertificateFingerprint[] {
    return this._fingerprints.map((fingerprint) => ({ ...fingerprint }));
  }
}

export function getCertificateMaterial(certificate: unknown): CertificatePemMaterial | undefined {
  return certificate instanceof RTCCertificate ? certificateMaterial.get(certificate) : undefined;
}

export function sameCertificateSet(
  left: readonly RTCCertificate[],
  right: readonly RTCCertificate[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((certificate, index) => certificate === right[index]);
}

export function normalizeCertificateExpiration(value: unknown): number {
  if (value === undefined) return Date.now() + 30 * 24 * 60 * 60 * 1000;
  const number = Number(value);
  if (!Number.isFinite(number) || !Number.isInteger(number) || number < 0) {
    throw new TypeError("expires must be a non-negative integer");
  }
  return Date.now() + number;
}

export function normalizeCertificateAlgorithm(algorithm: unknown): NormalizedCertificateAlgorithm {
  if (typeof algorithm === "string") {
    throw makeDOMException("Unsupported certificate algorithm", "NotSupportedError");
  }
  if (algorithm === null || typeof algorithm !== "object") {
    throw makeDOMException("Unsupported certificate algorithm", "NotSupportedError");
  }
  const input = algorithm as Record<string, unknown>;
  const name = String(input.name || "").toUpperCase();
  if (name === "ECDSA") {
    if (String(input.namedCurve || "").toUpperCase() !== "P-256") {
      throw makeDOMException("Unsupported ECDSA curve", "NotSupportedError");
    }
    return { name: "ECDSA" };
  }
  if (name === "RSASSA-PKCS1-V1_5") {
    const hash =
      typeof input.hash === "object" && input.hash !== null
        ? String((input.hash as { name?: unknown }).name || "")
        : String(input.hash || "");
    if (hash.toUpperCase() !== "SHA-256") {
      throw makeDOMException("Unsupported RSA hash", "NotSupportedError");
    }
    const modulusLength = Number(input.modulusLength);
    if (!Number.isInteger(modulusLength) || modulusLength < 1024) {
      throw makeDOMException("Unsupported RSA modulus length", "NotSupportedError");
    }
    return { name: "RSASSA-PKCS1-v1_5", modulusLength };
  }
  throw makeDOMException("Unsupported certificate algorithm", "NotSupportedError");
}

export function createNativeBackedCertificate({
  normalizedAlgorithm,
  expires,
  expiresMs,
}: {
  normalizedAlgorithm: NormalizedCertificateAlgorithm;
  expires: number;
  expiresMs: number;
}): RTCCertificate {
  const material = native.generateCertificate({
    algorithm: normalizedAlgorithm.name,
    modulusLength: normalizedAlgorithm.modulusLength,
    expiresMs,
  });
  return new RTCCertificate({
    expires,
    algorithm: normalizedAlgorithm.name,
    fingerprints: material.fingerprints,
    certificatePem: material.certificatePem,
    keyPem: material.keyPem,
  });
}

export function importCertificate({
  certificatePem,
  privateKeyPem,
  expires,
}: {
  certificatePem?: unknown;
  privateKeyPem?: unknown;
  expires?: unknown;
} = {}): RTCCertificate {
  if (typeof certificatePem !== "string" || certificatePem.length === 0) {
    throw new TypeError("certificatePem must be a non-empty string");
  }
  if (typeof privateKeyPem !== "string" || privateKeyPem.length === 0) {
    throw new TypeError("privateKeyPem must be a non-empty string");
  }
  if (
    expires !== undefined &&
    (!Number.isFinite(Number(expires)) || !Number.isInteger(Number(expires)) || Number(expires) < 0)
  ) {
    throw new TypeError("expires must be a non-negative integer timestamp");
  }

  let material;
  try {
    material = native.importCertificate({ certificatePem, keyPem: privateKeyPem });
  } catch (error) {
    throw new TypeError(
      `Invalid certificate material: ${(error as Error | undefined)?.message || String(error)}`,
    );
  }
  const effectiveExpires =
    expires === undefined ? material.expires : Math.min(Number(expires), material.expires);
  return new RTCCertificate({
    expires: effectiveExpires,
    algorithm: "imported",
    fingerprints: material.fingerprints,
    certificatePem: material.certificatePem,
    keyPem: material.keyPem,
  });
}

// Native code pre-generates these off the JavaScript thread; each is used once.
export function createDefaultNativeCertificate(): RTCCertificate {
  const material = native.takeDefaultCertificate();
  return new RTCCertificate({
    expires: material.expires,
    algorithm: "ECDSA",
    fingerprints: material.fingerprints,
    certificatePem: material.certificatePem,
    keyPem: material.keyPem,
  });
}

export function certificatePemToArrayBuffer(pem: string): ArrayBuffer {
  const raw = new crypto.X509Certificate(pem).raw;
  return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
}

export function generateCertificate(algorithm: unknown): Promise<RTCCertificate> {
  try {
    const normalizedAlgorithm = normalizeCertificateAlgorithm(algorithm);
    const expiresInput =
      algorithm && typeof algorithm === "object"
        ? (algorithm as { expires?: unknown }).expires
        : undefined;
    const expires = normalizeCertificateExpiration(expiresInput);
    const expiresMs = expiresInput === undefined ? 30 * 24 * 60 * 60 * 1000 : Number(expiresInput);
    return Promise.resolve(
      createNativeBackedCertificate({ normalizedAlgorithm, expires, expiresMs }),
    );
  } catch (error) {
    return Promise.reject(error);
  }
}
