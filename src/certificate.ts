// @ts-nocheck -- converted from JavaScript; strict typing lands module by module.

const crypto = require("node:crypto");

import { makeDOMException } from "./errors";
import { native } from "./native/binding";

export const certificateMaterial = new WeakMap();

export function fingerprintFromBytes(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(":");
}

export class RTCCertificate {
  expires: number;
  _algorithm: string;
  _fingerprints: Array<{ algorithm: string; value: string }>;

  constructor({
    expires,
    algorithm = "ECDSA",
    fingerprints,
    certificatePem = null,
    keyPem = null,
  } = {}) {
    this.expires = expires;
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

  getFingerprints() {
    return this._fingerprints.map((fingerprint) => ({ ...fingerprint }));
  }
}

export function getCertificateMaterial(certificate) {
  return certificate instanceof RTCCertificate ? certificateMaterial.get(certificate) : undefined;
}

export function sameCertificateSet(left, right) {
  if (left.length !== right.length) return false;
  return left.every((certificate, index) => certificate === right[index]);
}

export function normalizeCertificateExpiration(value) {
  if (value === undefined) return Date.now() + 30 * 24 * 60 * 60 * 1000;
  const number = Number(value);
  if (!Number.isFinite(number) || !Number.isInteger(number) || number < 0) {
    throw new TypeError("expires must be a non-negative integer");
  }
  return Date.now() + number;
}

export function normalizeCertificateAlgorithm(algorithm) {
  if (typeof algorithm === "string") {
    throw makeDOMException("Unsupported certificate algorithm", "NotSupportedError");
  }
  if (algorithm === null || typeof algorithm !== "object") {
    throw makeDOMException("Unsupported certificate algorithm", "NotSupportedError");
  }
  const name = String(algorithm.name || "").toUpperCase();
  if (name === "ECDSA") {
    if (String(algorithm.namedCurve || "").toUpperCase() !== "P-256") {
      throw makeDOMException("Unsupported ECDSA curve", "NotSupportedError");
    }
    return { name: "ECDSA" };
  }
  if (name === "RSASSA-PKCS1-V1_5") {
    const hash =
      typeof algorithm.hash === "object" && algorithm.hash !== null
        ? String(algorithm.hash.name || "")
        : String(algorithm.hash || "");
    if (hash.toUpperCase() !== "SHA-256") {
      throw makeDOMException("Unsupported RSA hash", "NotSupportedError");
    }
    const modulusLength = Number(algorithm.modulusLength);
    if (!Number.isInteger(modulusLength) || modulusLength < 1024) {
      throw makeDOMException("Unsupported RSA modulus length", "NotSupportedError");
    }
    return { name: "RSASSA-PKCS1-v1_5", modulusLength };
  }
  throw makeDOMException("Unsupported certificate algorithm", "NotSupportedError");
}

export function createNativeBackedCertificate({ normalizedAlgorithm, expires, expiresMs }) {
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

export function importCertificate({ certificatePem, privateKeyPem, expires } = {}) {
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
    throw new TypeError(`Invalid certificate material: ${error?.message || String(error)}`);
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
export function createDefaultNativeCertificate() {
  const material = native.takeDefaultCertificate();
  return new RTCCertificate({
    expires: material.expires,
    algorithm: "ECDSA",
    fingerprints: material.fingerprints,
    certificatePem: material.certificatePem,
    keyPem: material.keyPem,
  });
}

export function certificatePemToArrayBuffer(pem) {
  const raw = new crypto.X509Certificate(pem).raw;
  return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
}

export function generateCertificate(algorithm) {
  try {
    const normalizedAlgorithm = normalizeCertificateAlgorithm(algorithm);
    const expiresInput = algorithm && typeof algorithm === "object" ? algorithm.expires : undefined;
    const expires = normalizeCertificateExpiration(expiresInput);
    const expiresMs = expiresInput === undefined ? 30 * 24 * 60 * 60 * 1000 : Number(expiresInput);
    return Promise.resolve(
      createNativeBackedCertificate({ normalizedAlgorithm, expires, expiresMs }),
    );
  } catch (error) {
    return Promise.reject(error);
  }
}
