import type { AgentRow } from "@titan-design/agent-dispatch";
import { fakeGitHub, fakeSha, githubPort, type PrFile } from "@titan-design/github";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import type { StepRoute } from "@titan-design/workflow";
import { describe, expect, it, vi } from "vitest";
import { holdSlotsMigration } from "./store-migrations.js";
import { adversaryRehold } from "./adversary-anchor.js";
import { shepherdEventMigration } from "./events.js";
import { G10_RELEASE_STEP, TWO_MERGE_RULE, g10Recheck, g10ReleaseRoutes, holdClassOf, isOpusProfile, releaseG10Hold, satisfiesG10, satisfiesTwoMerge, withReviewerProfile, type G10Verdict, type TwoMergeMode } from "./g10-release.js";
import type { CiSnapshot } from "../workflows/land.js";
import type { PanelMember, Verdict } from "./phases.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import type { LineageRow } from "./reviewer-lineage.js";
import type { RosterReader } from "./roster.js";
import { ShepherdStore, holdReviewerMigration, holdSatisfiedMigration, lineageMigration, shepherdMigration, sliceMigration } from "./store.js";
import { readPath } from "../narrow.js";
import { partialFake } from "@titan-design/test-kit";
import { z } from "zod";
import { fakeLocator } from "../test-support/fakes.js";
import type { WorkflowContext } from "@titan-design/workflow";
import type { RoutedStepInput } from "@titan-design/workflow";

const REPO = "octo/demo";
const HEAD = fakeSha("head-1");
const MOVED = fakeSha("head-2");

const held = (reason: string | null, recorded = true) => ({ held: reason !== null, holdReason: reason, recorded });
const mergeAt = (head: string): G10Verdict => ({ value: "MERGE", head, reviewer: { agentId: "a-1", sessionId: "s-1" }, locator: fakeLocator({ source: { conversation: { nativeId: "s-1" } } }) });
const green = (head: string) => ({ head, green: true });

describe("satisfiesG10", () => {
  it("releases a g10-review hold on an opus MERGE at the PR's head with green checks", () => {
    expect(satisfiesG10(held("g10-review: auth change; TP-1"), mergeAt(HEAD), HEAD, green(HEAD), "bd-reviewer")).toBe(true);
  });

  it("keeps the hold on a FIX_FIRST", () => {
    expect(satisfiesG10(held("g10-review: x"), { ...mergeAt(HEAD), value: "FIX_FIRST" }, HEAD, green(HEAD), "bd-reviewer")).toBe(false);
  });

  it("keeps the hold when the verdict is for a head the PR has left", () => {
    expect(satisfiesG10(held("g10-review: x"), mergeAt(HEAD), MOVED, green(MOVED), "bd-reviewer")).toBe(false);
  });

  it("keeps the hold when the checks were read at another head", () => {
    expect(satisfiesG10(held("g10-review: x"), mergeAt(HEAD), HEAD, green(MOVED), "bd-reviewer")).toBe(false);
  });

  it("keeps the hold while the checks are not green", () => {
    expect(satisfiesG10(held("g10-review: x"), mergeAt(HEAD), HEAD, { head: HEAD, green: false }, "bd-reviewer")).toBe(false);
  });

  it.each(["g10-adversary: authority PR; TP-1", "awaiting a named review", "g10-review-extra: x", "freeze: main red", "  g10-review: x", "g10-review : x", " g10-review: x"])("keeps a %s hold", (reason) => {
    expect(satisfiesG10(held(reason), mergeAt(HEAD), HEAD, green(HEAD), "bd-reviewer")).toBe(false);
  });

  it("keeps the hold when the configured profile is not an opus profile", () => {
    expect(satisfiesG10(held("g10-review: x"), mergeAt(HEAD), HEAD, green(HEAD), "reviewer")).toBe(false);
    expect(satisfiesG10(held("g10-review: x"), mergeAt(HEAD), HEAD, green(HEAD), undefined)).toBe(false);
  });

  it("keeps a g10-review hold with no hold event on record: the owner may have assigned that review", () => {
    expect(satisfiesG10(held("g10-review: x", false), mergeAt(HEAD), HEAD, green(HEAD), "bd-reviewer")).toBe(false);
  });

  it("keeps a g10-review hold that names the person the review was assigned to", () => {
    expect(satisfiesG10({ ...held("g10-review: x"), holdReviewer: "seat-reviewer" }, mergeAt(HEAD), HEAD, green(HEAD), "bd-reviewer")).toBe(false);
  });

  it("keeps an owner-review hold", () => {
    expect(satisfiesG10(held("owner-review: assigned to a seat reviewer"), mergeAt(HEAD), HEAD, green(HEAD), "bd-reviewer")).toBe(false);
  });

  it("has nothing to release on a run that is not held", () => {
    expect(satisfiesG10(held(null), mergeAt(HEAD), HEAD, green(HEAD), "bd-reviewer")).toBe(false);
  });
});

