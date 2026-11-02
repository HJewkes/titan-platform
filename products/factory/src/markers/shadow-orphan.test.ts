import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { StepRoute, WorkflowRun } from "@titan-design/workflow";
import { defineWorkflow, type WorkflowDefinition } from "../definition.js";
import { advanceEpoch } from "../head-guard/epoch-store.js";
import { openFactoryHost } from "../host.js";
import { fakeOwnerHelper } from "../test-support/owner-edges.js";
import { markerHistory } from "./marker-store.js";
import type { ShadowEvent, ShadowSink } from "./shadow.js";

const PARAMS = { repo: "Fixture/Repo", pr: "7" };
const KEY = "fixture/repo#7";
const SHA = "d".repeat(40);
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const routes: StepRoute[] = [
  { match: "ci-wait", onRestart: "repeat", runner: { run: async () => ({ ok: true, output: JSON.stringify({ verdict: "green", headSha: SHA, mergeableState: "clean" }) }) } },
  { match: "sh-await-verdict", onRestart: "repeat", runner: { run: async () => ({ ok: true, output: JSON.stringify({ outcome: "MERGE", head: SHA }) }) } },
];

/** The land fixture; a later revision of the recipe can skip `ci-wait`, and can finish without its gate. */
function landFixture(options: { ci: () => boolean; gate: boolean }): WorkflowDefinition {
  return defineWorkflow({
    name: "land-fixture",
    steps: [
      { id: "ci-wait", kind: "dispatch" },
      { id: "sh-await-verdict", kind: "dispatch" },
      { id: "fixture-approve", kind: "assisted" },
    ],
    run: async (ctx) => {
      if (options.ci()) await ctx.dispatch("ci-wait", "wait", { schema: z.looseObject({ verdict: z.string() }) });
      await ctx.dispatch("sh-await-verdict", "await", { schema: z.looseObject({ outcome: z.string() }) });
      if (options.gate) await ctx.assisted("fixture-approve", "Land it?", { brief: { summary: "Land the fixture PR? Nothing else waits on it.", evidenceRef: "$ git log -1" } });
    },
  });
}

const ORIGINAL = landFixture({ ci: () => true, gate: true });
const SKIPS_CI = landFixture({ ci: () => false, gate: false });

function dbFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "shadow-orphan-"));
  dirs.push(dir);
  return join(dir, "factory.sqlite3");
}

function hostAt(dbPath: string, workflow: WorkflowDefinition, events?: ShadowEvent[], sink?: ShadowSink) {
  const markerShadow = events && { sink: sink ?? ((event: ShadowEvent) => void events.push(event)) };
  const host = openFactoryHost({ dbPath, workflows: [workflow], routes, gatePollMs: 10, ...(markerShadow ? { markerShadow } : {}) });
  advanceEpoch(host.db, { repo: PARAMS.repo, pr: 7, expectedEpoch: 0, head: SHA, by: "bootstrap", at: "2026-11-01T12:00:00.000Z" });
  return host;
}

/** Drives the original recipe to its gate in one host, so the run holds `ci-wait:0` and `sh-await-verdict:0`. */
async function gatedRun(dbPath: string, events?: ShadowEvent[]): Promise<string> {
  void fakeOwnerHelper(undefined);
  const host = hostAt(dbPath, ORIGINAL, events);
  const id = host.runtime.start("land-fixture", PARAMS);
  await vi.waitFor(() => expect(host.runtime.status(id)?.status).toBe("paused"));
  host.close();
  return id;
}

async function adoptUntil(host: ReturnType<typeof hostAt>, id: string, done: (run: WorkflowRun) => boolean): Promise<WorkflowRun> {
  await host.adopt();
  await vi.waitFor(() => expect(done(host.runs.get(id)!)).toBe(true));
  return host.runs.get(id)!;
}

