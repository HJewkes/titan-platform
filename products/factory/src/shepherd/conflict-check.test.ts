import { fakeSha } from "@titan-design/github";
import type { StepResult, WorkflowContext } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { conflictCheckedGates } from "./conflict-check.js";

const HEAD = fakeSha("conflict-check-head");
const PROMPT = `Merge PR #1 in octo/demo at head ${HEAD}? CI is green.`;

class Left extends Error {}

/** A gate that answers `decision`, and a check that reads a conflict on the calls `conflicting` lists, counting from 0. */
function wrapped(decision: string, conflicting: number[]) {
  const opened: string[] = [];
  const checked: string[] = [];
  const assisted: WorkflowContext["assisted"] = async (stepId) => (opened.push(stepId), { data: { decision, headSha: HEAD } } as unknown as StepResult);
  const conflicts = async (headSha: string) => conflicting.includes(checked.push(headSha) - 1);
  return { gate: conflictCheckedGates(assisted, conflicts, () => new Left()), opened, checked };
}

describe("conflictCheckedGates", () => {
  it("never opens approve-merge on a head that already conflicts with its base", async () => {
    const { gate, opened, checked } = wrapped("merge", [0]);

    await expect(gate("approve-merge", PROMPT)).rejects.toBeInstanceOf(Left);

    expect(opened).toEqual([]);
    expect(checked).toEqual([HEAD]);
  });

  it("leaves when the head conflicts once the owner approves it", async () => {
    const { gate, opened, checked } = wrapped("merge", [1]);

    await expect(gate("approve-merge", PROMPT)).rejects.toBeInstanceOf(Left);

    expect(opened).toEqual(["approve-merge"]);
    expect(checked).toEqual([HEAD, HEAD]);
  });

  it("returns the approval of a head that stays clear before and after the gate", async () => {
    const { gate, checked } = wrapped("merge", []);

    expect((await gate("approve-merge", PROMPT)).data).toMatchObject({ decision: "merge" });
    expect(checked).toEqual([HEAD, HEAD]);
  });

  it("does not check again after an abandon", async () => {
    const { gate, checked } = wrapped("abandon", [1]);

    expect((await gate("approve-merge", PROMPT)).data).toMatchObject({ decision: "abandon" });
    expect(checked).toEqual([HEAD]);
  });

  it("passes every other gate straight through", async () => {
    const { gate, opened, checked } = wrapped("retry", [0]);

    await gate("stuck-behind", `PR #1 at head ${HEAD} is still behind`);

    expect(opened).toEqual(["stuck-behind"]);
    expect(checked).toEqual([]);
  });
});
