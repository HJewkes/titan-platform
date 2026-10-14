import type { WorkflowContext } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { takeVerdict, verdictOf } from "./take-verdict.js";

type TakeArgs = Parameters<typeof takeVerdict>;
type VerdictArgs = Parameters<typeof verdictOf>;

describe("taking a verdict without the round's fix-proof standing", () => {
  it("cannot take a verdict, since an empty standing reads as verified", () => {
    const omitted = (ctx: WorkflowContext, target: TakeArgs[1], awaiting: TakeArgs[2], reviewer: TakeArgs[3]) =>
      // @ts-expect-error takeVerdict takes the round's fix-proof standing; no default may stand in for it
      takeVerdict(ctx, target, awaiting, reviewer, "default");

    expect(typeof omitted).toBe("function");
  });

  it("cannot read an awaited verdict, since an empty standing reads as verified", () => {
    const omitted = (ctx: WorkflowContext, target: VerdictArgs[1], awaiting: VerdictArgs[2], reviewer: VerdictArgs[3], awaited: VerdictArgs[4]) =>
      // @ts-expect-error verdictOf takes the round's fix-proof standing; no default may stand in for it
      verdictOf(ctx, target, awaiting, reviewer, awaited);

    expect(typeof omitted).toBe("function");
  });
});
