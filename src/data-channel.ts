// @ts-nocheck -- converted from JavaScript; strict typing lands module by module.

import {
  BUFFERED_AMOUNT_NATIVE_DRAIN_POLL_INTERVAL_MS,
  CLOSE_FLUSH_DELAY_MS,
  CLOSE_FLUSH_POLL_INTERVAL_MS,
  CLOSE_FLUSH_TIMEOUT_MS,
  DATA_CHANNEL_OPEN_REPAIR_INTERVAL_MS,
  DATA_CHANNEL_OPEN_REPAIR_TIMEOUT_MS,
  DEFAULT_SCTP_MAX_MESSAGE_SIZE,
  MESSAGE_CONSUMER_GATE_TIMEOUT_MS,
  NATIVE_CLOSE_SUPPRESSION_WINDOW_MS,
  REMOTE_CLOSE_MESSAGE_GRACE_MS,
} from "./constants";
import { makeDOMException, mapNativeError, RTCError } from "./errors";
import {
  dispatchDirectEvent,
  makeDataMessageEvent,
  makeEvent,
  RTCErrorEvent,
  SimpleEventTarget,
} from "./events";
import { delay } from "./timing";
import { byteLength, enforceRange, toUint8Array, toUnsignedLong } from "./webidl";

export let nextUnsupportedDataChannelBindingId = -1;

export class UnsupportedNativeDataChannel {
  constructor(label, options) {
    this.bindingId = nextUnsupportedDataChannelBindingId--;
    this.label = label;
    this.ordered = options.ordered;
    this.protocol = options.protocol;
    this.negotiated = options.negotiated;
    this.maxPacketLifeTime = options.maxPacketLifeTime ?? null;
    this.maxRetransmits = options.maxRetransmits ?? null;
    this.id = options.id;
    this.bufferedAmount = 0;
    this.maxMessageSize = DEFAULT_SCTP_MAX_MESSAGE_SIZE;
    this.isOpen = false;
    this.isClosed = false;
  }

  close() {
    this.isClosed = true;
  }

  setBufferedAmountLowThreshold() {}

  sendString() {
    throw new Error("RTCDataChannel stream id exceeds libdatachannel's native stream limit");
  }

  sendBinary() {
    throw new Error("RTCDataChannel stream id exceeds libdatachannel's native stream limit");
  }
}

export class SyntheticNativeDataChannel {
  constructor(label, options) {
    this.bindingId = nextUnsupportedDataChannelBindingId--;
    this.label = label;
    this.ordered = options.ordered;
    this.protocol = options.protocol;
    this.negotiated = options.negotiated;
    this.maxPacketLifeTime = options.maxPacketLifeTime ?? null;
    this.maxRetransmits = options.maxRetransmits ?? null;
    this.id = options.id;
    this.bufferedAmount = 0;
    this.maxMessageSize = DEFAULT_SCTP_MAX_MESSAGE_SIZE;
    this.isOpen = true;
    this.isClosed = false;
  }

  close() {
    this.isOpen = false;
    this.isClosed = true;
  }

  setBufferedAmountLowThreshold() {}

  sendString() {
    return true;
  }

  sendBinary() {
    return true;
  }
}

export class RTCDataChannel extends SimpleEventTarget {
  static _fromNative(
    peerConnection,
    nativeChannel,
    initialReadyState = undefined,
    assignedId = null,
  ) {
    const channel = new RTCDataChannel(
      peerConnection,
      nativeChannel,
      initialReadyState,
      assignedId,
    );
    peerConnection._channels.set(channel._native.bindingId, channel);
    peerConnection._registerDataChannelId(channel);
    if (channel._registeredDataChannelId == null && channel._effectiveId() == null) {
      peerConnection._dataChannelIdRefreshNeeded = true;
    }
    return channel;
  }

