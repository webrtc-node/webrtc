// @ts-nocheck -- converted from JavaScript; strict typing lands module by module.

const native = require("./native/load");

import { importCertificate, RTCCertificate } from "./certificate";
import { RTCDataChannel } from "./data-channel";
import { RTCError } from "./errors";
import {
  RTCDataChannelEvent,
  RTCErrorEvent,
  RTCPeerConnectionIceErrorEvent,
  RTCPeerConnectionIceEvent,
  SimpleEvent,
  SimpleEventTarget,
  SimpleMessageEvent,
} from "./events";
import {
  configurePeerConnection,
  getRemoteFingerprint,
  IceUdpMuxListener,
  setLocalIceCredentials,
} from "./nonstandard";
import { RTCPeerConnection } from "./peer-connection";
import { RTCIceCandidate, RTCIceCandidatePair, RTCSessionDescription } from "./sdp";
import { RTCDtlsTransport, RTCIceTransport, RTCSctpTransport } from "./transports";

export {
  RTCCertificate,
  RTCDataChannel,
  RTCDataChannelEvent,
  RTCDtlsTransport,
  RTCError,
  RTCErrorEvent,
  RTCIceCandidate,
  RTCIceCandidatePair,
  RTCIceTransport,
  RTCPeerConnection,
  RTCPeerConnectionIceErrorEvent,
  RTCPeerConnectionIceEvent,
  RTCSctpTransport,
  RTCSessionDescription,
  SimpleEvent as Event,
  SimpleEventTarget as EventTarget,
  SimpleMessageEvent as MessageEvent,
};

// Nonstandard libdatachannel extensions; see docs/nonstandard.md.
export const nonstandard = {
  IceUdpMuxListener,
  configurePeerConnection,
  setLocalIceCredentials,
  getRemoteFingerprint,
  importCertificate,
  native,
};
