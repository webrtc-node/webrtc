export const kInternalConstruct: unique symbol = Symbol("internalConstruct");

export function makeDOMException(message: string, name: string): Error {
  if (typeof globalThis.DOMException === "function") {
    return new globalThis.DOMException(message, name);
  }
  const error = new Error(message);
  error.name = name;
  return error;
}

export function mapNativeError(error: unknown, fallbackName = "OperationError"): Error {
  const value = error as { name?: string; message?: string } | null | undefined;
  if (value?.name && value.name !== "Error") return error as Error;
  return makeDOMException(value?.message || String(error), fallbackName);
}

export interface RTCErrorInit {
  errorDetail: string;
  sdpLineNumber?: number | null;
  sctpCauseCode?: number | null;
  receivedAlert?: number | null;
  sentAlert?: number | null;
}

export class RTCError extends Error {
  // Set as read-only own properties in the constructor.
  // Always 0; RTCError is not a legacy DOMException code holder.
  declare readonly code: 0;
  declare readonly errorDetail: string;
  declare readonly sdpLineNumber: number | null;
  declare readonly sctpCauseCode: number | null;
  declare readonly receivedAlert: number | null;
  declare readonly sentAlert: number | null;

  constructor(init: RTCErrorInit, message = "") {
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

export function defineReadonly(target: object, name: PropertyKey, value: unknown): void {
  Object.defineProperty(target, name, {
    value,
    enumerable: true,
    configurable: true,
    writable: false,
  });
}
