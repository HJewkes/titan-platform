import { fakeGitHub, fakeSha, githubPort } from "@titan-design/github";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import type { StepRoute } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { G10_RELEASE_STEP, g10ReleaseRoutes, holdClassOf, isOpusProfile, satisfiesG10, type G10Verdict } from "./g10-release.js";
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

  it.each(["g10-adversary: authority PR; TP-1", "awaiting a named review", "g10-review-extra: x", "freeze: main red"])("keeps a %s hold", (reason) => {
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

const stepInput = (pr: number, head: string, verdictHead = head) => ({ runId: "run-1", repo: REPO, pr, head, verdict: mergeAt(verdictHead), checks: green(head) });

describe(G10_RELEASE_STEP, () => {
  it("releases the hold and records the verdict ref", async () => {
    const { store, pr, deps } = rig("g10-review: auth; TP-1");
    const done = await runStep(g10ReleaseRoutes(deps, "bd-reviewer")[0]!, stepInput(pr, HEAD));
    expect(done).toMatchObject({ released: true, head: HEAD, verdict: { reviewer: { agentId: "a-1" }, locator: { source: { conversation: { nativeId: "s-1" } } } } });
    expect(store.byRun("run-1")?.held).toBe(false);
  });

  it("keeps the hold when the PR's head moved after the verdict was read", async () => {
    const { store, pr, deps } = rig("g10-review: auth; TP-1", MOVED);
    const done = await runStep(g10ReleaseRoutes(deps, "bd-reviewer")[0]!, stepInput(pr, HEAD));
    expect(done.released).toBe(false);
    expect(store.byRun("run-1")?.held).toBe(true);
  });

  it("keeps a g10-adversary hold", async () => {
    const { store, pr, deps } = rig("g10-adversary: authority; TP-1");
    const done = await runStep(g10ReleaseRoutes(deps, "bd-reviewer")[0]!, stepInput(pr, HEAD));
    expect(done.released).toBe(false);
    expect(store.byRun("run-1")?.held).toBe(true);
  });
});
