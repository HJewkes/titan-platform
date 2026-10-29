import { tmpdir } from "node:os";
import { dataFence, DispatchError, type AgentRow } from "@titan-design/agent-dispatch";
import { fakeGitHub, fakeSha, githubPort, successRun } from "@titan-design/github";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import type { RoutedStepInput } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { LEAKY_MESSAGE, expectNoLeak } from "../test-support/leak.js";
import type { ExitNoticePorts } from "./exit-notice.js";
import { mergeBaseExceptionMigration } from "./merge-base-exception.js";
import type { ShepherdDeps } from "./phases.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { SpawnDeferred } from "./spawn-gate.js";
import { lineageMigration, shepherdMigration, shepherdStoreRef, sliceMigration } from "./store.js";
import { wakeRoutes, type ImplementerAgents, type WakeStepResult } from "./wake.js";

const REPO = "octo/demo";
const H1 = fakeSha("head-1");
const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const CHECKOUT = tmpdir();
const STALLED = "impl-a started no turn within 5 minutes of the wake or of the message fallback";

function row(name: string, presence: string): AgentRow {
  const base = { name, agentId: `id-${name}`, state: presence, presence, status: "running", profile: "implementer", surface: "headless", model: null };
  return { ...base, cwd: `/work/${name}`, sessionId: `s-${name}`, transcriptPath: `/transcripts/${name}.jsonl`, transcriptExists: true, spawnedBy: "demo-coord", account: null, generation: 1, teleportFrom: null };
}

/** A roster whose live agent starts no turn until a successor is spawned; `fail` throws once from the named verb. */
function hungAgents(rows: AgentRow[]) {
  const asked: string[][] = [];
  const fail: { spawn?: Error; retire?: Error } = {};
  const failing = (verb: keyof typeof fail) => {
    const error = fail[verb];
    delete fail[verb];
    if (error) throw error;
  };
  const agents: ImplementerAgents = {
    roster: async () => rows.map((agent) => ({ ...agent })),
    resume: async (name) => void asked.push(["resume", name]),
    message: async (name) => void asked.push(["message", name]),
    spawn: async (name, brief, cwd) => (failing("spawn"), asked.push(["spawn", name, brief, cwd]), void rows.push(row(name, "live"))),
    retire: async (name) => (failing("retire"), asked.push(["retire", name]), void rows.splice(rows.findIndex((agent) => agent.name === name), 1)),
  };
  return { agents, asked, fail, verbs: () => asked.map(([verb, name]) => [verb, name]) };
}

/** A registered fixer run whose live implementer is woken on red CI, with a clock that advances by each sleep. */
function hungWake(scene: { advisory?: boolean; rows?: AgentRow[]; successors?: string[] } = {}) {
  const fake = fakeGitHub({ repo: REPO });
  fake.addPr({ headSha: H1, headRef: "feat/demo-fix" });
  fake.setRuns(H1, [successRun("dag-check", 11, undefined, "failure")]);
  const db = openDatabase(":memory:");
  runMigrations(db, [shepherdMigration(4), lineageMigration(5), sliceMigration(8), mergeBaseExceptionMigration(42)]);
  const store = shepherdStoreRef();
  store.bind(db);
  store.get().register({ repo: REPO, pr: 1, runId: "run-1", task: "demo task", implementer: "impl-a", policy: { ...OWNER_GATE_POLICY, fixer: true, seat: "demo-seat" } });
  const told: string[] = [];
  const exitNotice: ExitNoticePorts = { seatFor: () => "demo-seat", lastReport: async () => undefined, send: async (seat) => void told.push(seat) };
  for (const name of scene.successors ?? []) store.get().recordAuthor("run-1", { agentId: `id-${name}`, name, role: "successor", predecessor: "impl-a" });
  const hung = hungAgents(scene.rows ?? [row("impl-a", "live")]);
  let now = T0;
  const deps: ShepherdDeps = { port: githubPort(fake.wire), store, now: () => now, sleep: async (ms) => void (now += ms), pollMs: 1_000, agentChatBin: "/opt/bin/agent-chat", exitNotice, ...(scene.advisory && { advisory: () => true }) };
  const turnSince = async () => hung.asked.some(([verb]) => verb === "spawn");
  const route = wakeRoutes(deps, { turnSince, readWarmth: async () => ({ lastEventAt: T0 - 60_000, fill: 50_000 }), checkoutFor: () => CHECKOUT, agents: hung.agents }).find((candidate) => candidate.match === "sh-wake-implementer")!;
  const run = async (): Promise<WakeStepResult> => {
    const prompt = JSON.stringify({ kind: "ci-red", repo: REPO, pr: 1, round: 0, headSha: H1, payload: { failing: [{ name: "dag-check" }] }, runId: "run-1" });
    const step: RoutedStepInput = { runId: "run-1", workflowName: "wake-test", iteration: 0, prompt, signal: new AbortController().signal, attempt: 0, requestKey: "k", stepId: "sh-wake-implementer:0" };
    const outcome = await route.runner.run(step);
    if (!outcome.ok) throw new Error("the wake step failed");
    return z.looseObject({ result: z.custom<WakeStepResult>() }).parse(JSON.parse(outcome.output)).result;
  };
  return { ...hung, store, told, run };
}

