import type { FactoryRoutes } from "./host.js";

type HostHooks = Pick<FactoryRoutes, "bindHost" | "onEvent">;

/** A hook that throws must not stop the one beside it, nor the run whose event or bind it heard. */
function guarded<A extends unknown[], R>(what: string, hook: (...args: A) => R, fallback: R): (...args: A) => R {
  return (...args) => {
    try {
      return hook(...args);
    } catch (error) {
      console.warn(`[routes] ${what} failed: ${error instanceof Error ? error.message : String(error)}`);
      return fallback;
    }
  };
}

/** The host hooks of two route bundles as one: each runs in order, whichever of them is absent. */
export function composeRoutes(first: HostHooks, second: HostHooks): HostHooks {
  const { bindHost: bindFirst, onEvent: eventFirst } = first;
  const { bindHost: bindSecond, onEvent: eventSecond } = second;
  const hooks: { -readonly [K in keyof HostHooks]: HostHooks[K] } = {};
  if (bindFirst || bindSecond) {
    hooks.bindHost = (host) => {
      const unbinds = [bindFirst, bindSecond].map((bind) => (bind ? guarded("bindHost", bind, () => undefined)(host) : undefined));
      return () => unbinds.forEach((unbind) => guarded("unbind", () => unbind?.(), undefined)());
    };
  }
  if (eventFirst || eventSecond) {
    const listeners = [eventFirst, eventSecond].flatMap((listener) => (listener ? [guarded("onEvent", listener, undefined)] : []));
    hooks.onEvent = (event) => listeners.forEach((listener) => listener(event));
  }
  return hooks;
}
