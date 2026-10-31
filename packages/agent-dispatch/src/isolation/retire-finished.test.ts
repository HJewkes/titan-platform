import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  retireFinished,
  SCOPE_REQUIRED,
  STALE_AFTER_MS,
  STALE_RETIRE_CAP,
  workBlocker,
  type FinishedHolds,
  type FinishedRetirePort,
  type RetireScope,
} from "./index.js";
import { agent, allocated } from "./retire-test-support.js";
import type { AgentIdentity } from "../roster/types.js";
import type { JournalRow } from "../host/ports.js";

/** CC-323, CC-904, CC-950, CC-1325 and CC-1465: the plan and skip rules of `retire --finished`. */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});
const realDir = (): string => {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "retire-fin-"))
  );
  dirs.push(dir);
  return dir;
};

/** A git runner that answers every command as a clean, pushed tree. */
const cleanGit = async (args: readonly string[]): Promise<string | null> => {
  if (args[0] === "status") return "";
  if (args[0] === "rev-list") return "";
  if (args.includes("--abbrev-ref")) return "origin/agent-chat/x";
  return "ref";
};

function port(
  roster: AgentIdentity[],
  events: JournalRow[] = [],
  over: Partial<FinishedRetirePort> = {}
) {
  const retire = vi.fn(async () => ({ ok: true }));
  const full: FinishedRetirePort = {
    roster: () => roster,
    events: () => events,
    tracked: () => false,
    parking: () => false,
    current: (id) => roster.find((a) => a.agentId === id),
    presence: () => "none",
    retire,
    git: cleanGit,
    ...over,
  };
  return { port: full, retire };
}

const noHolds: FinishedHolds = {
  shepherd: async () => undefined,
  openPr: async () => undefined,
};

describe("retireFinished scope", () => {
  it("refuses a request with no scope field", async () => {
    const out = await retireFinished(port([agent("cc-a")]).port, {});

    expect(out).toEqual({
      ok: false,
      reason: SCOPE_REQUIRED,
      plan: [],
      results: [],
    });
  });

  it("refuses a field of the wrong type", async () => {
    const frame: RetireScope = {};
    Reflect.set(frame, "prefix", 3);

    const out = await retireFinished(port([]).port, frame);

    expect(out.reason).toBe("prefix must be a string");
  });

  it("plans only the agents the prefix and spawner select", async () => {
    const roster = [
      agent("cc-a"),
      agent("cc-b", { spawnedBy: "other" }),
      agent("zz-c"),
    ];

    const out = await retireFinished(port(roster).port, {
      prefix: "cc-",
      spawner: "coord",
      dryRun: true,
    });

    expect(out.plan.map((p) => p.name)).toEqual(["cc-a"]);
  });

  it("skips the caller itself", async () => {
    const out = await retireFinished(port([agent("cc-a")]).port, {
      prefix: "cc-",
      caller: "cc-a",
      dryRun: true,
    });

    expect(out.plan).toEqual([
      {
        name: "cc-a",
        action: "skip",
        reason: "cc-a is the caller itself, not an agent it spawned",
      },
    ]);
  });
});

