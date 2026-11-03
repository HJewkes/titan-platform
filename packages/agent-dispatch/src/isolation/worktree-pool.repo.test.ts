import fs from "node:fs";
import { DEFAULT_WORKTREE_BUDGET } from "@titan-design/worktree";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ctxFor, makeRepo, removeTempDirs } from "./fixtures/git-repo.js";
import {
  createWorktreeStrategy,
  DEFAULT_REVIEWER_WORKTREE_BUDGET,
  refusalsIn,
  treeHoldersOf,
  WorktreeBudgetExhaustedError,
  type IsolationContext,
} from "./index.js";

vi.setConfig({ testTimeout: 30_000 });
afterEach(removeTempDirs);

const fixed = (n: number) => () => n;

describe("worktree budget", () => {
  it("reports exhaustion from check and throws from allocate", async () => {
    const repo = makeRepo();
    const strategy = createWorktreeStrategy({ budget: fixed(1) });
    await strategy.allocate(ctxFor(repo));

    const ctx = ctxFor(repo, { agentName: "bob", agentId: "ag-2" });
    expect(refusalsIn(await strategy.check(ctx))[0]).toContain("budget exhausted");
    await expect(strategy.allocate(ctx)).rejects.toBeInstanceOf(WorktreeBudgetExhaustedError);
  });

  it("names who holds the full pool, largest holder first (CC-1469)", async () => {
    const repo = makeRepo();
    const strategy = createWorktreeStrategy({ budget: fixed(3) });
    for (const agentName of ["agent-a", "agent-b", "agent-c"])
      await strategy.allocate(ctxFor(repo, { agentName, agentId: `ag-${agentName}` }));
    const holders = new Map([
      ["agent-a", "seat-b"],
      ["agent-b", "seat-b"],
    ]);
    const ctx = ctxFor(repo, { agentName: "agent-d", agentId: "ag-4", treeHolders: () => holders });

    const reason = refusalsIn(await strategy.check(ctx))[0];
    const refused: unknown = await strategy.allocate(ctx).catch((err: unknown) => err);

    expect(reason).toContain(
      "(budget exhausted: 3/3, worktreeBudget) under .worktrees; held by seat-b 2, unknown 1",
    );
    expect(refused).toMatchObject({
      message:
        "implementer worktree pool exhausted: 3/3 allocated (budget exhausted: 3/3, worktreeBudget); " +
        "held by seat-b 2, unknown 1",
    });
  });

  it("reads holders from the strategy options when the request carries none", async () => {
    const repo = makeRepo();
    const treeHolders = () => new Map([["alice", "seat-a"]]);
    const strategy = createWorktreeStrategy({ budget: fixed(1), treeHolders });
    await strategy.allocate(ctxFor(repo));
    const ctx = ctxFor(repo, { agentName: "bob", agentId: "ag-2" });

    expect(refusalsIn(await strategy.check(ctx))[0]).toContain("held by seat-a 1");
    await expect(strategy.allocate(ctx)).rejects.toThrow("held by seat-a 1");
  });

  it("charges a reused name to its newest spawner", () => {
    const holders = treeHoldersOf([
      { name: "agent-x", spawnedBy: "seat-new" },
      { name: "agent-x", spawnedBy: "seat-old" },
      { name: "agent/y", spawnedBy: "" },
    ]);

    expect([...holders]).toEqual([
      ["agent-x", "seat-new"],
      ["agent-y", "unknown"],
    ]);
  });

  it("reads the budget on every spawn, so a host's config edit reaches the next one", async () => {
    const repo = makeRepo();
    let budget = 1;
    const strategy = createWorktreeStrategy({ budget: () => budget });
    await strategy.allocate(ctxFor(repo));
    const second = ctxFor(repo, { agentName: "bob", agentId: "ag-2" });
    await expect(strategy.allocate(second)).rejects.toBeInstanceOf(WorktreeBudgetExhaustedError);

    budget = 2;

    expect(refusalsIn(await strategy.check(second))).toEqual([]);
    await expect(strategy.allocate(second)).resolves.toBeDefined();
  });

  it("falls back to the package default when the host passes no reader", async () => {
    const repo = makeRepo();
    const strategy = createWorktreeStrategy();
    for (let n = 0; n < DEFAULT_WORKTREE_BUDGET; n++)
      await strategy.allocate(ctxFor(repo, { agentName: `w${n}`, agentId: `ag-${n}` }));

    const reasons = refusalsIn(await strategy.check(ctxFor(repo)));

    expect(reasons[0]).toContain(`${DEFAULT_WORKTREE_BUDGET}/${DEFAULT_WORKTREE_BUDGET}`);
  });

  it("reclaims budget from a worktree whose directory vanished", async () => {
    const repo = makeRepo();
    const strategy = createWorktreeStrategy({ budget: fixed(1) });
    const alloc = await strategy.allocate(ctxFor(repo));
    fs.rmSync(alloc.cwd, { recursive: true, force: true });

    const ctx = ctxFor(repo, { agentName: "bob", agentId: "ag-2" });
    expect(refusalsIn(await strategy.check(ctx))).toEqual([]);
    await expect(strategy.allocate(ctx)).resolves.toBeDefined();
  });
});

