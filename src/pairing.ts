// @ts-nocheck -- converted from JavaScript; strict typing lands module by module.

export const localDescriptionOwners = new Map();
export const localDescriptionOwnerFinalizer = new FinalizationRegistry((key) => {
  if (!localDescriptionOwners.get(key)?.deref()) localDescriptionOwners.delete(key);
});

export function descriptionPairingKey(description) {
  if (!description || typeof description.sdp !== "string" || !description.sdp) return null;
  return `${description.type}\n${description.sdp}`;
}
