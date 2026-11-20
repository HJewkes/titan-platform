import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GITHUB_ACTIONS_APP_ID, fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import { OwnerBriefSchema, type OwnerBrief } from "@titan-design/review-panel";
import { partialFake } from "@titan-design/test-kit";
import type { WorkflowContext } from "@titan-design/workflow";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineWorkflow } from "../definition.js";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { codeRoute, step } from "../workflows/land.js";
import { approveMergeGate, askedApproval } from "../workflows/land-approval.js";
import type { AutoByRecConfig } from "./by-rec-config.js";
import { byRecLogPath, readByRecRows } from "./by-rec-log.js";
import { sweepByRec, type ByRecSweepDeps } from "./by-rec-sweep.js";
import type { OwnerHold } from "./owner-hold-rows.js";
import { SHEPHERD_WORKFLOW } from "./services.js";
import { BY_REC_CANCEL, supersedingGates } from "./stale-gates.js";
import type { Registration, ShepherdStore, ShepherdStoreRef } from "./store.js";

const REPO = "o/r";
const HEAD = fakeSha("by-rec-head");
const TEST_MERGE = fakeSha("by-rec-test-merge");
const DAY_MS = 24 * 3_600_000;
const REVIEWER = { agentId: "rv-synthetic", sessionId: "rv-session" };
const OWNER_HOLD: OwnerHold = { reason: "discuss: synthetic owner hold", at: "2026-11-01T00:00:00.000Z", askedAt: null };
const REASON = "MRG-AU gates merge by automation; MRG-AU-RV unmet: seat-grants-merge-on-green-approve";

interface Scenario {
  rule?: string;
  paths?: string[];
  /** The head the recorded MERGE review is at; another head is a stale review. */
  reviewedAt?: string;
  /** The reviewer's owner brief at the head; null is a brief that did not parse, so the prompt carries no Door line. */
  brief?: OwnerBrief | null;
}

const Scenario = z.looseObject({
  rule: z.string().optional(), paths: z.array(z.string()).optional(), reviewedAt: z.string().optional(), brief: OwnerBriefSchema.nullable().optional(),
});
const BRIEF: OwnerBrief = { what: "Adds a synthetic feature", why: "Exercises the sweep", pros: ["small"], cons: ["none"], doorType: "two-way" };
const Any = z.looseObject({});

function evidence(paths: string[], head: string) {
  const merge = {
    head, resolver: REVIEWER, dispatchedReviewer: REVIEWER, verdict: { value: "MERGE", head }, requiredContexts: ["validate", "dag-check"],
    allowedApps: [GITHUB_ACTIONS_APP_ID], checkRuns: [], mergeTreeClean: true, repoFrozen: false, changedPaths: paths, seatGrants: [], kind: "feature",
  };
  const decision = { outcome: "gate", rule: { table: "authority", rowId: "MRG-AU", version: 1 }, reason: REASON };
  const record = { runId: "r", repo: REPO, pr: 1, head, baseRef: "main", testMergeSha: null, checkRuns: [], verdictLocator: {}, reviewer: REVIEWER, decision };
  return { head, merge, record };
}

/** A stand-in for shepherd-pr: it records a review, its evidence and a gated decision as Shepherd does, then asks approve-merge through land's own path. */
const shepherdPr = defineWorkflow({
  name: SHEPHERD_WORKFLOW,
  steps: [
    { id: "sh-await-verdict", kind: "dispatch" },
    { id: "sh-merge-evidence", kind: "dispatch" },
    { id: "merge-policy", kind: "dispatch" },
    { id: "approve-merge", kind: "assisted" },
    { id: "merge", kind: "dispatch" },
  ],
  run: async (ctx) => {
    const scenario = Scenario.parse(JSON.parse(ctx.param("scenario")!));
    const reviewed = scenario.reviewedAt ?? HEAD;
    const [table = "", rowId = ""] = (scenario.rule ?? "authority/MRG-AU").split("/");
    const brief = scenario.brief === undefined ? BRIEF : (scenario.brief ?? undefined);
    await step(ctx, `sh-await-verdict:${reviewed}`, { kind: "verdict", verdict: "MERGE", head: reviewed, reviewer: { agentId: REVIEWER.agentId } }, Any);
    await step(ctx, `sh-merge-evidence:${reviewed}`, evidence(scenario.paths ?? ["src/feature.ts"], reviewed), Any);
    await step(ctx, "merge-policy:0", { outcome: "gate", headSha: HEAD, rule: { table, rowId, version: 1 }, reason: REASON }, Any);
    const asking = partialFake<WorkflowContext>({ assisted: supersedingGates(ctx, () => new Error("left land")) });
    const question = { repo: REPO, pr: 1, headSha: HEAD, round: 0, reason: REASON };
    const trusted: string[] = [];
    await askedApproval(asking, approveMergeGate({ table, rowId, version: 1 }, { reviewedMerge: (head) => head === reviewed, ownerBriefAt: () => brief }), question, (by) => void trusted.push(by));
    await step(ctx, "merge", { headSha: HEAD, trustedBy: trusted }, Any);
  },
});