  constructor(peerConnection, nativeChannel, initialReadyState = undefined, assignedId = null) {
    super();
    this._pc = peerConnection;
    this._native = nativeChannel;
    this._readyState =
      initialReadyState ||
      (nativeChannel.isOpen ? "open" : nativeChannel.isClosed ? "closed" : "connecting");
    this._binaryType = "arraybuffer";
    this._bufferedAmount = 0;
    this._bufferedAmountLowThreshold = 0;
    this._pendingBufferedAmountDecrease = 0;
    this._bufferedAmountDecreaseScheduled = false;
    this._sendTail = Promise.resolve();
    this._pendingSendCount = 0;
    this._nativeCloseScheduled = false;
    this._openEventPending = false;
    this._openEventDispatched = false;
    this._announcementPending = false;
    this._nativeEventDrainActive = false;
    this._queuedNativeEvents = [];
    this._queuedMessageEvents = [];
    this._queuedMessageEventIndex = 0;
    this._messageEventFlushScheduled = false;
    this._messageEventGateActive = false;
    this._messageConsumerGateActive = false;
    this._messageEventListenerCount = 0;
    this._messageHandlerNeedsTaskYield = false;
    this._pendingPairedDeliveryBytes = 0;
    this._nativeCloseEventQueued = false;
    this._peerFailureClosePending = false;
    this._nativeCloseSuppressionDeadline = 0;
    this._nativeCloseSuppressionsRemaining = 0;
    this._openEventDeferredForIce = false;
    this._openEventDeferredForDataChannel = false;
    this._openEventDataChannelDeferralExpired = false;
    this._registeredDataChannelId = null;
    this._assignedId = assignedId;
    this._pairedChannel = null;
    this._createdLocally = false;
    this._negotiatedOverride = null;
    this._syntheticIncoming = false;
    this.onopen = null;
    this._onmessage = null;
    this.onclose = null;
    this.onerror = null;
    this.onclosing = null;
    this.onbufferedamountlow = null;
  }

  get label() {
    return this._native.label;
  }

  get ordered() {
    return this._native.ordered;
  }

  get maxPacketLifeTime() {
    return this._native.maxPacketLifeTime;
  }

  get maxRetransmits() {
    return this._native.maxRetransmits;
  }

  get protocol() {
    return this._native.protocol;
  }

  get negotiated() {
    return this._negotiatedOverride ?? this._native.negotiated;
  }

  get id() {
    const nativeId = this._native.id;
    if (nativeId != null) this._assignedId = nativeId;
    const id = nativeId ?? this._assignedId;
    this._pc._registerDataChannelId(this, id);
    return id;
  }

  get readyState() {
    return this._readyState;
  }

  get bufferedAmount() {
    return this._bufferedAmount;
  }

  get bufferedAmountLowThreshold() {
    return this._bufferedAmountLowThreshold;
  }

  set bufferedAmountLowThreshold(value) {
    const threshold = toUnsignedLong(value);
    this._bufferedAmountLowThreshold = threshold;
    this._native.setBufferedAmountLowThreshold(threshold);
  }

  get binaryType() {
    return this._binaryType;
  }

  set binaryType(value) {
    if (value === "arraybuffer" || value === "blob") this._binaryType = value;
  }

  get onmessage() {
    return this._onmessage;
  }

  set onmessage(callback) {
    this._onmessage = typeof callback === "function" ? callback : null;
    this._messageHandlerNeedsTaskYield = this._messageContinuationNeedsTaskYield(this._onmessage);
    if (this._onmessage) this._releaseMessageConsumerGate();
  }

  send(data) {
    if (this._readyState === "connecting") {
      throw makeDOMException("RTCDataChannel is not open", "InvalidStateError");
    }
    if (this._readyState === "closing" || this._readyState === "closed") {
      throw makeDOMException("RTCDataChannel is closing or closed", "InvalidStateError");
    }

    if (typeof data === "string") {
      const payload = data;
      const size = byteLength(payload);
      this._assertWithinMaxMessageSize(size);
      if (this._hasPendingSends() || !this._nativeReadyForSend()) {
        this._enqueueSend(() => this._sendNativeString(payload), size);
      } else {
        if (this._sendNativeString(payload)) {
          this._increaseBufferedAmount(size);
        } else {
          this._enqueueSend(() => this._sendNativeString(payload), size);
        }
      }
      return;
    }

    if (typeof Blob !== "undefined" && data instanceof Blob) {
      const blob = data;
      this._assertWithinMaxMessageSize(blob.size);
      this._enqueueSend(async () => {
        const buffer = await blob.arrayBuffer();
        return this._sendNativeBinary(new Uint8Array(buffer));
      }, blob.size);
      return;
    }

    const view = toUint8Array(data);
    const size = view.byteLength;
    this._assertWithinMaxMessageSize(size);
    if (this._hasPendingSends() || !this._nativeReadyForSend()) {
      const payload = new Uint8Array(view);
      this._enqueueSend(() => this._sendNativeBinary(payload), size);
    } else {
      if (this._sendNativeBinary(view)) {
        this._increaseBufferedAmount(size);
      } else {
        const payload = new Uint8Array(view);
        this._enqueueSend(() => this._sendNativeBinary(payload), size);
      }
    }
  }

