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
import type { ReviewerAgent, ReviewerDispatch, ReviewerMessage } from "@titan-design/review-panel";
import { reviewPhase } from "./review.js";
import { accountLimitStoreRef, type AccountLimitStore } from "./account-store.js";
import { shepherdStoreRef, type ShepherdStore } from "./store.js";

const REPO = "octo/demo";
const H1 = fakeSha("account-head-1");
const T0 = Date.parse("2026-10-08T12:00:00.000Z");
const RESET = Date.parse("2026-10-08T13:30:00.000Z");
const NOTICE = "You've hit your weekly limit · resets Oct 8 at 1:30pm (UTC)";
const PRIMARY = "/accounts/review";
const SPARE = "/accounts/spare";
const AUTO: EffectivePolicy = { ...OWNER_GATE_POLICY, merge: "auto", fixer: true, seat: "trusted-seat" };

const locatorIn = (nativeId: string): SourceTextLocator => ({
  source: {
    sourceId: nativeId,
    harness: "claude-code",
    format: "jsonl",
    formatVersion: null,
    path: `${nativeId}.jsonl`,
    namespace: "test",
    conversation: { harness: "claude-code", namespace: "test", nativeId },
    provenance: { kind: "claude-code-transcript", legacySessionId: nativeId },
  },
  evidence: {
    line: { sourceId: nativeId, byteOffset: 0, byteLength: 0, contentHash: "", lineNumber: null, nativeOrdinal: null },
    subrecord: { index: 0, path: [] },
  },
  selector: { kind: "subrecord-text", path: ["message", "content", 0, "text"] },
});

interface Spawned {
  name: string;
  account: string;
  at: number;
}

/** Who writes the limit line: Claude Code's own `<synthetic>` record, or a reviewer typing the same words. */
type Writer = "client" | "reviewer";

/**
 * When a limited reviewer meets the limit: before the on-time wait ends, after it (read by the late step), or in the turn it
 * was resumed for to correct a malformed verdict.
 */
type LimitAt = "on-time" | "late" | "correction";

/** Whether the reviewer spawned under `account` at `at`, the `index`th spawn of the run, is stopped by the limit. */
type Limited = (account: string, at: number, index: number) => boolean;

interface FakeOptions {
  writer: Writer;
  limitAt: LimitAt;
  /** The reset Claude Code records on the notice of a reviewer spawned at `at`. */
  resetOf: (at: number) => number;
}

/** The late reviewer writes past the scene's 5-minute on-time wait. */
const LATE_BY_MS = 6 * 60_000;
const MALFORMED = "Looks fine to me, merging is safe.";

/** Reviewers spawned under each account; one under an account `limited` gets the limit line from `writer`, any other says MERGE. */
function fakeAccounts(dirs: string[], limited: Limited, clock: () => number, onSpawn: () => void, options: FakeOptions) {
  const agents: ReviewerAgent[] = [];
  const spawns: Spawned[] = [];
  const alerts: string[] = [];
  const resumedAt = new Map<string, number>();
  const under = (account: string): ReviewerDispatch => ({
    roster: async () => [...agents],
    spawn: async (name) => void (onSpawn(), spawns.push({ name, account, at: clock() }), agents.push({ name, agentId: `id-${name}`, sessionId: `s-${name}`, presence: "live", spawnedBy: null, predecessor: null })),
    resume: async (name) => {
      if (options.limitAt !== "correction") throw new Error("no reviewer is resumed here");
      resumedAt.set(name, clock());
      agents.find((agent) => agent.name === name)!.presence = "live";
    },
  });
  const accounts: ReviewAccounts = { dirs, dispatchUnder: under, alert: async (_repo, text) => void alerts.push(text) };
  const said = (input: { agentId: string; sessionId: string }, text: string, writtenAt: number, synthetic?: { resetsAt: number }): ReviewerMessage => ({
    agentId: input.agentId,
    sessionId: input.sessionId,
    writtenAt,
    text,
    locator: locatorIn(input.sessionId),
    ...(synthetic && { synthetic: { apiError: "rate_limit", resetsAt: synthetic.resetsAt } }),
  });
  /** The limited reviewer's transcript at `now`; it exits on the turn that ends in the notice or the malformed message. */
  const limitedLines = (agent: ReviewerAgent, spawn: Spawned, now: number): ReviewerMessage[] => {
    const who = { agentId: agent.agentId, sessionId: agent.sessionId };
    const notice = (at: number) => said(who, NOTICE, at, options.writer === "client" ? { resetsAt: options.resetOf(spawn.at) } : undefined);
    if (options.limitAt === "on-time") return [notice(now + 1)];
    if (options.limitAt === "late") return now < spawn.at + LATE_BY_MS ? [] : ((agent.presence = "exited"), [notice(spawn.at + LATE_BY_MS)]);
    const resumed = resumedAt.get(spawn.name);
    agent.presence = "exited";
    return [said(who, MALFORMED, spawn.at + 1), ...(resumed === undefined ? [] : [notice(resumed + 1)])];
  };
  const read = async (input: { repo: string; pr: number; head: string; reviewerAgentId: string; reviewerSessionId: string }): Promise<ReviewerMessage[]> => {
    const index = spawns.findIndex((row) => `id-${row.name}` === input.reviewerAgentId);
    const spawn = spawns[index];
    const agent = agents.find((row) => row.agentId === input.reviewerAgentId);
    if (!spawn || !agent) return [];
    if (limited(spawn.account, spawn.at, index)) return limitedLines(agent, spawn, clock());
    return [said({ agentId: input.reviewerAgentId, sessionId: input.reviewerSessionId }, `Read it.\n\nVerdict: MERGE\nPR: ${input.repo}#${input.pr}\nHead: ${input.head}\n`, clock() + 1)];
  };
  return { accounts, dispatch: under(dirs[0]!), reader: { read }, spawns, alerts };
}

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

