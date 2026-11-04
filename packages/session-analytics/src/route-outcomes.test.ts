import { prRef } from "@titan-design/session-read";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFixtureGraph, insertOrigin, insertPrices, insertRequest, type FixtureGraph } from "./fixture.js";
import { routeOutcomes, type RouteOutcomeGroup } from "./route-outcomes.js";
import type { ShepherdRunRecord } from "./task-actuals-shepherd.js";

let fixture: FixtureGraph;

beforeEach(() => {
  fixture = createFixtureGraph();
  insertPrices(fixture.graph);
});
afterEach(() => fixture.close());

const LITE = "bd-implementer-lite";
const FULL = "bd-implementer";
const MERGED_AT = "2026-10-06T13:00:00Z";

interface SpawnSpec {
  id: string;
  profile: string;
  wanted: string;
  tasks?: string[];
  estimate?: number;
  spawnedAt?: string;
}

/** A routed spawn with one priced request, so every session costs the same. */
function addSpawn(spec: SpawnSpec): void {
  const db = fixture.graph.db;
  insertOrigin(db, { sessionId: spec.id, depth: 1, profile: spec.profile });
  db.prepare(
    `UPDATE session_origin SET task_ids = @tasks, task_source = 'name', spawned_at = @spawnedAt, route_mode = 'shadow',
       route_source = 'auto', route_prior = 'standard', route_table = 'shape-v1@0000abcd', route_wanted = @wanted, route_facts = @facts
     WHERE session_id = @id`,
  ).run({
    id: spec.id,
    tasks: JSON.stringify(spec.tasks ?? ["T-1"]),
    spawnedAt: spec.spawnedAt ?? "2026-10-06T09:00:00Z",
    wanted: spec.wanted,
    facts: JSON.stringify({ estimate: spec.estimate ?? 2 }),
  });
  addRequest(spec.id);
}

function addRequest(sessionId: string): void {
  insertRequest(fixture.graph.db, { sessionId, ts: "2026-10-06T09:00:00Z", outputTokens: 1000, model: "claude-opus-5", gapMs: null });
}

function linkPr(sessionId: string, pr: number, mergedAt: string | null = MERGED_AT): void {
  const ref = prRef("acme/widget", pr);
  fixture.graph.db.prepare("INSERT OR IGNORE INTO pr (pr_ref, merged_at) VALUES (?, ?)").run(ref, mergedAt);
  fixture.graph.edges.assert({ sourceRef: `session:${sessionId}`, relation: "linked", targetRef: ref });
}

function run(pr: number, reviewRounds: number, task: string | null = "alpha/T-1"): ShepherdRunRecord {
  return {
    runId: `run-${pr}`, task, repo: "acme/widget", pr, kind: "feature", status: "done",
    startedAt: "2026-10-06T10:00:00Z", completedAt: "2026-10-06T12:00:00Z", stageMinutes: {},
    reviewRounds, mergedAt: MERGED_AT, mergePath: "shepherd",
  };
}

function sessionCost(): number {
  const row: unknown = fixture.graph.db.prepare("SELECT cost_usd AS usd FROM request_cost LIMIT 1").get();
  const usd: unknown = typeof row === "object" && row !== null ? Reflect.get(row, "usd") : null;
  if (typeof usd !== "number" || usd <= 0) throw new Error("fixture request is unpriced");
  return usd;
}

function group(groups: RouteOutcomeGroup[], match: Partial<RouteOutcomeGroup>): RouteOutcomeGroup {
  const found = groups.filter((g) => Object.entries(match).every(([k, v]) => Reflect.get(g, k) === v));
  expect(found).toHaveLength(1);
  return found[0]!;
}

