import { describe, expect, it, vi } from "vitest";
import { linkGate, linkGateArgs } from "./cli-link-gate.js";
import { resolveConfig, type Machine } from "./config.js";

const HOME = "/srv/tester";
const LAN_IP = "192.0.2.10";
const TLS = { TITAN_CONSOLE_TLS_CERT: "~/tls/box.example.ts.net.crt", TITAN_CONSOLE_TLS_KEY: "~/tls/box.example.ts.net.key" };
const machine: Machine = { hostname: () => "Lan-Box", addresses: () => [LAN_IP] };
const config = (env: NodeJS.ProcessEnv) => resolveConfig({ TITAN_CONSOLE_STATE: "/state", ...env }, HOME, "linux", machine);
const lan = () => config({ TITAN_CONSOLE_HOST: LAN_IP, TITAN_CONSOLE_LAN_NAMES: "box.example.ts.net", ...TLS });
const LINK = "https://box.example.ts.net:7500/#/inbox/gate%3Arun-1%2Fapprove-merge";

describe("titan-console link gate", () => {
  it.each([200, 401])("prints the https link when the probe answers %i", async (status) => {
    const probe = vi.fn().mockResolvedValue(status);

    expect(await linkGate(lan(), "run-1/approve-merge", probe)).toEqual({ ok: true, link: LINK });
    expect(probe).toHaveBeenCalledWith(LINK);
  });

  it("fails on a status that is neither 200 nor 401", async () => {
    const result = await linkGate(lan(), "run-1/approve-merge", async () => 502);

    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("answered 502") });
  });

  it("fails on an empty reply or connection error", async () => {
    const result = await linkGate(lan(), "run-1/approve-merge", async () => Promise.reject(new Error("socket hang up")));

    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("socket hang up") });
  });

  it("refuses an http-only link without probing it", async () => {
    const probe = vi.fn();

    const result = await linkGate(config({}), "run-1/approve-merge", probe);

    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("not https") });
    expect(probe).not.toHaveBeenCalled();
  });

  it("takes exactly one <run>/<step> after link gate", () => {
    expect(linkGateArgs(["link", "gate", "run-1/approve-merge"])).toEqual({ gate: "run-1/approve-merge" });
    expect(linkGateArgs(["link", "gate", "run-1"])).toBeNull();
    expect(linkGateArgs(["link", "gate"])).toBeNull();
    expect(linkGateArgs(["link", "gate", "a/b", "x"])).toBeNull();
    expect(linkGateArgs(["inbox", "link", "a/b"])).toBeNull();
  });
});
