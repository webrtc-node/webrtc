export function nextTask(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
