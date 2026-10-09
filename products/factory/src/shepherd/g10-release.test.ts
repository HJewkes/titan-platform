import { fakeGitHub, fakeSha, githubPort } from "@titan-design/github";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import type { StepRoute } from "@titan-design/workflow";
import { describe, expect, it, vi } from "vitest";
import { G10_RELEASE_STEP, g10ReleaseRoutes, holdClassOf, isOpusProfile, releaseG10Hold, satisfiesG10, withReviewerProfile, type G10Verdict } from "./g10-release.js";
import type { Verdict } from "./phases.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { ShepherdStore, holdReviewerMigration, holdSatisfiedMigration, lineageMigration, shepherdMigration, sliceMigration } from "./store.js";

const REPO = "octo/demo";
const HEAD = fakeSha("head-1");
const MOVED = fakeSha("head-2");

const held = (reason: string | null) => ({ held: reason !== null, holdReason: reason });
const mergeAt = (head: string): G10Verdict => ({ value: "MERGE", head, reviewer: { agentId: "a-1", sessionId: "s-1" }, locator: { source: { conversation: { nativeId: "s-1" } } } as unknown as G10Verdict["locator"] });
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

function rig(reason: string, prHead = HEAD) {
  const db = openDatabase(":memory:");
  runMigrations(db, [shepherdMigration(4), lineageMigration(5), sliceMigration(8), holdReviewerMigration(9), holdSatisfiedMigration(11)]);
  const store = new ShepherdStore(db);
  const fake = fakeGitHub({ repo: REPO });
  const { number: pr } = fake.addPr({ headSha: prHead });
  store.register({ repo: REPO, pr, runId: "run-1", task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY });
  store.hold("run-1", reason);
  const deps = { port: githubPort(fake.wire), store: { get: () => store }, now: () => 0 } as unknown as Parameters<typeof g10ReleaseRoutes>[0];
  return { store, pr, deps };
}

async function runStep(route: StepRoute, input: object): Promise<{ released: boolean; head: string; verdict?: unknown }> {
  const result = await route.runner.run({ prompt: JSON.stringify(input), signal: new AbortController().signal } as never);
  if (!result.ok) throw new Error(result.error);
  return (JSON.parse(result.output) as { result: { released: boolean; head: string; verdict?: unknown } }).result;
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

function workflowRun(reviewerProfile: string | undefined, released = true) {
  const dispatch = vi.fn(async () => ({ data: { result: { released, head: HEAD } } }));
  const evidence = { record: { head: HEAD, verdictLocator: mergeAt(HEAD).locator, reviewer: { agentId: "a-1", sessionId: "s-1" } } };
  const merge = { kind: "MERGE" as const, headSha: HEAD, evidence, ...(reviewerProfile && { reviewerProfile }) };
  const ctx = { runId: "run-1", iteration: () => 0, dispatch } as never;
  return { dispatch, run: { ctx, target: { repo: REPO, pr: 1 }, reviews: new Map([[HEAD, merge]]), lastCi: { headSha: HEAD, verdict: "green" } as never } };
}

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
    const dispatch = vi.fn(async () => ({ data: { result: { released: true, head: MOVED } } }));
    const evidence = { record: { head: HEAD, verdictLocator: mergeAt(HEAD).locator, reviewer: { agentId: "a-1", sessionId: "s-1" } } };
    const reviewed = { kind: "MERGE" as const, headSha: HEAD, evidence, reviewerProfile: "bd-reviewer" };
    const carried = { kind: "MERGE" as const, headSha: MOVED, evidence: { record: { head: MOVED, carry: { fromHead: HEAD } } }, ...(mark && { mergeUpFrom: mark }) };
    const ctx = { runId: "run-1", iteration: () => 0, dispatch } as never;
    return { dispatch, run: { ctx, target: { repo: REPO, pr: 1 }, reviews: new Map<string, Verdict>([[HEAD, reviewed], [MOVED, carried]]), lastCi: { headSha: MOVED, verdict: "green" } as never } };
  }

  it("asks for a release at the moved head with the reviewed head's verdict ref and profile", async () => {
    const { dispatch, run } = mergeUpRun(HEAD);
    await releaseG10Hold(run, "g10-review: x");
    const vars = (dispatch.mock.calls[0] as unknown as [string, string, { vars: Record<string, string> }])[2].vars;
    expect(JSON.parse(Object.values(vars)[0]!)).toMatchObject({ head: MOVED, verdict: { head: HEAD }, reviewerProfile: "bd-reviewer", mergeUp: { fromHead: HEAD, head: MOVED }, checks: { head: MOVED, green: true } });
  });

  it("asks for nothing on a carried MERGE that is not a clean merge-up, or under a g10-adversary hold", async () => {
    const unmarked = mergeUpRun(undefined);
    await releaseG10Hold(unmarked.run, "g10-review: x");
    const adversary = mergeUpRun(HEAD);
    await releaseG10Hold(adversary.run, "g10-adversary: x");
    expect([unmarked.dispatch, adversary.dispatch].map((d) => d.mock.calls.length)).toEqual([0, 0]);
  });
});
