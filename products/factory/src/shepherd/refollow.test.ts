import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeGitHub, fakeSha, githubPort, type FakeGitHub } from "@titan-design/github";
import type { GateRecord } from "@titan-design/hitl";
import { gitIn, seedRepo, withHistory } from "@titan-design/test-kit/git";
import type { WorkflowContext } from "@titan-design/workflow";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineWorkflow } from "../definition.js";
import { approveMergeDecision } from "../gate-brief.js";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { factoryRoutesFor } from "../workflows.js";
import { codeRoute, sleep, step } from "../workflows/land.js";
import { followingApprovals } from "./approval-carry.js";
import { hostCarryPorts } from "./carry-cache-adapter.js";
import { APPROVAL_CARRY_STEP, CARRY_SCOPE_STEPS } from "./carry-merge.js";
import { FIX_CARRY_STEP, fixCarryRoute } from "./fix-carry.js";
import { LeaveLand } from "./leave-land.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { REFOLLOWED, refollowGates } from "./refollow.js";
import { REMERGE_STEP, remergeRoute } from "./remerge-carry.js";
import type { ShepherdServices } from "./services.js";
import { SUPERSEDED, supersedingGates } from "./stale-gates.js";
import { shepherdStoreRef, type ShepherdStore } from "./store.js";

const REPO = "acme/widgets";
const REASON = "the authority policy did not allow an automated merge: MRG-AU gates merge by automation";
const READ_HEAD = "sh-read-head";
const REVIEW = "sh-review-stand-in";
const OWNER = { class: "owner-terminal", id: "owner", channel: "factory-cli" } as const;
const HeadRead = z.object({ headSha: z.string() });
/** The carry steps an owner answer's follow takes for a correctness run; the seat, claims and set reads belong to other carries. */
const FOLLOW_STEPS = CARRY_SCOPE_STEPS.filter((declared) => ["sh-carry-scope", REMERGE_STEP, FIX_CARRY_STEP, APPROVAL_CARRY_STEP].includes(declared.id));

/** Heads whose MERGE stands for the run; a test adds one to model a review that stood only after the land gate opened. */
const standing = new Set<string>();

const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  standing.clear();
});

const landPrompt = (head: string): string => `Merge PR #1 in ${REPO} at head ${head} into main? CI is green. Policy authority/MRG-AU: ${REASON}`;

/** Land's gate through the run's own wrappers: a merge answer is the head merged, a superseded cancel is a leave. */
async function askLand(assisted: WorkflowContext["assisted"], head: string): Promise<string | undefined> {
  try {
    const answer = await assisted("approve-merge", landPrompt(head), approveMergeDecision({ repo: REPO, pr: 1, headSha: head, reason: REASON, reviewedMerge: true }));
    return z.object({ decision: z.literal("merge"), headSha: z.string() }).safeParse(answer.data).data?.headSha;
  } catch (error) {
    if (error instanceof LeaveLand) return undefined;
    throw error;
  }
}

/**
 * A stand-in for shepherd-pr: each round reads the PR head, reviews a head it has no review for, and asks land's gate through
 * Shepherd's superseding wrapper inside the real approval carry; a re-review cancel drops the head's review, as the run does.
 */
const landStandIn = defineWorkflow({
  name: "shepherd-pr",
  steps: [...FOLLOW_STEPS, { id: READ_HEAD, kind: "dispatch" }, { id: REVIEW, kind: "dispatch" }, { id: "approve-merge", kind: "assisted" }],
  run: async (ctx) => {
    const target = { repo: REPO, pr: 1 };
    const reviewed = new Set<string>();
    const leave = (rereview: string | undefined) => (rereview !== undefined && reviewed.delete(rereview), new LeaveLand());
    const assisted = followingApprovals(ctx, supersedingGates(ctx, leave), { target, reviewedMerge: (head) => standing.has(head) });
    for (;;) {
      const { headSha } = await step(ctx, READ_HEAD, target, HeadRead);
      if (!reviewed.has(headSha)) await step(ctx, REVIEW, { headSha }, z.object({}));
      reviewed.add(headSha);
      const merged = await askLand(assisted, headSha);
      if (merged !== undefined && (await step(ctx, READ_HEAD, target, HeadRead)).headSha === merged) return;
    }
  },
});

