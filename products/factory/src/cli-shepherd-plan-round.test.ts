import { EXIT } from "@titan-design/registry";
import { describe, expect, it } from "vitest";
import { runCli } from "./cli.js";
import type { CliDeps } from "./cli-types.js";
import { PlanApprovalActionSchema } from "./console-action/record.js";
import { doneWhenHash } from "./dispatch/ops.js";
import { fakeActiveWork } from "./test-support/active-work.js";

const REPO = "example-org/example-repo";
const DONE_WHEN = "The widget renders in both themes.";
const task = (tags: string[]) => ({ id: "TP-7", status: "open", title: "Add a dark theme", done_when: DONE_WHEN, notes: "", tags });

async function planRound(args: string[], fetch: typeof globalThis.fetch) {
  const out = { stdout: "", stderr: "" };
  const io = { stdout: (t: string) => void (out.stdout += t), stderr: (t: string) => void (out.stderr += t), env: {} };
  const deps: CliDeps = { workflows: [], routes: [], fetch };
  const code = await runCli(["shepherd", "plan-round", ...args], io, deps);
  return { code, ...out };
}

const approvalArgs = (reason = "new-direction") => ["--task-approval", "example/TP-7", "--reason", reason, "--repo", REPO];

describe("shepherd plan-round --task-approval", () => {
  it("plan-round --task-approval drafts one question bound to the task gate", async () => {
    const aw = fakeActiveWork([task(["owner-validate"])]);

    const { code, stdout } = await planRound([...approvalArgs(), "--visual-signoff"], aw.fetch);

    expect(code).toBe(EXIT.OK);
    const round = JSON.parse(stdout);
    expect(round.questions).toHaveLength(1);
    expect(round.questions[0]).toMatchObject({ kind: "pick-one", prompt: "Validate TP-7: Add a dark theme?" });
    expect(round.questions[0].options).toEqual(["Approve: validate example/TP-7 as described below", "Not now: leave example/TP-7 unvalidated"]);
    expect(round.sections[0].context).toContain(`Done when: ${DONE_WHEN}`);
    const scope = { doneWhenHash: doneWhenHash(DONE_WHEN), reason: "new-direction", visualSignoff: true };
    expect(round.planApprovals).toEqual([{ questionId: "q1", approve: round.questions[0].options[0], task: "example/TP-7", repo: REPO, gate: "task", scope }]);
    const { task: boundTask, repo, gate } = round.planApprovals[0];
    expect(PlanApprovalActionSchema.safeParse({ kind: "plan-approval", task: boundTask, repo, round: "r", gate, scope }).success).toBe(true);
  });

  it("plan-round --task-approval refuses a task not tagged owner-validate", async () => {
    const aw = fakeActiveWork([task(["shepherd"])]);

    const { code, stdout, stderr } = await planRound(approvalArgs(), aw.fetch);

    expect(code).toBe(EXIT.DATAERR);
    expect(stdout).toBe("");
    expect(stderr).toContain("is not tagged owner-validate");
  });

  it("plan-round --task-approval refuses a reason outside the four", async () => {
    const aw = fakeActiveWork([task(["owner-validate"])]);

    const { code, stdout, stderr } = await planRound(approvalArgs("nice-to-have"), aw.fetch);

    expect(code).toBe(EXIT.DATAERR);
    expect(stdout).toBe("");
    expect(stderr).toContain("--reason is one of new-direction, one-way-door, new-cap, authority-widening");
  });

  it.each(["TP-7", "example/tp-7"])("plan-round --task-approval refuses the key %s without reading active-work", async (key) => {
    const aw = fakeActiveWork([task(["owner-validate"])]);

    const { code, stderr } = await planRound(["--task-approval", key, "--reason", "new-cap", "--repo", REPO], aw.fetch);

    expect(code).toBe(EXIT.DATAERR);
    expect(stderr).toContain("takes <initiative>/<ID>");
    expect(aw.calls).toEqual([]);
  });

  it("plan-round --task-approval exits 69 and prints no round when active-work is down", async () => {
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;

    const { code, stdout } = await planRound(approvalArgs(), down);

    expect(code).toBe(EXIT.UNAVAILABLE);
    expect(stdout).toBe("");
  });

  it("plan-round --task-approval with a plan file, or without --repo, is a usage error", async () => {
    const aw = fakeActiveWork([task(["owner-validate"])]);

    const withPlan = await planRound(["plan.md", ...approvalArgs()], aw.fetch);
    const noRepo = await planRound(["--task-approval", "example/TP-7", "--reason", "new-cap"], aw.fetch);

    expect([withPlan.code, noRepo.code]).toEqual([EXIT.USAGE, EXIT.USAGE]);
  });
});
