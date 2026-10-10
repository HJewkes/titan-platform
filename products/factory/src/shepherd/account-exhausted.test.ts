import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import type { SourceTextLocator } from "@titan-design/session-read";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { gateId } from "../test-support/land.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import type { ReviewAccounts } from "./account-limit.js";
import { shepherdPrWorkflow } from "./pr.js";
import { OWNER_GATE_POLICY, type EffectivePolicy } from "./policy.js";
import { reviewPhase, type ReviewerAgent, type ReviewerDispatch, type ReviewerMessage } from "./review.js";
import { shepherdStoreRef } from "./store.js";

const REPO = "octo/demo";
const H1 = fakeSha("account-head-1");
const T0 = Date.parse("2026-10-08T12:00:00.000Z");
const RESET = Date.parse("2026-10-08T13:30:00.000Z");
const NOTICE = "You've hit your weekly limit · resets Oct 8 at 1:30pm (UTC)";
const PRIMARY = "/accounts/review";
const SPARE = "/accounts/spare";
const AUTO: EffectivePolicy = { ...OWNER_GATE_POLICY, merge: "auto", fixer: true, seat: "trusted-seat" };

const locatorIn = (nativeId: string) => ({ source: { conversation: { nativeId } } }) as SourceTextLocator;

interface Spawned {
  name: string;
  account: string;
  at: number;
}

/** Who writes the limit line: Claude Code's own `<synthetic>` record, or a reviewer typing the same words. */
type Writer = "client" | "reviewer";

/** Reviewers spawned under each account; one under an account `limited` gets the limit line from `writer`, any other says MERGE. */
function fakeAccounts(dirs: string[], limited: (account: string, now: number) => boolean, clock: () => number, onSpawn: () => void, writer: Writer) {
  const agents: ReviewerAgent[] = [];
  const spawns: Spawned[] = [];
  const alerts: string[] = [];
  const under = (account: string): ReviewerDispatch => ({
    roster: async () => [...agents],
    spawn: async (name) => void (onSpawn(), spawns.push({ name, account, at: clock() }), agents.push({ name, agentId: `id-${name}`, sessionId: `s-${name}`, presence: "live", spawnedBy: null, predecessor: null })),
    resume: async () => Promise.reject(new Error("no reviewer is resumed here")),
  });
  const accounts: ReviewAccounts = { dirs, dispatchUnder: under, alert: async (_repo, text) => void alerts.push(text) };
  const read = async (input: { repo: string; pr: number; head: string; reviewerAgentId: string; reviewerSessionId: string }): Promise<ReviewerMessage[]> => {
    const spawn = spawns.find((row) => `id-${row.name}` === input.reviewerAgentId);
    if (!spawn) return [];
    const limit = limited(spawn.account, spawn.at);
    const text = limit ? NOTICE : `Read it.\n\nVerdict: MERGE\nPR: ${input.repo}#${input.pr}\nHead: ${input.head}\n`;
    const synthetic = limit && writer === "client" ? { synthetic: { apiError: "rate_limit", resetsAt: RESET } } : {};
    return [{ agentId: input.reviewerAgentId, sessionId: input.reviewerSessionId, writtenAt: clock() + 1, text, locator: locatorIn(input.reviewerSessionId), ...synthetic }];
  };
  return { accounts, dispatch: under(dirs[0]!), reader: { read }, spawns, alerts };
}

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

interface SceneHooks {
  /** Called at every sleep with the new time, so a test can move the head or the CI mid-run. */
  onTick?: (now: number, scene: { fake: FakeGitHub; ci: { greenFrom: number } }) => void;
}

/**
 * One shepherd-pr run over the real review phase; every sleep moves the clock, and the store's hold reasons are sampled at
 * each. Required checks stay queued until `ci.greenFrom`, so a test can make a round's review start after a given time.
 */
function shepherdWith(dirs: string[], limited: (account: string, now: number) => boolean, writer: Writer = "client", hooks: SceneHooks = {}) {
  const fake = fakeGitHub();
  const ci = { greenFrom: Number.NEGATIVE_INFINITY };
  fake.addPr({ headSha: H1, mergeSha: fakeSha("account-merge") });
  const queued = { ...successRun("validate", 1), status: "queued" as const, conclusion: null };
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, clock < ci.greenFrom ? [queued] : [successRun("validate", 1), successRun("dag-check", 2)]);
  fake.prFiles.set(1, [{ path: "src/a.ts", status: "modified" }]);
  let clock = T0;
  const store = shepherdStoreRef(() => clock);
  const holds = new Set<string>();
  let runId = "";
  /** Whether an approve-merge gate stood when each reviewer was spawned. */
  const approveAtSpawn: boolean[] = [];
  const reviewers = fakeAccounts(dirs, limited, () => clock, () => void approveAtSpawn.push(host.gates.get(gateId(runId, "approve-merge")) !== undefined), writer);
  const tick = async (ms: number, signal: AbortSignal) => {
    clock += ms;
    hooks.onTick?.(clock, { fake, ci });
    const reason = runId === "" ? undefined : store.get().byRun(runId)?.holdReason;
    if (reason) holds.add(reason);
    await sleep(1, signal);
  };
  const review = { reader: reviewers.reader, dispatch: reviewers.dispatch, accounts: reviewers.accounts, timeoutMs: 5 * 60_000 };
  const routes = factoryRoutesFor({ port: githubPort(fake.wire), store, now: () => clock, sleep: tick, review });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow({ review: reviewPhase, wake: async () => ({ kind: "unhandled", reason: "no fixer here" }) })], routes, gatePollMs: 5 });
  hosts.push(host);
  runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(AUTO) });
  store.get().register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy: AUTO });
  const stepIds = () => Object.values(host.runtime.status(runId)!.stepResults).map((result) => result.stepId);
  return { runId, store, reviewers, holds, stepIds, approveAtSpawn, fake };
}