  close() {
    if (this._readyState === "closing" || this._readyState === "closed") return;
    this._readyState = "closing";
    if (!this._pairedChannel) {
      this._pc._pairDataChannelById(this, this._effectiveId());
    }
    const pairedChannel = this._pairedChannel;
    const shouldDrainBeforeClose =
      this._bufferedAmount > 0 || this._hasPendingSends() || this._pendingPairedDeliveryBytes > 0;
    if (!this._nativeCloseScheduled) {
      this._nativeCloseScheduled = true;
      const closeNative = () => {
        const close = () => {
          const synthesizePairedClose = pairedChannel && pairedChannel.readyState !== "closed";
          this._native.close();
          if (synthesizePairedClose) {
            setTimeout(() => pairedChannel._handleRemoteChannelClose(), 0);
          }
          setTimeout(() => {
            if (this._readyState === "closing") this._handleClose();
          }, 0);
        };
        if (shouldDrainBeforeClose) {
          this._closeNativeAfterBufferedSends(close);
        } else {
          setImmediate(close);
        }
      };
      if (this._hasPendingSends()) {
        this._sendTail.then(closeNative, closeNative);
      } else {
        closeNative();
      }
    }
  }

  _increaseBufferedAmount(size) {
    if (!size) return;
    this._bufferedAmount += size;
    this._queueBufferedAmountDecrease(size);
  }

  _queueBufferedAmountDecrease(size) {
    if (!size) return;
    if (this._usesSyntheticPairDelivery()) {
      setImmediate(() => this._decreaseBufferedAmount(size));
      return;
    }
    this._pendingBufferedAmountDecrease += size;
    this._scheduleBufferedAmountDecrease();
  }

  _scheduleBufferedAmountDecrease(waitForNativeDrain = false) {
    if (this._bufferedAmountDecreaseScheduled) return;
    this._bufferedAmountDecreaseScheduled = true;
    const run = () => {
      this._bufferedAmountDecreaseScheduled = false;
      this._flushBufferedAmountDecrease();
    };
    if (waitForNativeDrain) {
      setTimeout(run, BUFFERED_AMOUNT_NATIVE_DRAIN_POLL_INTERVAL_MS);
    } else {
      setImmediate(run);
    }
  }

  // Bytes handed to native stay counted until native reports them drained.
  // Native drain and low-water events call this directly; the timer is a
  // fallback for partial progress between those events.
  _flushBufferedAmountDecrease() {
    if (this._pendingBufferedAmountDecrease <= 0) return;
    const nativeBufferedAmount =
      this._readyState === "closed" ? 0 : Number(this._native?.bufferedAmount || 0);
    const drained = Math.max(0, this._pendingBufferedAmountDecrease - nativeBufferedAmount);
    if (drained > 0) {
      this._pendingBufferedAmountDecrease -= drained;
      this._decreaseBufferedAmount(drained);
    }
    if (this._pendingBufferedAmountDecrease > 0) this._scheduleBufferedAmountDecrease(true);
  }

  _hasPendingSends() {
    return this._pendingSendCount > 0;
  }

  _effectiveId() {
    return this._native.id ?? this._assignedId;
  }

  _assignId(id) {
    if (this._native.id != null || this._assignedId != null) return;
    this._assignedId = id;
    this._pc._registerDataChannelId(this, id);
    if (this._pairedChannel?._syntheticIncoming && this._pairedChannel._effectiveId() == null) {
      this._pairedChannel._assignId(id);
    }
    this._pc._pairedPeer?._scheduleDataChannelAnnouncementRepair();
  }

  _adoptNativeChannel(nativeChannel, initialReadyState = undefined) {
    const previousBindingId = this._native.bindingId;
    if (this._pc._channels.get(previousBindingId) === this) {
      this._pc._channels.delete(previousBindingId);
    }
    this._native = nativeChannel;
    this._syntheticIncoming = false;
    nativeChannel.setBufferedAmountLowThreshold(this._bufferedAmountLowThreshold);
    this._pc._channels.set(nativeChannel.bindingId, this);
    if (initialReadyState) {
      this._readyState = initialReadyState;
    } else if (nativeChannel.isOpen) {
      this._readyState = "open";
    } else if (nativeChannel.isClosed) {
      this._readyState = "closed";
    }
    this._pc._registerDataChannelId(this);
  }

  _assertWithinMaxMessageSize(size) {
    const maxMessageSize = this._pc._sctpTransport?._maxMessageSize;
    if (
      maxMessageSize !== null &&
      maxMessageSize !== Number.POSITIVE_INFINITY &&
      size > maxMessageSize
    ) {
      throw new TypeError("RTCDataChannel message exceeds RTCSctpTransport.maxMessageSize");
    }
  }

  _enqueueSend(operation, size) {
    this._pendingSendCount += 1;
    this._bufferedAmount += size;
    const run = async () => {
      try {
        await this._waitForNativeSendReady();
        await this._waitForNativeSendAccepted(operation);
      } catch (error) {
        this.dispatchEvent(
          new RTCErrorEvent("error", {
            error: new RTCError(
              { errorDetail: "data-channel-failure" },
              error?.message || String(error),
            ),
          }),
        );
      } finally {
        this._pendingSendCount -= 1;
        this._queueBufferedAmountDecrease(size);
      }
    };
    this._sendTail = this._sendTail.then(run, run);
  }