describe("hold classes and opus profiles", () => {
  it("reads the class as the text before the first colon", () => {
    expect([holdClassOf("g10-adversary: a: b"), holdClassOf("no class"), holdClassOf(null)]).toEqual(["g10-adversary", undefined, undefined]);
  });

  it("knows bd-reviewer and any profile named for opus", () => {
    expect([isOpusProfile("bd-reviewer"), isOpusProfile("rv-opus"), isOpusProfile("reviewer"), isOpusProfile("opusless")]).toEqual([true, true, false, false]);
  });
});

function rig(reason: string, prHead = HEAD, actor?: string, files: PrFile[] = []) {
  const db = openDatabase(":memory:");
  runMigrations(db, [shepherdMigration(4), lineageMigration(5), sliceMigration(8), holdReviewerMigration(9), holdSatisfiedMigration(11), shepherdEventMigration(16), holdSlotsMigration(19)]);
  const store = new ShepherdStore(db);
  const fake = fakeGitHub({ repo: REPO });
  const { number: pr } = fake.addPr({ headSha: prHead });
  fake.prFiles.set(pr, files);
  store.register({ repo: REPO, pr, runId: "run-1", task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY });
  store.hold("run-1", reason, undefined, actor === undefined ? {} : { actor });
  const deps = Object.assign(partialFake<Parameters<typeof g10ReleaseRoutes>[0]>(), { port: githubPort(fake.wire), store: { get: () => store }, now: () => 0 });
  return { store, pr, deps };
}

async function runStep(route: StepRoute, input: unknown): Promise<{ released: boolean; head: string; verdict?: unknown }> {
  const result = await route.runner.run(partialFake<RoutedStepInput>({ prompt: JSON.stringify(input), signal: new AbortController().signal }));
  if (!result.ok) throw new Error(result.error);
  return z.looseObject({ released: z.boolean(), head: z.string(), verdict: z.unknown().optional() }).parse(JSON.parse(result.output).result);
}

const stepInput = (pr: number, head: string, verdictHead = head) => ({ runId: "run-1", repo: REPO, pr, head, verdict: mergeAt(verdictHead), reviewerProfile: "bd-reviewer", checks: green(head) });

describe(G10_RELEASE_STEP, () => {
  it("releases the hold and records the verdict ref", async () => {
    const { store, pr, deps } = rig("g10-review: auth; TP-1");
    const done = await runStep(g10ReleaseRoutes(deps)[0]!, stepInput(pr, HEAD));
    expect(done).toMatchObject({ released: true, head: HEAD, verdict: { reviewer: { agentId: "a-1" }, locator: { source: { conversation: { nativeId: "s-1" } } } } });
    expect(store.byRun("run-1")?.held).toBe(false);
  });

  it("keeps the hold when the PR's head moved after the verdict was read", async () => {
    const { store, pr, deps } = rig("g10-review: auth; TP-1", MOVED);
    const done = await runStep(g10ReleaseRoutes(deps)[0]!, stepInput(pr, HEAD));
    expect(done.released).toBe(false);
    expect(store.byRun("run-1")?.held).toBe(true);
  });

  it("releases a g10-review hold a seat placed with no reviewer, as before", async () => {
    const { store, pr, deps } = rig("g10-review: auth; TP-1", HEAD, "seat");
    const done = await runStep(g10ReleaseRoutes(deps)[0]!, stepInput(pr, HEAD));
    expect(done.released).toBe(true);
    expect(store.byRun("run-1")?.held).toBe(false);
  });

  it("keeps a g10-review hold that names an assigned reviewer", async () => {
    const { store, pr, deps } = rig("g10-review: auth; TP-1");
    store.hold("run-1", "g10-review: auth; TP-1", "seat-reviewer", { actor: "seat" });
    const done = await runStep(g10ReleaseRoutes(deps)[0]!, stepInput(pr, HEAD));
    expect(done.released).toBe(false);
    expect(store.byRun("run-1")).toMatchObject({ held: true, holdReviewer: "seat-reviewer" });
  });

  it("keeps a g10-review hold when the hold history cannot be read", async () => {
    const { store, pr, deps } = rig("g10-review: auth; TP-1");
    vi.spyOn(store, "eventsOf").mockImplementation(() => {
      throw new Error("database is locked");
    });
    const done = await runStep(g10ReleaseRoutes(deps)[0]!, stepInput(pr, HEAD));
    expect(done.released).toBe(false);
    expect(store.byRun("run-1")?.held).toBe(true);
  });

  it("keeps a g10-adversary hold", async () => {
    const { store, pr, deps } = rig("g10-adversary: authority; TP-1");
    const done = await runStep(g10ReleaseRoutes(deps)[0]!, stepInput(pr, HEAD));
    expect(done.released).toBe(false);
    expect(store.byRun("run-1")?.held).toBe(true);
  });
});

