import type { StepResult } from "@titan-design/workflow";
import { describe, expect, it, vi } from "vitest";
import { recordingOverrides } from "./override-gate.js";

const HEAD = "a".repeat(40);
const PROMPT = `Merge PR #1 in octo/demo at head ${HEAD}? CI is green. Policy shepherd-merge/owner-gate: owner decides`;
const answered = (data: Record<string, unknown>) => (async () => ({ stepId: "approve-merge", iteration: 0, agentId: null, signal: null, completedAt: "", data }) as StepResult) as never;
const ask = (assisted: never, record: () => Promise<void>, reviewed = true, warn = vi.fn()) => recordingOverrides(assisted, () => reviewed, record, warn)("approve-merge", PROMPT, {} as never);

describe("recordingOverrides", () => {
  it("records an abandon after a reviewer MERGE and returns the answer untouched", async () => {
    const record = vi.fn(async () => undefined);

    const result = await ask(answered({ decision: "abandon", headSha: HEAD }), record);

    expect(record).toHaveBeenCalledWith({ trigger: "owner-answer", head: HEAD, shepherd: "MERGE", other: "abandon" });
    expect(result.data).toEqual({ decision: "abandon", headSha: HEAD });
  });

  it("records nothing when the owner merges", async () => {
    const record = vi.fn(async () => undefined);

    await ask(answered({ decision: "merge", headSha: HEAD }), record);

    expect(record).not.toHaveBeenCalled();
  });

  it("records nothing for an abandon with no reviewer MERGE at the head", async () => {
    const record = vi.fn(async () => undefined);

    await ask(answered({ decision: "abandon", headSha: HEAD }), record, false);

    expect(record).not.toHaveBeenCalled();
  });

  it("logs a failed record and still returns the owner's abandon", async () => {
    const warn = vi.fn();

    const result = await ask(answered({ decision: "abandon", headSha: HEAD }), async () => Promise.reject(new Error("ledger down")), true, warn);

    expect(result.data).toEqual({ decision: "abandon", headSha: HEAD });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("ledger down"));
  });
});
