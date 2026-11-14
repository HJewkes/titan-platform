import { BetSchema, TaskSchema, type Bet, type Task } from "@titan-design/pm";
import { describe, expect, it } from "vitest";
import { upkeepHolds, type MergedPrFiles, type UpkeepRead } from "./upkeep.js";

const RULES = { capShare: 0.25, windowDays: 7, factoryOutcomes: ["alpha/factory-health"] };

function task(n: number, fields: Record<string, unknown> = {}): Task {
  return TaskSchema.parse({ id: `AL-${n}`, title: `Synthetic ${n}`, priority: 1, status: "open", created: "2026-11-01", updated: "2026-11-09", done_at: null, ...fields });
}

function bet(outcome = "alpha/faster-landing"): Bet {
  const prediction = { metric: "lead time", direction: "decrease", baseline: 4, expected: 2, read_by: "2026-11-30" };
  return BetSchema.parse({ id: "alpha/B1", initiative: "alpha", week: "2026-W47", outcome, order: 1, tasks: ["alpha/AL-1"], prediction, state: "selected" });
}

const pr = (n: number, files: string[]): MergedPrFiles => ({ pr: `acme/app#${n}`, files });

const factoryOnly = pr(1, ["products/factory/src/a.ts", "products/factory/src/b.ts"]);
const consoleOnly = pr(2, ["apps/console/src/x.tsx", "apps/console/src/y.tsx", "apps/console/src/z.ts"]);
const mixed = pr(3, ["products/factory/src/c.ts", "apps/console/src/w.tsx", "apps/console/src/w.test.ts"]);

const upkeepTask = task(1, { class: "upkeep" });

function holdsOver(prs: MergedPrFiles[], candidates = [{ task: upkeepTask, bet: bet() }]) {
  return upkeepHolds({ initiative: "alpha", candidates, read: { ok: true, prs }, rules: RULES });
}

describe("upkeep share by changed paths", () => {
  it("a factory-only, a console and a mixed PR give the share of upkeep files among all files changed", () => {
    const holds = holdsOver([factoryOnly, consoleOnly, mixed]);

    expect(holds).toEqual([
      expect.objectContaining({ task: "alpha/AL-1", stage: "upkeep", codes: ["upkeep-cap"], numbers: { upkeepFiles: 3, allFiles: 8, prs: 3, share: 0.375, cap: 0.25 } }),
    ]);
  });

  it("a share of exactly the cap holds, and one just under it does not", () => {
    const atCap = holdsOver([pr(1, ["scripts/a.mjs", "apps/console/src/a.ts", "apps/console/src/b.ts", "apps/console/src/c.ts"])]);
    const underCap = holdsOver([pr(1, ["scripts/a.mjs", "apps/console/src/a.ts", "apps/console/src/b.ts", "apps/console/src/c.ts", "apps/console/src/d.ts"])]);

    expect(atCap.map((hold) => hold.numbers?.share)).toEqual([0.25]);
    expect(underCap).toEqual([]);
  });

  it("no merged PR in the window is a share of zero and holds nothing", () => {
    expect(holdsOver([])).toEqual([]);
  });
});

describe("test-only PR rule", () => {
  it("test files are upkeep in a PR that changed only tests, and product beside the code they test", () => {
    const testOnly = holdsOver([pr(1, ["apps/console/src/a.test.ts", "apps/console/src/b.test.ts"]), pr(2, ["apps/console/src/c.ts", "apps/console/src/d.ts"])]);
    const besideCode = holdsOver([pr(1, ["apps/console/src/a.ts", "apps/console/src/a.test.ts"])]);

    expect(testOnly.map((hold) => hold.numbers)).toEqual([{ upkeepFiles: 2, allFiles: 4, prs: 2, share: 0.5, cap: 0.25 }]);
    expect(besideCode).toEqual([]);
  });
});

describe("which tasks the cap holds", () => {
  const everything = [factoryOnly];

  it("product tasks are never held, even when every changed file was upkeep", () => {
    const product = [{ task: task(1, { class: "product" }), bet: bet("alpha/factory-health") }];

    expect(holdsOver(everything, product)).toEqual([]);
  });

  it("an untagged task is held only when its bet serves one of the factory's outcomes", () => {
    const factoryWork = { task: task(1), bet: bet("alpha/factory-health") };
    const otherWork = { task: task(2), bet: bet("alpha/faster-landing") };

    expect(holdsOver(everything, [factoryWork, otherWork]).map((hold) => hold.task)).toEqual(["alpha/AL-1"]);
  });

  it("an unread share holds the upkeep tasks and never the product ones", () => {
    const read: UpkeepRead = { ok: false, why: "gh could not read the files of acme/app#4" };
    const candidates = [{ task: upkeepTask, bet: bet() }, { task: task(2, { class: "product" }), bet: bet() }];

    const holds = upkeepHolds({ initiative: "alpha", candidates, read, rules: RULES });

    expect(holds).toEqual([{ task: "alpha/AL-1", stage: "upkeep", codes: ["signal-unreadable"], details: ["upkeep share unread: gh could not read the files of acme/app#4"] }]);
  });
});