const REPLACED = [
  ["message", "impl-a"],
  ["message", "impl-a"],
  ["retire", "impl-a"],
  ["spawn", "impl-a-s1"],
];

describe("sh-wake-implementer: a live agent that takes no wake is replaced (TP-4430)", () => {
  it("retires a live agent idle through the ci-red wake and its fallback, and starts a successor on the PR branch with the failure, telling no seat", async () => {
    const wake = hungWake();

    const result = await wake.run();

    expect(result).toEqual({ kind: "woken", agent: "impl-a-s1", mode: "successor", askedAt: expect.any(Number) });
    expect(wake.verbs()).toEqual(REPLACED);
    const [, , brief, cwd] = wake.asked[3]!;
    expect(cwd).toBe(CHECKOUT);
    expect(brief).toContain("taking over octo/demo#1 from impl-a");
    expect(brief).toContain(dataFence("head branch", "feat/demo-fix"));
    expect(brief).toContain(`CI failed at head ${H1}`);
    expect(wake.store.get().authorsOf("run-1")).toContainEqual(expect.objectContaining({ name: "impl-a-s1", role: "successor", predecessor: "impl-a" }));
    expect(wake.told).toEqual([]);
  });

  it("polls when the spawn gate defers the successor, and starts it without asking the retired agent again", async () => {
    const wake = hungWake();
    wake.fail.spawn = new SpawnDeferred("load5 40 is past the limit 28");

    const result = await wake.run();

    expect(result).toMatchObject({ kind: "woken", agent: "impl-a-s1", mode: "successor" });
    expect(wake.verbs()).toEqual(REPLACED);
  });

  it("starts no successor beside the agent when agent-chat refuses its retire, and tells the seat with the error class only", async () => {
    const wake = hungWake();
    wake.fail.retire = new DispatchError(LEAKY_MESSAGE);

    const result = await wake.run();

    expect(result).toMatchObject({ kind: "unhandled", reason: `${STALLED}, and its retire failed: DispatchError` });
    expect(wake.verbs().map(([verb]) => verb)).not.toContain("spawn");
    expect(wake.told).toEqual(["demo-coord"]);
    expectNoLeak(result);
  });

  it("replaces a hung successor with the next successor, not a resume of the warm implementer before it", async () => {
    const wake = hungWake({ rows: [row("impl-a", "exited"), row("impl-a-s1", "live")], successors: ["impl-a-s1"] });

    const result = await wake.run();

    expect(result).toMatchObject({ kind: "woken", agent: "impl-a-s2", mode: "successor" });
    expect(wake.verbs()).toEqual([
      ["message", "impl-a-s1"],
      ["message", "impl-a-s1"],
      ["retire", "impl-a-s1"],
      ["spawn", "impl-a-s2"],
    ]);
  });

  it("leaves the live agent running when no successor could push, as on an advisory repo", async () => {
    const wake = hungWake({ advisory: true });

    const result = await wake.run();

    expect(result).toMatchObject({ kind: "unhandled", reason: STALLED });
    expect(wake.verbs()).toEqual(REPLACED.slice(0, 2));
  });
});
