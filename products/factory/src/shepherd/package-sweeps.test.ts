import type { Logger } from "@titan-design/daemon";
import { partialFake } from "@titan-design/test-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FactoryHost } from "../host.js";
import type { Sweep } from "../sweep.js";
import { RELEASE_SWEEP_MS, TOOLCHAIN_SWEEP_MS, startPackageSweeps, type PackageSweepOptions } from "./package-sweeps.js";
import type { ShepherdServices } from "./services.js";

const log = partialFake<Logger>({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });
let started: Sweep[] = [];

afterEach(() => {
  started.forEach((sweep) => sweep.halt());
  started = [];
  vi.useRealTimers();
});

/** Each sweep's first read of `services` tells the two apart: the release sweep reads the store, the toolchain sweep the port. */
function countingServices() {
  const runs = { release: 0, toolchain: 0 };
  const services = partialFake<ShepherdServices>({
    store: partialFake<ShepherdServices["store"]>({ get: () => partialFake<ReturnType<ShepherdServices["store"]["get"]>>({ all: () => (runs.release++, []) }) }),
    get port(): never {
      runs.toolchain++;
      throw new Error("synthetic port failure");
    },
  });
  return { runs, services };
}

function start(options: PackageSweepOptions, services: ShepherdServices | undefined) {
  vi.useFakeTimers();
  started = startPackageSweeps(partialFake<FactoryHost>(), services, options, log);
  return started;
}

describe("startPackageSweeps", () => {
  it("starts the Version Packages and toolchain sweeps at their configured intervals", async () => {
    const { runs, services } = countingServices();
    const sweeps = start({ releaseSweepMs: 1_000, toolchainSweepMs: 5_000 }, services);

    await vi.advanceTimersByTimeAsync(4_999);
    expect({ ...runs }).toEqual({ release: 4, toolchain: 0 });
    await vi.advanceTimersByTimeAsync(1);

    expect(sweeps.map(({ name }) => name)).toEqual(["version packages sweep", "toolchain adoption sweep"]);
    expect({ ...runs }).toEqual({ release: 5, toolchain: 1 });
  });

  it("falls back to the default intervals when none are configured", async () => {
    const { runs, services } = countingServices();
    start({}, services);

    await vi.advanceTimersByTimeAsync(RELEASE_SWEEP_MS - 1);
    expect(runs.release).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(runs.release).toBe(1);

    await vi.advanceTimersByTimeAsync(TOOLCHAIN_SWEEP_MS - RELEASE_SWEEP_MS - 1);
    expect(runs.toolchain).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(runs.toolchain).toBe(1);
  });

  it("starts no sweeps without Shepherd services", () => {
    expect(start({}, undefined)).toEqual([]);
  });
});
