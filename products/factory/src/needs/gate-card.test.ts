import type { GateRecord } from "@titan-design/hitl";
import { partialFake } from "@titan-design/test-kit";
import { describe, expect, it } from "vitest";
import { cardFields, consequenceOf, proceedOf } from "./gate-card.js";

const gate = (id: string): GateRecord => partialFake<GateRecord>({ id, prompt: "Deploy slice shell?", status: "pending", createdAt: "2026-10-28T00:00:00Z" });

describe("owner cards for build-surface's gates", () => {
  it("gives a per-slice deploy gate its family's card", () => {
    const deploy = gate("run-1/deploy-approve:shell");

    expect(cardFields(deploy).irreversible).toMatch(/changes what the live surface serves/);
    expect(consequenceOf(deploy, "skip")).toMatch(/stays merged and undeployed/);
    expect(proceedOf("deploy-approve:shell")).toBe("deploy");
  });

  it("cards a parked infra failure under its family, whatever its round suffix", () => {
    const park = gate("run-1/infra-park:shell:0:1");

    expect(proceedOf("infra-park:shell:0")).toBe("retry");
    expect(consequenceOf(park, "retry")).toMatch(/no fix round is counted/);
    expect(cardFields(park).irreversible).toMatch(/a fresh start picks the slice up/);
  });

  it("cards the device check and the final walk", () => {
    expect(proceedOf("device-check:shell")).toBe("pass");
    expect(consequenceOf(gate("run-1/final-walk"), "changes")).toMatch(/notes recorded/);
  });
});
