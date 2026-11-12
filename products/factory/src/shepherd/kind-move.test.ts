import type { StepResult } from "@titan-design/workflow";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO } from "../test-support/land.js";
import { BRANCH, callCommand, shepherdFixture, type ShepherdFixture } from "../test-support/shepherd.js";
import type { Registered } from "./commands.js";

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

interface World extends ShepherdFixture {
  host: FactoryHost;
  call: <T>(name: string, args: unknown) => ReturnType<typeof callCommand<T>>;
}

/** A frozen run never sleeps past its first wait, so it stays short of review unless a test says otherwise. */
function world(): World {
  const fixture = shepherdFixture({ frozen: true });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: fixture.workflows, routes: fixture.routes, gatePollMs: 5 });
  hosts.push(host);
  fixture.fake.addPr({ headSha: H1, headRef: BRANCH });
  return { ...fixture, host, call: (name, args) => callCommand(host, fixture.routes, name, args) };
}

/** A synthetic replay of a correctness PR whose proof cannot reproduce: an exit-code rename to the same value. */
const RENAME_PR = { repo: REPO, pr: 1, task: "demo/T-1", implementer: "impl-a", kind: "correctness" };
const MOVE = { ...RENAME_PR, kind: "refactor", kindReason: "renames an exit code to the same value; no behaviour changes", actor: "seat-a" };

async function registeredRun(w: World): Promise<string> {
  const envelope = await w.call<Registered>("shepherd.register", RENAME_PR);
  if (!envelope.ok) throw new Error(envelope.error);
  return envelope.data.runId;
}

const reviewStep = (stepId: string): StepResult => ({ stepId, iteration: 0, operation: "dispatch", agentId: null, signal: null, completedAt: "2026-11-01T00:00:00Z", data: { result: {} } });

/** The run reads as having recorded `stepId`, as a run whose review has started does. */
function withStep(w: World, runId: string, stepId: string): void {
  const status = w.host.runtime.status.bind(w.host.runtime);
  vi.spyOn(w.host.runtime, "status").mockImplementation((id) => {
    const run = status(id);
    return id === runId && run ? { ...run, stepResults: { ...run.stepResults, [`${stepId}:0`]: reviewStep(stepId) } } : run;
  });
}

const kindMoves = (w: World, runId: string) => w.routes.shepherd!.store.get().eventsOf(runId).filter((event) => event.kind === "kind-move");

describe("moving a correctness run's kind before review (TP-5399)", () => {
  it.each(["refactor", "feature"])("moves a correctness run to %s before any review, and records who moved it and why", async (kind) => {
    const w = world();
    const runId = await registeredRun(w);

    const moved = await w.call<Registered>("shepherd.register", { ...MOVE, kind });

    expect(moved).toMatchObject({ ok: true, data: { runId, registration: { kind } } });
    expect(kindMoves(w, runId)).toEqual([expect.objectContaining({ actor: "seat-a", reason: `kind correctness -> ${kind}: ${MOVE.kindReason}` })]);
  });

  it.each([
    ["the fix-proof read", "sh-fix-proof:" + H1, true],
    ["a review intent", "sh-review-intent:" + H1, false],
    ["a reviewer dispatch", "sh-review:" + H1, false],
    ["a verdict wait", "sh-await-verdict:" + H1, false],
  ])("after %s, %s", async (_, stepId, allowed) => {
    const w = world();
    const runId = await registeredRun(w);
    withStep(w, runId, stepId);

    const moved = await w.call<Registered>("shepherd.register", MOVE);

    expect(moved.ok).toBe(allowed);
    if (!allowed) expect(moved).toMatchObject({ error: expect.stringContaining("a review has started") });
    expect(w.routes.shepherd!.store.get().byRun(runId)?.kind).toBe(allowed ? "refactor" : "correctness");
    expect(kindMoves(w, runId)).toHaveLength(allowed ? 1 : 0);
  });

  it("refuses the move without a reason and leaves the run and its events alone", async () => {
    const w = world();
    const runId = await registeredRun(w);

    const moved = await w.call<Registered>("shepherd.register", { ...RENAME_PR, kind: "refactor" });

    expect(moved).toMatchObject({ ok: false, error: expect.stringContaining("without --kind-reason") });
    expect(w.routes.shepherd!.store.get().byRun(runId)?.kind).toBe("correctness");
    expect(kindMoves(w, runId)).toEqual([]);
  });

  it("refuses a move to unknown, which no early move reaches", async () => {
    const w = world();
    await registeredRun(w);

    expect(await w.call<Registered>("shepherd.register", { ...MOVE, kind: "unknown" })).toMatchObject({ ok: false, error: expect.stringContaining("outside the fix-proof kinds") });
  });
});