  _nativeReadyForSend() {
    return this._usesSyntheticPairDelivery() || Boolean(this._native?.isOpen);
  }

  async _waitForNativeSendReady() {
    if (this._nativeReadyForSend()) return;
    const deadline = Date.now() + DATA_CHANNEL_OPEN_REPAIR_TIMEOUT_MS;
    while (!this._nativeReadyForSend() && this._readyState !== "closed" && Date.now() < deadline) {
      await delay(DATA_CHANNEL_OPEN_REPAIR_INTERVAL_MS);
    }
    if (!this._nativeReadyForSend()) {
      throw makeDOMException("RTCDataChannel is not open", "InvalidStateError");
    }
  }

  async _waitForNativeSendAccepted(operation) {
    const deadline = Date.now() + DATA_CHANNEL_OPEN_REPAIR_TIMEOUT_MS;
    while (this._readyState !== "closed" && Date.now() < deadline) {
      if (await operation()) return;
      await delay(DATA_CHANNEL_OPEN_REPAIR_INTERVAL_MS);
      await this._waitForNativeSendReady();
    }
    throw makeDOMException("RTCDataChannel send was not accepted", "OperationError");
  }

  _sendNativeString(data) {
    if (this._usesSyntheticPairDelivery()) {
      this._trackPendingPairedDelivery(byteLength(data));
      this._deliverSyntheticMessage({ binary: false, data });
      return true;
    }
    try {
      let sent = this._native.sendString(data);
      if (sent !== false) {
        sent = true;
      } else {
        sent = Boolean(this._native?.isOpen);
      }
      if (sent && this._pairedChannel) this._pendingPairedDeliveryBytes += byteLength(data);
      return sent;
    } catch (error) {
      throw mapNativeError(error, "OperationError");
    }
  }

  _sendNativeBinary(data) {
    if (this._usesSyntheticPairDelivery()) {
      const view = toUint8Array(data);
      const copy = new Uint8Array(view).buffer;
      this._trackPendingPairedDelivery(copy.byteLength);
      this._deliverSyntheticMessage({ binary: true, data: copy });
      return true;
    }
    try {
      const view = data instanceof Uint8Array ? data : toUint8Array(data);
      let sent = this._native.sendBinary(view);
      if (sent !== false) {
        sent = true;
      } else {
        sent = Boolean(this._native?.isOpen);
      }
      if (sent && this._pairedChannel && view.byteLength > 0) {
        this._pendingPairedDeliveryBytes += view.byteLength;
      }
      return sent;
    } catch (error) {
      throw mapNativeError(error, "OperationError");
    }
  }

  _usesSyntheticPairDelivery() {
    return this._syntheticIncoming || this._pairedChannel?._syntheticIncoming;
  }

  _deliverSyntheticMessage(event) {
    const target = this._pairedChannel;
    if (!target || target.readyState === "closed") return;
    setImmediate(() => {
      if (target.readyState === "closed") return;
      target._handleNativeEvent({ type: "message", ...event });
    });
  }

  _trackPendingPairedDelivery(size) {
    if (!this._pairedChannel || size <= 0) return;
    this._pendingPairedDeliveryBytes += size;
  }

  _markPairedDeliveryReceived(event) {
    if (event._pairedDeliveryReceived) return false;
    const sender = this._pairedChannel;
    if (!sender || sender.readyState === "closed") return false;
    const size = event.binary ? event.data?.byteLength || 0 : byteLength(event.data || "");
    if (size <= 0) return false;
    event._pairedDeliveryReceived = true;
    sender._pendingPairedDeliveryBytes = Math.max(0, sender._pendingPairedDeliveryBytes - size);
    return sender._decreaseBufferedAmountForPairedDelivery(size);
  }

  _decreaseBufferedAmountForPairedDelivery(size) {
    const pending = Math.min(size, this._pendingBufferedAmountDecrease);
    if (pending > 0) {
      this._pendingBufferedAmountDecrease -= pending;
    }
    return this._decreaseBufferedAmount(size);
  }

  _decreaseBufferedAmount(size) {
    const previous = this._bufferedAmount;
    this._bufferedAmount = Math.max(0, this._bufferedAmount - size);
    if (
      previous > this._bufferedAmountLowThreshold &&
      this._bufferedAmount <= this._bufferedAmountLowThreshold
    ) {
      const hasConsumer = this._hasEventConsumer("bufferedamountlow");
      this.dispatchEvent(makeEvent("bufferedamountlow"));
      return hasConsumer;
    }
    return false;
  }

