import { describe, expect, it } from "vitest";
import {
  BOOKKEEPING_REASON,
  limitsReport,
  limitsReportSchema,
  type LimitsClaim,
  type LimitsPlanInput,
  type LimitsRefusal,
  type LimitsSeatInput,
} from "./index.js";

const NOW = new Date("2026-10-12T16:40:00Z");
const clock = () => NOW;

const range = (n: number, from = 1): number[] => Array.from({ length: n }, (_, i) => i + from);

/** A synthetic tick in the shape of a supply-bound afternoon: one PR blocks most of the ready set. */
const refusals: LimitsRefusal[] = [
  ...range(13).map((n) => ({
    initiative: "demo",
    task: `DM-${n}`,
    kind: "open-pr",
    reason: `#1152 (feat/demo-wide) names DM-${n}: widen the demo`,
  })),
  ...range(2, 20).map((n) => ({ initiative: "demo", task: `DM-${n}`, kind: "open-pr", reason: `#1160 (fix/x) names DM-${n}: x` })),
  ...range(3, 30).map((n) => ({
    initiative: "demo",
    task: `DM-${n}`,
    slice: "a",
    kind: "file-overlap",
    reason: `#1170 touches packages/demo/src/f${n % 2}.ts`,
    blocker: { pr: 1170, repo: "demo/repo" },
  })),
  { initiative: "demo", task: "DM-1", kind: "file-overlap", reason: "#1170 touches packages/demo/src/f9.ts" },
  ...range(4, 40).map((n) => ({ initiative: "demo", task: `DM-${n}`, kind: "claimed", reason: BOOKKEEPING_REASON })),
  { initiative: "demo", task: "DM-50", kind: "plan-blocked", reason: "dep-blocked: DM-90 (open)" },
  { initiative: "demo", task: "DM-51", kind: "plan-blocked", reason: "retry-spent: two failed upstreams" },
  { initiative: "other", task: "OT-1", kind: "out-of-scope", reason: "tag outside the seat's scope" },
];

/** The `burndown-ticks.jsonl` row the tick wrote for the same plan. */
const tickRow = {
  v: 1,
  ts: NOW.toISOString(),
  seats: {
    alpha: {
      refusals: { "open-pr": 15, "file-overlap": 3, claimed: 4, "plan-blocked": 2, "out-of-scope": 1 },
      roles: { used: { implementers: 4, reviewers: 0, planners: 0 }, cap: { implementers: 6, reviewers: 2, planners: 1 } },
    },
  },
} as const;

const implementing = (n: number, extra: Partial<LimitsClaim> = {}): LimitsClaim => ({
  taskId: `IM-${n}`,
  initiative: "demo",
  seat: "alpha",
  phase: "implementing",
  agentName: `al-impl-${n}`,
  ...extra,
});

const ledger = {
  claims: [
    ...range(20).map((n) => implementing(n, n === 5 ? { stale: { class: "timeout", proposed: "respawn", since: "2026-10-12T12:00:00Z" } } : {})),
    implementing(99, { phase: "done" }),
    implementing(98, { seat: "beta" }),
  ],
};

function seat(overrides: Partial<LimitsSeatInput> = {}): LimitsSeatInput {
  return {
    seat: "alpha",
    refusals,
    roles: {
      implementers: { cap: 6, used: 4, hand: 1, handReserve: 2 },
      reviewers: { cap: 2, used: 0, hand: 0 },
      planners: { cap: 1, used: 0, hand: 0 },
    },
    supply: { ready: 0, waiting: 3, readyAgesMinutes: [10, 40, 20, 90] },
    pools: [{ pool: "agents", fiveHour: { value: 62, readAt: "2026-10-12T16:30:00Z" }, band: "green", pace: 0.8 }],
    worktrees: { active: { "demo/repo": 3 }, perRepoPerSeat: 4, totalCeiling: 12, leftFree: 2, budget: 12 },
    prs: [{ pr: 1152, status: "stalled" }],
    ...overrides,
  };
}

function plan(overrides: Partial<LimitsPlanInput> = {}): LimitsPlanInput {
  return {
    seats: [seat()],
    liveAgents: ["al-impl-1", "al-impl-2", "al-impl-3"],
    dispositionsStamped: false,
    ...overrides,
  };
}

const alpha = (input: LimitsPlanInput = plan()) => {
  const report = limitsReport(input, ledger, clock).seats.alpha;
  if (report === undefined) throw new Error("no alpha seat in the report");
  return report;
};

