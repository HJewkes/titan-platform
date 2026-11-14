import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { partialFake } from "@titan-design/test-kit";
import type { WorkflowRun } from "@titan-design/workflow";
import { WorkflowRunStore } from "@titan-design/workflow";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Verbs } from "../cli-types.js";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { ShepherdStore } from "../shepherd/store.js";
import { factoryRoutes, factoryWorkflows } from "../workflows.js";
import { loadRuleFile } from "./shadow/rule-file.js";
import type { RefusedRow } from "./shadow/row.js";
import { shadowTick } from "./shadow/tick.js";
import { calm, enabledRules, fakeRpc, selectedBet, shadowHome, task } from "./shadow/tick.test-helpers.js";
import { upkeepCapHolds } from "./upkeep-signals.js";

const NOW = "2026-11-18T12:00:00Z";
const IN_WINDOW = "2026-11-17T09:00:00.000Z";
const TOO_OLD = "2026-11-01T09:00:00.000Z";
const REPO = "acme/app";
const POLICY = { merge: "auto", mergeMethod: "squash", fixer: false, seat: "synthetic-seat" } as const;

const hosts: FactoryHost[] = [];
// upkeepCapHolds reads the wall clock for its window, so the date is pinned to NOW.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
  hosts.splice(0).forEach((host) => host.close());
});

function runOf(id: string, state: { merged: boolean; at: string }): WorkflowRun {
  const stepResults: WorkflowRun["stepResults"] = state.merged
    ? { "sh-landed:0": { stepId: "sh-landed", iteration: 0, agentId: null, signal: null, completedAt: state.at, data: { result: { done: true } } } }
    : {};
  return {
    id, workflowName: "shepherd-pr", params: { repo: REPO }, status: state.merged ? "completed" : "running", currentStep: null,
    stepResults, activeSteps: {}, revision: 0, ownerGeneration: 0, startedAt: state.at, completedAt: state.merged ? state.at : null, error: null,
  };
}

interface Seed {
  pr: number;
  task: string;
  merged: boolean;
  at: string;
}

/** A real factory host whose Shepherd store holds one registration and one stored run per seed. */
function seededHost(seeds: readonly Seed[]): FactoryHost {
  const host = openFactoryHost({ dbPath: ":memory:", workflows: factoryWorkflows, routes: factoryRoutes() });
  hosts.push(host);
  const store = new ShepherdStore(host.db);
  for (const seed of seeds) {
    const runId = `run-${seed.pr}`;
    new WorkflowRunStore(host.db).create(runOf(runId, seed));
    store.register({ repo: REPO, pr: seed.pr, runId, task: seed.task, implementer: "synthetic-impl", policy: POLICY });
  }
  return host;
}

/** The pr-files cache the cap reads beside the shadow dir, so no PR needs a gh call. */
function seedFiles(cacheFile: string, files: Record<number, string[]>): void {
  mkdirSync(join(cacheFile, ".."), { recursive: true });
  writeFileSync(cacheFile, JSON.stringify({ v: 1, files: Object.fromEntries(Object.entries(files).map(([pr, list]) => [`${REPO}#${pr}`, list])) }));
}

async function tickOver(host: FactoryHost, files: Record<number, string[]>): Promise<RefusedRow[]> {
  const home = shadowHome();
  writeFileSync(join(home.dir, "dispatcher.json"), JSON.stringify(enabledRules(home)));
  const loaded = loadRuleFile(join(home.dir, "dispatcher.json"))!;
  seedFiles(join(home.dir, "cache", "pr-files.json"), files);
  const rpc = fakeRpc({ tasks: [task(1, { class: "upkeep" }), task(2, { class: "product", created: "2026-11-02" })], bets: [selectedBet(1, 1, ["alpha/AL-1", "alpha/AL-2"])] });
  const verbs = partialFake<Verbs>({
    io: { stdout: () => {}, stderr: () => {}, env: home.env },
    deps: { workflows: [], routes: [], fetch: rpc.fetch, laneSignals: async () => calm },
    withHost: async (fn) => void (await fn(host, factoryRoutes())),
  });
  const { rows } = await shadowTick({ loaded, verbs, now: new Date(NOW), wake: "w", providers: [upkeepCapHolds] });
  return rows.filter((row): row is RefusedRow => row.kind === "refused");
}

describe("live merged PRs from a seeded Shepherd store", () => {
  it("counts only the lane's PRs that merged inside the window, not out-of-lane, too-old or unmerged registrations", async () => {
    const host = seededHost([
      { pr: 1, task: "alpha/AL-1", merged: true, at: IN_WINDOW },
      { pr: 2, task: "beta/BE-1", merged: true, at: IN_WINDOW },
      { pr: 3, task: "alpha/AL-2", merged: true, at: TOO_OLD },
      { pr: 4, task: "alpha/AL-2", merged: false, at: IN_WINDOW },
    ]);

    const rows = await tickOver(host, {
      1: ["products/factory/src/a.ts"],
      2: ["apps/console/src/b.tsx", "apps/console/src/c.tsx"],
      3: ["apps/console/src/d.tsx", "apps/console/src/e.tsx"],
      4: ["apps/console/src/f.tsx", "apps/console/src/g.tsx"],
    });

    expect(rows.map(({ task: id, codes, numbers }) => ({ id, codes, numbers }))).toEqual([
      { id: "alpha/AL-1", codes: ["upkeep-cap"], numbers: { upkeepFiles: 1, allFiles: 1, prs: 1, share: 1, cap: 0.25 } },
    ]);
  });

  it("a store with no merged PR in the lane leaves the share empty and holds nothing", async () => {
    const host = seededHost([{ pr: 4, task: "alpha/AL-2", merged: false, at: IN_WINDOW }]);

    expect(await tickOver(host, { 4: ["apps/console/src/f.tsx"] })).toEqual([]);
  });
});

