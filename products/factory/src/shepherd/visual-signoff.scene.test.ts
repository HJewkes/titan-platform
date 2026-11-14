import { describe, it } from "vitest";
import type { PlanApproval } from "./plan-approval.js";
import { AUTO, byConsole, gatedAt, merged, modified, plannedRun, type Row } from "./plan-approval.scene.test-helpers.js";

/**
 * TP-5411 S8c over a real shepherd-pr run: under `shepherd.visualGate: async` a reviewed, green visual PR merges with no
 * owner, unless the owner approved its task with visual sign-off, which keeps the visual-path gate for every PR of it.
 */
const VISUAL_FILE = "src/ui/button.tsx";

const taskApproval = (visualSignoff: boolean): PlanApproval => ({
  gate: "task",
  scope: { doneWhen: "The button renders in both themes.", reason: "new-direction", visualSignoff },
  round: "validate-demo-tp-1-r1",
});

const asyncVisualRow = (visualSignoff: boolean): Row => ({
  files: modified(VISUAL_FILE),
  policy: { ...AUTO, visualPaths: ["src/ui/**"] },
  reviewerLines: "",
  approve: byConsole(taskApproval(visualSignoff)),
  visualGate: "async",
});

const noSeed = (): void => undefined;

describe("a visual PR under shepherd.visualGate async", () => {
  it("a visual PR of a visual-signoff task raises approve-merge on visual-path under async", async () => {
    await gatedAt(plannedRun(asyncVisualRow(true), noSeed), "visual-path");
  });

  it("a visual PR of a task approved without visual sign-off merges under async", async () => {
    await merged(plannedRun(asyncVisualRow(false), noSeed));
  });
});