interface SceneHooks {
  /** Called at every sleep with the new time, so a test can move the head or the CI mid-run. */
  onTick?: (now: number, scene: { fake: FakeGitHub; ci: { greenFrom: number } }) => void;
  /** Runs once the run is registered and before its first step, with the account marks and the registration to seed. */
  seed?: (limits: AccountLimitStore, store: ShepherdStore, runId: string) => void;
  /**
   * Real milliseconds each simulated tick lasts. Ticks only yield to the event loop unless named, which keeps a run of a thousand
   * 15 s head polls under a second even on a loaded runner; a test that acts on the run between ticks names it.
   */
  realTickMs?: number;
  /** When the limited reviewer meets the limit; on time unless named. */
  limitAt?: LimitAt;
  /** The reset recorded on a notice from a reviewer spawned at `at`; RESET unless named. */
  resetOf?: (at: number) => number;
}

/**
 * One shepherd-pr run over the real review phase; every sleep moves the clock, and the store's hold reasons are sampled at
 * each. Required checks stay queued until `ci.greenFrom`, so a test can make a round's review start after a given time.
 */
function shepherdWith(dirs: string[], limited: Limited, writer: Writer = "client", hooks: SceneHooks = {}) {
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
  const options: FakeOptions = { writer, limitAt: hooks.limitAt ?? "on-time", resetOf: hooks.resetOf ?? (() => RESET) };
  const reviewers = fakeAccounts(dirs, limited, () => clock, () => void approveAtSpawn.push(host.gates.get(gateId(runId, "approve-merge")) !== undefined), options);
  const tick = async (ms: number, signal: AbortSignal) => {
    clock += ms;
    hooks.onTick?.(clock, { fake, ci });
    const reason = runId === "" ? undefined : store.get().byRun(runId)?.holdReason;
    if (reason) holds.add(reason);
    if (hooks.realTickMs === undefined) {
      signal.throwIfAborted();
      await new Promise<void>((resolve) => setImmediate(resolve));
    } else await sleep(hooks.realTickMs, signal);
  };
  const review = { reader: reviewers.reader, dispatch: reviewers.dispatch, accounts: reviewers.accounts, timeoutMs: 5 * 60_000 };
  const accountLimits = accountLimitStoreRef(() => clock);
  const routes = factoryRoutesFor({ port: githubPort(fake.wire), store, accountLimits, now: () => clock, sleep: tick, review });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow({ review: reviewPhase, wake: async () => ({ kind: "unhandled", reason: "no fixer here" }) })], routes, gatePollMs: 5 });
  hosts.push(host);
  runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(AUTO) });
  store.get().register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy: AUTO });
  hooks.seed?.(accountLimits.get(), store.get(), runId);
  const stepIds = () => Object.values(host.runtime.status(runId)!.stepResults).map((result) => result.stepId);
  const intents = () => Object.values(host.runtime.status(runId)!.stepResults).flatMap((result) => (result.stepId.startsWith("sh-review-intent") ? [result.data?.["result"]] : []));
  return { runId, store, accountLimits, host, reviewers, holds, stepIds, intents, approveAtSpawn, fake };
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

  describe("a limit read after the on-time wait", () => {
    const HELD = `account-exhausted: ${PRIMARY} until 2026-10-08T13:30:00.000Z; TP-1955`;
    const limitedUntilReset: Limited = (account, at) => account === PRIMARY && at < RESET;

    it.each<[string, LimitAt, string]>([
      ["late, by the late step", "late", `sh-late-verdict:${H1}`],
      ["as the reply to its correction", "correction", `sh-await-verdict:${H1}:corrected`],
    ])("holds the run until the reset with one spawn when the reviewer meets its limit %s, then merges", async (_name, limitAt, readBy) => {
      const scene = shepherdWith([PRIMARY], limitedUntilReset, "client", { limitAt });

      await vi.waitFor(() => expect(scene.fake.calls).toContain("merge"), { timeout: 20_000 });

      expect(scene.stepIds()).toContain(readBy);
      expect(scene.holds).toEqual(new Set([HELD]));
      expect(scene.reviewers.spawns.map((row) => row.at >= RESET)).toEqual([false, true]);
      expect(scene.reviewers.alerts).toEqual([expect.stringContaining(`${PRIMARY} hit its usage limit and resets at 2026-10-08T13:30:00.000Z`)]);
      expect(scene.approveAtSpawn).toEqual([false, false]);
    });

    it("opens no failed-rounds gate when the reviewer meets its limit late at one head in three windows running", async () => {
      const MINUTE = 60_000;
      const scene = shepherdWith([PRIMARY], (account, _at, index) => account === PRIMARY && index < 3, "client", { limitAt: "late", resetOf: (at) => at + LATE_BY_MS + 90 * MINUTE });

      await vi.waitFor(() => expect(scene.fake.calls).toContain("merge"), { timeout: 20_000 });

      expect(scene.reviewers.spawns).toHaveLength(4);
      expect(scene.holds.size).toBe(3);
      expect(scene.approveAtSpawn).toEqual([false, false, false, false]);
      expect(scene.host.gates.get(gateId(scene.runId, "approve-merge"))).toBeUndefined();
    });
  });

  describe("the run's own hold after its wait ends", () => {
    const MINUTE = 60_000;
    const limitedUntilReset: Limited = (account, at) => account === PRIMARY && at < RESET;

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

    it("merges with no owner release when the run is repointed during the hold and the reset passes", async () => {
      const scene = shepherdWith([PRIMARY], limitedUntilReset, "client", { realTickMs: 1 });
      await vi.waitFor(() => expect(scene.stepIds()).toContain(`sh-account-wait:${H1}`), { timeout: 20_000 });
      scene.host.runtime.cancel(scene.runId, "replaced in this test");

      const next = scene.host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(AUTO) }, { onStart: (id) => void scene.store.get().repoint(scene.runId, id) });

      expect(scene.accountLimits.get().holdsRun(next)).toBe(true);
      await vi.waitFor(() => expect(scene.fake.calls).toContain("merge"), { timeout: 20_000 });
      expect(scene.store.get().byRun(next)?.held).toBe(false);
    });

    it("leaves no hold when the PR closes during the hold", async () => {
      const scene = shepherdWith([PRIMARY], limitedUntilReset, "client", {
        onTick: (now, { fake }) => {
          if (now >= T0 + 50 * MINUTE) fake.pr(1).state = "closed";
        },
      });

      await vi.waitFor(() => expect(scene.stepIds()).toContain("sh-stopped"), { timeout: 20_000 });

      expect(scene.store.get().byRun(scene.runId)?.held).toBe(false);
      expect(scene.holds).toEqual(new Set([`account-exhausted: ${PRIMARY} until 2026-10-08T13:30:00.000Z; TP-1955`]));
      expect(scene.fake.calls).not.toContain("merge");
    });
  });

  describe("a review that is not the default spawn", () => {
    const exhaustedUntilReset = (account: string) => (limits: AccountLimitStore) => void limits.markExhausted(account, RESET, NOTICE);
    const fresh = () => false;

    it("leaves a seat's ask standing while every account is exhausted, and spends it on the review after the reset", async () => {
      const scene = shepherdWith([PRIMARY], fresh, "client", {
        seed: (limits, store, runId) => (exhaustedUntilReset(PRIMARY)(limits), void store.requestReview(runId, H1)),
      });

      await vi.waitFor(() => expect(scene.reviewers.spawns).toHaveLength(1), { timeout: 20_000 });

      expect(scene.reviewers.spawns[0]!.at).toBeGreaterThanOrEqual(RESET);
      const intents = scene.intents();
      expect(intents.length).toBeGreaterThan(1);
      expect(intents.slice(0, -1)).toEqual(intents.slice(0, -1).map(() => expect.objectContaining({ kind: "none", exhausted: PRIMARY })));
      expect(intents.at(-1)).toMatchObject({ kind: "intent", mode: "spawn", account: PRIMARY, requested: true });
    });

    it("bills Shepherd's own g10-adversary reviewer to an account with headroom, never the exhausted one", async () => {
      const scene = shepherdWith([PRIMARY, SPARE], fresh, "client", {
        seed: (limits, store, runId) => (exhaustedUntilReset(PRIMARY)(limits), void store.hold(runId, "g10-adversary: merge-policy change; TP-1", "seat-rv")),
      });

      await vi.waitFor(() => expect(scene.reviewers.spawns).toHaveLength(1), { timeout: 20_000 });

      expect(scene.reviewers.spawns.map((row) => row.account)).toEqual([SPARE]);
      expect(scene.intents()[0]).toMatchObject({ kind: "intent", mode: "spawn", account: SPARE });
    });

    it("spawns no g10-adversary reviewer before the reset when every account is exhausted", async () => {
      const scene = shepherdWith([PRIMARY], fresh, "client", {
        seed: (limits, store, runId) => (exhaustedUntilReset(PRIMARY)(limits), void store.hold(runId, "g10-adversary: merge-policy change; TP-1", "seat-rv")),
      });

      await vi.waitFor(() => expect(scene.reviewers.spawns).toHaveLength(1), { timeout: 20_000 });

      expect(scene.reviewers.spawns[0]!.at).toBeGreaterThanOrEqual(RESET);
      expect(scene.intents()[0]).toMatchObject({ kind: "none", exhausted: PRIMARY });
    });
  });
});
