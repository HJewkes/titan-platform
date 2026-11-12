import type { Logger } from "@titan-design/daemon";
import { partialFake } from "@titan-design/test-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FactoryHost } from "../host.js";
import type { Sweep } from "../sweep.js";
import { startPackageSweeps } from "./package-sweeps.js";
import type { ShepherdServices } from "./services.js";
import type { Registration } from "./store.js";

let started: Sweep[] = [];

afterEach(() => {
  started.forEach((sweep) => sweep.halt());
  started = [];
  vi.useRealTimers();
  vi.clearAllMocks();
});

/** A port with no methods makes every read throw, which each sweep turns into an error note. */
async function runSweeps(remotes: string[], releaseSweepMs = 1e9) {
  const log = partialFake<Logger>({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });
  const services = partialFake<ShepherdServices>({
    port: partialFake<ShepherdServices["port"]>({}),
    seats: () => partialFake<ReturnType<ShepherdServices["seats"]>>({ seats: remotes.length > 0 ? [partialFake<ReturnType<ShepherdServices["seats"]>["seats"][number]>({ remotes })] : [], denied: [] }),
    store: partialFake<ShepherdServices["store"]>({ get: () => partialFake<ReturnType<ShepherdServices["store"]["get"]>>({ all: () => (releaseSweepMs < 1e9 ? [partialFake<Registration>({ repo: "acme/widgets" })] : []) }) }),
  });
  vi.useFakeTimers();
  started = startPackageSweeps(partialFake<FactoryHost>(), services, { releaseSweepMs, toolchainSweepMs: 1_000, consumerBumpSweepMs: 1_000 }, log);
  await vi.advanceTimersByTimeAsync(1_000);
  return log;
}

describe("package sweep note logging", () => {
  it("logs a toolchain adoption error note at warn", async () => {
    const log = await runSweeps([]);

    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(String) }), "swept a toolchain adoption");
    expect(log.info).not.toHaveBeenCalledWith(expect.anything(), "swept a toolchain adoption");
  });

  it("logs a consumer bump error note at warn", async () => {
    const log = await runSweeps(["acme/widgets"]);

    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ repo: "acme/widgets", error: expect.any(String) }), "swept a consumer bump");
    expect(log.info).not.toHaveBeenCalledWith(expect.anything(), "swept a consumer bump");
  });

  it("logs a Version Packages error note at warn", async () => {
    const log = await runSweeps([], 1_000);

    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ repo: "acme/widgets", error: expect.any(String) }), "swept a Version Packages PR");
    expect(log.info).not.toHaveBeenCalledWith(expect.anything(), "swept a Version Packages PR");
  });
});
