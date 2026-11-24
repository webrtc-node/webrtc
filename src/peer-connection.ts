// @ts-nocheck -- converted from JavaScript; strict typing lands module by module.

const native = require("./native/load");

import {
  createDefaultNativeCertificate,
  generateCertificate,
  getCertificateMaterial,
  sameCertificateSet,
} from "./certificate";
import { cloneConfiguration, normalizePeerConnectionConfiguration } from "./configuration";
import {
  DATA_CHANNEL_ANNOUNCEMENT_REPAIR_GRACE_MS,
  DATA_CHANNEL_ANNOUNCEMENT_REPAIR_INTERVAL_MS,
  DATA_CHANNEL_ANNOUNCEMENT_REPAIR_TIMEOUT_MS,
  DATA_CHANNEL_OPEN_REPAIR_INTERVAL_MS,
  DATA_CHANNEL_OPEN_REPAIR_TIMEOUT_MS,
  DEFAULT_SCTP_MAX_MESSAGE_SIZE,
  LIBDATACHANNEL_SCTP_MAX_CHANNELS,
  MAX_LOCAL_DESCRIPTION_PAIRING_KEYS,
  SCTP_CONNECT_POLL_INTERVAL_MS,
  SCTP_CONNECT_POLL_TIMEOUT_MS,
} from "./constants";
import {
  normalizeDataChannelInit,
  RTCDataChannel,
  SyntheticNativeDataChannel,
  UnsupportedNativeDataChannel,
} from "./data-channel";
import { kInternalConstruct, makeDOMException, mapNativeError } from "./errors";
import {
  makeEvent,
  RTCDataChannelEvent,
  RTCPeerConnectionIceEvent,
  SimpleEventTarget,
} from "./events";
import {
  descriptionPairingKey,
  localDescriptionOwnerFinalizer,
  localDescriptionOwners,
} from "./pairing";
import {
  appendRemoteCandidateToDescription,
  assertValidSdpSyntax,
  createIceRestartCredentials,
  dtlsSetupFromDescription,
  extractIceCandidatesFromDescription,
  hasDataMediaSection,
  hasDifferentIceCredentials,
  hasTrickleIceOption,
  isNoMediaSdp,
  markJsOnlyIceRestart,
  maxMessageSizeFromSdp,
  normalizeAddIceCandidateInput,
  normalizeDescription,
  RTCIceCandidate,
  RTCSessionDescription,
  resolveCandidateMid,
  rewriteIceCredentials,
  sameCandidate,
  stripIceCandidateLinesFromDescription,
} from "./sdp";
import { nextTask } from "./timing";
import { RTCSctpTransport } from "./transports";
import { byteLength, validateByteLength } from "./webidl";

export class RTCPeerConnection extends SimpleEventTarget {
  static generateCertificate(algorithm) {
    return generateCertificate(algorithm);
  }

  constructor(configuration = {}) {
    super();
    const normalizedConfiguration = normalizePeerConnectionConfiguration(configuration);
    this._configuration = normalizedConfiguration;
    this._channels = new Map();
    this._usedDataChannelIds = new Map();
    this._dataChannelIdRefreshNeeded = false;
    this._closed = false;
    this._localDescription = null;
    this._remoteDescription = null;
    this._currentLocalDescription = null;
    this._pendingLocalDescription = null;
    this._currentRemoteDescription = null;
    this._pendingRemoteDescription = null;
    this._localDescriptionPairingKeys = new Set();
    this._pairedPeer = null;
    this._sctpTransport = null;
    this._canTrickleIceCandidates = null;
    this._selfRemoteDescription = false;
    this._pendingIce = [];
    this._localIceCandidates = [];
    this._remoteIceCandidates = [];
    this._pendingRemoteCandidatesForNative = [];
    this._deferredIceEvents = [];
    this._iceEventFlushScheduled = false;
    this._processingDeferredIceEvent = false;
    this._iceEventIdleCallbacks = [];
    this._iceRole = "unknown";
    this._preparedLocalDescription = null;
    this._nonstandardPreparedLocalDescriptionType = null;
    this._nonstandardLocalIceCredentials = null;
    this._nonstandardConfiguration = {
      enableIceUdpMux: false,
      disableFingerprintVerification: false,
      maxMessageSize: undefined,
    };
    this._lastCreatedOffer = null;
    this._lastCreatedAnswer = null;
    this._localDescriptionSetByApi = false;
    this._localDescriptionRefreshScheduled = false;
    this._nativeCandidateGatheringScheduled = false;
    this._iceRestartPending = false;
    this._pendingIceRestartCredentials = null;
    this._jsOnlyIceRestartOfferPending = false;
    this._jsOnlyIceRestartRemoteOffer = false;
    this._operationsPending = 0;
    this._operationQueue = [];
    this._operationIdleCallbacks = [];
    this._explicitIceCandidateExchange = false;
    this._sameProcessIceCandidateExchange = false;
    this._suppressNextNativeSignalingState = null;
    this._sctpTransportUpdateScheduled = false;
    this._sctpConnectedTransitionScheduled = false;
    this._sctpConnectedTransitionReady = false;
    this._sctpConnectPollScheduled = false;
    this._sctpConnectPollDeadline = 0;
    this._connectedStateRepairScheduled = false;
    this._dataChannelOpenRepairScheduled = false;
    this._dataChannelOpenRepairDeadline = 0;
    this._dataChannelAnnouncementRepairScheduled = false;
    this._dataChannelAnnouncementRepairReadyAt = 0;
    this._dataChannelAnnouncementRepairDeadline = 0;
    this._remoteAnnouncedDataChannelIds = new Set();
    this._pendingSyntheticDataChannelAnnouncements = new Map();
    this._localDataChannelCount = 0;
    this._negotiationNeeded = false;
    this._negotiationNeededScheduled = false;
    this._ondatachannel = null;
    this._pendingDataChannelEvents = [];
    this._pendingNativeDataChannelEvents = new Map();
    this._dataChannelFlushScheduled = false;
    this.onicecandidate = null;
    this.onicecandidateerror = null;
    this.onicegatheringstatechange = null;
    this.oniceconnectionstatechange = null;
    this.onconnectionstatechange = null;
    this.onsignalingstatechange = null;
    this.onnegotiationneeded = null;
    this._connectionState = "new";
    this._iceConnectionState = "new";
    this._lastDispatchedConnectionState = "new";
    this._lastDispatchedIceConnectionState = "new";
    this._remoteTransportClosed = false;
    this._iceGatheringState = "new";
    this._signalingState = "stable";
    this._lastDispatchedSignalingState = "stable";
    this._native = null;
    this._nativeCertificates = null;
  }

  getConfiguration() {
    return cloneConfiguration(this._configuration);
  }

  _ensureNativePeerConnection() {
    this._assertNotClosed();
    if (this._native) return this._native;
    const nativeConfiguration = {
      iceServers: this._configuration.iceServers.map((server) => ({
        ...server,
        urls: [...server.urls],
      })),
      iceTransportPolicy: this._configuration.iceTransportPolicy,
      ...this._nonstandardConfiguration,
    };
    let nativeCertificates = this._configuration.certificates;
    if (nativeCertificates.length === 0) {
      nativeCertificates = [createDefaultNativeCertificate()];
    }
    const material = getCertificateMaterial(nativeCertificates[0]);
    if (material) {
      nativeConfiguration.certificatePem = material.certificatePem;
      nativeConfiguration.keyPem = material.keyPem;
    }
    const nativePeerConnection = new native.NativePeerConnection(
      nativeConfiguration,
      (event, payloads) => {
        if (payloads !== undefined) {
          this._handleNativeMessages(event, payloads);
        } else if (Array.isArray(event)) {
          this._handleNativeEventBatch(event);
        } else {
          this._handleNativeEvent(event);
        }
      },
    );
    this._nativeCertificates = nativeCertificates;
    this._native = nativePeerConnection;
    return this._native;
  }

  setConfiguration(configuration = {}) {
    this._assertNotClosed();
    const normalizedConfiguration = normalizePeerConnectionConfiguration(
      configuration,
      this._configuration,
    );
    this._assertNotClosed();
    if (normalizedConfiguration.bundlePolicy !== this._configuration.bundlePolicy) {
      throw makeDOMException("bundlePolicy cannot be changed", "InvalidModificationError");
    }
    if (normalizedConfiguration.rtcpMuxPolicy !== this._configuration.rtcpMuxPolicy) {
      throw makeDOMException("rtcpMuxPolicy cannot be changed", "InvalidModificationError");
    }
    if (
      !sameCertificateSet(normalizedConfiguration.certificates, this._configuration.certificates)
    ) {
      throw makeDOMException("certificates cannot be changed", "InvalidModificationError");
    }
    if (
      this.localDescription &&
      normalizedConfiguration.iceCandidatePoolSize !== this._configuration.iceCandidatePoolSize
    ) {
      throw makeDOMException(
        "iceCandidatePoolSize cannot change with an applied local description",
        "InvalidModificationError",
      );
    }
    this._configuration = normalizedConfiguration;
  }

  get localDescription() {
    return this._pendingLocalDescription || this._currentLocalDescription;
  }

  get currentLocalDescription() {
    return this._currentLocalDescription;
  }

  get pendingLocalDescription() {
    return this._pendingLocalDescription;
  }

  get remoteDescription() {
    return this._pendingRemoteDescription || this._currentRemoteDescription;
  }

  get currentRemoteDescription() {
    return this._currentRemoteDescription;
  }

  get pendingRemoteDescription() {
    return this._pendingRemoteDescription;
  }

  get signalingState() {
    return this._closed ? "closed" : this._signalingState;
  }

  get iceGatheringState() {
    return this._iceGatheringState;
  }

  get iceConnectionState() {
    return this._iceConnectionState;
  }

  get connectionState() {
    return this._connectionState;
  }

  get canTrickleIceCandidates() {
    return this._canTrickleIceCandidates;
  }

  get sctp() {
    return this._sctpTransport;
  }

  get ondatachannel() {
    return this._ondatachannel;
  }

  set ondatachannel(callback) {
    this._ondatachannel = typeof callback === "function" ? callback : null;
    this._scheduleDataChannelFlush();
    this._scheduleDataChannelAnnouncementRepair();
    this._pairedPeer?._scheduleDataChannelAnnouncementRepair();
  }

  createDataChannel(label, init = {}) {
    this._assertNotClosed();
    if (arguments.length === 0) throw new TypeError("createDataChannel requires a label");
    const options = normalizeDataChannelInit(init);
    const stringLabel = String(label);
    validateByteLength(stringLabel, "label");
    validateByteLength(options.protocol, "protocol");
    if (options.negotiated && this._isDataChannelIdInUse(options.id)) {
      throw makeDOMException("RTCDataChannel id is already in use", "OperationError");
    }
    const nativeChannel = this._createNativeDataChannel(stringLabel, options);
    const assignedId = options.negotiated ? options.id : null;
    const channel = RTCDataChannel._fromNative(this, nativeChannel, undefined, assignedId);
    channel._createdLocally = true;
    this._localDataChannelCount += 1;
    if (this._localDataChannelCount === 1) this._markNegotiationNeeded();
    this._assignDataChannelIdsFromDtlsRole();
    this._scheduleDataChannelOpenRepair();
    this._pairedPeer?._scheduleDataChannelAnnouncementRepair();
    return channel;
  }

  _createNativeDataChannel(label, options) {
    try {
      return this._ensureNativePeerConnection().createDataChannel(label, options);
    } catch (error) {
      const highNegotiatedStream =
        options.negotiated &&
        options.id >= LIBDATACHANNEL_SCTP_MAX_CHANNELS &&
        /stream id is too high/i.test(error?.message || "");
      if (!highNegotiatedStream) throw error;
      return new UnsupportedNativeDataChannel(label, options);
    }
  }

  async createOffer(options = undefined) {
    this._assertNotClosed();
    const optionsObject = options !== null && typeof options === "object" ? options : {};
    const iceRestartRequested = optionsObject.iceRestart === true;
    return this._chainOperation(() => this._createOffer(iceRestartRequested));
  }

