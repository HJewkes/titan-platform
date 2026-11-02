/**
 * Records every timeout and immediate a test file starts and has not yet seen fire or clear. React's scheduler
 * keeps the `setImmediate` it finds when it first loads, so a file imports this module before anything that
 * imports React for the wrapper to be the one the scheduler keeps.
 */
const pending = new Map<object, string>();

const originalSetTimeout = globalThis.setTimeout;
const originalSetImmediate = globalThis.setImmediate;
const originalClearTimeout = globalThis.clearTimeout;
const originalClearImmediate = globalThis.clearImmediate;

// defineProperty takes the new value as `unknown`, so the wrappers need no cast to the overloaded Node signatures.
function install(
  name: "setTimeout" | "setImmediate" | "clearTimeout" | "clearImmediate",
  value: unknown
): void {
  Object.defineProperty(globalThis, name, {
    value,
    configurable: true,
    writable: true,
  });
}

function labelOf(kind: string, callback: () => void): string {
  return `${kind}: ${callback.name || "anonymous"}`;
}

install("setTimeout", (callback: () => void, delay?: number) => {
  const handle = originalSetTimeout(() => {
    pending.delete(handle);
    callback();
  }, delay);
  pending.set(handle, labelOf("setTimeout", callback));
  return handle;
});

install("setImmediate", (callback: () => void) => {
  const handle = originalSetImmediate(() => {
    pending.delete(handle);
    callback();
  });
  pending.set(handle, labelOf("setImmediate", callback));
  return handle;
});

install("clearTimeout", (handle: Parameters<typeof clearTimeout>[0]) => {
  if (typeof handle === "object") pending.delete(handle);
  originalClearTimeout(handle);
});

install("clearImmediate", (handle: Parameters<typeof clearImmediate>[0]) => {
  if (typeof handle === "object") pending.delete(handle);
  originalClearImmediate(handle);
});

/** The timers started and neither fired nor cleared, oldest first, for an `afterEach` that asserts none are left. */
export const pendingTimers = (): string[] => [...pending.values()];