/** An origin with the approved head on `feature` and one clean merge-up of main on top; `fix` adds a commit of the fixer's own. */
function repoWithMergeUp(root: string, fix: boolean): { origin: string; approved: string; head: string } {
  const origin = join(root, "origin");
  const git = gitIn(origin);
  seedRepo(origin, {});
  git("config", "uploadpack.allowAnySHA1InWant", "true");
  const approved = withHistory(origin, [
    { files: { "a.txt": "a0\nx\ny\nz\n" }, message: "seed" },
    { branch: "feature", from: ":1", files: { "a.txt": "a1\nx\ny\nz\n" }, message: "pr change" },
  ])[1]!;
  withHistory(origin, [{ files: { "main-1.txt": "m1\n" }, message: "main 1" }]);
  git("checkout", "-q", "feature");
  git("merge", "-q", "--no-ff", "--no-edit", "main");
  if (fix) withHistory(origin, [{ branch: "feature", files: { "a.txt": "a2\nx\ny\nz\n" }, message: "fixer change" }]);
  return { origin, approved, head: git("rev-parse", "feature") };
}

interface World {
  host: FactoryHost;
  services: ShepherdServices;
  store: ShepherdStore;
  gh: FakeGitHub;
  runId: string;
  approved: string;
  head: string;
}

const gateId = (w: World, call: number): string => `${w.runId}/approve-merge${call === 0 ? "" : `:${call}`}`;
const gate = (w: World, call: number): GateRecord | undefined => w.host.gates.get(gateId(w, call));
const pendingIds = (w: World): string[] => w.host.pendingGates().map(({ gate: pending }) => pending.id);
const stepsOf = (w: World, prefix: string): string[] => Object.keys(w.host.runtime.status(w.runId)?.stepResults ?? {}).filter((key) => key.startsWith(prefix));

/** A registered correctness run paused on land's gate at the approved head, over a real origin. */
async function world(fix = false): Promise<World> {
  const root = mkdtempSync(join(tmpdir(), "refollow-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const { origin, approved, head } = repoWithMergeUp(root, fix);
  const gh = fakeGitHub({ repo: REPO });
  gh.addPr({ headSha: approved });
  const port = githubPort(gh.wire);
  const ref = shepherdStoreRef();
  const factory = factoryRoutesFor({ port, store: ref, now: () => 0, sleep: async (_ms, signal) => sleep(1, signal) });
  const carry = { ports: hostCarryPorts, stateDir: join(root, "state"), remote: () => origin };
  const routes = Object.assign(
    [
      codeRoute("sh-carry-scope", () => 0, async () => ({ kind: "correctness", baseRef: "main", askedHead: null, g10Held: false })),
      remergeRoute(() => 0, carry),
      fixCarryRoute(() => 0, carry),
      codeRoute(APPROVAL_CARRY_STEP, () => 0, async (input: object) => input),
      codeRoute(READ_HEAD, () => 0, async (target: { repo: string; pr: number }) => ({ headSha: (await port.getPr(target.repo, target.pr)).headSha })),
      codeRoute(REVIEW, () => 0, async () => ({})),
    ],
    { database: factory.database },
  );
  const host = openFactoryHost({ dbPath: join(root, "factory.sqlite3"), workflows: [landStandIn], routes, gatePollMs: 5 });
  cleanups.push(() => host.close());
  const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1" });
  ref.get().register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY, kind: "correctness" });
  if (!factory.shepherd) throw new Error("the factory routes carry no shepherd services");
  const w = { host, services: factory.shepherd, store: ref.get(), gh, runId, approved, head };
  await vi.waitFor(() => expect(pendingIds(w)).toEqual([gateId(w, 0)]));
  return w;
}

/** The PR moves to the merge-up head, then the owner answers merge at the approved head; the run asks again at the new head. */
async function ownerMergedThenMovedUp(w: World): Promise<void> {
  w.gh.pushHead(1, w.head);
  w.host.gates.resolve(gateId(w, 0), { decision: "merge", headSha: w.approved }, OWNER);
  await vi.waitFor(() => expect(pendingIds(w)).toEqual([gateId(w, 1)]));
}

