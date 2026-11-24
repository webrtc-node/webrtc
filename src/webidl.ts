import { types } from "node:util";

type Getter<This, Value> = (this: This) => Value;

function intrinsicGetter<This, Value>(target: object, name: string): Getter<This, Value> {
  const getter = Object.getOwnPropertyDescriptor(target, name)?.get;
  if (!getter) throw new TypeError(`Missing intrinsic accessor ${name}`);
  return getter as Getter<This, Value>;
}

function optionalGetter<This, Value>(
  target: object,
  name: string,
): Getter<This, Value> | undefined {
  return Object.getOwnPropertyDescriptor(target, name)?.get as Getter<This, Value> | undefined;
}

// Intrinsic accessors, captured once so user code cannot shadow them.
export const arrayBufferByteLength = intrinsicGetter<ArrayBufferLike, number>(
  ArrayBuffer.prototype,
  "byteLength",
);
export const arrayBufferResizable = optionalGetter<ArrayBufferLike, boolean>(
  ArrayBuffer.prototype,
  "resizable",
);
export const arrayBufferDetached = optionalGetter<ArrayBufferLike, boolean>(
  ArrayBuffer.prototype,
  "detached",
);
export const typedArrayPrototype: object = Object.getPrototypeOf(Uint8Array.prototype);
export const typedArrayBuffer = intrinsicGetter<ArrayBufferView, ArrayBufferLike>(
  typedArrayPrototype,
  "buffer",
);
export const typedArrayByteOffset = intrinsicGetter<ArrayBufferView, number>(
  typedArrayPrototype,
  "byteOffset",
);
export const typedArrayByteLength = intrinsicGetter<ArrayBufferView, number>(
  typedArrayPrototype,
  "byteLength",
);
export const dataViewBuffer = intrinsicGetter<ArrayBufferView, ArrayBufferLike>(
  DataView.prototype,
  "buffer",
);
export const dataViewByteOffset = intrinsicGetter<ArrayBufferView, number>(
  DataView.prototype,
  "byteOffset",
);
export const dataViewByteLength = intrinsicGetter<ArrayBufferView, number>(
  DataView.prototype,
  "byteLength",
);

export function byteLength(value: unknown): number {
  return Buffer.byteLength(String(value), "utf8");
}

export function enforceRange(value: unknown, name: string, max = 65535): number {
  // Unary plus, unlike Number(), throws for a BigInt as WebIDL requires.
  const number = Math.trunc(+(value as number));
  if (!Number.isFinite(number) || number < 0 || number > max) {
    throw new TypeError(`${name} must be an integer between 0 and ${max}`);
  }
  return number === 0 ? 0 : number;
}

export function toUnsignedLong(value: unknown): number {
  if (typeof value === "bigint" || Object.prototype.toString.call(value) === "[object BigInt]") {
    throw new TypeError("Cannot convert BigInt to unsigned long");
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number === 0) return 0;
  const integer = Math.trunc(number);
  const modulo = 2 ** 32;
  return ((integer % modulo) + modulo) % modulo;
}

export function validateByteLength(value: unknown, name: string): void {
  if (byteLength(value) > 65535) {
    throw new TypeError(`${name} exceeds 65535 bytes`);
  }
}

export function normalizeEnum<T extends string, D>(
  value: unknown,
  name: string,
  allowed: readonly T[],
  defaultValue: D,
): T | D {
  if (value === undefined) return defaultValue;
  const string = toDOMString(value);
  if (!(allowed as readonly string[]).includes(string)) {
    throw new TypeError(`${name} must be one of: ${allowed.join(", ")}`);
  }
  return string as T;
}

export function isObject(value: unknown): value is object {
  return value !== null && (typeof value === "object" || typeof value === "function");
}

export function toDOMString(value: unknown): string {
  if (typeof value === "symbol") throw new TypeError("Cannot convert a Symbol to a string");
  return String(value);
}

export function sequenceFromIterator<T>(
  value: unknown,
  iterator: (...args: unknown[]) => Iterator<unknown>,
  convert: (item: unknown, index: number) => T,
): T[] {
  return Array.from({ [Symbol.iterator]: () => Reflect.apply(iterator, value, []) }, convert);
}

export function normalizeSequence<T>(
  value: unknown,
  convert: (item: unknown, index: number) => T,
  name: string,
): T[] {
  if (!isObject(value)) throw new TypeError(`${name} must be iterable`);
  const iterator = (value as { [Symbol.iterator]?: unknown })[Symbol.iterator];
  if (typeof iterator !== "function") throw new TypeError(`${name} must be iterable`);
  return sequenceFromIterator(
    value,
    iterator as (...args: unknown[]) => Iterator<unknown>,
    convert,
  );
}

export function toUint8Array(data: unknown): Uint8Array {
  const isBuffer = types.isArrayBuffer(data);
  const isDataView = types.isDataView(data);
  let buffer: ArrayBufferLike;
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
  const view = data as ArrayBufferView;
  return new Uint8Array(
    buffer,
    (isDataView ? dataViewByteOffset : typedArrayByteOffset).call(view),
    (isDataView ? dataViewByteLength : typedArrayByteLength).call(view),
  );
}
