import { describe, expect, it, vi } from "vitest";
import { evidenceMarker } from "./evidence-comment.js";
import type { OwnerValidateMode } from "./g10-owner-validate.js";
import { AUTO, byConsole, gatedAt, HEAD, merged, modified, PR, plannedRun, type Row } from "./plan-approval.scene.test-helpers.js";
import type { TaskApprovalReads } from "./task-approval-round.js";

/**
 * TP-5411 (gate model S8b): the merge backstop. Under `shepherd.gateReset.ownerValidate: on`, a reviewed green PR whose
 * run's task is tagged owner-validate, or cannot be read, raises approve-merge on the owner-validate row until the owner's
 * console task approval holds the task's current done_when. Each scene runs the real shepherd-pr workflow on a fake GitHub.
 */
const DONE_WHEN = "the demo widget renders its synthetic rows";
const FILES = modified("packages/demo/src/plain.ts");

const tasksAnswering = (tags: string[]): TaskApprovalReads => ({ task: async () => ({ title: "Synthetic demo", doneWhen: DONE_WHEN, tags }) });
const TAGGED = tasksAnswering(["owner-validate"]);
const DOWN: TaskApprovalReads = {
  task: async () => {
    throw new Error("connect ECONNREFUSED 127.0.0.1:7400");
  },
};

const taskApproval = byConsole({ gate: "task", scope: { doneWhen: DONE_WHEN, reason: "new-direction", visualSignoff: false }, round: "round-1" });

const run = (tasks: TaskApprovalReads, ownerValidate: OwnerValidateMode, approve: Row["approve"] = () => undefined) =>
  plannedRun({ files: FILES, policy: AUTO, reviewerLines: "", approve, ownerValidate, tasks }, () => undefined);

function postedEvidence(scene: ReturnType<typeof run>): unknown {
  const body = scene.fake.comments.get(PR)?.find((comment) => comment.body.includes(evidenceMarker(HEAD)))?.body ?? "";
  const posted: unknown = JSON.parse(body.split("```json\n")[1]!.split("\n```")[0]!);
  return posted;
}

describe("under ownerValidate on", () => {
  it("a reviewed green PR of an owner-validate task with no approval raises approve-merge on owner-validate", async () => {
    const scene = run(TAGGED, "on");

    await gatedAt(scene, "owner-validate");

    expect(scene.approveMerge()?.prompt).toContain("demo/TP-1 is tagged owner-validate and holds no owner task approval (no-approval)");
  });

  it("the same PR merges once the console task approval is recorded, with no further owner answer", async () => {
    const scene = run(TAGGED, "on", taskApproval);

    await merged(scene);
  });

  it("a PR of an untagged task merges with no owner-validate gate", async () => {
    const scene = run(tasksAnswering(["demo"]), "on");

    await merged(scene);
  });

  it("a PR whose task cannot be read raises approve-merge on owner-validate", async () => {
    const scene = run(DOWN, "on", taskApproval);

    await gatedAt(scene, "owner-validate");

    expect(scene.approveMerge()?.prompt).toContain("(task-unread)");
  });
});

describe("under ownerValidate shadow", () => {
  it("under shadow the unapproved PR merges and records the would-gate", async () => {
    const scene = run(TAGGED, "shadow");

    await vi.waitFor(() => expect(scene.fake.effects.merge).toBe(1), { timeout: 20_000 });

    expect(scene.approveMerge()).toBeUndefined();
    expect(postedEvidence(scene)).toMatchObject({
      ownerValidate: { mode: "shadow", task: "demo/TP-1", tagged: true, doneWhen: DONE_WHEN },
      decision: { outcome: "allow", reason: expect.stringContaining("; owner validate would gate: task demo/TP-1 is tagged owner-validate") },
    });
  });
});
