import { describe, expect, it } from "vitest";
import { foldUsage, type UsageMeasurement } from "./index.js";

const tokens = (input: number) => ({ input, output: 1, cachedInput: null, cacheWriteInput: null, reasoningOutput: null, total: null });

function delta(responseId: string, input: number): UsageMeasurement {
  return { kind: "delta", responseId, model: "model-a", tokens: tokens(input), cost: null, source: "test" };
}

function snapshot(input: number, fields: { sequence?: number; scope?: "turn" | "conversation"; scopeId?: string; epoch?: string } = {}): UsageMeasurement {
  const { sequence = 0, scope = "turn", scopeId = `${scope}-1`, epoch = "epoch-1" } = fields;
  return { kind: "snapshot", scope, scopeId, epoch, sequence, model: "model-a", tokens: tokens(input), cost: null, source: "test" };
}

const inputs = (measurements: UsageMeasurement[]) => measurements.map((value) => value.tokens.input);

describe("foldUsage", () => {
  it("counts a repeated response once, keeping its last report in first-seen position", () => {
    const fold = foldUsage([delta("r1", 10), delta("r2", 20), delta("r1", 11)]);
    expect(fold.basis).toBe("delta");
    expect(inputs(fold.measurements)).toEqual([11, 20]);
  });

  it("drops every snapshot once any delta reports the same spend", () => {
    const fold = foldUsage([snapshot(300), delta("r1", 100), snapshot(400, { scope: "conversation" }), delta("r2", 200)]);
    expect(fold).toEqual({ basis: "delta", measurements: [delta("r1", 100), delta("r2", 200)] });
  });

  it("keeps the highest-sequence snapshot per scope, scope ID and epoch regardless of arrival order", () => {
    const fold = foldUsage([snapshot(50, { sequence: 5 }), snapshot(10, { sequence: 1 }), snapshot(70, { sequence: 2, scopeId: "turn-2" })]);
    expect(fold.basis).toBe("snapshot");
    expect(inputs(fold.measurements)).toEqual([50, 70]);
  });

  it("lets the later of two equal-sequence snapshots win", () => {
    expect(inputs(foldUsage([snapshot(1, { sequence: 3 }), snapshot(2, { sequence: 3 })]).measurements)).toEqual([2]);
  });

  it("accounts each reset epoch of the same scope ID separately", () => {
    const fold = foldUsage([snapshot(10, { epoch: "a", sequence: 9 }), snapshot(20, { epoch: "b", sequence: 0 })]);
    expect(inputs(fold.measurements)).toEqual([10, 20]);
  });

  it("lets a conversation snapshot supersede turn snapshots in its epoch only", () => {
    const fold = foldUsage([
      snapshot(10, { epoch: "a" }), snapshot(99, { epoch: "a", scope: "conversation" }), snapshot(20, { epoch: "b" }),
    ]);
    expect(inputs(fold.measurements)).toEqual([99, 20]);
  });

  it("passes zero and negative token counts through unchanged", () => {
    expect(inputs(foldUsage([delta("r1", 0), delta("r2", -5)]).measurements)).toEqual([0, -5]);
  });

  it("returns no measurements on a snapshot basis for an empty list", () => {
    expect(foldUsage([])).toEqual({ basis: "snapshot", measurements: [] });
  });

  it("accepts any iterable, including a generator", () => {
    function* stream() { yield delta("r1", 1); yield delta("r1", 2); }
    expect(inputs(foldUsage(stream()).measurements)).toEqual([2]);
  });
});
