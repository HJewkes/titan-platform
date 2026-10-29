import { describe, expect, it } from "vitest";
import { configuredDiagnosis, configuredVisualPacket } from "./workflows-spawned.js";

const ENV = { XDG_STATE_HOME: "/state" };
const cwdFor = () => "/work/repo";

describe("configuredVisualPacket", () => {
  it("wires nothing while the mode is off or unset", () => {
    expect(configuredVisualPacket({}, ENV, undefined, undefined as never, cwdFor)).toBeUndefined();
    expect(configuredVisualPacket({ visualPacket: "off" }, ENV, undefined, undefined as never, cwdFor)).toBeUndefined();
  });

  it("falls back to the default packager profile and the factory state directory", () => {
    const ports = configuredVisualPacket({ visualPacket: "on" } as never, ENV, undefined, undefined as never, cwdFor);

    expect(ports).toMatchObject({ mode: "on", profile: "review-packager", stateDir: "/state/titan-factory", cwdFor });
    expect(ports?.agents).toBeUndefined();
  });
});

describe("configuredDiagnosis", () => {
  it("reports to the hub seat and spawns nothing without an agent-chat binary", () => {
    const ports = configuredDiagnosis({ hubSeat: "hub" } as never, ENV, undefined, undefined as never, cwdFor);

    expect(ports.profile).toBe("bd-planner");
    expect(ports.reportTo?.()).toBe("hub");
    expect(ports.agents).toBeUndefined();
  });

  it("uses the configured diagnosis profile as given", () => {
    const ports = configuredDiagnosis({ diagnosisProfile: "custom-planner" } as never, ENV, undefined, undefined as never, cwdFor);

    expect(ports.profile).toBe("custom-planner");
  });
});