const orphansIn = (events: ShadowEvent[]) => events.filter((event) => event.kind === "call-site-orphan");
const released = (status: WorkflowRun["status"]) => (run: WorkflowRun) => run.status === status && !run.owner;
const withoutClock = (run: WorkflowRun): string =>
  JSON.stringify(Object.values(run.stepResults).map(({ completedAt: _c, startedAt: _s, firstStartedAt: _f, ...rest }) => rest)).split(run.id).join("<run>");

describe("the call-site orphan trap on the host", () => {
  it("A17: a recipe changed to skip ci-wait sends one call-site-orphan to the sink and the run completes on the blob", async () => {
    const dbPath = dbFile();
    const id = await gatedRun(dbPath, []);
    const events: ShadowEvent[] = [];
    // The disagreement log failing on the orphan must not reach the run either.
    const failingLog: ShadowSink = (event) => {
      events.push(event);
      if (event.kind === "call-site-orphan") throw new Error("disagreement log is down");
    };
    const host = hostAt(dbPath, SKIPS_CI, events, failingLog);

    const run = await adoptUntil(host, id, released("completed"));

    expect(orphansIn(events)).toEqual([expect.objectContaining({ runId: id, callSite: "land-fixture/ci-wait", fact: "ci:green", failClosed: true })]);
    expect(Object.keys(run.stepResults)).toEqual(["ci-wait:0", "sh-await-verdict:0"]);
    host.close();
  });

  it("the same orphan across two drives of one host is sent once", async () => {
    const dbPath = dbFile();
    const id = await gatedRun(dbPath, []);
    const events: ShadowEvent[] = [];
    const host = hostAt(dbPath, landFixture({ ci: () => false, gate: true }), events);

    await adoptUntil(host, id, released("recovery_required"));
    const verdictsAfterFirst = events.filter((event) => event.kind === "verdict").length;
    await host.adopt();
    await vi.waitFor(() => expect(events.filter((event) => event.kind === "verdict").length).toBeGreaterThan(verdictsAfterFirst));
    await vi.waitFor(() => expect(released("recovery_required")(host.runs.get(id)!)).toBe(true));

    expect(orphansIn(events)).toHaveLength(1);
    host.close();
  });

  it("after an orphan the shadow reports no would-fast-forward for that run", async () => {
    const dbPath = dbFile();
    const id = await gatedRun(dbPath, []);
    let callsCi = false;
    const events: ShadowEvent[] = [];
    const host = hostAt(dbPath, landFixture({ ci: () => callsCi, gate: true }), events);
    await adoptUntil(host, id, released("recovery_required"));
    callsCi = true;

    await adoptUntil(host, id, (run) => run.status === "paused");

    const ciVerdicts = events.filter((event) => event.kind === "verdict" && event.stepId === "ci-wait");
    expect(ciVerdicts.map((event) => event.kind === "verdict" && [event.verdict.status, event.wouldFastForward])).toEqual([["valid", false]]);
    expect(orphansIn(events)).toHaveLength(1);
    host.close();
  });

  it("step_results are byte-equal with the shadow on and off on a run that has an orphan", async () => {
    const [offPath, onPath] = [dbFile(), dbFile()];
    const [offId, onId] = [await gatedRun(offPath), await gatedRun(onPath, [])];
    const events: ShadowEvent[] = [];
    const [off, on] = [hostAt(offPath, SKIPS_CI), hostAt(onPath, SKIPS_CI, events)];

    const [plain, shadowed] = [await adoptUntil(off, offId, released("completed")), await adoptUntil(on, onId, released("completed"))];

    expect(orphansIn(events)).toHaveLength(1);
    expect(withoutClock(shadowed)).toBe(withoutClock(plain));
    [off, on].forEach((host) => host.close());
  });

  it("a marker's call_site is the workflow and its declared step id", async () => {
    const dbPath = dbFile();

    await gatedRun(dbPath, []);

    const host = hostAt(dbPath, ORIGINAL);
    expect(markerHistory(host.db, { item: KEY, fact: "ci:green" }).map((row) => row.callSite)).toEqual(["land-fixture/ci-wait"]);
    host.close();
  });
});
