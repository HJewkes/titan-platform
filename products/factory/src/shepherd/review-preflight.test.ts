import { fakeGitHub, fakeSha, githubPort, successRun } from "@titan-design/github";
import type { PanelPolicy, ReviewerAgent, ReviewerDispatch } from "@titan-design/review-panel";
import { partialFake } from "@titan-design/test-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConfigRef } from "../config-ref.js";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { holdAdversary } from "../workflows-live.js";
import { factoryRoutesFor } from "../workflows.js";
import type { Verdict } from "./phases.js";
import { OWNER_GATE_POLICY, type EffectivePolicy } from "./policy.js";
import { shepherdPrWorkflow } from "./pr.js";
import { reviewPhase } from "./review.js";
import { countRound, type Routed } from "./routed.js";
import { routeFor } from "./route-table.js";
import { freshFailedRounds } from "./failed-rounds-demotion.js";
import { shepherdStoreRef } from "./store.js";

const REPO = "octo/preflight";
const PR = 9;
const HEAD = "1986aaaa".padEnd(40, "0");
const T0 = Date.parse("2026-10-31T09:00:00.000Z");
const AUTO: EffectivePolicy = { ...OWNER_GATE_POLICY, merge: "auto", fixer: true, seat: "trusted-seat" };

/** tp#1986: the correctness member takes the one premium seat, so the fable adversary is lowered to `reviewer`, which is not installed. */
const PANEL: PanelPolicy = {
  roles: { g10: "bd-reviewer", standard: "bd-reviewer" },
  shapeRoles: { adversary: { g10: "fable-reviewer", standard: "fable-reviewer" } },
  panel: [{ shape: "adversary", classes: ["g10", "standard"], touches: [], always: true, blocking: true }],
};

const hosts: FactoryHost[] = [];
afterEach(() => {
  hosts.splice(0).forEach((host) => host.close());
});

/** One shepherd-pr run whose panel is planned as tp#1986's was, under `review.workflow` on:preflight. */
function replay1986() {
  const fake = fakeGitHub();
  fake.addPr({ number: PR, headSha: HEAD, mergeSha: fakeSha("preflight-merge") });
  fake.setRuns(HEAD, [successRun("validate", 1), successRun("dag-check", 2)]);
  fake.prFiles.set(PR, [{ path: "src/a.ts", status: "modified" }]);
  let clock = T0;
  const store = shepherdStoreRef(() => clock);
  const spawned: string[] = [];
  const agents: ReviewerAgent[] = [];
  const dispatch: ReviewerDispatch = {
    roster: async () => [...agents],
    spawn: async (name) => void spawned.push(name),
    resume: async () => {
      throw new Error("no reviewer is resumed here");
    },
  };
  const review = { reader: { read: async () => [] }, dispatch, timeoutMs: 60_000, panel: "on" as const, panelPolicy: PANEL, profileInstalled: (profile: string) => profile !== "reviewer", workflow: "on:preflight" as const };
  const sleep = async (ms: number) => {
    clock += ms;
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  const routes = factoryRoutesFor({ port: githubPort(fake.wire), store, now: () => clock, sleep, review });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow({ review: reviewPhase, wake: async () => ({ kind: "unhandled", reason: "no fixer here" }) })], routes, gatePollMs: 5 });
  hosts.push(host);
  const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: String(PR), policy: JSON.stringify(AUTO) });
  store.get().register({ repo: REPO, pr: PR, runId, task: "octo/TP-1", implementer: "tc-tp-1-a", policy: AUTO });
  const steps = () => Object.values(host.runtime.status(runId)!.stepResults);
  return { spawned, steps };
}

/** A shepherd-pr run's round counters at its first round, observed clean at `HEAD`. */
function firstRound(verdict: Verdict): { run: Parameters<typeof countRound>[0]; routed: Routed } {
  const ctx = partialFake<Parameters<typeof countRound>[0]["ctx"]>({ historyNext: () => undefined });
  const run = { ctx, target: { repo: REPO, pr: PR }, ...freshFailedRounds(), throttledRounds: 0, closer: { streak: 0 }, seatHeldRounds: new Map(), fixFirstTrail: [] };
  const outcome = verdict.kind === "none" && verdict.cause !== undefined ? verdict.cause : "no-verdict";
  const observed = partialFake<Routed["observed"]>({ runState: "open", mergeableState: "clean", headSha: HEAD });
  return { run, routed: { headSha: HEAD, verdict, observed, outcome, route: routeFor("open", "clean", outcome) } };
}

describe("review.workflow on:preflight in Shepherd's review round", () => {
  it("holds tp#1986's head on its fixer fingerprint and records no adversary step", async () => {
    const replay = replay1986();

    await vi.waitFor(() => expect(replay.steps().some((result) => result.stepId.startsWith("sh-no-reviewer-hold:"))).toBe(true), { timeout: 30_000 });

    const intent = replay.steps().find((result) => result.stepId === `sh-review-intent:${HEAD}`);
    expect(intent?.data?.result).toMatchObject({ kind: "none", fixer: { fingerprint: "profile:reviewer", failure: "start-refused:profile" } });
    expect(replay.steps().filter((result) => result.stepId.startsWith(`sh-review:${HEAD}`))).toEqual([]);
    expect(replay.spawned).toEqual([]);
  }, 40_000);

  it("routes the needs-fixer round to await-fixer and counts no failed round", async () => {
    const { run, routed } = firstRound({ kind: "none", cause: "needs-fixer", reason: "preflight: the profile 'reviewer' is not installed" });

    const escalated = await countRound(run, routed);

    expect([routed.outcome, routed.route, escalated, run.failedRounds]).toEqual(["needs-fixer", "await-fixer", undefined, 0]);
  });
});

describe("the adversaryProfile config-load check", () => {
  const config = partialFake<ConfigRef>({ get: () => ({}) });
  const under = () => {
    throw new Error("no adversary dispatch is built here");
  };
  const load = (adversaryProfile: string, uninstalled: string) => () => holdAdversary({ profile: "bd-reviewer", adversaryProfile }, config, under, (profile) => profile !== uninstalled);

  it("fails a config whose adversaryProfile is not installed", () => {
    expect(load("opus-adversary", "opus-adversary")).toThrow("shepherd.review.adversaryProfile 'opus-adversary' is not installed headless");
  });

  it("fails a config whose adversaryProfile would be lowered to an uninstalled profile (tp#1986)", () => {
    expect(load("fable-reviewer", "reviewer")).toThrow("would be lowered to 'reviewer'");
  });

  it("loads a config whose adversaryProfile and its lowered profile are installed", () => {
    expect(load("fable-reviewer", "none")).not.toThrow();
  });
});