  async _createOffer(iceRestartRequested) {
    if (this._signalingState !== "stable" && this._signalingState !== "have-local-offer") {
      throw makeDOMException("Cannot create offer in current signaling state", "InvalidStateError");
    }
    try {
      await nextTask();
      if (this._closed) return new Promise(() => {});
      if (iceRestartRequested && !this._nonstandardLocalIceCredentials) {
        this._iceRestartPending = true;
        this._armDataChannelNativeCloseSuppression();
      }
      let offer =
        this._prepareNonstandardLocalDescription("offer") ||
        this._ensureNativePeerConnection().createOffer();
      const jsOnlyIceRestart = this._iceRestartPending && !this._canApplyNativeIceCredentials();
      if (this._iceRestartPending && !jsOnlyIceRestart) {
        offer = {
          type: offer.type,
          sdp: rewriteIceCredentials(offer.sdp, this._ensureIceRestartCredentials()),
        };
      }
      this._lastCreatedOffer = new RTCSessionDescription(offer);
      if (jsOnlyIceRestart) markJsOnlyIceRestart(this._lastCreatedOffer);
      return offer;
    } catch (error) {
      throw mapNativeError(error, "InvalidStateError");
    }
  }

  _armDataChannelNativeCloseSuppression() {
    const peers = new Set([this, this._pairedPeer].filter(Boolean));
    for (const peer of peers) {
      for (const channel of peer._channels.values()) channel._armNativeCloseSuppression();
    }
  }

  restartIce() {
    if (this._closed) return;
    if (!this._localDescription && !this._remoteDescription) return;
    this._iceRestartPending = true;
    this._pendingIceRestartCredentials = null;
    this._armDataChannelNativeCloseSuppression();
    if (this._signalingState === "stable") this._markNegotiationNeeded();
  }

  async createAnswer() {
    this._assertNotClosed();
    return this._chainOperation(() => this._createAnswer());
  }

  async _createAnswer() {
    if (
      this._signalingState !== "have-remote-offer" &&
      this._signalingState !== "have-local-pranswer"
    ) {
      throw makeDOMException(
        "Cannot create answer in current signaling state",
        "InvalidStateError",
      );
    }
    try {
      await nextTask();
      if (this._closed) return new Promise(() => {});
      if (this._jsOnlyIceRestartRemoteOffer) {
        const answer = markJsOnlyIceRestart(
          new RTCSessionDescription(this._ensureNativePeerConnection().createAnswer()),
        );
        this._lastCreatedAnswer = answer;
        Object.defineProperty(answer, "_webrtcNodeAnswerer", {
          value: this,
          configurable: true,
        });
        return answer;
      }
      if (isNoMediaSdp(this.remoteDescription)) {
        const answer = {
          type: "answer",
          sdp: this.remoteDescription.sdp,
        };
        this._lastCreatedAnswer = new RTCSessionDescription(answer);
        return answer;
      }
      const answer =
        this._prepareNonstandardLocalDescription("answer") ||
        this._ensureNativePeerConnection().createAnswer();
      this._lastCreatedAnswer = new RTCSessionDescription(answer);
      Object.defineProperty(answer, "_webrtcNodeAnswerer", {
        value: this,
        configurable: true,
      });
      return answer;
    } catch (error) {
      throw mapNativeError(error, "InvalidStateError");
    }
  }

  async setLocalDescription(description = undefined) {
    this._assertNotClosed();
    const jsOnlyIceRestartDescription = Boolean(description?._webrtcNodeJsOnlyIceRestart);
    const normalized = description === undefined ? null : normalizeDescription(description);
    return this._chainOperation(() =>
      this._setLocalDescription(description, normalized, jsOnlyIceRestartDescription),
    );
  }

  async _setLocalDescription(description, normalized, jsOnlyIceRestartDescription) {
    const type = normalized ? normalized.type : this._implicitLocalDescriptionType();
    if (normalized?.type === "rollback" && this._signalingState !== "have-local-offer") {
      throw makeDOMException(
        "Cannot roll back a local description in current signaling state",
        "InvalidStateError",
      );
    }
    try {
      await nextTask();
      if (this._closed) return new Promise(() => {});
      if (normalized?.type === "offer") {
        if (this._signalingState !== "stable" && this._signalingState !== "have-local-offer") {
          throw makeDOMException(
            "Cannot set a local offer in current signaling state",
            "InvalidStateError",
          );
        }
        if (normalized.sdp === "" && this._lastCreatedOffer) normalized = this._lastCreatedOffer;
        if (!this._lastCreatedOffer || normalized.sdp !== this._lastCreatedOffer.sdp) {
          throw makeDOMException(
            "Local offer does not match the last created offer",
            "InvalidModificationError",
          );
        }
      }
      if (normalized?.type === "rollback") {
        if (this._signalingState !== "have-local-offer") {
          throw makeDOMException(
            "Cannot roll back a local description in current signaling state",
            "InvalidStateError",
          );
        }
        const previousState = this._signalingState;
        const previousGatheringState = this._iceGatheringState;
        const rollingBackInitialOffer = !this._currentLocalDescription;
        const nativeBackedRollback =
          this._localDescription && !isNoMediaSdp(this._localDescription);
        if (nativeBackedRollback) {
          this._suppressNextNativeSignalingState = "stable";
          try {
            this._ensureNativePeerConnection().setLocalDescription("rollback");
          } catch (error) {
            this._suppressNextNativeSignalingState = null;
            throw error;
          }
        }
        this._rollbackLocalDescription();
        this._localDescriptionSetByApi = hasDataMediaSection(this._localDescription);
        this._localIceCandidates = [];
        this._unregisterLocalDescriptionsForPairing();
        this._syncStatesFromNative();
        this._signalingState = "stable";
        if (rollingBackInitialOffer) {
          this._iceGatheringState = "new";
        }
        this._refreshIceRole();
        this._updateSctpTransport();
        if (rollingBackInitialOffer && previousGatheringState !== "new") {
          this.dispatchEvent(makeEvent("icegatheringstatechange"));
          this._iceTransport()?.dispatchEvent(makeEvent("gatheringstatechange"));
        }
        if (previousState !== this._signalingState) this._dispatchSignalingStateChange();
        await nextTask();
        if (this._suppressNextNativeSignalingState === "stable")
          this._suppressNextNativeSignalingState = null;
        return;
      }
      if (normalized?.type === "pranswer") {
        if (
          this._signalingState !== "have-remote-offer" &&
          this._signalingState !== "have-local-pranswer"
        ) {
          throw makeDOMException(
            "Cannot set a local pranswer in current signaling state",
            "InvalidStateError",
          );
        }
        const previousState = this._signalingState;
        this._setPendingLocalDescription(normalized);
        this._localDescriptionSetByApi = hasDataMediaSection(this._localDescription);
        this._registerLocalDescriptionForPairing();
        this._signalingState = "have-local-pranswer";
        this._refreshIceRole();
        this._updateSctpTransport();
        if (previousState !== this._signalingState) this._dispatchSignalingStateChange();
        await nextTask();
        return;
      }
      let alreadyAppliedAnswer = false;
      if (normalized?.type === "answer") {
        if (normalized.sdp === "" && this._lastCreatedAnswer) normalized = this._lastCreatedAnswer;
        const answerCreatedByThisPeer = description && description._webrtcNodeAnswerer === this;
        alreadyAppliedAnswer =
          this._localDescription?.type === "answer" &&
          (this._localDescription.sdp === normalized.sdp || answerCreatedByThisPeer);
        if (
          !alreadyAppliedAnswer &&
          this._signalingState !== "have-remote-offer" &&
          this._signalingState !== "have-local-pranswer"
        ) {
          throw makeDOMException(
            "Cannot set a local answer in current signaling state",
            "InvalidStateError",
          );
        }
        if (!this._lastCreatedAnswer || normalized.sdp !== this._lastCreatedAnswer.sdp) {
          throw makeDOMException(
            "Local answer does not match the last created answer",
            "InvalidModificationError",
          );
        }
      }
      if (alreadyAppliedAnswer) {
        this._localDescriptionSetByApi = hasDataMediaSection(this._localDescription);
        this._syncStatesFromNative();
        this._refreshIceRole();
        for (const candidate of this._pendingIce.splice(0))
          await this._addExchangedLocalCandidate(candidate);
        this._flushPendingRemoteCandidatesForNative();
        return;
      }
      if (normalized && isNoMediaSdp(normalized)) {
        await this._applyNoMediaLocalDescription(normalized);
        this._localDescriptionSetByApi = hasDataMediaSection(this._localDescription);
        return;
      }
      if (!normalized && type === "offer") {
        const offer =
          this._lastCreatedOffer ||
          new RTCSessionDescription(this._ensureNativePeerConnection().createOffer());
        if (isNoMediaSdp(offer)) {
          await this._applyNoMediaLocalDescription(offer);
          this._localDescriptionSetByApi = hasDataMediaSection(this._localDescription);
          return;
        }
      }
      if (!normalized && type === "answer" && isNoMediaSdp(this.remoteDescription)) {
        const answer =
          this._lastCreatedAnswer ||
          new RTCSessionDescription({
            type: "answer",
            sdp: this.remoteDescription.sdp,
          });
        await this._applyNoMediaLocalDescription(answer);
        this._localDescriptionSetByApi = hasDataMediaSection(this._localDescription);
        return;
      }
      if (type === "answer" && this._jsOnlyIceRestartRemoteOffer) {
        const answer =
          normalized ||
          this._lastCreatedAnswer ||
          new RTCSessionDescription(this._ensureNativePeerConnection().createAnswer());
        await this._applyJsOnlyLocalAnswer(answer);
        this._localDescriptionSetByApi = hasDataMediaSection(this._localDescription);
        return;
      }
      if (type === "offer" && this._shouldApplyDataOnlyLocalOffer(normalized)) {
        const offer = normalized || this._currentLocalDescription || this._lastCreatedOffer;
        await this._applyDataOnlyLocalOffer(offer);
        this._localDescriptionSetByApi = hasDataMediaSection(this._localDescription);
        return;
      }
      if (type === "answer" && this._shouldApplyDataOnlyLocalAnswer(normalized)) {
        const answer = normalized || this._currentLocalDescription || this._lastCreatedAnswer;
        await this._applyDataOnlyLocalAnswer(answer);
        this._localDescriptionSetByApi = hasDataMediaSection(this._localDescription);
        return;
      }
      const previousIceGatheringState = this._iceGatheringState;
      const previousSignalingState = this._signalingState;
      let appliedIceRestart = false;
      let usedJsOnlyIceRestart = false;
      if (
        this._localDescription?.type === type &&
        type !== "offer" &&
        !this._pendingRemoteDescription
      ) {
        this._syncStatesFromNative();
      } else if (this._preparedLocalDescription && type === this._preparedLocalDescription.type) {
        this._localDescription = this._preparedLocalDescription;
        this._preparedLocalDescription = null;
        this._nonstandardPreparedLocalDescriptionType = null;
        this._nonstandardLocalIceCredentials = null;
        this._syncStatesFromNative();
        this._scheduleNativeCandidateGathering();
      } else {
        const hadIceRestartRequest =
          (this._iceRestartPending || jsOnlyIceRestartDescription) && type === "offer";
        const useJsOnlyIceRestart = hadIceRestartRequest && !this._canApplyNativeIceCredentials();
        if (useJsOnlyIceRestart) {
          const localDescription = new RTCSessionDescription(
            normalized ||
              this._lastCreatedOffer ||
              this._ensureNativePeerConnection().createOffer(),
          );
          this._localDescription = markJsOnlyIceRestart(localDescription);
          this._jsOnlyIceRestartOfferPending = true;
          this._signalingState = "have-local-offer";
          appliedIceRestart = true;
          usedJsOnlyIceRestart = true;
        } else {
          const localDescriptionInit = this._localOfferInit(type);
          this._ensureNativePeerConnection().setLocalDescription(type, localDescriptionInit);
          appliedIceRestart = hadIceRestartRequest;
          const nativeDescription = this._ensureNativePeerConnection().localDescription();
          this._localDescription = nativeDescription
            ? new RTCSessionDescription(nativeDescription)
            : null;
          this._syncStatesFromNative();
          this._scheduleNativeCandidateGathering();
        }
      }
      if (type === "offer") {
        this._setPendingLocalDescription(this._localDescription);
        this._syncSignalingStateFromDescriptions();
      } else if (type === "answer") {
        this._commitRemoteDescription();
        this._commitLocalDescription(this._localDescription);
        this._syncSignalingStateFromDescriptions();
        for (const candidate of this._pendingIce.splice(0))
          await this._addExchangedLocalCandidate(candidate);
        this._flushPendingRemoteCandidatesForNative();
      }
      this._localDescriptionSetByApi = hasDataMediaSection(this._localDescription);
      this._clearNegotiationNeededIfDataMLineIsPresent();
      this._refreshIceRole();
      // The native callback can arrive after the next signaling operation starts.
      if (
        !this._closed &&
        previousSignalingState !== this._signalingState &&
        this._lastDispatchedSignalingState !== this._signalingState
      ) {
        this._dispatchSignalingStateChange();
      }
      if (appliedIceRestart) {
        if (previousIceGatheringState === "complete") this._queueSyntheticIceRestartGathering();
        this._clearIceRestartRequest();
      }
      await nextTask();
      if (usedJsOnlyIceRestart) {
        this._registerLocalDescriptionForPairing();
      } else {
        await this._refreshLocalDescriptionAfterGatheringWindow();
        this._registerLocalDescriptionForPairing();
      }
    } catch (error) {
      throw mapNativeError(error, "InvalidStateError");
    }
  }

