import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { silentLogger, type Logger } from "@titan-design/daemon";
import { afterEach, describe, expect, it, vi } from "vitest";
import { REPO } from "../test-support/land.js";
import { branchOf, build, closeDeploys, ctxOf, deploy, HEAD_B, recorded, STACK_CHILDREN_TAIL } from "../test-support/diverged-sweep.js";
import { restartDivergedLogged, restartDivergedRuns } from "./diverged-sweep.js";

afterEach(closeDeploys);

const CLOSED = "replay diverged; PR closed";
const STACK_CALL = STACK_CHILDREN_TAIL.call;

/** A run that merged its PR and then parked as diverged while its sh-stack-children step was in flight. */
async function mergedInStackChildren(childBase = branchOf(1)) {
  const dbPath = join(mkdtempSync(join(tmpdir(), "tp3248-")), "factory.db");
  const [runId] = await recorded(dbPath, [1], undefined, STACK_CHILDREN_TAIL);
  const next = deploy(dbPath, build(true, STACK_CHILDREN_TAIL));
  next.fake.addPr({ headSha: HEAD_B, headRef: branchOf(1), headRepo: REPO, state: "closed", merged: true });
  const child = next.fake.addPr({ headRef: "agent-chat/child", headRepo: REPO, baseRef: childBase });
  await next.host.adopt();
  await next.host.runtime.wait(runId!);
  expect(next.host.runtime.status(runId!)?.activeSteps).toHaveProperty([STACK_CALL]);
  return { next, runId: runId!, child: child.number };
}

describe("restartDivergedRuns on a merged PR whose run parked in sh-stack-children (TP-3248)", () => {
  it("ends the run, records the dropped step and names the stacked child left for retarget", async () => {
    const { next, runId, child } = await mergedInStackChildren();

    const sweep = await restartDivergedRuns(ctxOf(next));

    expect(sweep.ended).toEqual([{ runId, reason: CLOSED, stacked: [child] }]);
    expect(next.host.runtime.status(runId)).toMatchObject({ status: "cancelled", activeSteps: {} });
    expect(next.events).toContainEqual(expect.objectContaining({ type: "step_abandoned", runId, stepId: STACK_CALL, reason: `cancelled: ${CLOSED}` }));
  });

  it("names no child when no open PR is based on the merged branch", async () => {
    const { next, runId } = await mergedInStackChildren("main");

    const sweep = await restartDivergedRuns(ctxOf(next));

    expect(sweep.ended).toEqual([{ runId, reason: CLOSED }]);
  });

  it("names why the children could not be listed, and still ends the run", async () => {
    const { next, runId } = await mergedInStackChildren();
    vi.spyOn(next.routes.shepherd!.port, "listOpenPrs").mockRejectedValue(new TypeError("synthetic read failure"));

    const sweep = await restartDivergedRuns(ctxOf(next));

    expect(sweep.ended).toEqual([{ runId, reason: CLOSED, stackedUnread: "TypeError" }]);
    expect(next.host.runtime.status(runId)?.status).toBe("cancelled");
  });

  it("warns in serve's log which children the merged run left to retarget", async () => {
    const { next, runId, child } = await mergedInStackChildren();
    const log: Logger = { ...silentLogger, warn: vi.fn() };

    await restartDivergedLogged(next.host, next.routes.shepherd!, log);

    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ runId, stacked: [child] }), expect.stringContaining("retarget"));
  });
});