describe("retireFinished skips", () => {
  const plan = async (
    a: AgentIdentity,
    over: Partial<FinishedRetirePort> = {},
    events: JournalRow[] = []
  ) =>
    (
      await retireFinished(port([a], events, over).port, {
        prefix: "cc-",
        dryRun: true,
      })
    ).plan[0];

  it("retires an exited agent that holds no tree", async () => {
    expect(await plan(agent("cc-a"))).toEqual({
      name: "cc-a",
      action: "retire",
    });
  });

  it.each([
    ["a live agent", agent("cc-a", { state: "live" }), {}, "live"],
    [
      "a detached agent whose process is tracked",
      agent("cc-a", { state: "detached" }),
      { tracked: () => true },
      "detached, but its process is still running",
    ],
    [
      "an agent whose process is still connected",
      agent("cc-a"),
      { presence: () => "self" as const },
      "exited, but its process is still connected",
    ],
    [
      "an agent not spawned by agent-chat",
      agent("cc-a", { origin: "adopted" }),
      {},
      "not spawned by agent-chat; retire it by name",
    ],
    [
      "an agent being parked",
      agent("cc-a"),
      { parking: () => true },
      "being parked",
    ],
    [
      "an agent the caller does not own",
      agent("cc-a"),
      { ownership: () => "not yours" },
      "not yours",
    ],
  ])("skips %s", async (_label, a, over, reason) => {
    expect(await plan(a, over as Partial<FinishedRetirePort>)).toEqual({
      name: "cc-a",
      action: "skip",
      reason,
    });
  });

  it("skips an agent whose tree another identity works in", async () => {
    const tree = realDir();
    const roster = [agent("cc-a"), agent("heir", { cwd: tree })];
    const events = [allocated("cc-a", "agent-chat/cc-a", tree)];

    const out = await retireFinished(port(roster, events).port, {
      prefix: "cc-",
      dryRun: true,
    });

    expect(out.plan[0]?.reason).toBe(
      "heir (not retired) still works in its worktree"
    );
  });

  it("marks a name two unretired rows share", async () => {
    const roster = [agent("cc-a"), agent("cc-a", { agentId: "id-2" })];

    const out = await retireFinished(port(roster).port, {
      prefix: "cc-",
      dryRun: true,
    });

    expect(out.plan.map((p) => p.duplicate)).toEqual([true, true]);
  });
});

describe("retireFinished holds", () => {
  const plan = async (holds: FinishedHolds) =>
    (
      await retireFinished(
        port([agent("cc-a")], [allocated("cc-a", "agent-chat/cc-a", "/gone")], {
          holds,
        }).port,
        { prefix: "cc-", dryRun: true }
      )
    ).plan[0];

  it("skips with the Shepherd hold's reason", async () => {
    expect(
      await plan({
        ...noHolds,
        shepherd: async () => "open PR (Shepherd wakes it)",
      })
    ).toEqual({
      name: "cc-a",
      action: "skip",
      reason: "open PR (Shepherd wakes it)",
    });
  });

  it("asks the open-PR hold about the agent's own branch", async () => {
    const openPr = vi.fn(
      async () => "open PR on agent-chat/cc-a (kept until merged or closed)"
    );

    const entry = await plan({ ...noHolds, openPr });

    expect(openPr).toHaveBeenCalledWith([
      { gitRoot: "/repo", branch: "agent-chat/cc-a" },
    ]);
    expect(entry?.action).toBe("skip");
  });

  it("does not ask the open-PR hold once Shepherd's hold has answered", async () => {
    const openPr = vi.fn(async () => undefined);

    await plan({ shepherd: async () => "held", openPr });

    expect(openPr).not.toHaveBeenCalled();
  });
});

describe("retireFinished retires", () => {
  it("retires each planned agent by id and reports the results", async () => {
    const { port: p, retire } = port([agent("cc-a"), agent("cc-b")]);

    const out = await retireFinished(p, { prefix: "cc-" });

    expect(out.ok).toBe(true);
    expect(retire.mock.calls).toEqual([["id-cc-a"], ["id-cc-b"]]);
  });

  it("keeps going after one retire throws", async () => {
    const retire = vi.fn(async (id: string) => {
      if (id === "id-cc-a") throw new Error("socket closed");
      return { ok: true };
    });

    const out = await retireFinished(
      port([agent("cc-a"), agent("cc-b")], [], { retire }).port,
      { prefix: "cc-" }
    );

    expect(out.results).toEqual([
      { name: "cc-a", ok: false, reason: "socket closed" },
      { name: "cc-b", ok: true },
    ]);
    expect(out.ok).toBe(false);
  });

  it("refuses an agent that went live between the plan and the retire", async () => {
    const roster = [agent("cc-a")];
    const { port: p, retire } = port(roster, [], {
      current: () => agent("cc-a", { state: "live" }),
    });

    const out = await retireFinished(p, { prefix: "cc-" });

    expect(out.results).toEqual([
      { name: "cc-a", ok: false, reason: "became live after the plan" },
    ]);
    expect(retire).not.toHaveBeenCalled();
  });

  it("retires nothing on a dry run", async () => {
    const { port: p, retire } = port([agent("cc-a")]);

    await retireFinished(p, { prefix: "cc-", dryRun: true });

    expect(retire).not.toHaveBeenCalled();
  });
});