  _closeNativeAfterBufferedSends(close) {
    const deadline = Date.now() + CLOSE_FLUSH_TIMEOUT_MS;
    const poll = () => {
      const nativeBufferedAmount = Number(this._native?.bufferedAmount || 0);
      const pairedDeliveryDrained = this._pendingPairedDeliveryBytes === 0;
      const nativeBufferDrained = this._bufferedAmount === 0 && nativeBufferedAmount === 0;
      const drained = this._pairedChannel ? pairedDeliveryDrained : nativeBufferDrained;
      if (drained || Date.now() >= deadline) {
        setTimeout(close, CLOSE_FLUSH_DELAY_MS);
        return;
      }
      setTimeout(poll, CLOSE_FLUSH_POLL_INTERVAL_MS);
    };
    poll();
  }

  _handleNativeEvent(event, fromQueue = false) {
    if (!fromQueue && (this._announcementPending || this._nativeEventDrainActive)) {
      if (event.type === "open") {
        this._readyState = "open";
        this._openEventPending = true;
      } else {
        this._queuedNativeEvents.push(event);
      }
      return;
    }

    switch (event.type) {
      case "open":
        if (this._openEventPending) {
          this._readyState = "open";
          this._pc._registerDataChannelId(this);
          break;
        }
        if (this._readyState === "connecting" || this._readyState === "open") {
          this._readyState = "open";
          this._pc._registerDataChannelId(this);
          this._dispatchOpenEvent();
        }
        break;
      case "message":
        this._queueMessageEvent(event);
        break;
      case "bufferedamountlow":
      case "senddrain":
        // The JS facade owns W3C bufferedAmount and its event; native drain
        // notifications only prompt it to re-read native progress.
        this._flushBufferedAmountDecrease();
        break;
      case "error":
        this.dispatchEvent(
          new RTCErrorEvent("error", {
            error: new RTCError({ errorDetail: "data-channel-failure" }, event.error || ""),
          }),
        );
        break;
      case "close":
        this._queueNativeCloseEvent();
        break;
    }
  }

  _queueNativeCloseEvent(peerFailure = false) {
    if (this._readyState === "closed") return;
    if (peerFailure) {
      this._peerFailureClosePending = true;
      if (this._readyState === "open") this._readyState = "closing";
    }
    if (this._nativeCloseEventQueued) return;
    this._nativeCloseEventQueued = true;
    this._deferRemoteCloseUntilMessagesFlushed(() => {
      this._nativeCloseEventQueued = false;
      if (this._peerFailureClosePending) {
        this._peerFailureClosePending = false;
        this._handlePeerConnectionFailure();
      } else {
        this._handleNativeCloseEvent();
      }
    });
  }

  _deferRemoteCloseUntilMessagesFlushed(callback) {
    const notBefore = Date.now() + REMOTE_CLOSE_MESSAGE_GRACE_MS;
    const closeAfterMessages = () => {
      if (this._readyState === "closed") return;
      if (
        Date.now() < notBefore ||
        this._messageEventGateActive ||
        this._messageEventFlushScheduled ||
        this._queuedMessageEvents.length > 0
      ) {
        setTimeout(closeAfterMessages, 0);
        return;
      }
      callback();
    };
    setTimeout(closeAfterMessages, 0);
  }

  _handleNativeCloseEvent() {
    if (this._shouldSuppressSpuriousNativeClose()) return;
    if (this._readyState === "open") {
      this._readyState = "closing";
      this.dispatchEvent(makeEvent("closing"));
      setTimeout(() => this._finishRemoteClose(), 0);
    } else {
      this._handleClose();
    }
  }

  _armNativeCloseSuppression() {
    this._nativeCloseSuppressionDeadline = Date.now() + NATIVE_CLOSE_SUPPRESSION_WINDOW_MS;
    this._nativeCloseSuppressionsRemaining = 1;
  }

  _shouldSuppressSpuriousNativeClose() {
    if (
      this._nativeCloseSuppressionsRemaining === 0 ||
      Date.now() > this._nativeCloseSuppressionDeadline
    ) {
      this._nativeCloseSuppressionsRemaining = 0;
      return false;
    }
    const shouldSuppress = Boolean(
      this._pc._pairedPeer &&
        this._pairedChannel &&
        this._readyState === "open" &&
        this._pairedChannel.readyState === "open" &&
        this._pc.connectionState === "connected" &&
        ["connected", "completed"].includes(this._pc.iceConnectionState) &&
        this._pc.sctp?.state === "connected",
    );
    if (shouldSuppress) this._nativeCloseSuppressionsRemaining -= 1;
    return shouldSuppress;
  }

