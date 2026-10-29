import { partialFake } from "@titan-design/test-kit";
import { describe, expect, it } from "vitest";
import type { SpawnGate } from "./shepherd/spawn-gate.js";
import { configuredDiagnosis, configuredVisualPacket } from "./workflows-spawned.js";

const ENV = { XDG_STATE_HOME: "/state" };
const gate = partialFake<SpawnGate>();
const cwdFor = () => "/work/repo";

describe("configuredVisualPacket", () => {
  it("wires nothing while the mode is off or unset", () => {
    expect(configuredVisualPacket({}, ENV, undefined, gate, cwdFor)).toBeUndefined();
    expect(configuredVisualPacket({ visualPacket: "off" }, ENV, undefined, gate, cwdFor)).toBeUndefined();
  });

  it("falls back to the default packager profile and the factory state directory", () => {
    const ports = configuredVisualPacket({ visualPacket: "on" }, ENV, undefined, gate, cwdFor);

    expect(ports).toMatchObject({ mode: "on", profile: "review-packager", stateDir: "/state/titan-factory", cwdFor });
    expect(ports?.agents).toBeUndefined();
  });
});

describe("configuredDiagnosis", () => {
  it("reports to the hub seat and spawns nothing without an agent-chat binary", () => {
    const ports = configuredDiagnosis({ hubSeat: "hub" }, ENV, undefined, gate, cwdFor);

    expect(ports.profile).toBe("bd-planner");
    expect(ports.reportTo?.()).toBe("hub");
    expect(ports.agents).toBeUndefined();
  });

  it("uses the configured diagnosis profile as given", () => {
    const ports = configuredDiagnosis({ diagnosisProfile: "custom-planner" }, ENV, undefined, gate, cwdFor);

    expect(ports.profile).toBe("custom-planner");
  });
});
