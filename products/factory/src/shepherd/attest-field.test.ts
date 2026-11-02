import type { StepResult } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { attestedField } from "./attest-field.js";
import { MERGE_EVIDENCE_STEP } from "./merge-facts.js";

const evidence = (head: string, attested: unknown[], completedAt: string): StepResult =>
  ({ stepId: `${MERGE_EVIDENCE_STEP}:${head}`, completedAt, data: { result: { record: { attested } } } }) as unknown as StepResult;

const met = { step: "ci-wait", closure: "4e0d912b0000", meeters: [{ name: "rev-a", agentId: "a1", shape: "correctness" }] };

describe("attestedField", () => {
  it("reads the newest evidence that met a row and stamps its completion time", () => {
    const steps = [evidence("h1", [met], "2026-03-01T00:00:00Z"), evidence("h2", [], "2026-03-02T00:00:00Z")];

    expect(attestedField(steps)).toEqual({ attested: [{ step: "ci-wait", closure: "4e0d912b0000", meeters: [{ name: "rev-a", shape: "correctness" }], at: "2026-03-01T00:00:00Z" }] });
  });

  it("is absent when no evidence met a row", () => {
    expect(attestedField([evidence("h1", [], "2026-03-01T00:00:00Z")])).toEqual({});
  });
});