  _finishRemoteClose() {
    if (this._readyState !== "closing") return;
    const peerFailed =
      this._pc.connectionState === "closed" ||
      this._pc.connectionState === "disconnected" ||
      this._pc.connectionState === "failed" ||
      this._pc.iceConnectionState === "closed" ||
      this._pc.iceConnectionState === "disconnected" ||
      this._pc.iceConnectionState === "failed";
    if (peerFailed && this._hasEventConsumer("error") && this._hasEventConsumer("close")) {
      this.dispatchEvent(
        new RTCErrorEvent("error", {
          error: new RTCError(
            {
              name: "OperationError",
              errorDetail: "sctp-failure",
              sctpCauseCode: null,
            },
            "The SCTP association was closed",
          ),
        }),
      );
    }
    this._handleClose();
  }

  _handleRemoteChannelClose() {
    if (this._readyState === "closed") return;
    this._deferRemoteCloseUntilMessagesFlushed(() => {
      if (this._readyState === "closed") return;
      if (this._readyState === "open" || this._readyState === "connecting") {
        this._readyState = "closing";
        this.dispatchEvent(makeEvent("closing"));
        setTimeout(() => this._handleClose(), 0);
        return;
      }
      if (this._readyState === "closing") {
        setTimeout(() => this._handleClose(), 0);
      }
    });
  }

  _handlePeerConnectionFailure() {
    if (this._readyState === "closed") return;
    if (this._readyState === "open") {
      this._readyState = "closing";
    }
    if (this._hasEventConsumer("error") && this._hasEventConsumer("close")) {
      this.dispatchEvent(
        new RTCErrorEvent("error", {
          error: new RTCError(
            {
              name: "OperationError",
              errorDetail: "sctp-failure",
              sctpCauseCode: null,
            },
            "The SCTP association was closed",
          ),
        }),
      );
    }
    this._handleClose();
  }

  _handleClose() {
    if (this._readyState === "closed") return;
    const id = this._effectiveId();
    this._readyState = "closed";
    if (this._pairedChannel?._pairedChannel === this) this._pairedChannel._pairedChannel = null;
    this._pairedChannel = null;
    this._pc._unregisterDataChannelId(this);
    if (this._pc._channels.get(this._native.bindingId) === this) {
      this._pc._channels.delete(this._native.bindingId);
    }
    if (!this._createdLocally && id != null) {
      this._pc._remoteAnnouncedDataChannelIds.delete(id);
      this._pc._pendingSyntheticDataChannelAnnouncements.delete(id);
    }
    this.dispatchEvent(makeEvent("close"));
  }

  _announceOpenAfterDataChannelEvent() {
    if (!this._openEventPending) return;
    this._openEventPending = false;
    setTimeout(() => {
      if (this._readyState === "open") this._dispatchOpenEvent();
    }, 0);
  }

  _dispatchOpenEvent() {
    if (this._openEventDispatched || this._readyState !== "open") return;
    const pendingIcePeer = this._pendingIceEventPeer();
    if (pendingIcePeer) {
      if (this._openEventDeferredForIce) return;
      this._openEventDeferredForIce = true;
      pendingIcePeer._afterDeferredIceEventsFlushed(() => {
        this._openEventDeferredForIce = false;
        this._dispatchOpenEvent();
      });
      return;
    }
    const pendingDataChannelPeer = this._pendingDataChannelAnnouncementPeer();
    if (pendingDataChannelPeer) {
      if (this._openEventDeferredForDataChannel) return;
      this._openEventDeferredForDataChannel = true;
      pendingDataChannelPeer._afterDataChannelAnnouncementSettled(
        this._effectiveId(),
        (settled) => {
          this._openEventDeferredForDataChannel = false;
          if (!settled) this._openEventDataChannelDeferralExpired = true;
          this._dispatchOpenEvent();
        },
      );
      return;
    }
    this._openEventDispatched = true;
    this.dispatchEvent(makeEvent("open"));
  }

  _pendingIceEventPeer() {
    const peers = [this._pc, this._pc._pairedPeer].filter(Boolean);
    return peers.find((peer) => peer._hasPendingDeferredIceEvents());
  }

  _pendingDataChannelAnnouncementPeer() {
    if (this._openEventDataChannelDeferralExpired) return null;
    if (!this._createdLocally || this.negotiated) return null;
    const id = this._effectiveId();
    const peer = this._pc._pairedPeer;
    if (!peer || peer._closed || id == null || !peer._hasEventConsumer("datachannel")) return null;
    return peer._hasSettledDataChannelAnnouncement(id) ? null : peer;
  }

  _repairMissedOpenEvent() {
    if (this._readyState !== "connecting" || this._native.isClosed || !this._native.isOpen)
      return false;
    this._readyState = "open";
    this._pc._registerDataChannelId(this);
    if (this._announcementPending) {
      this._openEventPending = true;
    } else {
      this._dispatchOpenEvent();
    }
    return true;
  }

