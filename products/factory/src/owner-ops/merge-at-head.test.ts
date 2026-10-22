import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { successRun } from "@titan-design/github";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Outcome } from "../console-action/outcome.js";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { LAND_WORKFLOW } from "../registry.js";
import { OWNER_GATE_POLICY } from "../shepherd/policy.js";
import { callCommand, shepherdFixture, shepherdRuns, type ShepherdFixture } from "../test-support/shepherd.js";
import { mergeAtHead } from "./merge-at-head.js";
import { standingAnswers, sweepStandingAnswers, type StandingAnswers } from "./standing-answers.js";

const REPO = "example-org/example-repo";
const H = "a".repeat(40);
const H2 = "b".repeat(40);
const CONFIRM = `action:${"d".repeat(64)}`;
const NOW_MS = Date.parse("2026-10-18T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

const hosts: FactoryHost[] = [];
const dirs: string[] = [];
afterEach(() => {
  hosts.splice(0).forEach((host) => host.close());
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

interface World {
  fixture: ShepherdFixture;
  host: FactoryHost;
  answers: StandingAnswers;
  pr: number;
  tap(confirmEvent?: string, at?: number): Promise<Outcome>;
  sweep(at?: number): ReturnType<typeof sweepStandingAnswers>;
}

function world(fields: { behind?: boolean } = {}): World {
  const fixture = shepherdFixture();
  const host = openFactoryHost({ dbPath: ":memory:", workflows: fixture.workflows, routes: fixture.routes, gatePollMs: 5 });
  hosts.push(host);
  const dir = mkdtempSync(join(tmpdir(), "factory-merge-at-head-"));
  dirs.push(dir);
  const answers = standingAnswers(dir);
  const { number: pr } = fixture.fake.addPr({ headSha: H, ...fields });
  const services = fixture.routes.shepherd!;
  const deps = (at: number) => ({ host, port: services.port, services, answers, now: () => at });
  return {
    fixture,
    host,
    answers,
    pr,
    tap: (confirmEvent = CONFIRM, at = NOW_MS) => mergeAtHead("act-1", { op: { kind: "merge-at-head", repo: REPO, pr, headSha: H }, confirmEvent }, deps(at)),
    sweep: (at = NOW_MS) => sweepStandingAnswers(host, services, answers, new Date(at)),
  };
}

const landRuns = (host: FactoryHost) => host.runtime.list(["running", "paused", "completed", "failed", "cancelled"]).filter((run) => run.workflowName === LAND_WORKFLOW);

async function gateAt(host: FactoryHost, runId: string): Promise<string> {
  await vi.waitFor(() => expect(host.gates.get(`${runId}/approve-merge`)?.status).toBe("pending"));
  return `${runId}/approve-merge`;
}

async function accepted(w: World): Promise<string> {
  const outcome = await w.tap();
  if (outcome.outcome !== "accepted") throw new Error(`expected accepted, got ${JSON.stringify(outcome)}`);
  return outcome.runId;
}

describe("merge-at-head", () => {
  it("starts one land-pr that never updates the branch and answers accepted; a replay answers already with that run", async () => {
    const w = world();

    const runId = await accepted(w);
    const replay = await w.tap();

    expect(replay).toEqual({ outcome: "already", runId });
    expect(landRuns(w.host).map((run) => [run.id, run.params])).toEqual([[runId, { repo: REPO, pr: String(w.pr), update: "false" }]]);
  });

  it("resolves the land gate at the confirmed head as owner-remote with this tap's confirm event, and the PR merges", async () => {
    const w = world();
    const runId = await accepted(w);
    const gateId = await gateAt(w.host, runId);

    const swept = await w.sweep();
    await w.host.runtime.wait(runId);

    expect(swept).toEqual([{ kind: "resolved", actionId: "act-1", runId, gateId }]);
    expect(w.host.gates.get(gateId)?.resolvedBy).toMatchObject({ class: "owner-remote", id: "titan-console", confirmEvent: CONFIRM });
    expect(w.fixture.fake.effects.merge).toBe(1);
    expect(await w.tap()).toEqual({ outcome: "already", runId });
  });

  it("leaves a gate that asks about another head pending, and the replay reads moved", async () => {
    const w = world();
    const green = w.fixture.fake.onGetPr!;
    let reads = 0;
    w.fixture.fake.onGetPr = (pull, ...rest) => {
      // The tap reads H; a push lands before land-pr's first read.
      if (++reads === 2) pull.headSha = H2;
      green(pull, ...rest);
    };
    const runId = await accepted(w);
    const gateId = await gateAt(w.host, runId);

    const swept = await w.sweep();

    expect(swept).toEqual([{ kind: "pending", actionId: "act-1", runId, reason: `the gate asks about head ${H2}, the owner confirmed ${H}` }]);
    expect(w.host.gates.get(gateId)?.status).toBe("pending");
    expect(w.fixture.fake.effects.merge).toBe(0);
    expect(await w.tap()).toEqual({ outcome: "moved", currentHead: H2 });
  });

  it("never answers once the standing answer has expired", async () => {
    const w = world();
    const runId = await accepted(w);
    const gateId = await gateAt(w.host, runId);

    const swept = await w.sweep(NOW_MS + DAY_MS);

    expect(swept).toEqual([]);
    expect(w.host.gates.get(gateId)?.status).toBe("pending");
    expect(await w.tap(CONFIRM, NOW_MS + DAY_MS)).toMatchObject({ outcome: "gone" });
  });

  it("stops a strict-behind PR as behind with no update-branch call", async () => {
    const w = world({ behind: true });

    const runId = await accepted(w);
    await w.host.runtime.wait(runId);

    expect(w.host.runtime.status(runId)?.status).toBe("completed");
    expect(w.fixture.fake.effects).toMatchObject({ updateBranch: 0, merge: 0 });
    expect(w.host.gates.get(`${runId}/approve-merge`)).toBeUndefined();
  });

  it("never reaches a gate on a red required check, so the tap merges nothing", async () => {
    const w = world();
    w.fixture.fake.onGetPr = (pull) => w.fixture.fake.setRuns(pull.headSha, [successRun("validate", 1, undefined, "failure"), successRun("dag-check", 2)]);

    const runId = await accepted(w);
    await vi.waitFor(() => expect(w.host.gates.get(`${runId}/ci-failed`)?.status).toBe("pending"));
    await w.sweep();

    expect(w.host.gates.get(`${runId}/approve-merge`)).toBeUndefined();
    expect(w.fixture.fake.effects.merge).toBe(0);
  });

  it("refuses a PR under an owner-asked hold, and leaves a land gate pending when that hold is placed after the tap", async () => {
    const w = world();
    const runId = await accepted(w);
    const gateId = await gateAt(w.host, runId);
    const store = w.fixture.routes.shepherd!.store.get();
    store.register({ repo: REPO, pr: w.pr, runId: "run-held", task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY });
    store.hold("run-held", "owner-asked: synthetic question");

    const swept = await w.sweep();
    const fresh = await w.tap(`action:${"e".repeat(64)}`);

    expect(swept).toEqual([expect.objectContaining({ kind: "pending", reason: expect.stringContaining("owner-asked") })]);
    expect(w.host.gates.get(gateId)?.status).toBe("pending");
    expect(fresh).toMatchObject({ outcome: "refused", reason: "class" });
  });

  it("resolves the Shepherd run's pending approve-merge at the confirmed head and starts no land-pr", async () => {
    const w = world();
    const registered = await callCommand<{ runId: string }>(w.host, w.fixture.routes, "shepherd.register", { repo: REPO, pr: w.pr, task: "demo/T-1", implementer: "impl-a" });
    if (!registered.ok) throw new Error(registered.error);
    const gateId = await gateAt(w.host, registered.data.runId);

    const outcome = await w.tap();

    expect(outcome).toEqual({ outcome: "resolved", gateId });
    expect(w.host.gates.get(gateId)?.resolvedBy).toMatchObject({ class: "owner-remote", confirmEvent: CONFIRM });
    expect(landRuns(w.host)).toEqual([]);
    expect(await w.tap()).toEqual({ outcome: "already", gateId });
  });

  it("after land merges, ends the PR's live Shepherd run", async () => {
    const w = world();
    const runId = await accepted(w);
    await gateAt(w.host, runId);
    const registered = await callCommand<{ runId: string }>(w.host, w.fixture.routes, "shepherd.register", { repo: REPO, pr: w.pr, task: "demo/T-1", implementer: "impl-a" });
    if (!registered.ok) throw new Error(registered.error);
    await w.sweep();
    await w.host.runtime.wait(runId);

    await w.sweep();

    expect(shepherdRuns(w.host)).toEqual([registered.data.runId]);
    await vi.waitFor(() => expect(w.host.runtime.status(registered.data.runId)?.status).toBe("cancelled"));
  });
});