describe("a reviewer account out of usage", () => {
  it("holds the run as account-exhausted, alerts once, spawns nobody on that account until its reset, then reviews the head again", async () => {
    const scene = shepherdWith([PRIMARY], (account, at) => account === PRIMARY && at < RESET);

    await vi.waitFor(() => expect(scene.reviewers.spawns).toHaveLength(2), { timeout: 20_000 });

    expect(scene.holds).toEqual(new Set([`account-exhausted: ${PRIMARY} until 2026-10-08T13:30:00.000Z; TP-1955`]));
    expect(scene.reviewers.alerts).toEqual([expect.stringContaining(`${PRIMARY} hit its usage limit and resets at 2026-10-08T13:30:00.000Z`)]);
    expect(scene.reviewers.spawns[1]!.at).toBeGreaterThanOrEqual(RESET);
    expect(scene.stepIds().filter((id) => id.startsWith("sh-account-hold"))).toHaveLength(2);
    expect(scene.stepIds()).not.toContain(`sh-late-verdict:${H1}`);
    expect(scene.approveAtSpawn).toEqual([false, false]);
    expect(scene.store.get().byRun(scene.runId)?.held).toBe(false);
  });

  it("moves the review to the fallback account, alerts once and never holds the run, when a second account is configured", async () => {
    const scene = shepherdWith([PRIMARY, SPARE], (account) => account === PRIMARY);

    await vi.waitFor(() => expect(scene.reviewers.spawns).toHaveLength(2), { timeout: 20_000 });

    expect(scene.reviewers.spawns.map((row) => row.account)).toEqual([PRIMARY, SPARE]);
    expect(scene.reviewers.alerts).toHaveLength(1);
    expect(scene.holds).toEqual(new Set());
    expect(scene.stepIds().filter((id) => id.startsWith("sh-account-wait"))).toEqual([]);
  });

  it("marks no account, holds nothing and alerts nobody when the reviewer writes the limit line itself", async () => {
    const scene = shepherdWith([PRIMARY], (account) => account === PRIMARY, "reviewer");

    await vi.waitFor(() => expect(scene.reviewers.spawns.length).toBeGreaterThanOrEqual(2), { timeout: 20_000 });

    expect(scene.reviewers.alerts).toEqual([]);
    expect(scene.holds).toEqual(new Set());
    expect(scene.stepIds().filter((id) => id.startsWith("sh-account"))).toEqual([]);
    expect(scene.reviewers.spawns.map((row) => row.account)).toEqual(scene.reviewers.spawns.map(() => PRIMARY));
  });

  describe("the run's own hold after its wait ends", () => {
    const MINUTE = 60_000;
    const limitedUntilReset = (account: string, at: number) => account === PRIMARY && at < RESET;

    it("merges with no owner release when the head moves mid-hold and the reset passes before the new head's review", async () => {
      const H2 = fakeSha("account-head-2");
      let pushed = false;
      const scene = shepherdWith([PRIMARY], limitedUntilReset, "client", {
        onTick: (now, { fake, ci }) => {
          if (pushed || now < T0 + 50 * MINUTE) return;
          pushed = true;
          ci.greenFrom = RESET + MINUTE;
          fake.pushHead(1, H2);
        },
      });

      await vi.waitFor(() => expect(scene.fake.calls).toContain("merge"), { timeout: 20_000 });

      expect(scene.reviewers.spawns.map((row) => row.at >= RESET)).toEqual([false, true]);
      expect(scene.stepIds().filter((id) => id.startsWith("sh-account-hold"))).toHaveLength(1);
      expect(scene.store.get().byRun(scene.runId)?.held).toBe(false);
    });

    it("merges with no owner release when the wait expires and the reset passes before the next review", async () => {
      let slowed = false;
      const scene = shepherdWith([PRIMARY], limitedUntilReset, "client", {
        onTick: (now, { ci }) => {
          if (slowed || now < T0 + 30 * MINUTE) return;
          slowed = true;
          ci.greenFrom = RESET + MINUTE;
        },
      });

      await vi.waitFor(() => expect(scene.fake.calls).toContain("merge"), { timeout: 20_000 });

      expect(scene.reviewers.spawns.map((row) => row.at >= RESET)).toEqual([false, true]);
      expect(scene.stepIds().filter((id) => id.startsWith("sh-account-hold"))).toHaveLength(1);
      expect(scene.stepIds()).toContain(`sh-account-wait:${H1}`);
      expect(scene.store.get().byRun(scene.runId)?.held).toBe(false);
    });
  });
});
