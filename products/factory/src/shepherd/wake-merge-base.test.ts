import { dataFence, type AgentRow } from "@titan-design/agent-dispatch";
import { fakeGitHub, fakeSha, githubPort } from "@titan-design/github";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import type { RoutedStepInput } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { mergeBaseExceptionMigration } from "./merge-base-exception.js";
import type { ShepherdDeps } from "./phases.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { lineageMigration, shepherdMigration, shepherdStoreRef, sliceMigration } from "./store.js";
import { wakeRoutes, type ImplementerAgents } from "./wake.js";

const REPO = "octo/demo";
const H1 = fakeSha("head-1");
const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const TRANSCRIPT = "/transcripts/impl-a.jsonl";

function implementer(): AgentRow {
  const base = { name: "impl-a", agentId: "id-impl-a", state: "exited", presence: "exited", status: "finished", profile: "implementer", surface: "headless", model: null };
  return { ...base, cwd: "/work/impl-a", sessionId: "s-impl-a", transcriptPath: TRANSCRIPT, transcriptExists: true, spawnedBy: null, account: null, generation: 1, teleportFrom: null };
}

/** A registered fixer run whose warm implementer is resumed on a ci-red wake, recording the brief it is handed. */
function ciRedWake() {
  const fake = fakeGitHub({ repo: REPO });
  fake.addPr({ headSha: H1, headRef: "feat/demo-fix" });
  const db = openDatabase(":memory:");
  runMigrations(db, [shepherdMigration(4), lineageMigration(5), sliceMigration(8), mergeBaseExceptionMigration(42)]);
  const store = shepherdStoreRef();
  store.bind(db);
  store.get().register({ repo: REPO, pr: 1, runId: "run-1", task: "demo task", implementer: "impl-a", policy: { ...OWNER_GATE_POLICY, fixer: true, seat: "demo-seat" } });
  const briefs: string[] = [];
  const agents: ImplementerAgents = {
    roster: async () => [implementer()],
    resume: async (_name, message) => void briefs.push(message),
    spawn: async () => undefined,
    message: async () => undefined,
  };
  const deps: ShepherdDeps = { port: githubPort(fake.wire), store, now: () => T0, sleep: async () => undefined, pollMs: 1_000, agentChatBin: "/opt/bin/agent-chat" };
  const warmth = { lastEventAt: T0 - 60_000, fill: 50_000 };
  const route = wakeRoutes(deps, { turnSince: async () => true, readWarmth: async (path) => (path === TRANSCRIPT ? warmth : undefined), checkoutFor: () => "/repos/demo", agents }).find((candidate) => candidate.match === "sh-wake-implementer")!;
  const run = async () => {
    const prompt = JSON.stringify({ kind: "ci-red", repo: REPO, pr: 1, round: 0, headSha: H1, payload: {}, runId: "run-1" });
    const step: RoutedStepInput = { runId: "run-1", workflowName: "wake-test", iteration: 0, prompt, signal: new AbortController().signal, attempt: 0, requestKey: "k", stepId: "sh-wake-implementer:0" };
    await route.runner.run(step);
    return briefs[0]!;
  };
  return { exceptions: store.get().mergeBaseExceptions(), run };
}

describe("sh-wake-implementer: a planner's merge-base exception", () => {
  it("briefs a ci-red fixer with the merge-base exception a planner recorded on the run (TP-4242)", async () => {
    const wake = ciRedWake();
    wake.exceptions.allow({ runId: "run-1", reason: "the fix needs #12 from main", actor: "demo-planner" });

    const message = await wake.run();

    expect(message).toContain("A planner allowed this run's fix rounds to merge the base branch");
    expect(message).not.toContain("Do not merge the base branch");
    expect(message).toContain(dataFence("merge-base exception", "allowed by: demo-planner\nreason: the fix needs #12 from main"));
  });

  it("keeps the line against merging the base once the exception is revoked", async () => {
    const wake = ciRedWake();
    wake.exceptions.allow({ runId: "run-1", reason: "the fix needs #12 from main", actor: "demo-planner" });
    wake.exceptions.revoke("run-1");

    const message = await wake.run();

    expect(message).toContain("Do not merge the base branch");
    expect(message).not.toContain("merge-base exception");
  });
});
