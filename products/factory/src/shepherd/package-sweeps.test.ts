import type { Logger } from "@titan-design/daemon";
import { partialFake } from "@titan-design/test-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FactoryHost } from "../host.js";
import type { Sweep } from "../sweep.js";
import { CONSUMER_BUMP_SWEEP_MS, RELEASE_SWEEP_MS, TOOLCHAIN_SWEEP_MS, startPackageSweeps, type PackageSweepOptions } from "./package-sweeps.js";
import type { ShepherdServices } from "./services.js";

const log = partialFake<Logger>({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });
let started: Sweep[] = [];

afterEach(() => {
  started.forEach((sweep) => sweep.halt());
  started = [];
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Each sweep's first read of `services` tells them apart: the release sweep reads the store, the toolchain sweep the port, the consumer bump sweep the seat book. */
function countingServices() {
  const runs = { release: 0, toolchain: 0, consumer: 0 };
  const services = partialFake<ShepherdServices>({
    seats: () => (runs.consumer++, { seats: [], denied: [] }),
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
  it("starts the Version Packages, toolchain and consumer bump sweeps at their configured intervals", async () => {
    const { runs, services } = countingServices();
    const sweeps = start({ releaseSweepMs: 1_000, toolchainSweepMs: 5_000, consumerBumpSweepMs: 2_000 }, services);

    await vi.advanceTimersByTimeAsync(4_999);
    expect({ ...runs }).toEqual({ release: 4, toolchain: 0, consumer: 2 });
    await vi.advanceTimersByTimeAsync(1);

    expect(sweeps.map(({ name }) => name)).toEqual(["version packages sweep", "toolchain adoption sweep", "consumer bump sweep"]);
    expect({ ...runs }).toEqual({ release: 5, toolchain: 1, consumer: 2 });
  });

  it("falls back to the default intervals when none are configured", () => {
    const { services } = countingServices();
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    started = startPackageSweeps(partialFake<FactoryHost>(), services, {}, log);

    expect(setIntervalSpy.mock.calls.map(([, delay]) => delay)).toEqual([RELEASE_SWEEP_MS, TOOLCHAIN_SWEEP_MS, CONSUMER_BUMP_SWEEP_MS]);
    expect(CONSUMER_BUMP_SWEEP_MS).toBe(3_600_000);
  });

  it("starts no sweeps without Shepherd services", () => {
    expect(start({}, undefined)).toEqual([]);
  });
});
