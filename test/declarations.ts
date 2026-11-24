// Compile-time check that the implementation in src/ matches the public
// declarations in index.d.ts. Instances are compared because constructors take
// internal arguments; RTCPeerConnection statics are checked separately.
import type * as Declared from "..";
import type * as Impl from "../src/index";

type Conforms<Actual extends Expected, Expected> = Actual;

export type Checks = [
  Conforms<InstanceType<typeof Impl.Event>, Declared.Event>,
  Conforms<InstanceType<typeof Impl.MessageEvent>, Declared.MessageEvent<unknown>>,
  Conforms<InstanceType<typeof Impl.EventTarget>, Declared.EventTarget>,
  Conforms<InstanceType<typeof Impl.RTCIceCandidatePair>, Declared.RTCIceCandidatePair>,
  Conforms<InstanceType<typeof Impl.RTCSessionDescription>, Declared.RTCSessionDescription>,
  Conforms<InstanceType<typeof Impl.RTCIceCandidate>, Declared.RTCIceCandidate>,
  Conforms<InstanceType<typeof Impl.RTCCertificate>, Declared.RTCCertificate>,
  Conforms<InstanceType<typeof Impl.RTCDataChannel>, Declared.RTCDataChannel>,
  Conforms<InstanceType<typeof Impl.RTCDataChannelEvent>, Declared.RTCDataChannelEvent>,
  Conforms<InstanceType<typeof Impl.RTCPeerConnectionIceEvent>, Declared.RTCPeerConnectionIceEvent>,
  Conforms<
    InstanceType<typeof Impl.RTCPeerConnectionIceErrorEvent>,
    Declared.RTCPeerConnectionIceErrorEvent
  >,
  Conforms<InstanceType<typeof Impl.RTCError>, Declared.RTCError>,
  Conforms<InstanceType<typeof Impl.RTCErrorEvent>, Declared.RTCErrorEvent>,
  Conforms<InstanceType<typeof Impl.RTCDtlsTransport>, Declared.RTCDtlsTransport>,
  Conforms<InstanceType<typeof Impl.RTCIceTransport>, Declared.RTCIceTransport>,
  Conforms<InstanceType<typeof Impl.RTCSctpTransport>, Declared.RTCSctpTransport>,
  Conforms<InstanceType<typeof Impl.RTCPeerConnection>, Declared.RTCPeerConnection>,
  Conforms<
    typeof Impl.RTCPeerConnection.generateCertificate,
    typeof Declared.RTCPeerConnection.generateCertificate
  >,
  Conforms<typeof Impl.nonstandard, typeof Declared.nonstandard>,
];