describe("a re-hold while the PR head is read", () => {
  it("is not released: the release swaps only the hold it judged", async () => {
    const { store, pr, deps } = rig("g10-review: auth; TP-1");
    const reholding = { ...deps, port: { ...deps.port, getPr: async (...args: Parameters<typeof deps.port.getPr>) => (store.hold("run-1", "g10-adversary: x"), deps.port.getPr(...args)) } };
    const done = await runStep(g10ReleaseRoutes(reholding)[0]!, stepInput(pr, HEAD));
    expect(done.released).toBe(false);
    expect(store.byRun("run-1")).toMatchObject({ held: true, holdReason: "g10-adversary: x" });
  });
});

describe("which reviewer's verdict releases", () => {
  it("refuses a verdict whose spawned profile is not opus, or that carries none", () => {
    const verdict = mergeAt(HEAD);
    expect([satisfiesG10(held("g10-review: x"), verdict, HEAD, green(HEAD), "reviewer"), satisfiesG10(held("g10-review: x"), verdict, HEAD, green(HEAD), undefined)]).toEqual([false, false]);
  });

  it("marks only a MERGE with the profile it was spawned with", () => {
    const merge = { kind: "MERGE", headSha: HEAD, evidence: null } as const;
    expect(withReviewerProfile(merge, "bd-reviewer")).toMatchObject({ reviewerProfile: "bd-reviewer" });
    expect(withReviewerProfile(merge, undefined)).not.toHaveProperty("reviewerProfile");
    expect(withReviewerProfile({ kind: "FIX_FIRST", headSha: HEAD, text: "" }, "bd-reviewer")).not.toHaveProperty("reviewerProfile");
  });
});

/** A run whose CI read green at `ciHead` and whose release step answers `result`; only the fields releaseG10Hold reads are filled. */
function stubRun(reviews: [string, Verdict][], ciHead: string, result: object, historyNext: () => string | undefined = () => undefined) {
  const dispatch = vi.fn(async (_id: string, _kind: string, _input: { vars: Record<string, string> }) => ({ data: { result } }));
  const ctx = Object.assign(partialFake<WorkflowContext>(), { runId: "run-1", iteration: () => 0, historyNext, dispatch });
  const asked = (): unknown => JSON.parse(Object.values(dispatch.mock.calls[0]![2].vars)[0]!);
  return { dispatch, asked, run: { ctx, target: { repo: REPO, pr: 1 }, reviews: new Map(reviews), lastCi: partialFake<CiSnapshot>({ headSha: ciHead, verdict: "green" }) } };
}

function workflowRun(reviewerProfile: string | undefined, released = true, historyNext?: () => string | undefined) {
  const evidence = { record: { head: HEAD, verdictLocator: mergeAt(HEAD).locator, reviewer: { agentId: "a-1", sessionId: "s-1" } } };
  const merge: Verdict = { kind: "MERGE", headSha: HEAD, evidence, ...(reviewerProfile && { reviewerProfile }) };
  return stubRun([[HEAD, merge]], HEAD, { released, head: HEAD }, historyNext);
}

/** The recorded release step a replay is about to read back. */
const replaying = () => `${G10_RELEASE_STEP}:${HEAD}:0`;
const recheck = g10Recheck(() => ({ byPr: () => ({ runId: "run-1" }) }));