  async setRemoteDescription(description) {
    this._assertNotClosed();
    const jsOnlyIceRestartDescription = Boolean(description?._webrtcNodeJsOnlyIceRestart);
    const normalized = normalizeDescription(description);
    return this._chainOperation(() =>
      this._setRemoteDescription(description, normalized, jsOnlyIceRestartDescription),
    );
  }

  async _setRemoteDescription(description, normalized, jsOnlyIceRestartDescription) {
    if (
      normalized.type === "answer" &&
      this._signalingState !== "have-local-offer" &&
      this._signalingState !== "have-remote-pranswer" &&
      !this._jsOnlyIceRestartOfferPending
    ) {
      throw makeDOMException(
        "Cannot set a remote answer in current signaling state",
        "InvalidStateError",
      );
    }
    if (
      normalized.type === "pranswer" &&
      this._signalingState !== "have-local-offer" &&
      this._signalingState !== "have-remote-pranswer"
    ) {
      throw makeDOMException(
        "Cannot set a remote pranswer in current signaling state",
        "InvalidStateError",
      );
    }
    if (normalized.type === "rollback" && this._signalingState !== "have-remote-offer") {
      throw makeDOMException(
        "Cannot roll back a remote description in current signaling state",
        "InvalidStateError",
      );
    }
    try {
      await nextTask();
      if (this._closed) return new Promise(() => {});
      if (
        normalized.type === "answer" &&
        this._signalingState !== "have-local-offer" &&
        this._signalingState !== "have-remote-pranswer" &&
        !this._jsOnlyIceRestartOfferPending
      ) {
        throw makeDOMException(
          "Cannot set a remote answer in current signaling state",
          "InvalidStateError",
        );
      }
      if (normalized.type === "pranswer") {
        if (
          this._signalingState !== "have-local-offer" &&
          this._signalingState !== "have-remote-pranswer"
        ) {
          throw makeDOMException(
            "Cannot set a remote pranswer in current signaling state",
            "InvalidStateError",
          );
        }
        const previousState = this._signalingState;
        this._setPendingRemoteDescription(normalized);
        this._pairWithRemoteDescription(this._remoteDescription);
        this._canTrickleIceCandidates = hasTrickleIceOption(normalized);
        this._signalingState = "have-remote-pranswer";
        this._refreshIceRole();
        this._updateSctpTransport();
        if (previousState !== this._signalingState) this._dispatchSignalingStateChange();
        await nextTask();
        return;
      }
      if (
        normalized.type === "offer" &&
        (this._signalingState === "have-local-offer" ||
          this._signalingState === "have-remote-pranswer")
      ) {
        await this._implicitRollbackLocalDescription();
        if (this._closed) return new Promise(() => {});
      }
      assertValidSdpSyntax(normalized);
      if (normalized.type === "rollback") {
        if (this._signalingState !== "have-remote-offer") {
          throw makeDOMException(
            "Cannot roll back a remote description in current signaling state",
            "InvalidStateError",
          );
        }
        const previousState = this._signalingState;
        const nativeBackedRollback =
          this._remoteDescription && !isNoMediaSdp(this._remoteDescription);
        if (nativeBackedRollback) {
          this._suppressNextNativeSignalingState = "stable";
          try {
            this._ensureNativePeerConnection().setRemoteDescription({ type: "rollback", sdp: "" });
          } catch (error) {
            this._suppressNextNativeSignalingState = null;
            throw error;
          }
        }
        this._rollbackRemoteDescription();
        this._remoteIceCandidates = [];
        if (this._pairedPeer?._pairedPeer === this) this._pairedPeer._pairedPeer = null;
        this._pairedPeer = null;
        this._selfRemoteDescription = false;
        this._syncStatesFromNative();
        this._signalingState = "stable";
        this._refreshIceRole();
        this._updateSctpTransport();
        if (previousState !== this._signalingState) this._dispatchSignalingStateChange();
        await nextTask();
        if (this._suppressNextNativeSignalingState === "stable")
          this._suppressNextNativeSignalingState = null;
        return;
      }
      if (
        normalized.type === "offer" &&
        this._isJsOnlyIceRestartRemoteOffer(normalized, jsOnlyIceRestartDescription)
      ) {
        const previousState = this._signalingState;
        this._setPendingRemoteDescription(markJsOnlyIceRestart(normalized));
        this._pairWithRemoteDescription(this._remoteDescription);
        this._canTrickleIceCandidates = hasTrickleIceOption(normalized);
        this._signalingState = "have-remote-offer";
        this._jsOnlyIceRestartRemoteOffer = true;
        this._armDataChannelNativeCloseSuppression();
        this._refreshIceRole();
        this._updateSctpTransport();
        if (previousState !== this._signalingState) this._dispatchSignalingStateChange();
        await nextTask();
        return;
      }
      if (
        normalized.type === "answer" &&
        (jsOnlyIceRestartDescription || this._jsOnlyIceRestartOfferPending)
      ) {
        const previousState = this._signalingState;
        let remoteDescription = normalized;
        if (description && description._webrtcNodeAnswerer) {
          remoteDescription = await description._webrtcNodeAnswerer._ensureLocalAnswerApplied();
        }
        this._setPendingRemoteDescription(markJsOnlyIceRestart(remoteDescription));
        this._commitLocalDescription();
        this._commitRemoteDescription(this._remoteDescription);
        this._canTrickleIceCandidates = hasTrickleIceOption(remoteDescription);
        this._signalingState = "stable";
        this._jsOnlyIceRestartOfferPending = false;
        this._clearIceRestartRequest();
        this._refreshIceRole();
        this._assignDataChannelIdsFromDtlsRole();
        this._updateSctpTransport();
        if (previousState !== this._signalingState) this._dispatchSignalingStateChange();
        await nextTask();
        return;
      }
      if (normalized.type === "offer" && this._shouldApplyDataOnlyRemoteOffer(normalized)) {
        const previousState = this._signalingState;
        this._setPendingRemoteDescription(normalized);
        this._pairWithRemoteDescription(this._remoteDescription);
        this._canTrickleIceCandidates = hasTrickleIceOption(normalized);
        this._syncSignalingStateFromDescriptions();
        this._refreshIceRole();
        this._updateSctpTransport();
        if (previousState !== this._signalingState) this._dispatchSignalingStateChange();
        await nextTask();
        return;
      }
      if (normalized.type === "answer" && this._shouldApplyDataOnlyRemoteAnswer(normalized)) {
        const previousState = this._signalingState;
        let remoteDescription = normalized;
        if (description && description._webrtcNodeAnswerer) {
          remoteDescription = await description._webrtcNodeAnswerer._ensureLocalAnswerApplied();
        }
        this._setPendingRemoteDescription(remoteDescription);
        this._commitLocalDescription();
        this._commitRemoteDescription(this._remoteDescription);
        this._canTrickleIceCandidates = hasTrickleIceOption(remoteDescription);
        this._syncSignalingStateFromDescriptions();
        this._refreshIceRole();
        this._assignDataChannelIdsFromDtlsRole();
        this._updateSctpTransport();
        if (previousState !== this._signalingState) this._dispatchSignalingStateChange();
        await nextTask();
        return;
      }
      if (isNoMediaSdp(normalized)) {
        if (normalized.type === "offer") {
          this._rollbackLocalDescription();
          this._setPendingRemoteDescription(normalized);
        } else if (normalized.type === "answer") {
          this._commitLocalDescription();
          this._commitRemoteDescription(normalized);
        } else {
          this._setPendingRemoteDescription(normalized);
        }
        this._pairWithRemoteDescription(this._remoteDescription);
        this._canTrickleIceCandidates = hasTrickleIceOption(normalized);
        if (normalized.type === "offer") {
          this._signalingState = "have-remote-offer";
        } else if (normalized.type === "answer") {
          this._signalingState = "stable";
        }
        this._refreshIceRole();
        this._updateSctpTransport();
        this._dispatchSignalingStateChange();
        await nextTask();
        return;
      }
      if (normalized.type === "offer" && this._signalingState === "have-remote-offer") {
        this._setPendingRemoteDescription(normalized);
        this._pairWithRemoteDescription(this._remoteDescription);
        this._canTrickleIceCandidates = hasTrickleIceOption(normalized);
        this._refreshIceRole();
        this._updateSctpTransport();
        await nextTask();
        return;
      }
      let remoteDescription = normalized;
      if (normalized.type === "answer" && description && description._webrtcNodeAnswerer) {
        remoteDescription = await description._webrtcNodeAnswerer._ensureLocalAnswerApplied();
      }
      const previousSignalingState = this._signalingState;
      let suppressedNativeSignalingState = null;
      let nativeRemoteDescription = remoteDescription;
      let deferredCandidatesForNative = [];
      if (normalized.type === "offer") {
        deferredCandidatesForNative = extractIceCandidatesFromDescription(remoteDescription);
        if (deferredCandidatesForNative.length > 0) {
          nativeRemoteDescription = stripIceCandidateLinesFromDescription(remoteDescription);
        }
      }
      this._ensureNativePeerConnection().setRemoteDescription(nativeRemoteDescription.toJSON());
      this._queuePendingRemoteCandidatesForNative(deferredCandidatesForNative);
      this._canTrickleIceCandidates = hasTrickleIceOption(remoteDescription);
      this._remoteDescription = new RTCSessionDescription(remoteDescription);
      this._pairWithRemoteDescription(this._remoteDescription);
      this._syncStatesFromNative();
      if (normalized.type === "offer") {
        this._rollbackLocalDescription();
        this._setPendingRemoteDescription(this._remoteDescription);
        this._syncSignalingStateFromDescriptions();
      } else if (normalized.type === "answer") {
        this._commitLocalDescription();
        this._commitRemoteDescription(this._remoteDescription);
        this._syncSignalingStateFromDescriptions();
      }
      this._refreshIceRole();
      this._assignDataChannelIdsFromDtlsRole();
      if (previousSignalingState !== this._signalingState) {
        suppressedNativeSignalingState = this._signalingState;
        this._suppressNextNativeSignalingState = suppressedNativeSignalingState;
        this._dispatchSignalingStateChange();
      }
      if (normalized.type !== "offer") {
        for (const candidate of this._pendingIce.splice(0))
          await this._addExchangedLocalCandidate(candidate);
        this._flushPendingRemoteCandidatesForNative();
      }
      await nextTask();
      if (
        suppressedNativeSignalingState !== null &&
        this._suppressNextNativeSignalingState === suppressedNativeSignalingState
      ) {
        this._suppressNextNativeSignalingState = null;
      }
    } catch (error) {
      throw mapNativeError(error, "InvalidStateError");
    }
  }

  async addIceCandidate(candidate = null) {
    this._assertNotClosed();
    if (candidate instanceof RTCIceCandidate && candidate._webrtcNodeLocalCandidate) {
      const snapshot = new RTCIceCandidate(candidate);
      return this._chainOperation(() => this._addExchangedLocalCandidate(snapshot));
    }
    const normalized = normalizeAddIceCandidateInput(candidate);
    return this._chainOperation(() => this._addIceCandidate(normalized));
  }

