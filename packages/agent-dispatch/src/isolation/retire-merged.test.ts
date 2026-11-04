import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isWorkerProfile,
  passPrReads,
  PR_READS_PER_PASS,
  PR_REREAD_MS,
  retireMerged,
  type MergedRetirePort,
  type PrState,
} from "./index.js";
import { agent, allocated } from "./retire-test-support.js";

/** CC-1678: the broker retires an exited worker once the PR its last report names is done. */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

const merged: PrState = {
  state: "MERGED",
  head: { number: 7, headSha: "b".repeat(40) },
};

function setup(over: Partial<MergedRetirePort> = {}) {
  const tree = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "retire-merged-"))
  );
  dirs.push(tree);
  const park = vi.fn(async () => ({ ok: true }));
  const retire = vi.fn(async () => ({ ok: true }));
  const self = agent("cc-impl");
  const port: MergedRetirePort = {
    roster: () => [self],
    events: () => [allocated("cc-impl", "agent-chat/cc-impl", tree)],
    current: () => self,
    tracked: () => false,
    parking: () => false,
    presence: () => "none",
    lastReport: () => "Status: DONE\nPR: example/repo#7",
    treeHold: () => undefined,
    holds: { shepherd: async () => undefined, openPr: async () => undefined },
    readPr: async () => merged,
    park,
    retire,
    ...over,
  };
  return { port, park, retire, tree };
}

describe("retireMerged", () => {
  it("parks with the PR's head as backing, then retires", async () => {
    const { port, park, retire } = setup();

    expect(await retireMerged(port)).toEqual([
      {
        action: "retired",
        name: "cc-impl",
        pr: "example/repo#7",
        parked: true,
      },
    ]);
    expect(park).toHaveBeenCalledWith("id-cc-impl", merged.head);
    expect(retire).toHaveBeenCalledWith("id-cc-impl");
  });

  it("treats a closed, unmerged PR as done: parks on its head, then retires", async () => {
    const closed: PrState = { ...merged, state: "CLOSED" };
    const { port, park, retire } = setup({ readPr: async () => closed });

    expect(await retireMerged(port)).toEqual([
      {
        action: "retired",
        name: "cc-impl",
        pr: "example/repo#7",
        parked: true,
      },
    ]);
    expect(park).toHaveBeenCalledWith("id-cc-impl", closed.head);
    expect(retire).toHaveBeenCalledWith("id-cc-impl");
  });

  it("reports nothing for an open PR, a failed read or a report with no PR", async () => {
    for (const over of [
      { readPr: async () => ({ ...merged, state: "OPEN" as const }) },
      { readPr: async () => undefined },
      { lastReport: () => "Status: DONE" },
    ]) {
      const { port, retire } = setup(over);

      expect(await retireMerged(port)).toEqual([]);
      expect(retire).not.toHaveBeenCalled();
    }
  });

  it("passes over agents that are not exited spawned workers", async () => {
    const roster = [
      agent("a-live", { state: "live" }),
      agent("b-human", { origin: "adopted" }),
      agent("c-seat", { profile: "seat" }),
    ];
    const { port } = setup({ roster: () => roster });

    expect(await retireMerged(port)).toEqual([]);
  });

  const keeps: [string, (tree: string) => Partial<MergedRetirePort>, string][] = [
    [
      "a live agent in its tree",
      (tree: string) => ({
        roster: () => [
          agent("cc-impl"),
          agent("fix", { state: "live", cwd: tree }),
        ],
      }),
      "fix is live in ",
    ],
    ["an agent being parked", () => ({ parking: () => true }), "being parked"],
    [
      "a held burndown claim",
      () => ({ treeHold: () => "claim reads the tree" }),
      "claim reads the tree",
    ],
    [
      "a Shepherd hold",
      () => ({
        holds: {
          shepherd: async () => "held by shepherd",
          openPr: async () => undefined,
        },
      }),
      "held by shepherd",
    ],
    [
      "an open PR on the branch",
      () => ({
        holds: {
          shepherd: async () => undefined,
          openPr: async () => "open PR on x",
        },
      }),
      "open PR on x",
    ],
  ];
  it.each(keeps)("keeps the agent for %s", async (_label, make, reason) => {
    const { port, retire, tree } = setup();

    const [result] = await retireMerged({ ...port, ...make(tree) });

    expect(result).toMatchObject({
      action: "kept",
      reason: expect.stringContaining(reason),
    });
    expect(retire).not.toHaveBeenCalled();
  });

  it("keeps the agent when the park refuses", async () => {
    const { port, retire } = setup({
      park: async () => ({ ok: false, reason: "unpushed work" }),
    });

    expect(await retireMerged(port)).toEqual([
      {
        action: "kept",
        name: "cc-impl",
        pr: "example/repo#7",
        reason: "unpushed work",
      },
    ]);
    expect(retire).not.toHaveBeenCalled();
  });

  it("keeps an agent that went live while it was parked", async () => {
    const { port, retire } = setup();

    const [result] = await retireMerged({
      ...port,
      current: () => agent("cc-impl", { state: "live" }),
    });

    expect(result).toMatchObject({ action: "kept", reason: "live" });
    expect(retire).not.toHaveBeenCalled();
  });
});

describe("isWorkerProfile", () => {
  it("takes implementer, reviewer and adversary profiles, prefixed or not", () => {
    for (const p of [
      "implementer",
      "x-implementer-lite",
      "reviewer",
      "adversary",
    ])
      expect(isWorkerProfile(p)).toBe(true);
    for (const p of ["seat", "reviewers", "previewer"])
      expect(isWorkerProfile(p)).toBe(false);
  });
});

describe("passPrReads", () => {
  it("reads one PR once however many agents name it, across passes", async () => {
    const read = vi.fn(async () => merged);
    const pass = passPrReads(read);

    await pass()("example/repo#7");
    await pass()("example/repo#7");

    expect(read).toHaveBeenCalledOnce();
  });

  it("asks an open PR again only after the reread interval", async () => {
    let now = 0;
    const read = vi.fn(async () => ({ ...merged, state: "OPEN" as const }));
    const pass = passPrReads(read, () => now);

    await pass()("example/repo#7");
    await pass()("example/repo#7");
    now = PR_REREAD_MS;
    await pass()("example/repo#7");

    expect(read).toHaveBeenCalledTimes(2);
  });

  it("answers undefined for a failed read", async () => {
    const pass = passPrReads(async () => {
      throw new Error("rate limited");
    });
    const reader = pass();

    expect(await reader("example/repo#1")).toBeUndefined();
  });

  it("stops reading past the per-pass cap", async () => {
    const read = vi.fn(async () => merged);
    const reader = passPrReads(read)();

    for (let i = 1; i <= PR_READS_PER_PASS; i++)
      await reader(`example/repo#${i}`);

    expect(await reader("example/repo#999")).toBeUndefined();
    expect(read).toHaveBeenCalledTimes(PR_READS_PER_PASS);
  });
});