describe("retireFinished stale scope", () => {
  const now = 10 * STALE_AFTER_MS;
  const exited = (name: string, ago: number) =>
    agent(name, { exitedAt: now - ago });

  it("takes only agents exited over a day ago, machine-wide", async () => {
    const roster = [
      exited("old", STALE_AFTER_MS),
      exited("fresh", STALE_AFTER_MS - 1),
      agent("no-exit-time"),
    ];

    const out = await retireFinished(
      port(roster, [], { now: () => now }).port,
      { stale: true, dryRun: true }
    );

    expect(out.plan.map((p) => p.name)).toEqual(["old"]);
  });

  it("skips an agent whose tree is still on disk", async () => {
    const tree = realDir();
    const events = [allocated("old", "agent-chat/old", tree)];

    const out = await retireFinished(
      port([exited("old", STALE_AFTER_MS)], events, { now: () => now }).port,
      {
        stale: true,
        dryRun: true,
      }
    );

    expect(out.plan[0]?.reason).toBe(`still holds ${tree}; park it first`);
  });

  it("stops planning at the cap", async () => {
    const roster = Array.from({ length: STALE_RETIRE_CAP + 3 }, (_, i) =>
      exited(`old-${i}`, STALE_AFTER_MS)
    );

    const out = await retireFinished(
      port(roster, [], { now: () => now }).port,
      { stale: true, dryRun: true }
    );

    expect(out.plan).toHaveLength(STALE_RETIRE_CAP);
  });
});

describe("workBlocker", () => {
  const target = (worktree: string, gitRoot = "/gone-root") => ({
    gitRoot,
    worktree,
    branch: "agent-chat/cc-a",
    assigned: false,
  });
  const git =
    (answers: Record<string, string | null>) =>
    async (args: readonly string[]) =>
      answers[args[0] ?? ""] ?? null;

  it("finds nothing in a clean, pushed tree", async () => {
    expect(await workBlocker(target(realDir()), cleanGit)).toBeUndefined();
  });

  it("names uncommitted changes", async () => {
    const tree = realDir();

    expect(await workBlocker(target(tree), git({ status: " M a.ts" }))).toBe(
      `uncommitted changes in ${tree}`
    );
  });

  it("counts commits not on the upstream", async () => {
    const tree = realDir();
    const git2 = async (args: readonly string[]) =>
      args[0] === "status"
        ? ""
        : args[0] === "rev-list"
        ? "c1\nc2\n"
        : "origin/agent-chat/cc-a";

    expect(await workBlocker(target(tree), git2)).toBe(
      `2 commit(s) in ${tree} are not on upstream origin/agent-chat/cc-a`
    );
  });

  it("fails closed when git cannot read the tree", async () => {
    const tree = realDir();

    expect(await workBlocker(target(tree), async () => null)).toBe(
      `could not read git status in ${tree}`
    );
  });

  it("reads the branch when the tree is gone, and finds nothing when the branch is gone too", async () => {
    const root = realDir();

    expect(
      await workBlocker(target("/gone-tree", root), async () => null)
    ).toBeUndefined();
    expect(
      await workBlocker(target("/gone-tree", "/gone-root"), cleanGit)
    ).toBe("neither /gone-tree nor /gone-root is on disk");
  });
});
