import { describe, expect, it } from "vitest";
import { checkTaskApproval, type TaskApprovalCheckPorts } from "./cli-shepherd-task-approval.js";
import type { TaskApproval } from "./shepherd/plan-approval.js";

const KEY = "demo/TP-1";
const DONE_WHEN = "the demo widget renders its synthetic rows";
const APPROVED: TaskApproval = { gate: "task", scope: { doneWhen: DONE_WHEN, reason: "new-direction", visualSignoff: false }, round: "round-1" };

function harness(task: { tags: string[]; doneWhen: string } | Error | undefined, approval?: TaskApproval | Error) {
  const out: string[] = [];
  const err: string[] = [];
  const asked: string[] = [];
  const ports: TaskApprovalCheckPorts = {
    io: { stdout: (text) => void out.push(text), stderr: (text) => void err.push(text), env: {} },
    tasks: () => ({
      task: async (initiative, id) => {
        asked.push(`${initiative}/${id}`);
        if (task instanceof Error) throw task;
        return task && { title: "Synthetic demo", ...task };
      },
    }),
    approval: () => {
      if (approval instanceof Error) throw approval;
      return approval;
    },
  };
  return { ports, out, err, asked };
}

describe("shepherd task-approval check", () => {
  it("check exits 3 naming no-approval", async () => {
    const run = harness({ tags: ["owner-validate"], doneWhen: DONE_WHEN });

    expect(await checkTaskApproval(KEY, run.ports)).toBe(3);
    expect(run.out.join("")).toBe("no-approval\n");
    expect(run.asked).toEqual([KEY]);
  });

  it("check exits 0 after approval", async () => {
    const run = harness({ tags: ["owner-validate"], doneWhen: DONE_WHEN }, APPROVED);

    expect(await checkTaskApproval(KEY, run.ports)).toBe(0);
    expect(run.out.join("")).toBe(`dispatchable: ${KEY}\n`);
  });

  it("check exits 3 naming done-when-changed when the task's done_when moved since the approval", async () => {
    const run = harness({ tags: ["owner-validate"], doneWhen: `${DONE_WHEN} and its legend` }, APPROVED);

    expect(await checkTaskApproval(KEY, run.ports)).toBe(3);
    expect(run.out.join("")).toBe("done-when-changed\n");
  });

  it("check exits 0 for an untagged task with no approval", async () => {
    expect(await checkTaskApproval(KEY, harness({ tags: ["demo"], doneWhen: DONE_WHEN }).ports)).toBe(0);
  });

  it("check exits 3 naming task-unread when active-work is down or holds no such task", async () => {
    const down = harness(new Error("connect ECONNREFUSED"), APPROVED);
    const missing = harness(undefined, APPROVED);

    expect(await checkTaskApproval(KEY, down.ports)).toBe(3);
    expect(down.out.join("")).toBe("task-unread\n");
    expect(down.err.join("")).toContain("active-work did not answer: connect ECONNREFUSED");
    expect(await checkTaskApproval(KEY, missing.ports)).toBe(3);
    expect(missing.err.join("")).toContain(`${KEY} is not a task in active-work`);
  });

  it("check refuses a bare or malformed key without reading active-work", async () => {
    const run = harness({ tags: ["owner-validate"], doneWhen: DONE_WHEN }, APPROVED);

    expect(await checkTaskApproval("TP-1", run.ports)).toBe(2);
    expect(run.asked).toEqual([]);
  });

  it("check exits 69 when the plan-approval store cannot be read", async () => {
    const run = harness({ tags: ["demo"], doneWhen: DONE_WHEN }, new Error("no such table: shepherd_plan_approval"));

    expect(await checkTaskApproval(KEY, run.ports)).toBe(69);
    expect(run.err.join("")).toContain("no such table");
  });
});