describe("routeOutcomes", () => {
  // Catches: a FIX_FIRST PR counted as clean (100%), and the shadow-differ spawn pooled into the lite group (3 spawns).
  it("splits lite-agree from shadow-differ spawns and scores first-pass clean, review rounds and $ per merged PR", () => {
    addSpawn({ id: "lite-clean", profile: LITE, wanted: LITE });
    addSpawn({ id: "lite-fix", profile: LITE, wanted: LITE });
    addSpawn({ id: "full-differ", profile: FULL, wanted: LITE });
    linkPr("lite-clean", 1);
    linkPr("lite-fix", 2);
    linkPr("full-differ", 3);
    insertOrigin(fixture.graph.db, { sessionId: "rev-1", depth: 1, profile: "bd-reviewer" });
    addRequest("rev-1");
    linkPr("rev-1", 1);
    const runs = [run(1, 1), run(2, 2), run(3, 1)];

    const groups = routeOutcomes(fixture.openReadOnly(), { shepherdRuns: runs });

    const cost = sessionCost();
    const lite = group(groups, { profile: LITE });
    expect(lite).toMatchObject({ agreement: "agree", prior: "standard", estimateBand: "2", spawns: 2, prs: 2, mergedPrs: 2 });
    expect(lite).toMatchObject({ cleanFirstPassPct: 50, reviewRoundsPerPr: 1.5, fixSpawnsPerPr: 0 });
    expect(lite.implementerUsdPerMergedPr).toBeCloseTo(cost);
    expect(lite.allInUsdPerMergedPr).toBeCloseTo((3 * cost) / 2);
    expect(group(groups, { profile: FULL })).toMatchObject({ agreement: "differ", spawns: 1, mergedPrs: 1, cleanFirstPassPct: 100 });
  });

  // Catches: a task-only run join, which gives each slice both PRs' review rounds (4 rounds and 0% clean in each band).
  it("joins a run on its PR and task, so two slices of one task do not share each other's PR", () => {
    addSpawn({ id: "slice-a", profile: LITE, wanted: LITE, estimate: 1 });
    addSpawn({ id: "slice-b", profile: LITE, wanted: LITE, estimate: 3 });
    linkPr("slice-a", 1);
    linkPr("slice-b", 2);
    const runs = [run(1, 1), run(2, 3)];

    const groups = routeOutcomes(fixture.openReadOnly(), { shepherdRuns: runs });

    expect(group(groups, { estimateBand: "0-1" })).toMatchObject({ prs: 1, mergedPrs: 1, reviewRoundsPerPr: 1, cleanFirstPassPct: 100 });
    expect(group(groups, { estimateBand: "3" })).toMatchObject({ prs: 1, mergedPrs: 1, reviewRoundsPerPr: 3, cleanFirstPassPct: 0 });
  });

  // Catches: a PR counted once per linking spawn (2 merged PRs, halving $ per merged PR).
  it("counts a PR once when a fix-round spawn links it again", () => {
    addSpawn({ id: "first", profile: LITE, wanted: LITE });
    addSpawn({ id: "fix-round", profile: LITE, wanted: LITE });
    linkPr("first", 1);
    linkPr("fix-round", 1);

    const [only] = routeOutcomes(fixture.openReadOnly(), { shepherdRuns: [run(1, 2)] });

    expect(only).toMatchObject({ spawns: 2, prs: 1, mergedPrs: 1, reviewRoundsPerPr: 2, fixSpawnsPerPr: 1 });
    expect(only!.implementerUsdPerMergedPr).toBeCloseTo(2 * sessionCost());
  });

  it("leaves rates unknown and skips unrouted spawns and spawns before the window", () => {
    addSpawn({ id: "early", profile: LITE, wanted: LITE, spawnedAt: "2026-10-01T09:00:00Z" });
    addSpawn({ id: "open", profile: LITE, wanted: LITE });
    insertOrigin(fixture.graph.db, { sessionId: "unrouted", depth: 1, profile: LITE });
    linkPr("open", 1, null);

    const groups = routeOutcomes(fixture.openReadOnly(), { shepherdRuns: [], since: "2026-10-05T00:00:00Z" });

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ spawns: 1, prs: 1, mergedPrs: 0, cleanFirstPassPct: null, reviewRoundsPerPr: null, implementerUsdPerMergedPr: null });
  });
});