  async _addIceCandidate(normalized) {
    if (!this.remoteDescription) {
      throw makeDOMException("Remote description is not set", "InvalidStateError");
    }
    try {
      await nextTask();
      if (this._closed) return new Promise(() => {});
      const remoteDescription = appendRemoteCandidateToDescription(
        this._remoteDescription,
        normalized,
      );
      if (normalized.candidate === "") {
        this._refreshCurrentOrPendingRemoteDescription(remoteDescription);
        return;
      }
      const nativeCandidate = normalized.toJSON();
      if (nativeCandidate.sdpMid === null) {
        nativeCandidate.sdpMid = resolveCandidateMid(this._remoteDescription, normalized);
      }
      if (nativeCandidate.candidate) {
        this._rememberRemoteIceCandidate(
          new RTCIceCandidate({
            candidate: nativeCandidate.candidate,
            sdpMid: nativeCandidate.sdpMid,
            sdpMLineIndex: nativeCandidate.sdpMLineIndex,
            usernameFragment: nativeCandidate.usernameFragment,
          }),
        );
        this._markExplicitIceCandidateExchange();
      }
      if (this._shouldDeferRemoteCandidateUntilLocalAnswer()) {
        this._queuePendingRemoteCandidatesForNative([normalized]);
        this._refreshCurrentOrPendingRemoteDescription(remoteDescription);
        return;
      }
      this._ensureNativePeerConnection().addRemoteCandidate(nativeCandidate);
      this._refreshCurrentOrPendingRemoteDescription(remoteDescription);
    } catch (error) {
      throw mapNativeError(error, "OperationError");
    }
  }

  async _addExchangedLocalCandidate(candidate) {
    if (!candidate.candidate) return;
    this._sameProcessIceCandidateExchange = true;
    if (this._pairedPeer) this._pairedPeer._sameProcessIceCandidateExchange = true;
    this._rememberRemoteIceCandidate(candidate);
    this._markExplicitIceCandidateExchange();
    if (!this.remoteDescription) {
      if (!this._pendingIce.some((entry) => sameCandidate(entry, candidate))) {
        this._pendingIce.push(candidate);
      }
      return;
    }

    if (this._remoteDescription?.sdp?.includes(candidate.candidate)) return;
    const nativeCandidate = candidate.toJSON();
    if (nativeCandidate.sdpMid === null) {
      nativeCandidate.sdpMid = resolveCandidateMid(this._remoteDescription, candidate);
    }
    try {
      const remoteDescription = appendRemoteCandidateToDescription(
        this._remoteDescription,
        candidate,
      );
      if (this._shouldDeferRemoteCandidateUntilLocalAnswer()) {
        this._queuePendingRemoteCandidatesForNative([candidate]);
      } else {
        this._ensureNativePeerConnection().addRemoteCandidate(nativeCandidate);
      }
      this._refreshCurrentOrPendingRemoteDescription(remoteDescription);
    } catch {
      // Exchanged local candidates are delivered from event handlers that do
      // not await addIceCandidate(); keep them best-effort like browser ICE.
    }
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    this._operationQueue.length = 0;
    this._operationsPending = 0;
    const operationIdleCallbacks = this._operationIdleCallbacks.splice(0);
    for (const callback of operationIdleCallbacks) setImmediate(callback);
    const pairedPeer = this._pairedPeer;
    this._unregisterLocalDescriptionsForPairing();
    const nativePeer = this._native;
    if (nativePeer) {
      try {
        nativePeer.close();
      } catch {
        // JS-visible close state is already final; native teardown is best-effort.
      }
    }
    setImmediate(() => {
      if (pairedPeer && !pairedPeer._closed) pairedPeer._handleRemotePeerClosed();
    });
    this._connectionState = "closed";
    this._iceConnectionState = "closed";
    this._iceGatheringState = "new";
    this._deferredIceEvents = [];
    this._preparedLocalDescription = null;
    this._nonstandardPreparedLocalDescriptionType = null;
    this._nonstandardLocalIceCredentials = null;
    this._signalingState = "closed";
    this._updateSctpTransport();
    for (const channel of this._channels.values()) {
      if (channel.readyState !== "closed") channel._handleClose();
    }
    // W3C close() sets the signaling, ICE, and connection states without firing events.
    this._lastDispatchedSignalingState = "closed";
    this._lastDispatchedIceConnectionState = "closed";
    this._lastDispatchedConnectionState = "closed";
  }

  _registerLocalDescriptionForPairing() {
    if (this._closed) return;
    const key = descriptionPairingKey(this._localDescription);
    if (!key) return;
    localDescriptionOwners.set(key, new WeakRef(this));
    if (this._localDescriptionPairingKeys.has(key)) {
      this._localDescriptionPairingKeys.delete(key);
    } else {
      localDescriptionOwnerFinalizer.register(this, key, this);
    }
    this._localDescriptionPairingKeys.add(key);
    // A remote peer can only apply one of the latest local descriptions, so
    // bound the registry for long-lived peers that renegotiate repeatedly.
    for (const oldKey of this._localDescriptionPairingKeys) {
      if (this._localDescriptionPairingKeys.size <= MAX_LOCAL_DESCRIPTION_PAIRING_KEYS) break;
      this._localDescriptionPairingKeys.delete(oldKey);
      if (localDescriptionOwners.get(oldKey)?.deref() === this)
        localDescriptionOwners.delete(oldKey);
    }
  }

  _unregisterLocalDescriptionsForPairing() {
    localDescriptionOwnerFinalizer.unregister(this);
    for (const key of this._localDescriptionPairingKeys) {
      const owner = localDescriptionOwners.get(key)?.deref();
      if (!owner || owner === this) localDescriptionOwners.delete(key);
    }
    this._localDescriptionPairingKeys.clear();
    if (this._pairedPeer?._pairedPeer === this) this._pairedPeer._pairedPeer = null;
    this._pairedPeer = null;
  }

  _pairWithRemoteDescription(description) {
    const key = descriptionPairingKey(description);
    if (!key) return;
    const peerRef = localDescriptionOwners.get(key);
    const peer = peerRef?.deref();
    const ownCreatedOffer =
      description?.type === "offer" && this._lastCreatedOffer?.sdp === description.sdp;
    if (!peer) {
      if (peerRef) localDescriptionOwners.delete(key);
      this._selfRemoteDescription = ownCreatedOffer;
      return;
    }
    if (peer === this) {
      this._selfRemoteDescription = true;
      return;
    }
    if (peer._closed) return;
    this._selfRemoteDescription = false;
    this._pairedPeer = peer;
    peer._pairedPeer = this;
    if (this._explicitIceCandidateExchange || peer._explicitIceCandidateExchange) {
      this._explicitIceCandidateExchange = true;
      peer._explicitIceCandidateExchange = true;
    }
    if (this._sameProcessIceCandidateExchange || peer._sameProcessIceCandidateExchange) {
      this._sameProcessIceCandidateExchange = true;
      peer._sameProcessIceCandidateExchange = true;
    }
    this._pairExistingDataChannels();
    peer._pairExistingDataChannels();
    this._scheduleDataChannelAnnouncementRepair();
    peer._scheduleDataChannelAnnouncementRepair();
  }

  _markExplicitIceCandidateExchange() {
    this._explicitIceCandidateExchange = true;
    this._updateSctpTransport();
    if (this._pairedPeer && !this._pairedPeer._explicitIceCandidateExchange) {
      this._pairedPeer._explicitIceCandidateExchange = true;
      this._pairedPeer._scheduleSctpTransportUpdate();
    }
  }

  _rememberLocalIceCandidate(candidate) {
    if (!candidate?.candidate) return;
    if (!this._localIceCandidates.some((entry) => sameCandidate(entry, candidate))) {
      this._localIceCandidates.push(candidate);
    }
  }

  _rememberRemoteIceCandidate(candidate) {
    if (!candidate?.candidate) return;
    if (!this._remoteIceCandidates.some((entry) => sameCandidate(entry, candidate))) {
      this._remoteIceCandidates.push(candidate);
    }
  }

  _refreshIceRole() {
    if (this._localDescription?.type === "offer" && this._remoteDescription?.type === "answer") {
      this._iceRole = "controlling";
      return;
    }
    if (this._remoteDescription?.type === "offer" && this._localDescription?.type === "answer") {
      this._iceRole = "controlled";
      return;
    }
    this._iceRole = "unknown";
  }

  _iceTransport() {
    return this._sctpTransport?.transport?.iceTransport || null;
  }

  _pairExistingDataChannels() {
    for (const channel of this._channels.values()) {
      const id = channel.id;
      if (id != null) this._pairDataChannelById(channel, id);
    }
  }

  _pairDataChannelById(channel, id) {
    if (!this._pairedPeer || id == null || channel.readyState === "closed") return;
    for (const peerChannel of this._pairedPeer._channels.values()) {
      if (peerChannel.readyState === "closed") continue;
      if (peerChannel.id === id) {
        channel._pairedChannel = peerChannel;
        peerChannel._pairedChannel = channel;
        return;
      }
    }
  }

  _handleRemotePeerClosed() {
    if (this._closed) return;
    this._connectionState = "disconnected";
    this._iceConnectionState = "disconnected";
    this._updateSctpTransport();
    this._iceTransport()?._forceState("disconnected");
    this._dispatchIceConnectionStateChange();
    this._dispatchConnectionStateChange();
    this._closeChannelsOnPeerFailure({ includeDisconnected: true });
  }

  _updateSctpTransport() {
    const hasData =
      hasDataMediaSection(this._localDescription) || hasDataMediaSection(this._remoteDescription);
    if (!hasData) {
      this._sctpConnectedTransitionReady = false;
      this._sctpTransport = null;
      return;
    }

    if (!this._sctpTransport) this._sctpTransport = new RTCSctpTransport(kInternalConstruct, this);
    const closed =
      this._closed ||
      this._connectionState === "closed" ||
      this._iceConnectionState === "closed" ||
      this._connectionState === "failed" ||
      this._iceConnectionState === "failed" ||
      this._connectionState === "disconnected" ||
      this._iceConnectionState === "disconnected";
    const dataTransportNegotiated =
      hasDataMediaSection(this._localDescription) && hasDataMediaSection(this._remoteDescription);
    const pairedDataTransportNegotiated =
      this._pairedPeer &&
      hasDataMediaSection(this._pairedPeer._localDescription) &&
      hasDataMediaSection(this._pairedPeer._remoteDescription);
    const nativeTransportConnected =
      this._connectionState === "connected" ||
      this._iceConnectionState === "connected" ||
      this._iceConnectionState === "completed";
    const pairedNativeTransportConnected =
      this._pairedPeer &&
      (this._pairedPeer._connectionState === "connected" ||
        this._pairedPeer._iceConnectionState === "connected" ||
        this._pairedPeer._iceConnectionState === "completed");
    const nativeConnected =
      nativeTransportConnected &&
      dataTransportNegotiated &&
      (!this._pairedPeer || pairedDataTransportNegotiated) &&
      !this._selfRemoteDescription;
    const sameProcessConnected =
      this._sameProcessIceCandidateExchange &&
      dataTransportNegotiated &&
      pairedDataTransportNegotiated &&
      (nativeTransportConnected || pairedNativeTransportConnected);
    const operationsSettled =
      (this._operationsPending === 0 &&
        (!this._pairedPeer || this._pairedPeer._operationsPending === 0)) ||
      this._sctpTransport.state === "connected";
    const shouldConnect = (nativeConnected || sameProcessConnected) && operationsSettled;
    let connected = shouldConnect;
    if (closed || !shouldConnect) this._sctpConnectedTransitionReady = false;
    if (
      shouldConnect &&
      this._sctpTransport.state !== "connected" &&
      !this._sctpConnectedTransitionReady
    ) {
      this._scheduleSctpConnectedTransition();
      connected = false;
    }
    this._sctpTransport._setLimits({
      maxMessageSize: this._currentSctpMaxMessageSize(),
      maxChannels: connected ? this._currentSctpMaxChannels() : null,
    });
    this._sctpTransport._setState(closed ? "closed" : connected ? "connected" : "connecting");
    if (connected || closed) this._sctpConnectPollDeadline = 0;
    if (connected) {
      this._scheduleConnectedStateRepair();
      this._scheduleDataChannelOpenRepair();
      this._scheduleDataChannelAnnouncementRepair();
      this._pairedPeer?._scheduleDataChannelAnnouncementRepair();
    }
    this._scheduleSctpConnectPollIfNeeded();
  }

  _scheduleSctpConnectedTransition() {
    if (this._sctpConnectedTransitionScheduled) return;
    this._sctpConnectedTransitionScheduled = true;
    setImmediate(() => {
      this._sctpConnectedTransitionScheduled = false;
      if (this._closed || !this._sctpTransport) return;
      this._sctpConnectedTransitionReady = true;
      this._updateSctpTransport();
    });
  }