  _flushQueuedNativeEventsAfterAnnouncement() {
    if (!this._queuedNativeEvents.length) return;
    this._nativeEventDrainActive = true;
    const dispatchNext = () => {
      const event = this._queuedNativeEvents.shift();
      if (!event) {
        this._nativeEventDrainActive = false;
        return;
      }
      this._handleNativeEvent(event, true);
      if (this._queuedNativeEvents.length) setImmediate(dispatchNext);
      else this._nativeEventDrainActive = false;
    };
    setImmediate(dispatchNext);
  }

  _queueMessageEvent(event) {
    this._queuedMessageEvents.push(event);
    this._scheduleMessageEventFlush();
  }

  _queueMessageEvents(events) {
    for (const event of events) this._queuedMessageEvents.push(event);
    this._scheduleMessageEventFlush();
  }

  _scheduleMessageEventFlush() {
    if (this._messageEventFlushScheduled) return;
    this._messageEventFlushScheduled = true;
    setImmediate(() => {
      this._messageEventFlushScheduled = false;
      this._flushQueuedMessageEvents();
    });
  }

  _scheduleMessageEventContinuation({ yieldToTask = false } = {}) {
    if (this._messageEventFlushScheduled) return;
    this._messageEventFlushScheduled = true;
    const schedule = yieldToTask ? setTimeout : setImmediate;
    schedule(
      () => {
        this._messageEventFlushScheduled = false;
        this._flushQueuedMessageEvents();
      },
      yieldToTask ? 1 : 0,
    );
  }

  _messageContinuationNeedsTaskYield(handler = this._onmessage) {
    if (typeof handler !== "function") return false;
    try {
      return /\[native code\]/.test(Function.prototype.toString.call(handler));
    } catch {
      return false;
    }
  }

  _hasMessageEventListeners() {
    return this._messageEventListenerCount > 0;
  }

  _canContinueMessageBatchInCurrentTask(handler, yieldToTask) {
    return (
      typeof handler === "function" &&
      handler instanceof Function &&
      this._onmessage === handler &&
      !yieldToTask &&
      !this._hasMessageEventListeners()
    );
  }

  _canUseDirectMessageHandler(handler, yieldToTask, hasMessageListeners) {
    return !hasMessageListeners && this._canContinueMessageBatchInCurrentTask(handler, yieldToTask);
  }

  _dispatchMessageEvent(event, directHandler) {
    const messageEvent = makeDataMessageEvent(this._convertMessage(event));
    if (directHandler) {
      dispatchDirectEvent(this, messageEvent, directHandler);
    } else {
      this.dispatchEvent(messageEvent);
    }
  }

  _flushQueuedMessageEvents() {
    while (true) {
      if (this._readyState === "closed") {
        this._queuedMessageEvents.length = 0;
        this._queuedMessageEventIndex = 0;
        return;
      }

      const pendingPeer =
        this._pc._operationsPending > 0
          ? this._pc
          : this._pc._pairedPeer?._operationsPending > 0
            ? this._pc._pairedPeer
            : null;
      if (pendingPeer) {
        pendingPeer._afterOperationsIdle(() => this._scheduleMessageEventFlush());
        return;
      }

      if (this._messageEventGateActive) return;
      if (this._messageConsumerGateActive && !this._hasEventConsumer("message")) return;
      if (this._messageConsumerGateActive) this._messageConsumerGateActive = false;

      const event = this._queuedMessageEvents[this._queuedMessageEventIndex++];
      if (!event) {
        this._queuedMessageEventIndex = 0;
        return;
      }
      const handler = this._onmessage;
      const hasMessageListeners = this._hasMessageEventListeners();
      const yieldToTask = this._messageHandlerNeedsTaskYield;
      const directHandler = this._canUseDirectMessageHandler(
        handler,
        yieldToTask,
        hasMessageListeners,
      )
        ? handler
        : null;
      if (this._markPairedDeliveryReceived(event)) {
        // Let bufferedamountlow promise continuations attach their message handlers.
        this._queuedMessageEventIndex--;
        this._scheduleMessageEventContinuation();
        return;
      }
      this._dispatchMessageEvent(event, directHandler);

      if (this._queuedMessageEventIndex >= this._queuedMessageEvents.length) {
        this._queuedMessageEvents.length = 0;
        this._queuedMessageEventIndex = 0;
        return;
      }
      if (this._queuedMessageEventIndex > 1024) {
        this._queuedMessageEvents.splice(0, this._queuedMessageEventIndex);
        this._queuedMessageEventIndex = 0;
      }
      if (!this._canContinueMessageBatchInCurrentTask(handler, yieldToTask)) {
        this._scheduleMessageEventContinuation({ yieldToTask });
        return;
      }
    }
  }

