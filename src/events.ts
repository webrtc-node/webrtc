import type { RTCDataChannel } from "./data-channel";
import type { RTCError } from "./errors";
import { makeDOMException } from "./errors";
import { RTCIceCandidate } from "./sdp";
import { enforceRange } from "./webidl";

// A listener is a function or an object with handleEvent, as in the DOM.
export type EventListenerValue =
  | ((this: unknown, event: never) => unknown)
  | { handleEvent(event: never): unknown };

interface ListenerEntry {
  callback: EventListenerValue;
  once: boolean;
  capture: boolean;
  removed: boolean;
}

// Any object with a string type can be dispatched, not only SimpleEvent.
export interface DispatchableEvent {
  type: string;
  defaultPrevented?: boolean;
  target?: unknown;
  currentTarget?: unknown;
}

export const kHandlers = new WeakMap<object, Map<string, ListenerEntry[]>>();
export const dispatchingEvents = new WeakSet<object>();

export const kDispatching: unique symbol = Symbol("dispatching");
export const EMPTY_PORTS: readonly never[] = Object.freeze([]);

export interface SimpleEventInit {
  bubbles?: boolean;
  cancelable?: boolean;
}

export class SimpleEvent {
  type: string;
  bubbles: boolean;
  cancelable: boolean;
  defaultPrevented: boolean;
  target: SimpleEventTarget | null;
  currentTarget: SimpleEventTarget | null;
  [kDispatching]: boolean;

  constructor(type: unknown, init: SimpleEventInit = {}) {
    this.type = String(type);
    this.bubbles = Boolean(init.bubbles);
    this.cancelable = Boolean(init.cancelable);
    this.defaultPrevented = false;
    this.target = null;
    this.currentTarget = null;
    this[kDispatching] = false;
  }

  preventDefault(): void {
    if (this.cancelable) this.defaultPrevented = true;
  }
}

export interface SimpleMessageEventInit extends SimpleEventInit {
  data?: unknown;
  origin?: string;
  lastEventId?: string;
  source?: unknown;
  ports?: readonly unknown[];
}

export class SimpleMessageEvent extends SimpleEvent {
  data: unknown;
  origin: string;
  lastEventId: string;
  source: unknown;
  ports: readonly unknown[];

  constructor(type: unknown, init: SimpleMessageEventInit = {}) {
    super(type, init);
    this.data = init.data;
    this.origin = init.origin || "";
    this.lastEventId = init.lastEventId || "";
    this.source = init.source || null;
    this.ports = init.ports || EMPTY_PORTS;
  }
}

export class SimpleEventTarget {
  // Optional hooks that subclasses implement to track listener interest.
  _eventListenerAdded?(type: string): void;
  _eventListenerRemoved?(type: string): void;

  addEventListener(type: unknown, callback: unknown, options: unknown = undefined): void {
    if (callback == null) return;
    if (typeof callback !== "function" && typeof callback !== "object") {
      throw new TypeError("Event listener must be a function or an object");
    }
    let map = kHandlers.get(this);
    if (!map) {
      map = new Map();
      kHandlers.set(this, map);
    }
    const key = String(type);
    let listeners = map.get(key);
    if (!listeners) {
      listeners = [];
      map.set(key, listeners);
    }
    const once =
      typeof options === "object" &&
      options !== null &&
      Boolean((options as { once?: unknown }).once);
    const capture = listenerCapture(options);
    let added = false;
    if (
      !listeners.some((listener) => listener.callback === callback && listener.capture === capture)
    ) {
      listeners.push({ callback: callback as EventListenerValue, once, capture, removed: false });
      added = true;
    }
    if (added && typeof this._eventListenerAdded === "function") this._eventListenerAdded(key);
  }

  removeEventListener(type: unknown, callback: unknown, options: unknown = undefined): void {
    const key = String(type);
    const listeners = kHandlers.get(this)?.get(key);
    if (!listeners) return;
    const capture = listenerCapture(options);
    const index = listeners.findIndex(
      (listener) => listener.callback === callback && listener.capture === capture,
    );
    if (index !== -1) {
      listeners[index].removed = true;
      listeners.splice(index, 1);
      if (typeof this._eventListenerRemoved === "function") this._eventListenerRemoved(key);
    }
  }

  dispatchEvent(event: unknown): boolean {
    if (!event || typeof (event as DispatchableEvent).type !== "string") {
      throw new TypeError("dispatchEvent requires an Event object");
    }
    const dispatched = event as DispatchableEvent;
    beginEventDispatch(this, dispatched);
    try {
      const registeredListeners = kHandlers.get(this)?.get(dispatched.type);
      const listeners = registeredListeners?.length ? Array.from(registeredListeners) : null;
      const handler = (this as unknown as Record<string, unknown>)[`on${dispatched.type}`];
      if (listeners) {
        for (const listener of listeners) {
          if (listener.removed) continue;
          if (listener.once)
            this.removeEventListener(dispatched.type, listener.callback, listener.capture);
          callListener(listener.callback, this, dispatched);
        }
      }
      if (typeof handler === "function") {
        callListener(handler as EventListenerValue, this, dispatched);
      }
      return !dispatched.defaultPrevented;
    } finally {
      endEventDispatch(dispatched);
    }
  }

