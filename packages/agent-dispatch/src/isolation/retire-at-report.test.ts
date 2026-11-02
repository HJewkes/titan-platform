import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NOT_FINISHED,
  retireAtReport,
  type ReportRetirePort,
} from "./index.js";
import { agent, allocated } from "./retire-test-support.js";

/** CC-921: an opted-in spawner's agent that exits on a final report is parked and retired. */

const trees: string[] = [];
afterEach(() => {
  for (const dir of trees.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

function setup(
  over: Partial<ReportRetirePort> = {},
  report = "Status: DONE\nPR: example/repo#1"
) {
  const tree = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "retire-report-"))
  );
  trees.push(tree);
  const park = vi.fn(async () => ({ ok: true }));
  const retire = vi.fn(async () => ({ ok: true }));
  const self = agent("cc-a");
  const port: ReportRetirePort = {
    current: () => self,
    roster: () => [self],
    events: () => [allocated("cc-a", "agent-chat/cc-a", tree)],
    enabledFor: (spawner) => spawner === "coord",
    lastReport: () => report,
    tracked: () => false,
    holds: { shepherd: async () => undefined },
    park,
    retire,
    ...over,
  };
  return { port, park, retire, tree };
}

const run = (port: ReportRetirePort) => retireAtReport(port, "id-cc-a");

describe("retire at the final report", () => {
  it("parks the tree, then retires the agent", async () => {
    const { port, park, retire } = setup();

    expect(await run(port)).toEqual({
      action: "retired",
      name: "cc-a",
      parked: true,
    });
    expect(park.mock.invocationCallOrder[0]).toBeLessThan(
      retire.mock.invocationCallOrder[0] ?? 0
    );
  });

  it("retires an agent that holds no tree without parking", async () => {
    const { port, park } = setup({ events: () => [] });

    expect(await run(port)).toEqual({
      action: "retired",
      name: "cc-a",
      parked: false,
    });
    expect(park).not.toHaveBeenCalled();
  });

  it("does nothing for a spawner that did not opt in", async () => {
    const { port, retire } = setup({ enabledFor: () => false });

    expect(await run(port)).toEqual({ action: "off" });
    expect(retire).not.toHaveBeenCalled();
  });

  it("retires on DONE_WITH_CONCERNS and on a Verdict", async () => {
    for (const report of ["Status: DONE_WITH_CONCERNS", "Verdict: MERGE"])
      expect((await run(setup({}, report).port)).action).toBe("retired");
  });

  it.each([
    "Status: BLOCKED",
    "Status: NEEDS_CONTEXT",
    "Status: IN PROGRESS",
    "",
  ])(
    "keeps an agent whose last report is %j, since a retired name cannot be resumed",
    async (report) => {
      const { port, retire } = setup({}, report);

      expect(await run(port)).toEqual({
        action: "kept",
        name: "cc-a",
        reason: NOT_FINISHED,
      });
      expect(retire).not.toHaveBeenCalled();
    }
  );

  it("keeps an agent whose branch a Shepherd hold names", async () => {
    const { port, retire } = setup({
      holds: { shepherd: async () => "open PR (Shepherd wakes it)" },
    });

    expect(await run(port)).toEqual({
      action: "kept",
      name: "cc-a",
      reason: "open PR (Shepherd wakes it)",
    });
    expect(retire).not.toHaveBeenCalled();
  });

  it("keeps a tree another identity still works in", async () => {
    const { port, tree } = setup();
    const heir = agent("heir", { state: "live", cwd: tree });
    const roster = [agent("cc-a"), heir];

    const out = await run({ ...port, roster: () => roster });

    expect(out).toEqual({
      action: "kept",
      name: "cc-a",
      reason: "heir (not retired) still works in its worktree",
    });
  });

  it("keeps the agent with the park's reason when the park refuses", async () => {
    const { port, retire } = setup({
      park: async () => ({ ok: false, reason: "dirty" }),
    });

    expect(await run(port)).toEqual({
      action: "kept",
      name: "cc-a",
      reason: "dirty",
    });
    expect(retire).not.toHaveBeenCalled();
  });

  it("keeps an agent resumed while the park ran", async () => {
    const { port, retire } = setup();
    const resumed = agent("cc-a", { state: "live" });
    let reads = 0;

    const out = await run({
      ...port,
      current: () => (reads++ === 0 ? agent("cc-a") : resumed),
    });

    expect(out).toEqual({
      action: "kept",
      name: "cc-a",
      reason: "became live before the retire",
    });
    expect(retire).not.toHaveBeenCalled();
  });

  it("keeps an agent whose retire refuses, and never rejects", async () => {
    expect(
      await run(
        setup({ retire: async () => ({ ok: false, reason: "locked" }) }).port
      )
    ).toEqual({
      action: "kept",
      name: "cc-a",
      reason: "locked",
    });
    expect(
      await run(
        setup({
          retire: async () => {
            throw new Error("socket closed");
          },
        }).port
      )
    ).toEqual({ action: "kept", name: "cc-a", reason: "socket closed" });
  });
});
