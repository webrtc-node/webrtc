// @ts-nocheck -- converted from JavaScript; strict typing lands module by module.

export const kInternalConstruct = Symbol("internalConstruct");

export function makeDOMException(message, name) {
  if (typeof globalThis.DOMException === "function") {
    return new globalThis.DOMException(message, name);
  }
  const error = new Error(message);
  error.name = name;
  return error;
}

export function mapNativeError(error, fallbackName = "OperationError") {
  if (error?.name && error.name !== "Error") return error;
  return makeDOMException(error?.message || String(error), fallbackName);
}

export class RTCError extends Error {
  constructor(init, message = "") {
    if (!init || typeof init !== "object" || init.errorDetail === undefined) {
      throw new TypeError("RTCErrorInit.errorDetail is required");
    }
    const errorDetail = String(init.errorDetail);
    if (
      ![
        "data-channel-failure",
        "dtls-failure",
        "fingerprint-failure",
        "sctp-failure",
        "sdp-syntax-error",
        "hardware-encoder-error",
        "hardware-encoder-not-available",
      ].includes(errorDetail)
    ) {
      throw new TypeError(`Invalid RTCErrorDetailType: ${errorDetail}`);
    }
    super(message);
    defineReadonly(this, "name", "OperationError");
    defineReadonly(this, "code", 0);
    defineReadonly(this, "errorDetail", errorDetail);
    defineReadonly(this, "sdpLineNumber", init.sdpLineNumber ?? null);
    defineReadonly(this, "sctpCauseCode", init.sctpCauseCode ?? null);
    defineReadonly(this, "receivedAlert", init.receivedAlert ?? null);
    defineReadonly(this, "sentAlert", init.sentAlert ?? null);
  }
}

export function defineReadonly(target, name, value) {
  Object.defineProperty(target, name, {
    value,
    enumerable: true,
    configurable: true,
    writable: false,
  });
}