  _shouldRepairConnectedState() {
    return Boolean(
      !this._closed &&
        this._sctpTransport?.state === "connected" &&
        this._sameProcessIceCandidateExchange &&
        this._hasNegotiatedDataTransport() &&
        this._pairedPeer?._hasNegotiatedDataTransport() &&
        this._operationsPending === 0 &&
        this._pairedPeer._operationsPending === 0 &&
        this._connectionState !== "failed" &&
        this._connectionState !== "disconnected" &&
        this._iceConnectionState !== "failed" &&
        this._iceConnectionState !== "disconnected" &&
        (this._connectionState !== "connected" ||
          !["connected", "completed"].includes(this._iceConnectionState)),
    );
  }

  _scheduleConnectedStateRepair() {
    if (this._connectedStateRepairScheduled || !this._shouldRepairConnectedState()) return;
    this._connectedStateRepairScheduled = true;
    setTimeout(() => {
      this._connectedStateRepairScheduled = false;
      if (!this._shouldRepairConnectedState()) return;

      if (this._iceConnectionState === "new") {
        this._iceConnectionState = "checking";
        this._dispatchIceConnectionStateChange();
        this._iceTransport()?._handlePeerIceConnectionState("checking");
      }
      if (this._connectionState === "new") {
        this._connectionState = "connecting";
        this._dispatchConnectionStateChange();
      }

      setTimeout(() => {
        if (!this._shouldRepairConnectedState()) return;
        if (!["connected", "completed"].includes(this._iceConnectionState)) {
          this._iceConnectionState = "connected";
          this._dispatchIceConnectionStateChange();
          this._iceTransport()?._handlePeerIceConnectionState("connected");
        }
        if (this._connectionState !== "connected") {
          this._connectionState = "connected";
          this._updateSctpTransport();
          this._dispatchConnectionStateChange();
        }
      }, 0);
    }, 0);
  }

  _hasNegotiatedDataTransport() {
    return (
      hasDataMediaSection(this._localDescription) && hasDataMediaSection(this._remoteDescription)
    );
  }

  _hasExplicitlyNegotiatedDataTransport() {
    return this._localDescriptionSetByApi && this._hasNegotiatedDataTransport();
  }

  _shouldDeferRemoteCandidateUntilLocalAnswer() {
    return (
      this._remoteDescription?.type === "offer" &&
      (this._signalingState === "have-remote-offer" ||
        this._pairedPeer?.signalingState === "have-local-offer" ||
        this._operationsPending > 0 ||
        this._pairedPeer?._operationsPending > 0)
    );
  }

  _queuePendingRemoteCandidatesForNative(candidates) {
    for (const candidate of candidates) {
      if (!candidate?.candidate) continue;
      if (
        !this._pendingRemoteCandidatesForNative.some((entry) => sameCandidate(entry, candidate))
      ) {
        this._pendingRemoteCandidatesForNative.push(candidate);
      }
    }
  }

  _flushPendingRemoteCandidatesForNative() {
    if (!this._remoteDescription || this._shouldDeferRemoteCandidateUntilLocalAnswer()) return;
    const candidates = this._pendingRemoteCandidatesForNative.splice(0);
    for (const candidate of candidates) {
      try {
        const nativeCandidate = candidate.toJSON();
        if (nativeCandidate.sdpMid === null) {
          nativeCandidate.sdpMid = resolveCandidateMid(this._remoteDescription, candidate);
        }
        this._ensureNativePeerConnection().addRemoteCandidate(nativeCandidate);
      } catch {
        // Same-process and inline SDP candidate races are best-effort.
      }
    }
  }

  _chainOperation(operation) {
    this._assertNotClosed();
    return new Promise((resolve, reject) => {
      const settle = (value, failed) => {
        // Closing a peer leaves active and queued operation promises pending.
        if (this._closed) return;
        if (failed) reject(value);
        else resolve(value);
        this._operationQueue.shift();
        this._finishPendingOperation();
        this._operationQueue[0]?.();
      };
      const run = () => {
        operation().then(
          (value) => settle(value, false),
          (error) => settle(error, true),
        );
      };
      this._operationsPending += 1;
      this._operationQueue.push(run);
      if (this._operationQueue.length === 1) run();
    });
  }

  _finishPendingOperation() {
    this._operationsPending = Math.max(0, this._operationsPending - 1);
    if (this._operationsPending === 0) {
      this._scheduleSctpTransportUpdate();
      if (this._pairedPeer && !this._pairedPeer._closed) {
        this._pairedPeer._scheduleSctpTransportUpdate();
      }
      this._flushPendingRemoteCandidatesForNative();
      this._pairedPeer?._flushPendingRemoteCandidatesForNative();
      this._scheduleDeferredIceEventFlush();
      const callbacks = this._operationIdleCallbacks.splice(0);
      for (const callback of callbacks) setImmediate(callback);
    }
  }

  _afterOperationsIdle(callback) {
    if (this._closed || this._operationsPending === 0) {
      setImmediate(callback);
      return;
    }
    this._operationIdleCallbacks.push(callback);
  }

  _shouldDeferIceEvent(event) {
    if (this._processingDeferredIceEvent || this._operationsPending === 0) return false;
    return event.type === "localcandidate" || event.type === "icegatheringstatechange";
  }

  _scheduleDeferredIceEventFlush() {
    if (this._iceEventFlushScheduled || this._deferredIceEvents.length === 0) return;
    this._iceEventFlushScheduled = true;
    setImmediate(() => {
      this._iceEventFlushScheduled = false;
      if (this._closed) {
        this._deferredIceEvents = [];
        this._flushIceEventIdleCallbacks();
        return;
      }
      if (this._operationsPending > 0) {
        this._scheduleDeferredIceEventFlush();
        return;
      }
      const event = this._deferredIceEvents.shift();
      this._processingDeferredIceEvent = true;
      try {
        if (event) this._handleNativeEvent(event);
      } finally {
        this._processingDeferredIceEvent = false;
      }
      if (this._deferredIceEvents.length) this._scheduleDeferredIceEventFlush();
      else this._flushIceEventIdleCallbacks();
    });
  }

  _hasPendingDeferredIceEvents() {
    return (
      this._deferredIceEvents.length > 0 ||
      this._iceEventFlushScheduled ||
      this._processingDeferredIceEvent
    );
  }

  _afterDeferredIceEventsFlushed(callback) {
    if (this._closed || !this._hasPendingDeferredIceEvents()) {
      setImmediate(callback);
      return;
    }
    this._iceEventIdleCallbacks.push(callback);
    this._scheduleDeferredIceEventFlush();
  }

  _flushIceEventIdleCallbacks() {
    if (this._hasPendingDeferredIceEvents()) return;
    const callbacks = this._iceEventIdleCallbacks.splice(0);
    for (const callback of callbacks) setImmediate(callback);
  }

  _queueSyntheticIceRestartGathering() {
    const hasGatheringStateEvent = this._deferredIceEvents.some(
      (event) => event.type === "icegatheringstatechange",
    );
    if (hasGatheringStateEvent) return;
    this._deferredIceEvents.push(
      { type: "icegatheringstatechange", state: "gathering" },
      { type: "icegatheringstatechange", state: "complete" },
    );
  }

  _scheduleSctpTransportUpdate() {
    if (this._sctpTransportUpdateScheduled) return;
    this._sctpTransportUpdateScheduled = true;
    setImmediate(() => {
      this._sctpTransportUpdateScheduled = false;
      if (!this._closed && !this._remoteTransportClosed && this._native) {
        this._connectionState = this._fromNativeConnectionState(this._native.connectionState);
        this._iceConnectionState = this._fromNativeIceConnectionState(
          this._native.iceConnectionState,
        );
      }
      this._updateSctpTransport();
    });
  }

  _scheduleSctpConnectPollIfNeeded() {
    if (
      this._closed ||
      this._operationsPending > 0 ||
      this._pairedPeer?._operationsPending > 0 ||
      this._sctpTransport?.state !== "connecting" ||
      !hasDataMediaSection(this._localDescription) ||
      !hasDataMediaSection(this._remoteDescription)
    ) {
      return;
    }

    const now = Date.now();
    if (!this._sctpConnectPollDeadline) {
      this._sctpConnectPollDeadline = now + SCTP_CONNECT_POLL_TIMEOUT_MS;
    }
    if (this._sctpConnectPollScheduled || now >= this._sctpConnectPollDeadline) return;
    this._sctpConnectPollScheduled = true;
    setTimeout(() => {
      this._sctpConnectPollScheduled = false;
      if (this._closed || this._sctpTransport?.state !== "connecting") return;
      this._scheduleSctpTransportUpdate();
    }, SCTP_CONNECT_POLL_INTERVAL_MS);
  }

  _scheduleDataChannelOpenRepair() {
    if (this._closed || this._dataChannelOpenRepairScheduled) return;
    if (this._sctpTransport?.state !== "connected") return;
    const now = Date.now();
    if (!this._dataChannelOpenRepairDeadline) {
      this._dataChannelOpenRepairDeadline = now + DATA_CHANNEL_OPEN_REPAIR_TIMEOUT_MS;
    }
    if (now >= this._dataChannelOpenRepairDeadline) return;
    this._dataChannelOpenRepairScheduled = true;
    setTimeout(() => {
      this._dataChannelOpenRepairScheduled = false;
      if (this._closed || this._sctpTransport?.state !== "connected") return;
      let hasConnectingChannel = false;
      for (const channel of this._channels.values()) {
        if (channel.readyState === "connecting") {
          hasConnectingChannel = true;
          channel._repairMissedOpenEvent();
        }
      }
      if (hasConnectingChannel) {
        this._scheduleDataChannelOpenRepair();
      } else {
        this._dataChannelOpenRepairDeadline = 0;
      }
    }, DATA_CHANNEL_OPEN_REPAIR_INTERVAL_MS);
  }

  _scheduleDataChannelAnnouncementRepair() {
    if (this._closed || this._dataChannelAnnouncementRepairScheduled) return;
    if (!this._hasDataChannelAnnouncementRepairCandidates()) {
      this._dataChannelAnnouncementRepairReadyAt = 0;
      this._dataChannelAnnouncementRepairDeadline = 0;
      return;
    }
    const now = Date.now();
    const canRepair = this._canRepairDataChannelAnnouncements();
    if (canRepair && !this._dataChannelAnnouncementRepairDeadline) {
      this._dataChannelAnnouncementRepairReadyAt = now + DATA_CHANNEL_ANNOUNCEMENT_REPAIR_GRACE_MS;
      this._dataChannelAnnouncementRepairDeadline =
        now + DATA_CHANNEL_ANNOUNCEMENT_REPAIR_TIMEOUT_MS;
    }
    if (canRepair && now >= this._dataChannelAnnouncementRepairDeadline) {
      this._dataChannelAnnouncementRepairReadyAt = 0;
      this._dataChannelAnnouncementRepairDeadline = 0;
      return;
    }
    this._dataChannelAnnouncementRepairScheduled = true;
    setTimeout(() => {
      this._dataChannelAnnouncementRepairScheduled = false;
      if (this._closed) return;
      const repairable = this._canRepairDataChannelAnnouncements();
      if (repairable && !this._dataChannelAnnouncementRepairDeadline) {
        const now = Date.now();
        this._dataChannelAnnouncementRepairReadyAt =
          now + DATA_CHANNEL_ANNOUNCEMENT_REPAIR_GRACE_MS;
        this._dataChannelAnnouncementRepairDeadline =
          now + DATA_CHANNEL_ANNOUNCEMENT_REPAIR_TIMEOUT_MS;
      }
      const canCreateSyntheticAnnouncement =
        this._pendingSyntheticDataChannelAnnouncements.size > 0 ||
        Date.now() >= this._dataChannelAnnouncementRepairReadyAt;
      const hasWork = repairable
        ? canCreateSyntheticAnnouncement
          ? this._repairMissingDataChannelAnnouncements()
          : this._hasDataChannelAnnouncementRepairCandidates()
        : this._hasDataChannelAnnouncementRepairCandidates();
      if (hasWork) {
        this._scheduleDataChannelAnnouncementRepair();
      } else {
        this._dataChannelAnnouncementRepairReadyAt = 0;
        this._dataChannelAnnouncementRepairDeadline = 0;
      }
    }, DATA_CHANNEL_ANNOUNCEMENT_REPAIR_INTERVAL_MS);
  }

  _canRepairDataChannelAnnouncements() {
    return Boolean(
      this._pairedPeer &&
        !this._pairedPeer._closed &&
        this._operationsPending === 0 &&
        this._pairedPeer._operationsPending === 0 &&
        this._hasNegotiatedDataTransport() &&
        this._pairedPeer._hasNegotiatedDataTransport(),
    );
  }