describe("reviewer worktree pool (CC-1040)", () => {
  const reviewer = (repo: string, n: number): IsolationContext =>
    ctxFor(repo, { agentName: `rv-o-r-${n}`, agentId: `ag-rv-${n}` });

  const allocateReviewers = async (
    strategy: ReturnType<typeof createWorktreeStrategy>,
    repo: string,
    count: number,
  ) => {
    for (let n = 1; n <= count; n++) await strategy.allocate(reviewer(repo, n));
  };

  it("eight reviewer trees leave the implementer budget free, the default reviewer cap", async () => {
    const repo = makeRepo();
    const strategy = createWorktreeStrategy({ budget: fixed(1) });
    await allocateReviewers(strategy, repo, DEFAULT_REVIEWER_WORKTREE_BUDGET);

    expect(DEFAULT_REVIEWER_WORKTREE_BUDGET).toBe(8);
    expect(refusalsIn(await strategy.check(ctxFor(repo)))).toEqual([]);
    await expect(strategy.allocate(ctxFor(repo))).resolves.toBeDefined();
  });

  it("a reviewer past the cap is refused naming the reviewer pool", async () => {
    const repo = makeRepo();
    const strategy = createWorktreeStrategy({ budget: fixed(1), reviewerBudget: fixed(2) });
    await allocateReviewers(strategy, repo, 2);

    expect(refusalsIn(await strategy.check(reviewer(repo, 3)))[0]).toMatch(
      /reviewer worktree pool exhausted: 2\/2/,
    );
    const refused: unknown = await strategy.allocate(reviewer(repo, 3)).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(WorktreeBudgetExhaustedError);
    expect(refused).toMatchObject({
      pool: "reviewer",
      message: expect.stringMatching(/reviewer worktree pool exhausted: 2\/2.*reviewerWorktreeBudget/),
    });
  });

  it("implementer trees do not consume reviewer slots", async () => {
    const repo = makeRepo();
    const strategy = createWorktreeStrategy({ budget: fixed(3), reviewerBudget: fixed(1) });
    await strategy.allocate(ctxFor(repo));
    await strategy.allocate(ctxFor(repo, { agentName: "bob", agentId: "ag-2" }));

    await expect(strategy.allocate(reviewer(repo, 1))).resolves.toBeDefined();
  });

  it("counts an adversarial review tree in the reviewer pool and a preview tree as an implementer", async () => {
    const repo = makeRepo();
    const strategy = createWorktreeStrategy({ budget: fixed(1), reviewerBudget: fixed(1) });
    await strategy.allocate(ctxFor(repo, { agentName: "seat-1-adv-review" }));
    await strategy.allocate(ctxFor(repo, { agentName: "preview-x", agentId: "ag-2" }));

    const reviewerRefusal = refusalsIn(await strategy.check(reviewer(repo, 1)))[0];
    const implementerRefusal = refusalsIn(await strategy.check(ctxFor(repo, { agentId: "ag-3" })))[0];

    expect(reviewerRefusal).toMatch(/reviewer worktree pool exhausted: 1\/1/);
    expect(implementerRefusal).toMatch(/implementer worktree pool exhausted: 1\/1/);
  });

  it("reads the reviewer budget on every spawn", async () => {
    const repo = makeRepo();
    let reviewerBudget = 1;
    const strategy = createWorktreeStrategy({ budget: fixed(1), reviewerBudget: () => reviewerBudget });
    await strategy.allocate(reviewer(repo, 1));
    await expect(strategy.allocate(reviewer(repo, 2))).rejects.toBeInstanceOf(WorktreeBudgetExhaustedError);

    reviewerBudget = 2;

    await expect(strategy.allocate(reviewer(repo, 2))).resolves.toBeDefined();
  });
});
