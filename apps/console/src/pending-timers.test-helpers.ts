/**
 * Records every timer a test file starts and not yet fired or cleared. React's scheduler captures `setImmediate`
 * when it first loads, so a file must import this module before anything that imports React for the wrapper to
 * be the one it keeps.
 */
const pending = new Map<number, string>();
let nextId = 0;

type Starter = (callback: (...args: never[]) => void, ...rest: never[]) => unknown;

function track(name: "setTimeout" | "setImmediate"): void {
  const original: Starter | undefined = globalThis[name];
  if (!original) return;
  const wrapped: Starter = (callback, ...rest) => {
    const id = nextId++;
    pending.set(id, `${name}: ${callback.name || "anonymous"}`);
    const handle = original(
      (...args) => {
        pending.delete(id);
        callback(...args);
      },
      ...rest,
    );
    handles.set(handle, id);
    return handle;
  };
  (globalThis as Record<string, unknown>)[name] = wrapped;
}

const handles = new Map<unknown, number>();

const originalClearTimeout = globalThis.clearTimeout;
const originalClearImmediate = globalThis.clearImmediate;
globalThis.clearTimeout = ((handle: unknown) => {
  const id = handles.get(handle);
  if (id !== undefined) pending.delete(id);
  originalClearTimeout(handle as Parameters<typeof clearTimeout>[0]);
}) as typeof clearTimeout;
globalThis.clearImmediate = ((handle: unknown) => {
  const id = handles.get(handle);
  if (id !== undefined) pending.delete(id);
  originalClearImmediate(handle as Parameters<typeof clearImmediate>[0]);
}) as typeof clearImmediate;

track("setTimeout");
track("setImmediate");

/** The timers started and neither fired nor cleared, oldest first, for an `afterEach` that asserts none are left. */
export const pendingTimers = (): string[] => [...pending.values()];
