// @ts-nocheck -- converted from JavaScript; strict typing lands module by module.

const { types } = require("node:util");

export const arrayBufferByteLength = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  "byteLength",
).get;
export const arrayBufferResizable = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  "resizable",
)?.get;
export const arrayBufferDetached = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  "detached",
)?.get;
export const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
export const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer").get;
export const typedArrayByteOffset = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  "byteOffset",
).get;
export const typedArrayByteLength = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  "byteLength",
).get;
export const dataViewBuffer = Object.getOwnPropertyDescriptor(DataView.prototype, "buffer").get;
export const dataViewByteOffset = Object.getOwnPropertyDescriptor(
  DataView.prototype,
  "byteOffset",
).get;
export const dataViewByteLength = Object.getOwnPropertyDescriptor(
  DataView.prototype,
  "byteLength",
).get;

export function byteLength(value) {
  return Buffer.byteLength(String(value), "utf8");
}

export function enforceRange(value, name, max = 65535) {
  const number = Math.trunc(+value);
  if (!Number.isFinite(number) || number < 0 || number > max) {
    throw new TypeError(`${name} must be an integer between 0 and ${max}`);
  }
  return number === 0 ? 0 : number;
}

export function toUnsignedLong(value) {
  if (typeof value === "bigint" || Object.prototype.toString.call(value) === "[object BigInt]") {
    throw new TypeError("Cannot convert BigInt to unsigned long");
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number === 0) return 0;
  const integer = Math.trunc(number);
  const modulo = 2 ** 32;
  return ((integer % modulo) + modulo) % modulo;
}

export function validateByteLength(value, name) {
  if (byteLength(value) > 65535) {
    throw new TypeError(`${name} exceeds 65535 bytes`);
  }
}

export function normalizeEnum(value, name, allowed, defaultValue) {
  if (value === undefined) return defaultValue;
  const string = toDOMString(value);
  if (!allowed.includes(string)) {
    throw new TypeError(`${name} must be one of: ${allowed.join(", ")}`);
  }
  return string;
}

export function isObject(value) {
  return value !== null && (typeof value === "object" || typeof value === "function");
}

export function toDOMString(value) {
  if (typeof value === "symbol") throw new TypeError("Cannot convert a Symbol to a string");
  return String(value);
}

export function sequenceFromIterator(value, iterator, convert) {
  return Array.from({ [Symbol.iterator]: () => Reflect.apply(iterator, value, []) }, convert);
}

export function normalizeSequence(value, convert, name) {
  if (!isObject(value)) throw new TypeError(`${name} must be iterable`);
  const iterator = value[Symbol.iterator];
  if (typeof iterator !== "function") throw new TypeError(`${name} must be iterable`);
  return sequenceFromIterator(value, iterator, convert);
}

export function toUint8Array(data) {
  const isBuffer = types.isArrayBuffer(data);
  const isDataView = types.isDataView(data);
  let buffer;
  if (isBuffer) {
    buffer = data;
  } else if (ArrayBuffer.isView(data)) {
    buffer = (isDataView ? dataViewBuffer : typedArrayBuffer).call(data);
  } else {
    throw new TypeError(
      "RTCDataChannel.send expects a string, Blob, ArrayBuffer, or ArrayBufferView",
    );
  }
  if (types.isSharedArrayBuffer(buffer)) {
    throw new TypeError("RTCDataChannel.send buffer must not be shared");
  }
  if (arrayBufferResizable?.call(buffer)) {
    throw new TypeError("RTCDataChannel.send buffer must not be resizable");
  }
  const size = arrayBufferByteLength.call(buffer);
  if (arrayBufferDetached) {
    if (arrayBufferDetached.call(buffer)) return new Uint8Array();
  } else if (size === 0) {
    // Node 20 lacks ArrayBuffer.prototype.detached. Constructing a view checks it.
    try {
      new Uint8Array(buffer);
    } catch {
      return new Uint8Array();
    }
  }
  if (isBuffer) return new Uint8Array(buffer);
  return new Uint8Array(
    buffer,
    (isDataView ? dataViewByteOffset : typedArrayByteOffset).call(data),
    (isDataView ? dataViewByteLength : typedArrayByteLength).call(data),
  );
}
