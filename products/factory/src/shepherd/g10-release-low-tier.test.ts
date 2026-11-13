import { fakeGitHub, fakeSha, githubPort } from "@titan-design/github";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { partialFake } from "@titan-design/test-kit";
import type { RoutedStepInput, StepRoute } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { fakeLocator } from "../test-support/fakes.js";
import { shepherdEventMigration } from "./events.js";
import { LOW_TIER_RULE, g10ReleaseRoutes, satisfiesG10, type G10Verdict } from "./g10-release.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { holdSlotsMigration } from "./store-migrations.js";
import { ShepherdStore, holdReviewerMigration, holdSatisfiedMigration, lineageMigration, shepherdMigration, sliceMigration } from "./store.js";

const REPO = "octo/demo";
const HEAD = fakeSha("low-tier-head-1");
const PUSHED = fakeSha("low-tier-head-2");
const LOW_TIER_HOLD = "g10-review: low-tier policy touch (hold-closure)";

const mergeAt = (head: string): G10Verdict => ({ value: "MERGE", head, reviewer: { agentId: "rev-1", sessionId: "s-1" }, locator: fakeLocator({ source: { conversation: { nativeId: "s-1" } } }) });
const green = (head: string) => ({ head, green: true });

/** A run Shepherd held g10-review at registration, with the PR now at `prHead`. */
function rig(prHead = HEAD) {
  const db = openDatabase(":memory:");
  runMigrations(db, [shepherdMigration(4), lineageMigration(5), sliceMigration(8), holdReviewerMigration(9), holdSatisfiedMigration(11), shepherdEventMigration(16), holdSlotsMigration(19)]);
  const store = new ShepherdStore(db);
  const fake = fakeGitHub({ repo: REPO });
  const { number: pr } = fake.addPr({ headSha: prHead });
  store.register({ repo: REPO, pr, runId: "run-1", task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY });
  store.hold("run-1", LOW_TIER_HOLD, undefined, { actor: "shepherd" });
  const deps = Object.assign(partialFake<Parameters<typeof g10ReleaseRoutes>[0]>(), { port: githubPort(fake.wire), store: { get: () => store }, now: () => 0 });
  return { store, pr, route: g10ReleaseRoutes(deps)[0]! };
}

const Released = z.looseObject({ released: z.boolean(), head: z.string(), rule: z.string().optional(), reviewerProfile: z.string().optional(), verdict: z.unknown().optional() });

async function runStep(route: StepRoute, input: unknown): Promise<z.infer<typeof Released>> {
  const result = await route.runner.run(partialFake<RoutedStepInput>({ prompt: JSON.stringify(input), signal: new AbortController().signal }));
  if (!result.ok) throw new Error(result.error);
  return Released.parse(JSON.parse(result.output).result);
}

interface Ask {
  verdictHead?: string;
  checksHead?: string;
  profile?: string;
}

const ask = (pr: number, { verdictHead = HEAD, checksHead = HEAD, profile = "bd-reviewer" }: Ask = {}) => ({
  ...{ runId: "run-1", repo: REPO, pr, head: HEAD },
  ...{ verdict: mergeAt(verdictHead), reviewerProfile: profile, checks: green(checksHead) },
});

describe("releasing a low-tier policy hold", () => {
  it("a low-tier hold releases on one opus MERGE at the fresh PR head with green checks", async () => {
    const { store, pr, route } = rig();

    const done = await runStep(route, ask(pr));

    expect(done).toMatchObject({ released: true, head: HEAD, rule: LOW_TIER_RULE, reviewerProfile: "bd-reviewer", verdict: { reviewer: { agentId: "rev-1" } } });
    expect(store.byRun("run-1")?.held).toBe(false);
    expect(store.eventsOf("run-1").at(-1)).toMatchObject({ kind: "release", reason: LOW_TIER_HOLD, actor: "shepherd", headSha: HEAD });
  });

  it("a MERGE from a non-opus profile does not release it", async () => {
    const { store, pr, route } = rig();

    expect((await runStep(route, ask(pr, { profile: "reviewer" }))).released).toBe(false);
    expect(store.byRun("run-1")?.held).toBe(true);
  });

  it("a MERGE at the previous head does not release it after a push", async () => {
    const { store, pr, route } = rig(PUSHED);

    expect((await runStep(route, ask(pr, { checksHead: PUSHED }))).released).toBe(false);
    expect(store.byRun("run-1")?.held).toBe(true);
  });

  it("green checks at another head do not release it", async () => {
    const { store, pr, route } = rig();

    expect((await runStep(route, ask(pr, { checksHead: PUSHED }))).released).toBe(false);
    expect(store.byRun("run-1")?.held).toBe(true);
  });

  it("a hold naming a reviewer does not release itself", async () => {
    const { store, pr, route } = rig();
    store.hold("run-1", LOW_TIER_HOLD, "seat-reviewer", { actor: "seat" });

    expect((await runStep(route, ask(pr))).released).toBe(false);
    expect(store.byRun("run-1")).toMatchObject({ held: true, holdReviewer: "seat-reviewer" });
  });

  it("a carried or external verdict with no profile does not release it", () => {
    const run = { held: true, holdReason: LOW_TIER_HOLD, recorded: true };

    expect([satisfiesG10(run, mergeAt(HEAD), HEAD, green(HEAD), undefined), satisfiesG10(run, mergeAt(HEAD), HEAD, green(HEAD), "bd-reviewer")]).toEqual([false, true]);
  });
});
