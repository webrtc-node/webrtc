// @ts-nocheck -- converted from JavaScript; strict typing lands module by module.

export function nextTask() {
  return new Promise((resolve) => setImmediate(resolve));
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