  _hasDataChannelAnnouncementRepairCandidates() {
    if (!this._pairedPeer || this._pairedPeer._closed) return false;
    if (this._pendingSyntheticDataChannelAnnouncements.size > 0) return true;
    for (const sourceChannel of this._pairedPeer._channels.values()) {
      if (
        !sourceChannel._createdLocally ||
        sourceChannel.negotiated ||
        sourceChannel.readyState === "closed"
      ) {
        continue;
      }
      const id = sourceChannel._effectiveId();
      if (id == null || !this._hasRemoteDataChannelForId(id)) return true;
    }
    return false;
  }

  _repairMissingDataChannelAnnouncements() {
    if (!this._pairedPeer || this._pairedPeer._closed) return false;
    let hasPendingWork = false;

    for (const [id, channel] of this._pendingSyntheticDataChannelAnnouncements) {
      if (channel.readyState === "closed") {
        this._pendingSyntheticDataChannelAnnouncements.delete(id);
        continue;
      }
      if (!channel._native.isOpen) {
        hasPendingWork = true;
        continue;
      }
      channel._readyState = "open";
      channel._openEventPending = true;
      channel._announcementPending = true;
      const sourceChannel = channel._pairedChannel;
      if (sourceChannel?.readyState === "connecting") {
        sourceChannel._readyState = "open";
        sourceChannel._pc._registerDataChannelId(sourceChannel);
        sourceChannel._dispatchOpenEvent();
      }
      this._remoteAnnouncedDataChannelIds.add(id);
      this._pendingSyntheticDataChannelAnnouncements.delete(id);
      this._pendingDataChannelEvents.push(new RTCDataChannelEvent("datachannel", { channel }));
      this._scheduleDataChannelFlush();
    }

    for (const sourceChannel of this._pairedPeer._channels.values()) {
      if (
        !sourceChannel._createdLocally ||
        sourceChannel.negotiated ||
        sourceChannel.readyState === "closed"
      ) {
        continue;
      }
      let id = sourceChannel.id;
      if (id == null) {
        this._assignSyntheticDataChannelIdIfNeeded(sourceChannel);
        id = sourceChannel.id;
      }
      if (id == null) {
        hasPendingWork = true;
        continue;
      }
      if (this._hasRemoteDataChannelForId(id)) continue;
      const channel = this._createSyntheticIncomingDataChannel(sourceChannel, id);
      if (channel) hasPendingWork = true;
    }

    return hasPendingWork || this._pendingSyntheticDataChannelAnnouncements.size > 0;
  }

  _assignSyntheticDataChannelIdIfNeeded(channel) {
    if (channel.negotiated || channel._effectiveId() != null || channel.readyState === "closed") {
      return;
    }
    const parity = channel._pc._dataChannelIdParityFromDtlsRole() ?? 1;
    const id = channel._pc._nextAvailableDataChannelId(parity);
    if (id != null) channel._assignId(id);
  }

  _hasRemoteDataChannelForId(id) {
    if (
      this._remoteAnnouncedDataChannelIds.has(id) ||
      this._pendingSyntheticDataChannelAnnouncements.has(id)
    ) {
      return true;
    }
    for (const channel of this._channels.values()) {
      if (!channel._createdLocally && channel.readyState !== "closed" && channel.id === id)
        return true;
    }
    return false;
  }

  _syntheticIncomingDataChannelForId(id) {
    const pending = this._pendingSyntheticDataChannelAnnouncements.get(id);
    if (pending && pending.readyState !== "closed") return pending;
    for (const event of this._pendingDataChannelEvents) {
      const channel = event.channel;
      if (channel?._syntheticIncoming && channel.readyState !== "closed" && channel.id === id) {
        return channel;
      }
    }
    for (const channel of this._channels.values()) {
      if (channel._syntheticIncoming && channel.readyState !== "closed" && channel.id === id) {
        return channel;
      }
    }
    return null;
  }

  _hasPendingDataChannelEventForId(id) {
    return this._pendingDataChannelEvents.some((event) => {
      const channel = event.channel;
      const channelId =
        typeof channel?._effectiveId === "function" ? channel._effectiveId() : channel?.id;
      return channelId === id;
    });
  }

  _hasSettledDataChannelAnnouncement(id) {
    if (id == null) return false;
    if (
      this._pendingSyntheticDataChannelAnnouncements.has(id) ||
      this._hasPendingDataChannelEventForId(id)
    ) {
      return false;
    }
    if (this._remoteAnnouncedDataChannelIds.has(id)) return true;
    for (const channel of this._channels.values()) {
      if (!channel._createdLocally && channel.readyState !== "closed" && channel.id === id) {
        return true;
      }
    }
    return false;
  }

  _afterDataChannelAnnouncementSettled(id, callback) {
    const deadline = Date.now() + DATA_CHANNEL_ANNOUNCEMENT_REPAIR_TIMEOUT_MS;
    const poll = () => {
      const settled = this._hasSettledDataChannelAnnouncement(id);
      if (
        settled ||
        this._closed ||
        !this._hasEventConsumer("datachannel") ||
        Date.now() >= deadline
      ) {
        setTimeout(() => callback(settled), 0);
        return;
      }
      this._scheduleDataChannelAnnouncementRepair();
      this._scheduleDataChannelFlush();
      setTimeout(poll, DATA_CHANNEL_ANNOUNCEMENT_REPAIR_INTERVAL_MS);
    };
    setTimeout(poll, 0);
  }

  _createSyntheticIncomingDataChannel(sourceChannel, id) {
    const options = {
      ordered: sourceChannel.ordered,
      maxPacketLifeTime: sourceChannel.maxPacketLifeTime,
      maxRetransmits: sourceChannel.maxRetransmits,
      protocol: sourceChannel.protocol,
      negotiated: true,
      id,
    };
    const nativeChannel = new SyntheticNativeDataChannel(sourceChannel.label, options);
    const channel = RTCDataChannel._fromNative(this, nativeChannel, undefined, id);
    channel._createdLocally = false;
    channel._negotiatedOverride = false;
    channel._syntheticIncoming = true;
    channel._pairedChannel = sourceChannel;
    sourceChannel._pairedChannel = channel;
    this._pendingSyntheticDataChannelAnnouncements.set(id, channel);
    return channel;
  }

  _currentSctpMaxMessageSize() {
    if (!this._localDescription || !this._remoteDescription) return null;
    if (
      !hasDataMediaSection(this._localDescription) ||
      !hasDataMediaSection(this._remoteDescription)
    )
      return null;
    if (this._selfRemoteDescription && !this._explicitIceCandidateExchange) return null;
    const localLimit =
      maxMessageSizeFromSdp(this._localDescription) || DEFAULT_SCTP_MAX_MESSAGE_SIZE;
    const remoteLimit = maxMessageSizeFromSdp(this._remoteDescription);
    if (remoteLimit === null) return Math.min(65536, localLimit);
    if (remoteLimit === 0) return localLimit || Number.POSITIVE_INFINITY;
    return localLimit === 0 ? remoteLimit : Math.min(remoteLimit, localLimit);
  }

  _currentSctpMaxChannels() {
    const connected =
      this._connectionState === "connected" || this._sctpTransport?.state === "connected";
    if (!connected || this._selfRemoteDescription) return null;
    if (!this._native) return null;
    const maxId = Number(this._native.maxDataChannelId);
    return Number.isFinite(maxId) && maxId >= 0 ? maxId + 1 : LIBDATACHANNEL_SCTP_MAX_CHANNELS;
  }

  _implicitLocalDescriptionType() {
    return this._signalingState === "have-remote-offer" ||
      this._signalingState === "have-local-pranswer"
      ? "answer"
      : "offer";
  }

  _descriptionSignalingState() {
    if (this._closed) return "closed";
    if (this._pendingLocalDescription?.type === "offer") return "have-local-offer";
    if (this._pendingRemoteDescription?.type === "offer") return "have-remote-offer";
    if (this._pendingLocalDescription?.type === "pranswer") return "have-local-pranswer";
    if (this._pendingRemoteDescription?.type === "pranswer") return "have-remote-pranswer";
    return "stable";
  }

  _syncSignalingStateFromDescriptions() {
    if (this._jsOnlyIceRestartOfferPending) {
      this._signalingState = "have-local-offer";
      return;
    }
    this._signalingState = this._descriptionSignalingState();
  }

  _dispatchSignalingStateChange() {
    this._lastDispatchedSignalingState = this._signalingState;
    this.dispatchEvent(makeEvent("signalingstatechange"));
  }

  // States can be synchronized from native without an event, so compare with
  // the last dispatched value; the events fire only when the state changes.
  _dispatchConnectionStateChange() {
    if (this._connectionState === this._lastDispatchedConnectionState) return;
    this._lastDispatchedConnectionState = this._connectionState;
    this.dispatchEvent(makeEvent("connectionstatechange"));
  }

  _dispatchIceConnectionStateChange() {
    if (this._iceConnectionState === this._lastDispatchedIceConnectionState) return;
    this._lastDispatchedIceConnectionState = this._iceConnectionState;
    this.dispatchEvent(makeEvent("iceconnectionstatechange"));
  }

  // libdatachannel reports Closed when the remote peer ends DTLS/SCTP, but W3C
  // reserves "closed" for close() on this object. Report the terminal states a
  // browser reaches after its peer closes; see docs/divergences.md.
  _fromNativeConnectionState(state) {
    if (state !== "closed" || this._closed) return state;
    this._remoteTransportClosed = true;
    return "failed";
  }

  _fromNativeIceConnectionState(state) {
    if (state !== "closed" || this._closed) return state;
    this._remoteTransportClosed = true;
    return "disconnected";
  }

  _setPendingLocalDescription(description) {
    this._pendingLocalDescription = description;
    this._localDescription = description || this._currentLocalDescription;
  }

  _commitLocalDescription(description = this._pendingLocalDescription || this._localDescription) {
    if (description) this._currentLocalDescription = description;
    this._pendingLocalDescription = null;
    this._localDescription = this._currentLocalDescription;
  }

  _rollbackLocalDescription() {
    this._pendingLocalDescription = null;
    this._localDescription = this._currentLocalDescription;
  }

  _setPendingRemoteDescription(description) {
    this._pendingRemoteDescription = description;
    this._remoteDescription = description || this._currentRemoteDescription;
  }

  _commitRemoteDescription(
    description = this._pendingRemoteDescription || this._remoteDescription,
  ) {
    if (description) this._currentRemoteDescription = description;
    this._pendingRemoteDescription = null;
    this._remoteDescription = this._currentRemoteDescription;
  }

  _rollbackRemoteDescription() {
    this._pendingRemoteDescription = null;
    this._remoteDescription = this._currentRemoteDescription;
  }

  async _implicitRollbackLocalDescription() {
    const previousState = this._signalingState;
    const previousGatheringState = this._iceGatheringState;
    const rollingBackInitialOffer = !this._currentLocalDescription;
    const nativeBackedRollback = this._localDescription && !isNoMediaSdp(this._localDescription);
    if (nativeBackedRollback) {
      this._suppressNextNativeSignalingState = "stable";
      try {
        this._ensureNativePeerConnection().setLocalDescription("rollback");
      } catch (error) {
        this._suppressNextNativeSignalingState = null;
        throw error;
      }
    }
    this._rollbackLocalDescription();
    this._localIceCandidates = [];
    this._unregisterLocalDescriptionsForPairing();
    this._syncStatesFromNative();
    this._signalingState = "stable";
    if (rollingBackInitialOffer) this._iceGatheringState = "new";
    this._refreshIceRole();
    this._updateSctpTransport();
    if (rollingBackInitialOffer && previousGatheringState !== "new") {
      this.dispatchEvent(makeEvent("icegatheringstatechange"));
      this._iceTransport()?.dispatchEvent(makeEvent("gatheringstatechange"));
    }
    if (previousState !== this._signalingState) this._dispatchSignalingStateChange();
    await nextTask();
    if (this._suppressNextNativeSignalingState === "stable")
      this._suppressNextNativeSignalingState = null;
  }

  _refreshCurrentOrPendingLocalDescription(description) {
    if (!description) return;
    this._localDescription = description;
    if (this._pendingLocalDescription?.type === description.type) {
      this._pendingLocalDescription = description;
    } else {
      this._currentLocalDescription = description;
    }
  }

