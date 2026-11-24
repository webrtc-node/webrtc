import type { RTCPeerConnection } from "./peer-connection";

export const localDescriptionOwners = new Map<string, WeakRef<RTCPeerConnection>>();
export const localDescriptionOwnerFinalizer = new FinalizationRegistry<Set<string>>((keys) => {
  for (const key of keys) {
    if (!localDescriptionOwners.get(key)?.deref()) localDescriptionOwners.delete(key);
  }
});

export function descriptionPairingKey(
  description: { type?: unknown; sdp?: unknown } | null | undefined,
): string | null {
  if (!description || typeof description.sdp !== "string" || !description.sdp) return null;
  return `${description.type}\n${description.sdp}`;
}
