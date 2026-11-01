import { GITHUB_ACTIONS_APP_ID, fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import { afterEach, describe, expect, it } from "vitest";
import { defineWorkflow } from "../definition.js";
import type { GatePolicy } from "../gate-policy.js";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { authorityGateReason } from "../test-support/authority-reason.js";
import { H1, REPO, landScenario } from "../test-support/land.js";
import { factoryRoutesFor } from "../workflows.js";
import { LAND_STEPS, land, sleep, type AskApproval, type LandOutcome } from "../workflows/land.js";
import { MERGE_MAIN_STEPS, mergeMainFirst, mergeMainRoute } from "./merge-main.js";
import type { ShepherdPhases, WakeRequest } from "./phases.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { shepherdPrWorkflow } from "./pr.js";
import { shepherdStoreRef } from "./store.js";

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

const FORK = fakeSha("fork");
const RULE = { table: "authority", rowId: "MRG-AU", version: 1 };

/**
 * Main moved past the PR's merge base, changing `files`; its tip is the fake's base ref. The repo does not require up-to-date
 * heads, so land merges a behind green head as it stands unless something merges main first.
 */
function mainMovedPast(fake: FakeGitHub, head: string, files: string[]): string {
  const tip = fake.refs.get("main")!;
  fake.rules.strict = false;
  fake.pr(1).behind = true;
  fake.compares.set(`${head}...${tip}`, { mergeBaseSha: FORK, files });
  return tip;
}

/** A failed check outside the required contexts: MRG-AU-RV then lacks only no-non-green-run. */
const nonGreenReason = authorityGateReason(H1, {
  checkRuns: [
    { name: "validate", appId: GITHUB_ACTIONS_APP_ID, headSha: H1, conclusion: "success" },
    { name: "flaky-e2e", appId: GITHUB_ACTIONS_APP_ID, headSha: H1, conclusion: "failure" },
  ],
});

/** Gates H1 with `reason` and allows any other head, as authority does once the head's runs are green. */
const gatingH1 = (reason: string): GatePolicy => ({
  decide: (_action, target) => (target?.headSha === H1 ? { outcome: "gate", rule: RULE, reason } : { outcome: "allow", rule: RULE, reason: "allowed" }),
});

/** `land` with Shepherd's merge-main step wired as it is in shepherd-pr; every approval asked is answered merge. */
function landWithMergeMain(policy: GatePolicy) {
  const scenario = landScenario({ policy });
  const asked: string[] = [];
  const askApproval: AskApproval = async (_ctx, question) => (asked.push(question.headSha), "merge");
  const outcomes: LandOutcome[] = [];
  const options = { policy, askApproval, mergeBaseFirst: mergeMainFirst(REPO) };
  const workflow = defineWorkflow({ name: "land-merge-main", steps: [...LAND_STEPS, ...MERGE_MAIN_STEPS], run: async (ctx) => void outcomes.push(await land(ctx, { repo: REPO, pr: 1 }, options)) });
  const routes = [...scenario.routes, mergeMainRoute({ port: githubPort(scenario.fake.wire), now: scenario.now })];
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [workflow], routes, gatePollMs: 5 });
  hosts.push(host);
  return { fake: scenario.fake, host, asked, outcomes, start: () => host.runtime.start("land-merge-main") };
}

describe("Shepherd merges main itself when a green PR's guard files are older than main's", () => {
  it("merges main into the head before deciding, and decides only the merged head", async () => {
    const world = landWithMergeMain(gatingH1("owner gate"));
    mainMovedPast(world.fake, H1, ["src/other.ts", "scripts/stage-version-guard.mjs"]);

    await world.host.runtime.wait(world.start());

    const merged = world.fake.pr(1).headSha;
    expect(world.fake.effects.updateBranch).toBe(1);
    expect(merged).not.toBe(H1);
    expect(world.asked).toEqual([]);
    expect(world.outcomes.at(-1)).toMatchObject({ kind: "merged", headSha: merged });
  });

  it("leaves a head whose base moved only outside the guard files to its ordinary decision", async () => {
    const world = landWithMergeMain(gatingH1("owner gate"));
    mainMovedPast(world.fake, H1, ["src/other.ts"]);

    await world.host.runtime.wait(world.start());

    expect(world.fake.effects.updateBranch).toBe(0);
    expect(world.asked).toEqual([H1]);
  });
});

describe("Shepherd merges main itself when an approve-merge gate lacks only a green run", () => {
  it("merges main at a gate citing MRG-AU no-non-green-run when main's tip is green, instead of asking", async () => {
    const world = landWithMergeMain(gatingH1(nonGreenReason));
    const tip = mainMovedPast(world.fake, H1, ["src/fix.ts"]);
    world.fake.setRuns(tip, [successRun("validate", 7), successRun("dag-check", 8)]);

    await world.host.runtime.wait(world.start());

    expect(nonGreenReason).toContain("MRG-AU-RV unmet: no-non-green-run");
    expect(world.fake.effects.updateBranch).toBe(1);
    expect(world.asked).toEqual([]);
    expect(world.outcomes.at(-1)).toMatchObject({ kind: "merged", headSha: world.fake.pr(1).headSha });
  });

  it("asks the owner as before when main's tip is not green", async () => {
    const world = landWithMergeMain(gatingH1(nonGreenReason));
    const tip = mainMovedPast(world.fake, H1, ["src/fix.ts"]);
    world.fake.setRuns(tip, [successRun("validate", 7, undefined, "failure"), successRun("dag-check", 8)]);

    await world.host.runtime.wait(world.start());

    expect(world.fake.effects.updateBranch).toBe(0);
    expect(world.asked).toEqual([H1]);
  });
});

describe("Shepherd's own merge of main that conflicts", () => {
  it("falls back to the conflict fix-round wake at the unchanged head", async () => {
    const H2 = fakeSha("head2");
    const fake = fakeGitHub();
    fake.updateBranchConflict = true;
    fake.addPr({ headSha: H1 });
    fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
    mainMovedPast(fake, H1, [".github/fix-proof.json"]);
    const wakes: WakeRequest[] = [];
    const phases: ShepherdPhases = {
      wake: async (_ctx, request) => (wakes.push(request), fake.pushHead(1, H2), { kind: "woken", agent: "impl-a" }),
      review: async () => ({ kind: "none" }),
    };
    let clock = 0;
    const routes = factoryRoutesFor({ port: githubPort(fake.wire), store: shepherdStoreRef(), now: () => clock, sleep: async (ms, signal) => ((clock += ms), sleep(1, signal)) });
    const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow(phases)], routes, gatePollMs: 5 });
    hosts.push(host);

    const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(OWNER_GATE_POLICY) });
    await expect.poll(() => wakes.length).toBeGreaterThan(0);
    host.runtime.cancel(runId, "test done");

    expect(wakes[0]).toMatchObject({ kind: "conflict", headSha: H1 });
  });
});