  _refreshCurrentOrPendingRemoteDescription(description) {
    if (!description) return;
    this._remoteDescription = description;
    if (this._pendingRemoteDescription?.type === description.type) {
      this._pendingRemoteDescription = description;
    } else {
      this._currentRemoteDescription = description;
    }
  }

  _ensureIceRestartCredentials() {
    if (!this._pendingIceRestartCredentials) {
      this._pendingIceRestartCredentials = createIceRestartCredentials();
    }
    return this._pendingIceRestartCredentials;
  }

  _setNonstandardLocalIceCredentials(credentials) {
    this._assertNotClosed();
    if (credentials === null || typeof credentials !== "object") {
      throw new TypeError("ICE credentials must be an object");
    }
    const iceUfrag = credentials.iceUfrag;
    const icePwd = credentials.icePwd;
    if (typeof iceUfrag !== "string" || iceUfrag.length < 4) {
      throw new TypeError("iceUfrag must contain at least 4 characters");
    }
    if (typeof icePwd !== "string" || icePwd.length < 22) {
      throw new TypeError("icePwd must contain at least 22 characters");
    }
    if (byteLength(iceUfrag) > 256 || byteLength(icePwd) > 256) {
      throw new TypeError("ICE credentials must not exceed 256 bytes");
    }
    if (!/^[A-Za-z0-9+/]+$/.test(iceUfrag) || !/^[A-Za-z0-9+/]+$/.test(icePwd)) {
      throw new TypeError("ICE credentials may contain only ASCII letters, digits, +, or /");
    }
    if (this._nonstandardPreparedLocalDescriptionType) {
      const current = this._nonstandardLocalIceCredentials;
      if (current?.iceUfrag === iceUfrag && current?.icePwd === icePwd) return;
      throw makeDOMException(
        "Local ICE credentials have already been applied",
        "InvalidStateError",
      );
    }
    if (!this._canApplyNativeIceCredentials()) {
      throw makeDOMException(
        "Explicit local ICE credentials must be set before the first local description",
        "InvalidStateError",
      );
    }
    this._nonstandardLocalIceCredentials = { iceUfrag, icePwd };
  }

  _prepareNonstandardLocalDescription(type) {
    if (!this._nonstandardLocalIceCredentials) return null;
    if (this._nonstandardPreparedLocalDescriptionType) {
      if (this._nonstandardPreparedLocalDescriptionType !== type) {
        throw makeDOMException(
          "Explicit local ICE credentials were applied to another description type",
          "InvalidStateError",
        );
      }
      return this._preparedLocalDescription?.toJSON() ?? null;
    }

    this._nonstandardPreparedLocalDescriptionType = type;
    const nativeSignalingState = type === "offer" ? "have-local-offer" : "stable";
    this._suppressNextNativeSignalingState = nativeSignalingState;
    try {
      const nativePeerConnection = this._ensureNativePeerConnection();
      nativePeerConnection.setLocalDescription(type, this._nonstandardLocalIceCredentials);
      const description = nativePeerConnection.localDescription();
      if (!description) {
        throw new Error("libdatachannel did not generate a local description");
      }
      this._preparedLocalDescription = new RTCSessionDescription(description);
      return this._preparedLocalDescription.toJSON();
    } catch (error) {
      this._nonstandardPreparedLocalDescriptionType = null;
      this._preparedLocalDescription = null;
      if (this._suppressNextNativeSignalingState === nativeSignalingState) {
        this._suppressNextNativeSignalingState = null;
      }
      throw error;
    }
  }

  _localOfferInit(type) {
    if (type !== "offer" || !this._iceRestartPending || !this._canApplyNativeIceCredentials()) {
      return undefined;
    }
    return this._ensureIceRestartCredentials();
  }

  _canApplyNativeIceCredentials() {
    return (
      this._iceGatheringState === "new" &&
      !this._localDescription &&
      !this._currentLocalDescription &&
      !this._pendingLocalDescription
    );
  }

  _isJsOnlyIceRestartRemoteOffer(description, explicitMarker) {
    if (explicitMarker) return true;
    if (description.type !== "offer" || !this._currentRemoteDescription) return false;
    if (!hasDataMediaSection(description) || !hasDataMediaSection(this._currentRemoteDescription)) {
      return false;
    }
    return hasDifferentIceCredentials(description, this._currentRemoteDescription);
  }

  _shouldApplyDataOnlyLocalOffer(description) {
    return (
      !this._iceRestartPending &&
      this._signalingState === "stable" &&
      this._currentLocalDescription?.type === "offer" &&
      this._currentRemoteDescription?.type === "answer" &&
      hasDataMediaSection(this._currentLocalDescription) &&
      hasDataMediaSection(this._currentRemoteDescription) &&
      (!description ||
        (hasDataMediaSection(description) &&
          !hasDifferentIceCredentials(description, this._currentLocalDescription)))
    );
  }

  _shouldApplyDataOnlyLocalAnswer(description) {
    return (
      this._pendingRemoteDescription?.type === "offer" &&
      this._currentRemoteDescription?.type === "offer" &&
      this._currentLocalDescription?.type === "answer" &&
      hasDataMediaSection(this._pendingRemoteDescription) &&
      hasDataMediaSection(this._currentRemoteDescription) &&
      hasDataMediaSection(this._currentLocalDescription) &&
      !hasDifferentIceCredentials(this._pendingRemoteDescription, this._currentRemoteDescription) &&
      (!description ||
        (hasDataMediaSection(description) &&
          !hasDifferentIceCredentials(description, this._currentLocalDescription)))
    );
  }

  _shouldApplyDataOnlyRemoteOffer(description) {
    return (
      this._signalingState === "stable" &&
      this._currentRemoteDescription?.type === "offer" &&
      this._currentLocalDescription?.type === "answer" &&
      hasDataMediaSection(description) &&
      hasDataMediaSection(this._currentRemoteDescription) &&
      hasDataMediaSection(this._currentLocalDescription) &&
      !hasDifferentIceCredentials(description, this._currentRemoteDescription)
    );
  }

  _shouldApplyDataOnlyRemoteAnswer(description) {
    return (
      this._pendingLocalDescription?.type === "offer" &&
      this._currentLocalDescription?.type === "offer" &&
      this._currentRemoteDescription?.type === "answer" &&
      hasDataMediaSection(description) &&
      hasDataMediaSection(this._pendingLocalDescription) &&
      hasDataMediaSection(this._currentLocalDescription) &&
      hasDataMediaSection(this._currentRemoteDescription) &&
      !hasDifferentIceCredentials(this._pendingLocalDescription, this._currentLocalDescription) &&
      !hasDifferentIceCredentials(description, this._currentRemoteDescription)
    );
  }

  _clearIceRestartRequest() {
    this._iceRestartPending = false;
    this._pendingIceRestartCredentials = null;
  }

  _assertNotClosed() {
    if (this._closed) throw makeDOMException("RTCPeerConnection is closed", "InvalidStateError");
  }

  async _ensureLocalAnswerApplied() {
    if (this._localDescription?.type === "answer" && !this._pendingRemoteDescription)
      return this._localDescription;
    if (this._jsOnlyIceRestartRemoteOffer) {
      const answer =
        this._lastCreatedAnswer ||
        markJsOnlyIceRestart(
          new RTCSessionDescription(this._ensureNativePeerConnection().createAnswer()),
        );
      await this._applyJsOnlyLocalAnswer(answer);
      return this._localDescription;
    }
    if (isNoMediaSdp(this.remoteDescription)) {
      const answer =
        this._lastCreatedAnswer ||
        new RTCSessionDescription({
          type: "answer",
          sdp: this.remoteDescription.sdp,
        });
      await this._applyNoMediaLocalDescription(answer);
      return this._localDescription;
    }
    this._ensureNativePeerConnection().setLocalDescription("answer");
    const nativeDescription = this._ensureNativePeerConnection().localDescription();
    this._localDescription = nativeDescription
      ? new RTCSessionDescription(nativeDescription)
      : null;
    this._syncStatesFromNative();
    this._commitRemoteDescription();
    this._commitLocalDescription(this._localDescription);
    this._syncSignalingStateFromDescriptions();
    this._scheduleNativeCandidateGathering();
    for (const candidate of this._pendingIce.splice(0))
      await this._addExchangedLocalCandidate(candidate);
    this._flushPendingRemoteCandidatesForNative();
    await nextTask();
    await this._refreshLocalDescriptionAfterGatheringWindow();
    this._registerLocalDescriptionForPairing();
    return this._localDescription;
  }

  async _applyJsOnlyLocalAnswer(description) {
    const previousState = this._signalingState;
    const localDescription = markJsOnlyIceRestart(new RTCSessionDescription(description));
    this._commitRemoteDescription();
    this._commitLocalDescription(localDescription);
    this._registerLocalDescriptionForPairing();
    this._jsOnlyIceRestartRemoteOffer = false;
    this._clearNegotiationNeededIfDataMLineIsPresent();
    this._signalingState = "stable";
    this._refreshIceRole();
    this._updateSctpTransport();
    if (previousState !== this._signalingState) this._dispatchSignalingStateChange();
    await nextTask();
  }

  async _applyDataOnlyLocalOffer(description) {
    const previousState = this._signalingState;
    const localDescription = new RTCSessionDescription(description);
    this._setPendingLocalDescription(localDescription);
    this._registerLocalDescriptionForPairing();
    this._syncSignalingStateFromDescriptions();
    this._refreshIceRole();
    this._updateSctpTransport();
    if (previousState !== this._signalingState) this._dispatchSignalingStateChange();
    await nextTask();
  }

  async _applyDataOnlyLocalAnswer(description) {
    const previousState = this._signalingState;
    const localDescription = new RTCSessionDescription(description);
    this._commitRemoteDescription();
    this._commitLocalDescription(localDescription);
    this._registerLocalDescriptionForPairing();
    this._clearNegotiationNeededIfDataMLineIsPresent();
    this._syncSignalingStateFromDescriptions();
    this._refreshIceRole();
    this._updateSctpTransport();
    if (previousState !== this._signalingState) this._dispatchSignalingStateChange();
    await nextTask();
  }

  async _applyNoMediaLocalDescription(description) {
    const localDescription = new RTCSessionDescription(description);
    if (localDescription.type === "offer") {
      this._setPendingLocalDescription(localDescription);
    } else if (localDescription.type === "answer") {
      this._commitRemoteDescription();
      this._commitLocalDescription(localDescription);
    } else {
      this._setPendingLocalDescription(localDescription);
    }
    this._registerLocalDescriptionForPairing();
    this._signalingState = description.type === "offer" ? "have-local-offer" : "stable";
    this._clearNegotiationNeededIfDataMLineIsPresent();
    this._refreshIceRole();
    this._updateSctpTransport();
    this._dispatchSignalingStateChange();
    await nextTask();
  }

  _scheduleNativeCandidateGathering() {
    if (this._closed || !this._native || !hasDataMediaSection(this._localDescription)) return;
    if (this._nativeCandidateGatheringScheduled) return;
    this._nativeCandidateGatheringScheduled = true;
    setImmediate(() => {
      this._nativeCandidateGatheringScheduled = false;
      if (this._closed || !this._native || !hasDataMediaSection(this._localDescription)) return;
      try {
        this._native.gatherLocalCandidates();
      } catch {
        // Gathering may already be complete or the native transport may be closing.
      }
    });
  }

  _refreshLocalDescriptionFromNative() {
    if (this._closed || !this._localDescription) return;
    if (!this._native) return;
    const nativeDescription = this._native.localDescription();
    if (nativeDescription) {
      this._refreshCurrentOrPendingLocalDescription(new RTCSessionDescription(nativeDescription));
      this._registerLocalDescriptionForPairing();
    }
    this._syncStatesFromNative();
  }

  _refreshLocalDescriptionAfterGatheringWindow() {
    this._refreshLocalDescriptionFromNative();
    if (this._closed || !this._localDescription || this._iceGatheringState === "complete") return;
    if (this._localDescriptionRefreshScheduled) return;
    this._localDescriptionRefreshScheduled = true;
    setTimeout(() => {
      this._localDescriptionRefreshScheduled = false;
      this._refreshLocalDescriptionFromNative();
    }, 50);
  }

  _syncStatesFromNative() {
    if (this._closed) return;
    if (!this._native) return;
    this._connectionState = this._fromNativeConnectionState(this._native.connectionState);
    this._iceConnectionState = this._fromNativeIceConnectionState(this._native.iceConnectionState);
    this._syncSignalingStateFromDescriptions();
    this._refreshIceRole();
    this._updateSctpTransport();
  }