  _dispatchNativeMessageBatch(events) {
    if (this._readyState === "closed") return true;
    if (this._queuedMessageEvents.length > 0) return false;
    const pendingPeer =
      this._pc._operationsPending > 0
        ? this._pc
        : this._pc._pairedPeer?._operationsPending > 0
          ? this._pc._pairedPeer
          : null;
    if (pendingPeer || this._messageEventGateActive) return false;
    if (this._messageConsumerGateActive && !this._hasEventConsumer("message")) return false;
    if (this._messageConsumerGateActive) this._messageConsumerGateActive = false;

    const handler = this._onmessage;
    const hasMessageListeners = this._hasMessageEventListeners();
    const yieldToTask = this._messageHandlerNeedsTaskYield;
    const directHandler = this._canUseDirectMessageHandler(
      handler,
      yieldToTask,
      hasMessageListeners,
    )
      ? handler
      : null;
    if (!directHandler) return false;

    const shouldCreateBlob = this._binaryType === "blob" && typeof Blob !== "undefined";
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      if (this._markPairedDeliveryReceived(event)) {
        this._queueMessageEvents(events.slice(index));
        return true;
      }
      const messageEvent = makeDataMessageEvent(
        event.binary && shouldCreateBlob ? new Blob([event.data]) : event.data,
      );
      dispatchDirectEvent(this, messageEvent, directHandler);
      if (this._readyState === "closed") return true;
      if (
        index + 1 < events.length &&
        !this._canContinueMessageBatchInCurrentTask(handler, yieldToTask)
      ) {
        for (let remaining = index + 1; remaining < events.length; remaining += 1) {
          this._queuedMessageEvents.push(events[remaining]);
        }
        this._scheduleMessageEventContinuation({ yieldToTask: this._messageHandlerNeedsTaskYield });
        return true;
      }
    }
    return true;
  }

  _gateMessageEventsAfterAnnouncement() {
    if (this._messageEventGateActive) return;
    this._messageEventGateActive = true;
    setTimeout(() => {
      setTimeout(() => {
        this._messageEventGateActive = false;
        this._scheduleMessageEventFlush();
      }, 0);
    }, 0);
  }

  _gateMessageEventsUntilConsumer() {
    if (this._hasEventConsumer("message")) return;
    this._messageConsumerGateActive = true;
    setTimeout(() => this._releaseMessageConsumerGate(), MESSAGE_CONSUMER_GATE_TIMEOUT_MS);
  }

  _releaseMessageConsumerGate() {
    if (!this._messageConsumerGateActive) return;
    this._messageConsumerGateActive = false;
    this._scheduleMessageEventFlush();
  }

  _eventListenerAdded(type) {
    if (type !== "message") return;
    this._messageEventListenerCount += 1;
    this._releaseMessageConsumerGate();
  }

  _eventListenerRemoved(type) {
    if (type === "message" && this._messageEventListenerCount > 0) {
      this._messageEventListenerCount -= 1;
    }
  }

  _convertMessage(event) {
    if (!event.binary) return event.data;
    if (this._binaryType === "blob" && typeof Blob !== "undefined") {
      return new Blob([event.data]);
    }
    return event.data;
  }
}

export function normalizeDataChannelInit(init) {
  const options = {
    ordered: init.ordered !== undefined ? Boolean(init.ordered) : true,
    maxPacketLifeTime: init.maxPacketLifeTime,
    maxRetransmits: init.maxRetransmits,
    protocol: init.protocol === undefined ? "" : String(init.protocol),
    negotiated: init.negotiated !== undefined ? Boolean(init.negotiated) : false,
    id: init.id,
  };

  if (options.maxPacketLifeTime != null) {
    options.maxPacketLifeTime = enforceRange(options.maxPacketLifeTime, "maxPacketLifeTime");
  }
  if (options.maxRetransmits != null) {
    options.maxRetransmits = enforceRange(options.maxRetransmits, "maxRetransmits");
  }
  if (options.maxPacketLifeTime != null && options.maxRetransmits != null) {
    throw new TypeError("maxPacketLifeTime and maxRetransmits are mutually exclusive");
  }
  if (options.id != null) {
    options.id = enforceRange(options.id, "id", 65535);
  }
  if (options.negotiated && options.id == null) {
    throw new TypeError("negotiated RTCDataChannel requires an id");
  }
  if (options.negotiated && options.id > 65534) {
    throw new TypeError("id must be an integer between 0 and 65534");
  }
  if (!options.negotiated) {
    options.id = undefined;
  }
  return options;
}