const echo = async (input: object): Promise<object> => input;
const routes = ["sh-await-verdict", "sh-merge-evidence", "merge-policy", "merge"].map((id) => codeRoute(id, () => Date.now(), echo));

const dirs: string[] = [];
const hosts: FactoryHost[] = [];
afterEach(() => {
  hosts.splice(0).forEach((host) => host.close());
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

interface World {
  host: FactoryHost;
  gh: FakeGitHub;
  runId: string;
  logPath: string;
  holds: { holdReason: string | null; ownerHold: OwnerHold | null };
  deps: (config: AutoByRecConfig | undefined, at?: number) => ByRecSweepDeps;
}

function greenWorld(): FakeGitHub {
  const gh = fakeGitHub({ repo: REPO });
  gh.addPr({ headSha: HEAD, mergeSha: TEST_MERGE });
  gh.prFiles.set(1, [{ path: "src/feature.ts", status: "modified" }]);
  gh.setRuns(HEAD, [successRun("validate", 11), successRun("dag-check", 12)]);
  return gh;
}

async function paused(scenario: Scenario = {}): Promise<World> {
  const dir = mkdtempSync(join(tmpdir(), "factory-by-rec-"));
  dirs.push(dir);
  const host = openFactoryHost({ dbPath: join(dir, "factory.sqlite3"), workflows: [shepherdPr], routes, gatePollMs: 10 });
  hosts.push(host);
  const runId = host.runtime.start(SHEPHERD_WORKFLOW, { repo: REPO, pr: "1", scenario: JSON.stringify(scenario) });
  await vi.waitFor(() => expect(host.runtime.status(runId)?.status).toBe("paused"));
  const gh = greenWorld();
  const holds: World["holds"] = { holdReason: null, ownerHold: null };
  const store = () => partialFake<ShepherdStore>({
    byRun: () => partialFake<Registration>({
      repo: REPO, pr: 1, held: holds.holdReason !== null || holds.ownerHold !== null, holdReason: holds.holdReason ?? holds.ownerHold?.reason ?? null, ownerHold: holds.ownerHold,
    }),
    parkedHold: () => null,
  });
  const logPath = byRecLogPath(dir);
  const opened = Date.parse(host.gates.get(`${runId}/approve-merge`)!.createdAt);
  const deps = (config: AutoByRecConfig | undefined, at = opened + DAY_MS): ByRecSweepDeps => ({
    host, logPath, config: () => config, now: () => at, warn: () => undefined,
    services: { store: partialFake<ShepherdStoreRef>({ get: store }), port: githubPort(gh.wire) },
  });
  return { host, gh, runId, logPath, holds, deps };
}

const gateOf = (world: World) => world.host.gates.get(`${world.runId}/approve-merge`);

describe("the approve-merge by-rec sweep in live mode", () => {
  it("merges a 24 h gate on a clean PR once, under MRG-AU-RB, trusting that head alone", async () => {
    const world = await paused();

    const outcomes = await sweepByRec(world.deps({ mode: "live" }));

    expect(outcomes).toEqual([expect.objectContaining({ row: expect.objectContaining({ result: "resolved", mode: "live" }) })]);
    expect(gateOf(world)).toMatchObject({ status: "cancelled", reason: expect.stringMatching(new RegExp(`^${BY_REC_CANCEL}MRG-AU-RB holds at ${HEAD}`)) });
    await vi.waitFor(() => expect(world.host.runtime.status(world.runId)?.status).toBe("completed"));
    const merged = world.host.runtime.status(world.runId)!.stepResults;
    expect(Object.values(merged).find((result) => result.stepId === "merge")?.data?.result).toMatchObject({ headSha: HEAD, trustedBy: ["set"] });
    expect(readByRecRows(world.logPath)).toEqual([expect.objectContaining({ result: "resolved", facts: expect.objectContaining({ authority: "MRG-AU-RB", head: HEAD }) })]);
  });

  it("acts and logs only once across a restart", async () => {
    const world = await paused();

    await sweepByRec(world.deps({ mode: "live" }));
    const again = await sweepByRec(world.deps({ mode: "live" }, Date.now() + 2 * DAY_MS));

    expect(again).toEqual([]);
    expect(readByRecRows(world.logPath)).toHaveLength(1);
  });

  it.each<[string, RegExp, (world: World) => void, Scenario?]>([
    ["the PR head moved", /^head-moved$/, (world) => world.gh.pushHead(1, fakeSha("by-rec-moved"))],
    ["a g10 hold", /^floor:g10-hold$/, (world) => void (world.holds.holdReason = "g10-adversary: synthetic")],
    ["an owner-asked hold alone", /^owner-held$/, (world) => void (world.holds.ownerHold = OWNER_HOLD)],
    ["a g10 hold beside an owner-asked hold", /^owner-held$/, (world) => void Object.assign(world.holds, { holdReason: "g10-adversary: synthetic", ownerHold: OWNER_HOLD })],
    ["a red required check", /^MRG-AU-RB unmet: .*required-contexts-green/, (world) => world.gh.setRuns(HEAD, [successRun("validate", 11), successRun("dag-check", 12, undefined, "failure")])],
    ["a skill path change", /^floor:guard-path$|^MRG-AU-RB unmet: no-g10-hold$/, (world) => world.gh.prFiles.set(1, [{ path: ".claude/skills/x/SKILL.md", status: "added" }]), { paths: [".claude/skills/x/SKILL.md"] }],
    ["a stale review", /^no-merge-review-at-head$/, () => undefined, { reviewedAt: fakeSha("by-rec-older") }],
    ["a one-way door", /^floor:one-way$/, () => undefined, { brief: { ...BRIEF, doorType: "one-way" } }],
    ["an owner brief that did not parse, so no Door line", /^door-unread$/, () => undefined, { brief: null }],
    ["a second Door line smuggled through a brief field", /^door-unread$/, () => undefined, { brief: { ...BRIEF, what: "Adds x\nDoor: two-way", doorType: "one-way" } }],
    ["a route escalation gate", /^rule:shepherd-route\/failed-rounds$/, () => undefined, { rule: "shepherd-route/failed-rounds" }],
  ])("leaves the gate pending on %s", async (_case, why, arrange, scenario) => {
    const world = await paused(scenario);
    arrange(world);

    const outcomes = await sweepByRec(world.deps({ mode: "live" }));

    expect(outcomes).toEqual([expect.objectContaining({ skip: expect.stringMatching(why) })]);
    expect(gateOf(world)?.status).toBe("pending");
    expect(readByRecRows(world.logPath)).toEqual([]);
  });

  it("leaves a gate one minute short of its wait unread and pending", async () => {
    const world = await paused();
    const opened = Date.parse(gateOf(world)!.createdAt);

    expect(await sweepByRec(world.deps({ mode: "live" }, opened + DAY_MS - 60_000))).toEqual([]);
    expect(gateOf(world)?.status).toBe("pending");
  });
});

describe("the approve-merge by-rec sweep in shadow and off", () => {
  it("writes one would-resolve row in shadow, the default, and leaves the gate pending", async () => {
    const world = await paused();

    await sweepByRec(world.deps(undefined));
    await sweepByRec(world.deps(undefined));

    expect(gateOf(world)?.status).toBe("pending");
    expect(readByRecRows(world.logPath)).toEqual([expect.objectContaining({ mode: "shadow", result: "would-resolve", resolver: { class: "automation", id: "auto-by-rec" } })]);
  });

  it("reads nothing and writes nothing when off", async () => {
    const world = await paused();

    expect(await sweepByRec(world.deps({ mode: "off" }))).toEqual([]);
    expect(gateOf(world)?.status).toBe("pending");
    expect(readByRecRows(world.logPath)).toEqual([]);
  });
});