  _handleNativeEvent(event) {
    if (this._closed) {
      try {
        event.channel?.close?.();
      } catch {
        // Closed peers must ignore late native callbacks; channel close is best-effort.
      }
      return;
    }
    if (this._shouldDeferIceEvent(event)) {
      this._deferredIceEvents.push(event);
      return;
    }

    if (event.target === "datachannel") {
      const channel = this._channels.get(event.channelId);
      if (channel) {
        channel._handleNativeEvent(event);
      } else if (event.channelId) {
        const events = this._pendingNativeDataChannelEvents.get(event.channelId) || [];
        events.push(event);
        this._pendingNativeDataChannelEvents.set(event.channelId, events);
      }
      return;
    }

    switch (event.type) {
      case "datachannel": {
        const incomingId = event.channel?.id ?? null;
        let channel =
          incomingId == null ? null : this._syntheticIncomingDataChannelForId(incomingId);
        const adoptedSynthetic = Boolean(channel && channel.readyState !== "closed");
        if (adoptedSynthetic) {
          this._pendingSyntheticDataChannelAnnouncements.delete(incomingId);
          channel._adoptNativeChannel(event.channel, event.channelReadyState);
        } else {
          channel = RTCDataChannel._fromNative(this, event.channel, event.channelReadyState);
        }
        const id = channel.id;
        if (id != null) {
          if (adoptedSynthetic && this._remoteAnnouncedDataChannelIds.has(id)) {
            this._flushPendingNativeDataChannelEvents(channel, event.channel.bindingId);
            channel._flushQueuedNativeEventsAfterAnnouncement();
            if (!channel._announcementPending) channel._announceOpenAfterDataChannelEvent();
            break;
          }
          if (this._remoteAnnouncedDataChannelIds.has(id)) {
            channel.close();
            break;
          }
          this._remoteAnnouncedDataChannelIds.add(id);
        }
        channel._createdLocally = false;
        channel._openEventPending = channel.readyState === "open";
        channel._announcementPending = true;
        this._pendingDataChannelEvents.push(new RTCDataChannelEvent("datachannel", { channel }));
        this._flushPendingNativeDataChannelEvents(channel, event.channelId);
        this._scheduleDataChannelFlush();
        break;
      }
      case "localdescription": {
        const description = new RTCSessionDescription(event.description);
        if (this._nonstandardPreparedLocalDescriptionType === description.type) {
          this._preparedLocalDescription = description;
          break;
        }
        // A queued notification may describe an offer that has been rolled back
        // or replaced. Refresh only the description already applied by JS.
        if (!hasDataMediaSection(this._localDescription) || this._jsOnlyIceRestartOfferPending) {
          break;
        }
        const latest = this._native.localDescription();
        if (latest?.type !== this._localDescription.type) break;
        this._refreshCurrentOrPendingLocalDescription(new RTCSessionDescription(latest));
        this._registerLocalDescriptionForPairing();
        this._refreshIceRole();
        this._updateSctpTransport();
        break;
      }
      case "localcandidate": {
        const candidateInit = {
          candidate: event.candidate.candidate,
          sdpMid: event.candidate.sdpMid || "0",
        };
        const candidate = new RTCIceCandidate(candidateInit);
        Object.defineProperty(candidate, "_webrtcNodeLocalCandidate", {
          value: true,
          configurable: true,
        });
        this._rememberLocalIceCandidate(candidate);
        this._refreshCurrentOrPendingLocalDescription(
          appendRemoteCandidateToDescription(this._localDescription, candidate),
        );
        this.dispatchEvent(new RTCPeerConnectionIceEvent("icecandidate", { candidate }));
        break;
      }
      case "icegatheringstatechange":
        this._iceGatheringState = event.state;
        this.dispatchEvent(makeEvent("icegatheringstatechange"));
        this._iceTransport()?.dispatchEvent(makeEvent("gatheringstatechange"));
        if (event.state === "complete") {
          this.dispatchEvent(new RTCPeerConnectionIceEvent("icecandidate", { candidate: null }));
        }
        break;
      case "iceconnectionstatechange": {
        const state = this._fromNativeIceConnectionState(event.state);
        this._iceConnectionState = state;
        this._updateSctpTransport();
        this._dispatchIceConnectionStateChange();
        this._iceTransport()?._handlePeerIceConnectionState(state);
        this._closeChannelsOnPeerFailure();
        break;
      }
      case "connectionstatechange":
        this._connectionState = this._fromNativeConnectionState(event.state);
        this._updateSctpTransport();
        this._dispatchConnectionStateChange();
        this._closeChannelsOnPeerFailure();
        break;
      case "signalingstatechange":
        if (this._jsOnlyIceRestartOfferPending) {
          this._signalingState = "have-local-offer";
          break;
        }
        if (this._suppressNextNativeSignalingState === event.state) {
          this._suppressNextNativeSignalingState = null;
          break;
        }
        if (event.state !== this._descriptionSignalingState()) break;
        if (
          event.state === this._signalingState &&
          event.state === this._lastDispatchedSignalingState
        ) {
          break;
        }
        this._signalingState = event.state;
        this._dispatchSignalingStateChange();
        break;
    }
  }

  // Native message batches arrive as channel ids plus payloads; consecutive
  // messages for one channel keep the single-channel batch fast path.
  _handleNativeMessages(channelIds, payloads) {
    const count = payloads.length;
    let start = 0;
    while (start < count) {
      const channelId = channelIds[start];
      let end = start + 1;
      while (end < count && channelIds[end] === channelId) end += 1;
      const events = new Array(end - start);
      for (let index = start; index < end; index += 1) {
        const data = payloads[index];
        events[index - start] = {
          target: "datachannel",
          type: "message",
          channelId,
          binary: typeof data !== "string",
          data,
        };
      }
      if (events.length === 1) this._handleNativeEvent(events[0]);
      else this._handleNativeEventBatch(events);
      start = end;
    }
  }

  _handleNativeEventBatch(events) {
    if (!events.length) return;
    const first = events[0];
    if (first?.target !== "datachannel" || first.type !== "message" || first.channelId == null) {
      for (const event of events) this._handleNativeEvent(event);
      return;
    }

    const channelId = first.channelId;
    for (let index = 1; index < events.length; index += 1) {
      const event = events[index];
      if (
        event?.target !== "datachannel" ||
        event.type !== "message" ||
        event.channelId !== channelId
      ) {
        for (const item of events) this._handleNativeEvent(item);
        return;
      }
    }

    const channel = this._channels.get(channelId);
    if (channel) {
      if (channel._announcementPending || channel._nativeEventDrainActive) {
        for (const event of events) channel._queuedNativeEvents.push(event);
        return;
      }
      if (channel._dispatchNativeMessageBatch(events)) return;
      channel._queueMessageEvents(events);
      return;
    }

    const pending = this._pendingNativeDataChannelEvents.get(channelId) || [];
    for (const event of events) pending.push(event);
    this._pendingNativeDataChannelEvents.set(channelId, pending);
  }

  _registerDataChannelId(channel, id = channel._effectiveId()) {
    if (id == null) return;
    if (channel._registeredDataChannelId === id) return;
    this._unregisterDataChannelId(channel);
    const existing = this._usedDataChannelIds.get(id);
    if (existing && existing !== channel && existing.readyState !== "closed") return;
    channel._registeredDataChannelId = id;
    this._usedDataChannelIds.set(id, channel);
    this._pairDataChannelById(channel, id);
  }

  _flushPendingNativeDataChannelEvents(channel, channelId) {
    const events = this._pendingNativeDataChannelEvents.get(channelId);
    if (!events) return;
    this._pendingNativeDataChannelEvents.delete(channelId);
    for (const event of events) {
      if (channel._announcementPending || channel._nativeEventDrainActive) {
        channel._queuedNativeEvents.push(event);
      } else {
        channel._handleNativeEvent(event, true);
      }
    }
  }

  _unregisterDataChannelId(channel) {
    const id = channel._registeredDataChannelId;
    if (id == null) return;
    if (this._usedDataChannelIds.get(id) === channel) {
      this._usedDataChannelIds.delete(id);
    }
    channel._registeredDataChannelId = null;
  }

  _isDataChannelIdInUse(id) {
    let channel = this._usedDataChannelIds.get(id);
    if (channel && channel.readyState !== "closed") return true;
    if (!this._dataChannelIdRefreshNeeded) return false;

    let refreshStillNeeded = false;
    for (const currentChannel of this._channels.values()) {
      if (currentChannel.readyState === "closed") continue;
      const effectiveId = currentChannel._effectiveId();
      if (effectiveId == null) {
        refreshStillNeeded = true;
        continue;
      }
      this._registerDataChannelId(currentChannel, effectiveId);
    }
    this._dataChannelIdRefreshNeeded = refreshStillNeeded;
    channel = this._usedDataChannelIds.get(id);
    return Boolean(channel && channel.readyState !== "closed");
  }

  _dataChannelIdParityFromDtlsRole() {
    if (this._remoteDescription?.type !== "answer") return null;
    if (this._localDescription?.type !== "offer") return null;
    const setup = dtlsSetupFromDescription(this._remoteDescription);
    if (setup === "passive") return 0;
    if (setup === "active") return 1;
    return null;
  }

  _nextAvailableDataChannelId(parity) {
    for (let id = parity; id <= 65534; id += 2) {
      if (!this._isDataChannelIdInUse(id)) return id;
    }
    return null;
  }

  _assignDataChannelIdsFromDtlsRole() {
    const parity = this._dataChannelIdParityFromDtlsRole();
    if (parity === null) return;
    for (const channel of this._channels.values()) {
      if (channel.negotiated || channel._effectiveId() != null || channel.readyState === "closed")
        continue;
      const id = this._nextAvailableDataChannelId(parity);
      if (id === null) {
        channel._handlePeerConnectionFailure();
        continue;
      }
      channel._assignId(id);
    }
  }

  _closeChannelsOnPeerFailure({ includeDisconnected = false } = {}) {
    if (this._closed) return;
    const failed =
      this._connectionState === "closed" ||
      this._connectionState === "failed" ||
      this._iceConnectionState === "closed" ||
      this._iceConnectionState === "failed" ||
      (includeDisconnected &&
        (this._connectionState === "disconnected" || this._iceConnectionState === "disconnected"));
    if (!failed) return;
    for (const channel of this._channels.values()) {
      // Transport callbacks can overtake messages still queued for JS delivery.
      channel._queueNativeCloseEvent(true);
    }
  }

  _markNegotiationNeeded() {
    if (this._closed || this._signalingState !== "stable" || this._negotiationNeeded) return;
    this._negotiationNeeded = true;
    if (this._negotiationNeededScheduled) return;
    this._negotiationNeededScheduled = true;
    setTimeout(() => {
      this._negotiationNeededScheduled = false;
      if (this._closed || this._signalingState !== "stable" || !this._negotiationNeeded) return;
      this.dispatchEvent(makeEvent("negotiationneeded"));
    }, 0);
  }

  _clearNegotiationNeededIfDataMLineIsPresent() {
    const sdp = this._localDescription?.sdp || this._remoteDescription?.sdp || "";
    if (/\r?\nm=application\b/i.test(sdp)) {
      this._negotiationNeeded = false;
    }
  }

  _eventListenerAdded(type) {
    if (type === "datachannel") {
      this._scheduleDataChannelFlush();
      this._scheduleDataChannelAnnouncementRepair();
      this._pairedPeer?._scheduleDataChannelAnnouncementRepair();
    }
  }

  _scheduleDataChannelFlush() {
    if (this._dataChannelFlushScheduled || !this._pendingDataChannelEvents.length) return;
    this._dataChannelFlushScheduled = true;
    setTimeout(() => {
      this._dataChannelFlushScheduled = false;
      if (this._closed || !this._hasEventConsumer("datachannel")) return;
      const events = this._pendingDataChannelEvents.splice(0);
      for (const event of events) {
        if (this._closed) return;
        event.channel._gateMessageEventsUntilConsumer();
        this.dispatchEvent(event);
        event.channel._announcementPending = false;
        event.channel._announceOpenAfterDataChannelEvent();
        event.channel._gateMessageEventsAfterAnnouncement();
        event.channel._gateMessageEventsUntilConsumer();
        event.channel._flushQueuedNativeEventsAfterAnnouncement();
      }
      if (this._pendingDataChannelEvents.length) this._scheduleDataChannelFlush();
    }, 0);
  }
}
