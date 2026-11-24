// @ts-nocheck -- converted from JavaScript; strict typing lands module by module.

import { makeDOMException } from "./errors";
import { RTCIceCandidate } from "./sdp";
import { enforceRange } from "./webidl";

export const kHandlers = new WeakMap();
export const dispatchingEvents = new WeakSet();

export const kDispatching = Symbol("dispatching");
export const EMPTY_PORTS = Object.freeze([]);

export class SimpleEvent {
  constructor(type, init = {}) {
    this.type = String(type);
    this.bubbles = Boolean(init.bubbles);
    this.cancelable = Boolean(init.cancelable);
    this.defaultPrevented = false;
    this.target = null;
    this.currentTarget = null;
    this[kDispatching] = false;
  }

  preventDefault() {
    if (this.cancelable) this.defaultPrevented = true;
  }
}

export class SimpleMessageEvent extends SimpleEvent {
  constructor(type, init = {}) {
    super(type, init);
    this.data = init.data;
    this.origin = init.origin || "";
    this.lastEventId = init.lastEventId || "";
    this.source = init.source || null;
    this.ports = init.ports || EMPTY_PORTS;
  }
}

export class SimpleEventTarget {
  addEventListener(type, callback, options = undefined) {
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
    const once = typeof options === "object" && options !== null && Boolean(options.once);
    const capture = listenerCapture(options);
    let added = false;
    if (
      !listeners.some((listener) => listener.callback === callback && listener.capture === capture)
    ) {
      listeners.push({ callback, once, capture, removed: false });
      added = true;
    }
    if (added && typeof this._eventListenerAdded === "function") this._eventListenerAdded(key);
  }

  removeEventListener(type, callback, options = undefined) {
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

  dispatchEvent(event) {
    if (!event || typeof event.type !== "string") {
      throw new TypeError("dispatchEvent requires an Event object");
    }
    beginEventDispatch(this, event);
    try {
      const registeredListeners = kHandlers.get(this)?.get(event.type);
      const listeners = registeredListeners?.length ? Array.from(registeredListeners) : null;
      const handler = this[`on${event.type}`];
      if (listeners) {
        for (const listener of listeners) {
          if (listener.removed) continue;
          if (listener.once)
            this.removeEventListener(event.type, listener.callback, listener.capture);
          callListener(listener.callback, this, event);
        }
      }
      if (typeof handler === "function") callListener(handler, this, event);
      return !event.defaultPrevented;
    } finally {
      endEventDispatch(event);
    }
  }

  _hasEventConsumer(type) {
    const listeners = kHandlers.get(this)?.get(String(type));
    return Boolean((listeners && listeners.length > 0) || typeof this[`on${type}`] === "function");
  }
}

export function listenerCapture(options) {
  return typeof options === "object" && options !== null
    ? Boolean(options.capture)
    : Boolean(options);
}

// Facade events carry their dispatch flag; other event objects use the WeakSet.
export function beginEventDispatch(target, event) {
  const ownEvent = event instanceof SimpleEvent;
  if (ownEvent ? event[kDispatching] : dispatchingEvents.has(event)) {
    throw makeDOMException("Event is already being dispatched", "InvalidStateError");
  }
  event.target = target;
  event.currentTarget = target;
  if (ownEvent) event[kDispatching] = true;
  else dispatchingEvents.add(event);
}

export function endEventDispatch(event) {
  event.currentTarget = null;
  if (event instanceof SimpleEvent) event[kDispatching] = false;
  else dispatchingEvents.delete(event);
}

export function dispatchDirectEvent(target, event, handler) {
  beginEventDispatch(target, event);
  try {
    callListener(handler, target, event);
  } finally {
    endEventDispatch(event);
  }
}

export function callListener(listener, target, event) {
  try {
    if (typeof listener === "function") {
      listener.call(target, event);
    } else {
      listener.handleEvent(event);
    }
  } catch (error) {
    // Report through Node without interrupting event delivery or native cleanup.
    process.nextTick(() => {
      throw error;
    });
  }
}

export function makeEvent(type, init) {
  return new SimpleEvent(type, init);
}

export function makeMessageEvent(type, init) {
  return new SimpleMessageEvent(type, init);
}

export const dataMessageInit = { data: undefined };

// Per-message fast path: reuses one init dictionary instead of allocating one.
export function makeDataMessageEvent(data) {
  dataMessageInit.data = data;
  const event = new SimpleMessageEvent("message", dataMessageInit);
  dataMessageInit.data = undefined;
  return event;
}

export class RTCDataChannelEvent extends SimpleEvent {
  constructor(type, init) {
    if (!init || !init.channel) throw new TypeError("RTCDataChannelEventInit.channel is required");
    super(type, init);
    this.channel = init.channel;
  }
}

export class RTCPeerConnectionIceEvent extends SimpleEvent {
  constructor(type, init = {}) {
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

export class RTCPeerConnectionIceErrorEvent extends SimpleEvent {
  constructor(type, init = {}) {
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

export class RTCErrorEvent extends SimpleEvent {
  constructor(type, init = {}) {
    super(type, init);
    this.error = init.error;
  }
}