describe("releaseG10Hold", () => {
  it("asks for a release once for a verdict, so a re-hold at the same head waits for a newer one", async () => {
    const { dispatch, run } = workflowRun("bd-reviewer");
    await releaseG10Hold(run, "g10-review: x");
    await releaseG10Hold(run, "g10-review: x");
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("asks again after an attempt that released nothing", async () => {
    const { dispatch, run } = workflowRun("bd-reviewer", false);
    await releaseG10Hold(run, "g10-review: x");
    await releaseG10Hold(run, "g10-review: x");
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("asks for nothing on a verdict with no spawned profile, a non-opus profile, or under another class", async () => {
    const external = workflowRun(undefined);
    await releaseG10Hold(external.run, "g10-review: x");
    const sonnet = workflowRun("reviewer");
    await releaseG10Hold(sonnet.run, "g10-review: x");
    const adversary = workflowRun("bd-reviewer");
    await releaseG10Hold(adversary.run, "g10-adversary: x");
    expect([external.dispatch, sonnet.dispatch, adversary.dispatch].map((d) => d.mock.calls.length)).toEqual([0, 0, 0]);
  });
});

describe("the merge wait's recheck after a replayed release answer (TP-3956)", () => {
  it("ends the wait once, at the head of a replayed ask that released nothing", async () => {
    await releaseG10Hold(workflowRun("bd-reviewer", false, replaying).run, "g10-review: x");

    expect([recheck(REPO, 1, MOVED), recheck(REPO, 1, HEAD), recheck(REPO, 1, HEAD)]).toEqual([false, true, false]);
  });

  it.each([
    ["a live ask released nothing", false, undefined],
    ["a replayed ask released the hold", true, replaying],
  ])("ends no wait when %s", async (_case, released, historyNext) => {
    await releaseG10Hold(workflowRun("bd-reviewer", released, historyNext).run, "g10-review: x");

    expect(recheck(REPO, 1, HEAD)).toBe(false);
  });

  it("drops a replayed refusal once the run asks live again", async () => {
    await releaseG10Hold(workflowRun("bd-reviewer", false, replaying).run, "g10-review: x");
    await releaseG10Hold(workflowRun("bd-reviewer", false).run, "g10-review: x");

    expect(recheck(REPO, 1, HEAD)).toBe(false);
  });
});

describe("a release at a clean merge-up of the reviewed head", () => {
  const mergeUp = { fromHead: HEAD, head: MOVED };
  const upInput = (pr: number, extra: object = {}) => ({ ...stepInput(pr, MOVED, HEAD), mergeUp, ...extra });

  it("releases at the moved head on the opus MERGE written at the reviewed head", async () => {
    const { store, pr, deps } = rig("g10-review: auth; TP-1", MOVED);
    const done = await runStep(g10ReleaseRoutes(deps)[0]!, upInput(pr));
    expect(done).toMatchObject({ released: true, head: MOVED, verdict: { head: HEAD } });
    expect(store.byRun("run-1")?.held).toBe(false);
  });

  it.each([
    ["the merge-up is from another head", { mergeUp: { fromHead: fakeSha("other"), head: MOVED } }],
    ["the merge-up is to another head than the PR's", { mergeUp: { fromHead: HEAD, head: fakeSha("other") } }],
    ["the checks at the moved head are not green", { checks: { head: MOVED, green: false } }],
  ])("keeps the hold when %s", async (_case, extra) => {
    const { store, pr, deps } = rig("g10-review: auth; TP-1", MOVED);
    const done = await runStep(g10ReleaseRoutes(deps)[0]!, upInput(pr, extra));
    expect(done.released).toBe(false);
    expect(store.byRun("run-1")?.held).toBe(true);
  });

  it("keeps a g10-adversary hold", async () => {
    const { store, pr, deps } = rig("g10-adversary: authority; TP-1", MOVED);
    const done = await runStep(g10ReleaseRoutes(deps)[0]!, upInput(pr));
    expect(done.released).toBe(false);
    expect(store.byRun("run-1")?.held).toBe(true);
  });

  function mergeUpRun(mark: string | undefined) {
    const dispatch = vi.fn(async (_id: string, _kind: string, _input: { vars: Record<string, string> }) => ({ data: { result: { released: true, head: MOVED } } }));
    const evidence = { record: { head: HEAD, verdictLocator: mergeAt(HEAD).locator, reviewer: { agentId: "a-1", sessionId: "s-1" } } };
    const reviewed = { kind: "MERGE" as const, headSha: HEAD, evidence, reviewerProfile: "bd-reviewer" };
    const carried = { kind: "MERGE" as const, headSha: MOVED, evidence: { record: { head: MOVED, carry: { fromHead: HEAD } } }, ...(mark && { mergeUpFrom: mark }) };
    const ctx = Object.assign(partialFake<WorkflowContext>(), { runId: "run-1", iteration: () => 0, historyNext: () => undefined, dispatch });
    return { dispatch, run: { ctx, target: { repo: REPO, pr: 1 }, reviews: new Map<string, Verdict>([[HEAD, reviewed], [MOVED, carried]]), lastCi: partialFake<CiSnapshot>({ headSha: MOVED, verdict: "green" }) } };
  }

  it("asks for a release at the moved head with the reviewed head's verdict ref and profile", async () => {
    const { dispatch, run } = mergeUpRun(HEAD);
    await releaseG10Hold(run, "g10-review: x");
    const vars = z.record(z.string(), z.string()).parse(readPath(dispatch.mock.calls[0]?.[2], "vars"));
    expect(JSON.parse(Object.values(vars)[0]!)).toMatchObject({ head: MOVED, verdict: { head: HEAD }, reviewerProfile: "bd-reviewer", mergeUp: { fromHead: HEAD, head: MOVED }, checks: { head: MOVED, green: true } });
  });

  it("asks for nothing on a carried MERGE that is not a clean merge-up, or under a g10-adversary hold", async () => {
    const unmarked = mergeUpRun(undefined);
    await releaseG10Hold(unmarked.run, "g10-review: x");
    const adversary = mergeUpRun(HEAD);
    await releaseG10Hold(adversary.run, "g10-adversary: x");
    expect([unmarked.dispatch, adversary.dispatch].map((d) => d.mock.calls.length)).toEqual([0, 0]);
  });

  describe("when CI reads behind with the head's own checks green", () => {
    const behindAt = (headSha: string, checksGreen: boolean): CiSnapshot => ({ headSha, verdict: "behind", mergeableState: "behind", ...(checksGreen && { checksGreen }) });
    const askedInput = (dispatch: ReturnType<typeof mergeUpRun>["dispatch"]): unknown => JSON.parse(Object.values(dispatch.mock.calls[0]![2].vars)[0]!);

    it("releases the hold at the moved head on the MERGE written at the reviewed head", async () => {
      const { dispatch, run } = mergeUpRun(HEAD);
      const { store, deps } = rig("g10-review: auth; TP-1", MOVED);

      await releaseG10Hold({ ...run, lastCi: behindAt(MOVED, true) }, "g10-review: auth; TP-1");
      const done = await runStep(g10ReleaseRoutes(deps)[0]!, askedInput(dispatch));

      expect(done).toMatchObject({ released: true, head: MOVED, verdict: { head: HEAD } });
      expect(store.byRun("run-1")?.held).toBe(false);
    });

    it("keeps the hold when the behind read's own checks are not green", async () => {
      const { dispatch, run } = mergeUpRun(HEAD);
      const { store, deps } = rig("g10-review: auth; TP-1", MOVED);

      await releaseG10Hold({ ...run, lastCi: behindAt(MOVED, false) }, "g10-review: auth; TP-1");
      const done = await runStep(g10ReleaseRoutes(deps)[0]!, askedInput(dispatch));

      expect(done.released).toBe(false);
      expect(store.byRun("run-1")?.held).toBe(true);
    });

    it("asks with checks not green at a reviewed head that is itself behind, which waits for its update", async () => {
      const { dispatch, run } = mergeUpRun(HEAD);

      await releaseG10Hold({ ...run, lastCi: behindAt(HEAD, true) }, "g10-review: auth; TP-1");

      expect(askedInput(dispatch)).toMatchObject({ head: HEAD, checks: { head: HEAD, green: false } });
    });

    it("asks for nothing when the carry was not a recorded clean merge-up", async () => {
      const { dispatch, run } = mergeUpRun(undefined);

      await releaseG10Hold({ ...run, lastCi: behindAt(MOVED, true) }, "g10-review: auth; TP-1");

      expect(dispatch).not.toHaveBeenCalled();
    });
  });
});

describe("the g10-adversary/two-merge release (decision 422(1))", () => {
  const ADVERSARY_HOLD = "g10-adversary: policy touch";
  const OWNER_RULE_FILE = "packages/authority/src/table.json";
  const by = (head: string, sessionId: string): G10Verdict => ({ ...mergeAt(head), reviewer: { agentId: `agent-${sessionId}`, sessionId } });
  const merges = (head: string, adversary: Partial<{ profile: string; sessionId: string; value: string }> = {}, correctnessProfile = "bd-reviewer") => ({
    correctness: { verdict: by(head, "s-correctness"), profile: correctnessProfile },
    adversary: { verdict: { ...by(head, adversary.sessionId ?? "s-adversary"), value: adversary.value ?? "MERGE" }, profile: adversary.profile ?? "fable-reviewer" },
  });
  const twoInput = (pr: number, head: string, extra: object = {}) => ({ runId: "run-1", repo: REPO, pr, head, rule: TWO_MERGE_RULE, ...merges(head), checks: green(head), ...extra });
  const row = (sessionId: string, name: string, extra: Partial<LineageRow> = {}): AgentRow => ({
    ...{ name, agentId: `agent-${sessionId}`, sessionId, spawnedBy: "human", teleportFrom: null },
    ...{ state: "exited", presence: "exited", status: "finished", profile: "bd-reviewer", surface: "headless", cwd: "/work", generation: 1 },
    ...extra,
  });
  const SPAWNED = [row("s-correctness", "rv-demo-1"), row("s-adversary", "rv-demo-1-adversary")];
  const rosterOf = (rows: readonly AgentRow[] | "unread"): RosterReader => ({
    read: async () => (rows === "unread" ? { kind: "unknown", error: new Error("broker down") } : { kind: "known", rows }),
    rows: async () => (rows === "unread" ? [] : rows),
    invalidate: () => undefined,
  });

  function twoRig(prHead = HEAD, files: PrFile[] = [{ path: "src/policy.ts", status: "modified" }], rows: readonly AgentRow[] | "unread" = SPAWNED) {
    const rigged = rig(ADVERSARY_HOLD, prHead, "shepherd", files);
    const deps = { ...rigged.deps, roster: rosterOf(rows) };
    return { ...rigged, deps, route: (mode?: TwoMergeMode) => g10ReleaseRoutes(deps, mode)[0]! };
  }

  describe("satisfiesTwoMerge", () => {
    const run = { ...held(ADVERSARY_HOLD), holdReviewer: null };
    const files = ["src/policy.ts"];

    it("releases only when the adversary says MERGE as well as the correctness reviewer", () => {
      expect(satisfiesTwoMerge(run, merges(HEAD), HEAD, green(HEAD), files, SPAWNED)).toBe(true);
      expect(satisfiesTwoMerge(run, merges(HEAD, { value: "FIX_FIRST" }), HEAD, green(HEAD), files, SPAWNED)).toBe(false);
    });

    it("releases two MERGEs at the same opus profile from separately spawned sessions (decision 457)", () => {
      expect(satisfiesTwoMerge(run, merges(HEAD, { profile: "bd-reviewer" }), HEAD, green(HEAD), files, SPAWNED)).toBe(true);
    });

    it("refuses a correctness MERGE from a profile that is not opus", () => {
      expect(satisfiesTwoMerge(run, merges(HEAD, { profile: "bd-reviewer" }, "reviewer"), HEAD, green(HEAD), files, SPAWNED)).toBe(false);
    });

    it("refuses when the roster was not read", () => {
      expect(satisfiesTwoMerge(run, merges(HEAD, { profile: "bd-reviewer" }), HEAD, green(HEAD), files, undefined)).toBe(false);
    });

    it("refuses a g10-review hold, which its own rule releases", () => {
      expect(satisfiesTwoMerge({ ...run, holdReason: "g10-review: 900 changed lines" }, merges(HEAD), HEAD, green(HEAD), files, SPAWNED)).toBe(false);
    });
  });

  it("releases at H on both MERGEs and green CI, with no seat, and records both sessions, both profiles and the rule (tp#1355 replay)", async () => {
    const { store, pr, route } = twoRig();

    const done = await runStep(route("on"), twoInput(pr, HEAD));

    expect(done).toMatchObject({
      released: true,
      head: HEAD,
      rule: TWO_MERGE_RULE,
      correctness: { profile: "bd-reviewer", verdict: { reviewer: { sessionId: "s-correctness" } } },
      adversary: { profile: "fable-reviewer", verdict: { reviewer: { sessionId: "s-adversary" } } },
    });
    expect(store.byRun("run-1")?.held).toBe(false);
    expect(store.eventsOf("run-1").at(-1)).toMatchObject({ kind: "release", actor: "shepherd", headSha: HEAD, reason: ADVERSARY_HOLD });
  });

  it.each([
    ["the diff changes the owner's rule file", { path: OWNER_RULE_FILE, status: "modified" }],
    ["the diff renames the owner's rule file away", { path: "packages/authority/src/table.old.json", previousPath: OWNER_RULE_FILE, status: "renamed" }],
  ])("stays held when %s", async (_case, file) => {
    const { store, pr, route } = twoRig(HEAD, [{ path: "src/policy.ts", status: "modified" }, file]);

    const done = await runStep(route("on"), twoInput(pr, HEAD));

    expect(done.released).toBe(false);
    expect(store.byRun("run-1")?.held).toBe(true);
  });

  it("releases on MERGEs from two separately spawned bd-reviewer sessions (decision 457)", async () => {
    const { store, pr, route } = twoRig();

    const done = await runStep(route("on"), twoInput(pr, HEAD, merges(HEAD, { profile: "bd-reviewer" })));

    expect(done).toMatchObject({ released: true, correctness: { profile: "bd-reviewer" }, adversary: { profile: "bd-reviewer" } });
    expect(store.byRun("run-1")?.held).toBe(false);
  });

  const sameProfile = (sessionId?: string) => merges(HEAD, { profile: "bd-reviewer", ...(sessionId !== undefined && { sessionId }) });
  it.each([
    ["one session", sameProfile("s-correctness"), SPAWNED],
    ["an adversary forked from the correctness reviewer's context", sameProfile(), [SPAWNED[0]!, row("s-adversary", "rv-demo-1-adversary", { spawnedBy: "rv-demo-1" })]],
    ["a correctness reviewer forked from the adversary's context", sameProfile(), [row("s-correctness", "rv-demo-1", { spawnedBy: "rv-demo-1-adversary" }), SPAWNED[1]!]],
    ["two forks of one session", sameProfile(), [row("s-correctness", "rv-demo-1", { spawnedBy: "seat" }), row("s-adversary", "rv-demo-1-adversary", { spawnedBy: "seat" }), row("s-seat", "seat")]],
    ["an adversary that resumed the correctness reviewer's transcript", sameProfile(), [SPAWNED[0]!, SPAWNED[1]!, row("s-correctness", "rv-demo-1-adversary", { agentId: "agent-resumed" })]],
    ["an adversary that took the correctness reviewer over", sameProfile(), [SPAWNED[0]!, row("s-adversary", "rv-demo-1-adversary", { teleportFrom: "agent-s-correctness" })]],
    ["an adversary teleported from an agent the roster does not hold", sameProfile(), [SPAWNED[0]!, row("s-adversary", "rv-demo-1-adversary", { teleportFrom: "agent-gone" })]],
    ["an adversary whose name a fork of the correctness reviewer held in another generation", sameProfile(), [...SPAWNED, row("s-gen-2", "rv-demo-1-adversary", { agentId: "agent-gen-2", spawnedBy: "rv-demo-1" })]],
    ["an adversary whose session a fork of the correctness reviewer continues", sameProfile(), [...SPAWNED, row("s-adversary", "rv-fork", { agentId: "agent-fork", spawnedBy: "rv-demo-1" })]],
    [
      "an adversary whose spawning agent, under another name, was forked from the correctness reviewer",
      sameProfile(),
      [SPAWNED[0]!, row("s-adversary", "rv-demo-1-adversary", { spawnedBy: "seat" }), row("s-seat", "seat"), row("s-seat-2", "seat-renamed", { agentId: "agent-s-seat", spawnedBy: "rv-demo-1" })],
    ],
    ["an adversary spawned by a session the roster does not hold", sameProfile(), [SPAWNED[0]!, row("s-adversary", "rv-demo-1-adversary", { spawnedBy: "gone-seat" })]],
    ["an adversary the roster does not hold", sameProfile(), [SPAWNED[0]!]],
    ["a roster that could not be read", sameProfile(), "unread" as const],
  ])("stays held on MERGEs from %s", async (_case, extra, rows) => {
    const { store, pr, route } = twoRig(HEAD, undefined, rows);

    const done = await runStep(route("on"), twoInput(pr, HEAD, extra));

    expect(done.released).toBe(false);
    expect(store.byRun("run-1")?.held).toBe(true);
  });

  it("releases at H′ when Shepherd's recorded clean merge-up carried both MERGEs from H", async () => {
    const { store, pr, route } = twoRig(MOVED);

    const done = await runStep(route("on"), { ...twoInput(pr, MOVED), ...merges(HEAD), mergeUp: { fromHead: HEAD, head: MOVED } });

    expect(done).toMatchObject({ released: true, head: MOVED });
    expect(store.eventsOf("run-1").at(-1)).toMatchObject({ kind: "release", headSha: MOVED });
  });

  it("stays held when a seat pushed H′ over MERGEs written at H", async () => {
    const { store, pr, route } = twoRig(MOVED);

    const done = await runStep(route("on"), { ...twoInput(pr, MOVED), ...merges(HEAD) });

    expect(done.released).toBe(false);
    expect(store.byRun("run-1")?.held).toBe(true);
  });

  it("stays held when the hold names a reviewer (418(2))", async () => {
    const { store, pr, route } = twoRig();
    store.hold("run-1", ADVERSARY_HOLD, "seat-reviewer", { actor: "seat" });

    const done = await runStep(route("on"), twoInput(pr, HEAD));

    expect(done.released).toBe(false);
    expect(store.byRun("run-1")).toMatchObject({ held: true, holdReviewer: "seat-reviewer" });
  });

  it("under shadow records a would-release with both refs and leaves the hold in place", async () => {
    const { store, pr, route } = twoRig();

    const done = await runStep(route("shadow"), twoInput(pr, HEAD));

    expect(done).toMatchObject({ released: false, wouldRelease: true, mode: "shadow", rule: TWO_MERGE_RULE, adversary: { profile: "fable-reviewer" } });
    expect(store.byRun("run-1")?.held).toBe(true);
    expect(store.eventsOf("run-1").some((event) => event.kind === "release")).toBe(false);
  });

  it("with the flag off neither releases nor records a would-release", async () => {
    const { store, pr, route } = twoRig();

    const done = await runStep(route(undefined), twoInput(pr, HEAD));

    expect(done).toMatchObject({ released: false, mode: "off" });
    expect(done).not.toHaveProperty("wouldRelease");
    expect(store.byRun("run-1")?.held).toBe(true);
  });

  it("stays held when the PR's file list cannot be read", async () => {
    const { store, pr, deps } = twoRig();
    const unread = { ...deps, port: { ...deps.port, listPrFiles: async () => Promise.reject(new Error("HTTP 502")) } };

    const done = await runStep(g10ReleaseRoutes(unread, "on")[0]!, twoInput(pr, HEAD));

    expect(done.released).toBe(false);
    expect(store.byRun("run-1")?.held).toBe(true);
  });

  it("anchors the adversary line at H: a later head that is not a clean merge-up of H is re-held", async () => {
    const { store, pr, route } = twoRig();
    await runStep(route("on"), twoInput(pr, HEAD));
    const at = (head: string) => ({ head, baseRef: async () => "main" });
    const fixPush = async () => ({ equal: true, base: fakeSha("main"), firstParent: HEAD, headTree: fakeSha("fix-tree"), mergeTree: fakeSha("merge-tree") });

    expect(await adversaryRehold(store, "run-1", at(HEAD), fixPush)).toBeUndefined();
    expect((await adversaryRehold(store, "run-1", at(MOVED), fixPush))?.reason).toContain(`from ${HEAD} to ${MOVED}`);
  });

  describe("releaseG10Hold under a g10-adversary hold", () => {
    const LOCATOR = (sessionId: string) => ({ source: { conversation: { nativeId: sessionId } } });
    const adversaryMember = (head: string, extra: Partial<PanelMember> = {}, profile: string | null = "fable-reviewer"): PanelMember => ({
      ...{ shape: "adversary", agentId: "agent-s-adversary", sessionId: "s-adversary", locator: LOCATOR("s-adversary"), verdict: "MERGE", head },
      ...(profile !== null && { profile }),
      ...extra,
    });
    const panelMergeAt = (head: string, member: PanelMember): Verdict => ({
      kind: "MERGE",
      headSha: head,
      evidence: { record: { head, verdictLocator: LOCATOR("s-correctness"), reviewer: { agentId: "agent-s-correctness", sessionId: "s-correctness" } } },
      reviewerProfile: "bd-reviewer",
      panel: { satisfiesG10: true, degraded: [], members: [member] },
    });
    const adversaryRun = (reviews: [string, Verdict][], ciHead: string, result: object = { released: true, head: ciHead }) => stubRun(reviews, ciHead, result);

    it("asks with the correctness and adversary refs, their profiles and the rule", async () => {
      const { asked, run } = adversaryRun([[HEAD, panelMergeAt(HEAD, adversaryMember(HEAD))]], HEAD);

      await releaseG10Hold(run, ADVERSARY_HOLD);

      expect(asked()).toMatchObject({
        rule: TWO_MERGE_RULE,
        head: HEAD,
        correctness: { profile: "bd-reviewer", verdict: { head: HEAD, reviewer: { sessionId: "s-correctness" } } },
        adversary: { profile: "fable-reviewer", verdict: { head: HEAD, reviewer: { sessionId: "s-adversary" } } },
        checks: { head: HEAD, green: true },
      });
    });

    it("asks at H′ with the merge-up when both MERGEs were carried from H", async () => {
      const carried: Verdict = { kind: "MERGE", headSha: MOVED, evidence: { record: { head: MOVED, carry: { fromHead: HEAD } } }, mergeUpFrom: HEAD };
      const { asked, run } = adversaryRun([[HEAD, panelMergeAt(HEAD, adversaryMember(HEAD))], [MOVED, carried]], MOVED);

      await releaseG10Hold(run, ADVERSARY_HOLD);

      expect(asked()).toMatchObject({ head: MOVED, mergeUp: { fromHead: HEAD, head: MOVED }, adversary: { verdict: { head: HEAD } } });
    });

    it.each([
      ["the adversary said FIX_FIRST", adversaryMember(HEAD, { verdict: "FIX_FIRST" })],
      ["the adversary wrote at another head", adversaryMember(HEAD, { head: MOVED })],
      ["the adversary's spawn profile was not recorded", adversaryMember(HEAD, {}, null)],
      ["only a non-adversary member gave a verdict", adversaryMember(HEAD, { shape: "perf" })],
    ])("asks for nothing when %s", async (_case, member) => {
      const { dispatch, run } = adversaryRun([[HEAD, panelMergeAt(HEAD, member)]], HEAD);

      await releaseG10Hold(run, ADVERSARY_HOLD);

      expect(dispatch).not.toHaveBeenCalled();
    });

    describe("when a non-strict base moved past the reviewed head's green (TP-3933)", () => {
      const staleGreen = (headSha: string, extra: Partial<CiSnapshot>): CiSnapshot => ({ headSha, verdict: "behind", mergeableState: "blocked", checksGreen: true, ...extra });

      it("asks with checks green, as land merges that head as it stands, and the route releases", async () => {
        const { asked, run } = adversaryRun([[HEAD, panelMergeAt(HEAD, adversaryMember(HEAD))]], HEAD);
        const { store, route } = twoRig();

        await releaseG10Hold({ ...run, lastCi: staleGreen(HEAD, { baseMoved: true }) }, ADVERSARY_HOLD);
        const done = await runStep(route("on"), asked());

        expect(asked()).toMatchObject({ checks: { head: HEAD, green: true } });
        expect(done.released).toBe(true);
        expect(store.byRun("run-1")?.held).toBe(false);
      });

      it.each([
        ["a strict base reads it behind", {}],
        ["the head's own checks are not green", { baseMoved: true, checksGreen: false }],
      ])("asks with checks not green when %s", async (_case, extra) => {
        const { asked, run } = adversaryRun([[HEAD, panelMergeAt(HEAD, adversaryMember(HEAD))]], HEAD);

        await releaseG10Hold({ ...run, lastCi: staleGreen(HEAD, extra) }, ADVERSARY_HOLD);

        expect(asked()).toMatchObject({ checks: { head: HEAD, green: false } });
      });
    });

    it("asks once for a shadow would-release, as for a release", async () => {
      const { dispatch, run } = adversaryRun([[HEAD, panelMergeAt(HEAD, adversaryMember(HEAD))]], HEAD, { released: false, wouldRelease: true, head: HEAD });

      await releaseG10Hold(run, ADVERSARY_HOLD);
      await releaseG10Hold(run, ADVERSARY_HOLD);

      expect(dispatch).toHaveBeenCalledTimes(1);
    });
  });
});