describe("shepherd refollow (TP-4812)", { timeout: 60_000 }, () => {
  it("a refollowed gate whose run holds an owner merge and only clean merge-ups since is answered by the approval carry, and no gate row records a coordinator merge", async () => {
    const w = await world();
    await ownerMergedThenMovedUp(w);
    standing.add(w.head);

    const report = await refollowGates(w.host, w.services);

    expect(report.gates).toEqual([{ runId: w.runId, gateId: gateId(w, 1), repo: REPO, pr: 1, headSha: w.head, cancelled: true }]);
    await vi.waitFor(() => expect(w.host.runtime.status(w.runId)?.status).toBe("completed"));
    expect(gate(w, 1)?.reason?.startsWith(REFOLLOWED)).toBe(true);
    expect(gate(w, 2)).toBeUndefined();
    expect([gate(w, 0), gate(w, 1)].filter((row) => row?.status === "resolved").map((row) => row?.resolvedBy?.class)).toEqual(["owner-terminal"]);
    expect(w.host.runtime.status(w.runId)?.stepResults[`${APPROVAL_CARRY_STEP}:${w.head}:0`]?.data).toMatchObject({ result: { decision: "merge", headSha: w.head, fromHead: w.approved, rule: "remerge-empty" } });
  });

  it("a refollowed gate the carry refuses opens the owner's gate again at the same head", async () => {
    const w = await world(true);
    standing.add(w.head);
    await ownerMergedThenMovedUp(w);

    await refollowGates(w.host, w.services);

    await vi.waitFor(() => expect(pendingIds(w)).toEqual([gateId(w, 2)]));
    expect(gate(w, 2)?.prompt).toBe(landPrompt(w.head));
    expect(stepsOf(w, `${APPROVAL_CARRY_STEP}:${w.head}`)).toEqual([]);
  });

  it("refollow skips a gate whose earlier land gate was cancelled unanswered", async () => {
    const w = await world();
    w.gh.pushHead(1, w.head);
    w.host.gates.cancel(gateId(w, 0), `${SUPERSEDED}the run moved on to head ${w.head}`);
    await vi.waitFor(() => expect(pendingIds(w)).toEqual([gateId(w, 1)]));
    standing.add(w.head);

    const report = await refollowGates(w.host, w.services);

    expect(report.gates).toEqual([]);
    expect(gate(w, 1)?.status).toBe("pending");
  });

  it("refollow skips a gate whose earlier merge answer is on record from no owner class", async () => {
    const w = await world();
    await ownerMergedThenMovedUp(w);
    standing.add(w.head);
    const coordinator = JSON.stringify({ class: "coordinator", id: "tc-synthetic", channel: "factory-cli" });
    w.host.db.prepare("UPDATE hitl_gate SET resolved_by = ? WHERE id = ?").run(coordinator, gateId(w, 0));

    const report = await refollowGates(w.host, w.services);

    expect(report.gates).toEqual([]);
    expect(gate(w, 1)?.status).toBe("pending");
  });

  it("refollow does not cancel the same head twice", async () => {
    const w = await world(true);
    standing.add(w.head);
    await ownerMergedThenMovedUp(w);
    await refollowGates(w.host, w.services);
    await vi.waitFor(() => expect(pendingIds(w)).toEqual([gateId(w, 2)]));

    const again = await refollowGates(w.host, w.services);

    expect(again.gates).toEqual([]);
    expect(gate(w, 2)?.status).toBe("pending");
  });

  it("refollow leaves a gate pending on an owner-held run", async () => {
    const w = await world();
    await ownerMergedThenMovedUp(w);
    standing.add(w.head);
    w.store.hold(w.runId, "owner-asked: a synthetic scope question", undefined, { actor: "owner" });

    const report = await refollowGates(w.host, w.services);

    expect(report.gates).toEqual([]);
    expect(gate(w, 1)?.status).toBe("pending");
  });

  it("refollow keeps the head's review: no reviewer is dispatched", async () => {
    const w = await world(true);
    standing.add(w.head);
    await ownerMergedThenMovedUp(w);

    await refollowGates(w.host, w.services);

    await vi.waitFor(() => expect(pendingIds(w)).toEqual([gateId(w, 2)]));
    expect(stepsOf(w, REVIEW)).toHaveLength(2);
  });

  it("refollow skips a gate whose head is no longer the PR head", async () => {
    const w = await world();
    await ownerMergedThenMovedUp(w);
    standing.add(w.head);
    w.gh.pushHead(1, fakeSha("refollow-later"));

    const report = await refollowGates(w.host, w.services, { dryRun: true });

    expect(report.gates).toEqual([]);
    expect(gate(w, 1)?.status).toBe("pending");
  });
});
