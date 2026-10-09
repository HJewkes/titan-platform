import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DispatchError, type AgentRow } from "@titan-design/agent-dispatch";
import { fakeGitHub, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO, gateId, gateOpened } from "../test-support/land.js";
import { OWNER } from "../test-support/resolver.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import type { ExitNoticePorts } from "./exit-notice.js";
import type { ShepherdDeps, ShepherdPhases, Verdict } from "./phases.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { shepherdPrWorkflow } from "./pr.js";
import { shepherdStoreRef, type ShepherdStoreRef } from "./store.js";
import { timelineEntries, watchRow } from "./view.js";
import { WAKE_STEP, wakePhase, wakeRoutes, type ImplementerAgents } from "./wake.js";

const REFUSAL = "agent-chat refused to start the successor impl-a-s1: DispatchError";
const SCRATCH = mkdtempSync(join(tmpdir(), "tp1751-held-"));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));
const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

function implementerRow(): AgentRow {
  const base = { name: "impl-a", agentId: "id-impl-a", state: "exited", presence: "exited", status: "finished", profile: "implementer", surface: "headless", model: null };
  return { ...base, cwd: "/work/impl-a", sessionId: "s-impl-a", transcriptPath: "/transcripts/impl-a.jsonl", transcriptExists: true, spawnedBy: null, account: null, generation: 1, teleportFrom: null };
}

/** A cold implementer whose successor agent-chat refuses to start, so every wake ends with no fixer. */
const refusingAgents = (): ImplementerAgents => ({
  roster: async () => [implementerRow()],
  resume: async () => Promise.reject(new Error("a cold implementer is not resumed")),
  message: async () => Promise.reject(new Error("the implementer is not live")),
  spawn: async () => Promise.reject(new DispatchError("agent-chat refused the spawn")),
});

const seat = (fails: boolean): ExitNoticePorts => ({
  seatFor: () => "demo-coord",
  lastReport: async () => undefined,
  send: async () => {
    if (fails) throw new Error("broker refused the message");
  },
});

const phases: ShepherdPhases = {
  wake: wakePhase,
  review: async (_ctx, request): Promise<Verdict> => (request.headSha === H1 ? { kind: "FIX_FIRST", headSha: H1, text: "missing test" } : { kind: "none" }),
};

interface World {
  host: FactoryHost;
  store: ShepherdStoreRef;
}

/** The real shepherd-pr workflow and the real wake step, over agents that refuse the successor. */
function world(fake: FakeGitHub, ci: "success" | "failure", notice: ExitNoticePorts): World {
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1, undefined, ci), successRun("dag-check", 2)]);
  let clock = 0;
  const store = shepherdStoreRef();
  const deps: ShepherdDeps = { port: githubPort(fake.wire), store, now: () => clock, sleep: async (ms, signal) => ((clock += ms), sleep(1, signal)), agentChatBin: "/opt/bin/agent-chat" };
  const wake = wakeRoutes(deps, { agents: refusingAgents(), readWarmth: async () => undefined, checkoutFor: () => SCRATCH }).find((route) => route.match === WAKE_STEP)!;
  const factory = factoryRoutesFor({ port: deps.port, store, now: deps.now, sleep: deps.sleep, exitNotice: notice });
  const routes = Object.assign(factory.map((route) => (route.match === WAKE_STEP ? wake : route)), { database: factory.database, shepherd: factory.shepherd });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow(phases)], routes, gatePollMs: 5 });
  hosts.push(host);
  return { host, store };
}

function start({ host, store }: World): string {
  const policy = { ...OWNER_GATE_POLICY, fixer: true };
  const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(policy) });
  store.get().register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy });
  return runId;
}

async function waitingForHead(host: FactoryHost, runId: string): Promise<void> {
  await vi.waitFor(() => expect(host.runtime.status(runId)?.currentStep).toMatch(/^await-new-head/));
}

/** What the owner sees: the stored wake record, its timeline entry, and the watch row's next action. */
function seen({ host, store }: World, runId: string) {
  const run = host.runtime.status(runId)!;
  const wakeStep = Object.values(run.stepResults).find((result) => result.stepId.startsWith(WAKE_STEP))!;
  const entry = timelineEntries(run, []).find((item) => item.stepId === wakeStep.stepId);
  return { record: (wakeStep.data as { result: unknown }).result, entry, nextAction: watchRow({ registration: store.get().byRun(runId)!, run }).nextAction };
}

describe("what the watch view shows after a wake no fixer took", () => {
  it("says the seat was told only when the held send-back's notice was sent", async () => {
    const fake = fakeGitHub();
    const w = world(fake, "success", seat(false));
    fake.addPr({ headSha: H1 });
    const runId = start(w);

    await waitingForHead(w.host, runId);

    const { record, entry, nextAction } = seen(w, runId);
    expect(record).toEqual({ kind: "unhandled", reason: REFUSAL, held: { agent: "impl-a-s1" } });
    expect(entry).toMatchObject({ kind: "wake", outcome: "unhandled", held: REFUSAL });
    expect(nextAction).toBe(`no fixer could start (${REFUSAL}); the seat was told, waiting for a new head`);
  });

  it("does not claim the seat was told when the notice failed and the owner chose to await a new head", async () => {
    const fake = fakeGitHub();
    const w = world(fake, "success", seat(true));
    fake.addPr({ headSha: H1 });
    const runId = start(w);
    await gateOpened(w.host, gateId(runId, "sh-sent-back"));

    w.host.runtime.signal(runId, "sh-sent-back", { decision: "await-new-head" }, OWNER);
    await waitingForHead(w.host, runId);

    const { nextAction } = seen(w, runId);
    expect(nextAction).toBe(`no fixer could start (${REFUSAL}), waiting for a new head`);
    expect(nextAction).not.toContain("the seat was told");
  });

  it("records no hold for a ci-red wake, and shows none once the owner awaits a fix after the seat notice failed", async () => {
    const fake = fakeGitHub();
    const w = world(fake, "failure", seat(true));
    fake.addPr({ headSha: H1 });
    const runId = start(w);
    await gateOpened(w.host, gateId(runId, "ci-failed"));

    w.host.runtime.signal(runId, "ci-failed", { decision: "await-fix", headSha: H1 }, OWNER);
    await waitingForHead(w.host, runId);

    const { record, entry, nextAction } = seen(w, runId);
    expect(record).toEqual({ kind: "unhandled", reason: REFUSAL });
    expect(entry).not.toHaveProperty("held");
    expect(nextAction).not.toContain("no fixer could start");
    expect(nextAction).not.toContain("the seat was told");
  });
});