  _hasEventConsumer(type: unknown): boolean {
    const listeners = kHandlers.get(this)?.get(String(type));
    return Boolean(
      (listeners && listeners.length > 0) ||
        typeof (this as unknown as Record<string, unknown>)[`on${type}`] === "function",
    );
  }
}

export function listenerCapture(options: unknown): boolean {
  return typeof options === "object" && options !== null
    ? Boolean((options as { capture?: unknown }).capture)
    : Boolean(options);
}

// Facade events carry their dispatch flag; other event objects use the WeakSet.
export function beginEventDispatch(target: object, event: DispatchableEvent): void {
  const ownEvent = event instanceof SimpleEvent;
  if (ownEvent ? event[kDispatching] : dispatchingEvents.has(event)) {
    throw makeDOMException("Event is already being dispatched", "InvalidStateError");
  }
  event.target = target;
  event.currentTarget = target;
  if (ownEvent) event[kDispatching] = true;
  else dispatchingEvents.add(event);
}

export function endEventDispatch(event: DispatchableEvent): void {
  event.currentTarget = null;
  if (event instanceof SimpleEvent) event[kDispatching] = false;
  else dispatchingEvents.delete(event);
}

export function dispatchDirectEvent(
  target: object,
  event: DispatchableEvent,
  handler: EventListenerValue,
): void {
  beginEventDispatch(target, event);
  try {
    callListener(handler, target, event);
  } finally {
    endEventDispatch(event);
  }
}

export function callListener(listener: EventListenerValue, target: unknown, event: unknown): void {
  try {
    if (typeof listener === "function") {
      (listener as (this: unknown, event: unknown) => unknown).call(target, event);
    } else {
      (listener as { handleEvent(event: unknown): unknown }).handleEvent(event);
    }
  } catch (error) {
    // Report through Node without interrupting event delivery or native cleanup.
    process.nextTick(() => {
      throw error;
    });
  }
}

export function makeEvent(type: string, init?: SimpleEventInit): SimpleEvent {
  return new SimpleEvent(type, init);
}

export function makeMessageEvent(type: string, init?: SimpleMessageEventInit): SimpleMessageEvent {
  return new SimpleMessageEvent(type, init);
}

export const dataMessageInit: { data: unknown } = { data: undefined };

// Per-message fast path: reuses one init dictionary instead of allocating one.
export function makeDataMessageEvent(data: unknown): SimpleMessageEvent {
  dataMessageInit.data = data;
  const event = new SimpleMessageEvent("message", dataMessageInit);
  dataMessageInit.data = undefined;
  return event;
}

export interface RTCDataChannelEventInit extends SimpleEventInit {
  channel?: RTCDataChannel;
}

export class RTCDataChannelEvent extends SimpleEvent {
  channel: RTCDataChannel;

  constructor(type: unknown, init: RTCDataChannelEventInit) {
    if (!init || !init.channel) throw new TypeError("RTCDataChannelEventInit.channel is required");
    super(type, init);
    this.channel = init.channel;
  }
}

export interface RTCPeerConnectionIceEventInit extends SimpleEventInit {
  candidate?: RTCIceCandidate | null;
  url?: string | null;
}

export class RTCPeerConnectionIceEvent extends SimpleEvent {
  candidate: RTCIceCandidate | null;
  url: string | null;

  constructor(type: unknown, init: RTCPeerConnectionIceEventInit = {}) {
    if (arguments.length === 0) throw new TypeError("type is required");
    if (
      init.candidate !== undefined &&
      init.candidate !== null &&
      !(init.candidate instanceof RTCIceCandidate)
    ) {
      throw new TypeError("candidate must be an RTCIceCandidate or null");
    }
    super(type, init);
    this.candidate = init.candidate == null ? null : init.candidate;
    this.url = init.url === undefined ? null : init.url;
  }
}

export interface RTCPeerConnectionIceErrorEventInit extends SimpleEventInit {
  address?: unknown;
  port?: unknown;
  url?: unknown;
  errorCode?: unknown;
  errorText?: unknown;
}

export class RTCPeerConnectionIceErrorEvent extends SimpleEvent {
  address: string | null;
  port: number | null;
  url: string;
  errorCode: number;
  errorText: string;

  constructor(type: unknown, init: RTCPeerConnectionIceErrorEventInit = {}) {
    if (arguments.length === 0) throw new TypeError("type is required");
    super(type, init);
    this.address =
      init.address === undefined || init.address === null ? null : String(init.address);
    this.port =
      init.port === undefined || init.port === null ? null : enforceRange(init.port, "port");
    this.url = init.url === undefined ? "" : String(init.url);
    this.errorCode = init.errorCode === undefined ? 0 : enforceRange(init.errorCode, "errorCode");
    this.errorText = init.errorText === undefined ? "" : String(init.errorText);
  }
}

export interface RTCErrorEventInit extends SimpleEventInit {
  error?: RTCError;
}

export class RTCErrorEvent extends SimpleEvent {
  error: RTCError | undefined;

  constructor(type: unknown, init: RTCErrorEventInit = {}) {
    super(type, init);
    this.error = init.error;
  }
}