describe("limitsReport refusals", () => {
  it("counts each kind as the fixture tick row does, bookkeeping included under supply.seeded", () => {
    const report = alpha();

    const counted = Object.fromEntries(Object.entries(report.refusals).map(([kind, r]) => [kind, r.count]));
    expect({ ...counted, claimed: report.supply.seeded }).toEqual(tickRow.seats.alpha.refusals);
  });

  it("reports units held in the claim ledger as seeded supply, never as claimed refusals", () => {
    const report = alpha();

    expect(report.supply.seeded).toBe(4);
    expect(report.refusals.claimed).toBeUndefined();
    expect(report.binding).toMatchObject({ kind: "supply" });
    expect(report.binding.kind === "supply" && report.binding.mix.claimed).toBeUndefined();
  });

  it("ranks #1152 first among open-pr blockers with its 13 refusals and status", () => {
    const [top, next] = alpha().refusals["open-pr"]?.blockers ?? [];

    expect(top).toMatchObject({ pr: 1152, refusals: 13, status: "stalled" });
    expect(top?.slices).toHaveLength(13);
    expect(next).toMatchObject({ pr: 1160, refusals: 2, status: "unknown" });
  });

  it("names a file-overlap blocker's repo, slices and touched files", () => {
    const [blocker] = alpha().refusals["file-overlap"]?.blockers ?? [];

    expect(blocker).toMatchObject({ pr: 1170, repo: "demo/repo", refusals: 4 });
    expect(blocker?.slices).toEqual(["DM-30 a", "DM-31 a", "DM-32 a", "DM-1"]);
    expect(blocker?.files).toEqual(["packages/demo/src/f0.ts", "packages/demo/src/f1.ts", "packages/demo/src/f9.ts"]);
  });

  it("splits plan-blocked into dep-blocked and the dead-task classes", () => {
    expect(alpha().planBlocked).toEqual({ depBlocked: 1, dead: { "retry-spent": 1 } });
  });
});

describe("limitsReport binding", () => {
  it("binds on supply with the refusal mix when no capacity lever refused", () => {
    expect(alpha().binding).toEqual({
      kind: "supply",
      ready: 0,
      mix: { "open-pr": 15, "file-overlap": 3, "plan-blocked": 2, "out-of-scope": 1 },
    });
  });

  it("binds on the first capacity lever in rank order", () => {
    const gate = { lever: "seats.alpha.implementers", value: 6, reading: 6, headroom: 0, source: "seat config" };
    const capped: LimitsRefusal = { initiative: "demo", task: "DM-70", kind: "role-cap", reason: "holds 6 of 6", gate };

    const report = alpha(plan({ seats: [seat({ refusals: [...refusals.slice(0, 1), capped] })] }));

    expect(report.binding).toEqual({ kind: "lever", refusal: "role-cap", initiative: "demo", task: "DM-70", ...gate });
  });
});

describe("limitsReport roles", () => {
  it("with 20 ledger claims and 3 live agents lists 17 ledger-only claims", () => {
    const { implementers } = alpha().roles;

    expect(implementers).toMatchObject({ cap: 6, used: 4, live: 3, ledger: 20, hand: 1, spawning: 0 });
    expect(implementers.ledgerOnly).toHaveLength(17);
    expect(implementers.ledgerOnly.find((c) => c.task === "IM-5")).toMatchObject({ stale: "timeout", disposition: null });
    expect(implementers.handReserve).toEqual({ reserve: 2, remaining: 1 });
  });

  it("keeps the planner's used count equal to the tick row's", () => {
    const roles = alpha().roles;

    expect(roles.implementers.used).toBe(tickRow.seats.alpha.roles.used.implementers);
  });
});

describe("limitsReport contradictions", () => {
  it("reads undisposed as null, never 0, while dispositions are not stamped", () => {
    const { contradictions } = alpha();

    expect(contradictions.undisposed).toBeNull();
    expect(contradictions.items).toEqual([
      { initiative: "demo", task: "IM-5", class: "timeout", proposed: "respawn", since: "2026-10-12T12:00:00Z", disposition: null },
    ]);
  });

  it("counts stale claims with no disposition once dispositions are stamped", () => {
    expect(alpha(plan({ dispositionsStamped: true })).contradictions.undisposed).toBe(1);
  });
});

describe("limitsReport sections", () => {
  it("ages pool readings against the clock and derives the worktree ceiling", () => {
    const report = alpha();

    expect(report.pools[0]).toEqual({
      pool: "agents",
      fiveHour: { value: 62, ageMinutes: 10 },
      sevenDay: null,
      band: "green",
      pace: 0.8,
      reserve: null,
    });
    expect(report.worktrees).toEqual({ repos: { "demo/repo": { active: 3, perRepoPerSeat: 4 } }, ceiling: 10, budget: 12 });
    expect(report.supply).toMatchObject({ waiting: 3, outOfScope: 1, readyAgeMinutes: { p50: 20, p90: 90 } });
  });

  it("groups Shepherd runs by phase and counts reviews in flight against the cap", () => {
    const runs = [
      ...range(13).map((n) => ({ id: `r${n}`, phase: "review", reviewInFlight: true })),
      { id: "r20", phase: "ci", holdReason: "owner hold" },
    ];

    const report = limitsReport(plan({ shepherd: { runs, maxConcurrent: 16 } }), ledger, clock);

    expect(report.shepherd).toEqual({
      runs: { review: 13, ci: 1 },
      held: [{ run: "r20", reason: "owner hold" }],
      reviews: { inFlight: 13, maxConcurrent: 16 },
    });
  });

  it("carries a failed Shepherd read as an error while the seats still report", () => {
    const report = limitsReport(plan({ shepherd: { error: "shepherd status exited 69" } }), ledger, clock);

    expect(report.shepherd).toEqual({ error: "shepherd status exited 69" });
    expect(report.seats.alpha?.supply.seeded).toBe(4);
  });
});

describe("limitsReportSchema", () => {
  it("parses the report it describes", () => {
    const report = limitsReport(plan({ shepherd: { runs: [] } }), ledger, clock);

    expect(limitsReportSchema.parse(report)).toEqual(report);
    expect(report).toMatchObject({ v: 1, at: NOW.toISOString() });
  });
});
