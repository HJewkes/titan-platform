import { afterEach, beforeEach } from "vitest";
import { GATE_DEMOTIONS, type GateDemotions } from "../shepherd/auto-pass.js";

/** Runs the enclosing suite with one demotion off, so its tests pin the owner gate that turning the class off restores. */
export function withDemotionOff(demotion: keyof GateDemotions): void {
  let before = true;
  beforeEach(() => {
    before = GATE_DEMOTIONS[demotion];
    GATE_DEMOTIONS[demotion] = false;
  });
  afterEach(() => {
    GATE_DEMOTIONS[demotion] = before;
  });
}
