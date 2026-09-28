import type { WorkflowDefinition } from "../definition.js";
import { openFactoryHost, type FactoryHost } from "../host.js";
import type { StepRoute } from "../routed-runner.js";

/** Short enough to keep tests fast, long enough that the renewal timer (lease / 3) fires during a test. */
export const CRASH_LEASE_MS = 3_000;
const T0 = Date.parse("2026-01-01T00:00:00.000Z");

export interface CrashOptions {
  dbPath: string;
  workflows: readonly WorkflowDefinition[];
  routes: readonly StepRoute[];
  /** The step id whose runner never settles in the crashing host. */
  hangAt: string;
}

export interface Crash {
  /** The host that "died": its clock is frozen and it never releases its lease. */
  crashed: FactoryHost;
  /** Resolves once the crashing host has entered the `hangAt` step. */
  reached: Promise<void>;
  /** A second host on the same file whose clock is already past the crashed host's lease. */
  takeOver(routes?: readonly StepRoute[]): FactoryHost;
  dispose(): void;
}

/**
 * How a `kill -9` looks to the store: the owner stops mid-step and never releases its lease.
 * Start a run on `crashed`, await `reached`, then `takeOver().resume()`.
 */
export function crashAt(options: CrashOptions): Crash {
  let entered!: () => void;
  const reached = new Promise<void>((resolve) => (entered = resolve));
  const crashed = openFactoryHost({ ...options, routes: hangingRoutes(options.routes, options.hangAt, entered), now: () => T0, leaseMs: CRASH_LEASE_MS, gatePollMs: 10 });
  const hosts: FactoryHost[] = [crashed];
  return {
    crashed,
    reached,
    takeOver(routes = options.routes) {
      const started = Date.now();
      const later = () => T0 + CRASH_LEASE_MS + 1 + (Date.now() - started);
      const host = openFactoryHost({ dbPath: options.dbPath, workflows: options.workflows, routes, now: later, leaseMs: CRASH_LEASE_MS, gatePollMs: 10 });
      hosts.push(host);
      return host;
    },
    dispose: () => hosts.forEach((host) => host.close()),
  };
}

function hangingRoutes(routes: readonly StepRoute[], hangAt: string, entered: () => void): StepRoute[] {
  return routes.map((route) => ({
    ...route,
    runner: {
      run: (input) => {
        if (input.stepId !== hangAt) return route.runner.run(input);
        entered();
        return new Promise(() => undefined);
      },
    },
  }));
}
