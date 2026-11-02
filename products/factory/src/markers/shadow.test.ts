import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { StepRoute, WorkflowRun } from "@titan-design/workflow";
import { defineWorkflow } from "../definition.js";
import { advanceEpoch } from "../head-guard/epoch-store.js";
import { openFactoryHost, type FactoryHostOptions } from "../host.js";
import { fakeOwnerHelper } from "../test-support/owner-edges.js";
import { markerHistory } from "./marker-store.js";
import type { ShadowEvent } from "./shadow.js";

const PARAMS = { repo: "Fixture/Repo", pr: "7" };
const KEY = "fixture/repo#7";
const SHA = "c".repeat(40);
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

let ciRuns = 0;
const ciOutput = { verdict: "green", headSha: SHA, mergeableState: "clean" };
const routes: StepRoute[] = [
  { match: "ci-wait", onRestart: "repeat", runner: { run: async () => (ciRuns++, { ok: true, output: JSON.stringify(ciOutput) }) } },
  { match: "sh-await-verdict", onRestart: "repeat", runner: { run: async () => ({ ok: true, output: JSON.stringify({ outcome: "MERGE", head: SHA }) }) } },
];

const landFixture = defineWorkflow({
  name: "land-fixture",
  steps: [
    { id: "ci-wait", kind: "dispatch" },
    { id: "sh-await-verdict", kind: "dispatch" },
    { id: "fixture-approve", kind: "assisted" },
  ],
  run: async (ctx) => {
    await ctx.dispatch("ci-wait", "wait", { schema: z.looseObject({ verdict: z.string() }) });
    await ctx.dispatch("sh-await-verdict", "await", { schema: z.looseObject({ outcome: z.string() }) });
    await ctx.assisted("fixture-approve", "Land it?", { brief: { summary: "Land the fixture PR? Nothing else waits on it.", evidenceRef: "$ git log -1" } });
  },
});

function dbFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "marker-shadow-"));
  dirs.push(dir);
  return join(dir, "factory.sqlite3");
}

function hostAt(dbPath: string, events?: ShadowEvent[], diffPin?: () => Promise<never>) {
  const markerShadow: FactoryHostOptions["markerShadow"] = events && { sink: (event) => void events.push(event), ...(diffPin ? { diffPin } : {}) };
  const host = openFactoryHost({ dbPath, workflows: [landFixture], routes, gatePollMs: 10, ...(markerShadow ? { markerShadow } : {}) });
  advanceEpoch(host.db, { repo: PARAMS.repo, pr: 7, expectedEpoch: 0, head: SHA, by: "bootstrap", at: "2026-11-01T12:00:00.000Z" });
  return host;
}

async function runToGate(host: ReturnType<typeof hostAt>): Promise<WorkflowRun> {
  void fakeOwnerHelper(undefined);
  const id = host.runtime.start("land-fixture", PARAMS);
  await vi.waitFor(() => expect(host.runtime.status(id)?.status).toBe("paused"));
  return host.runtime.status(id)!;
}

const withoutClock = (run: WorkflowRun): string =>
  JSON.stringify(Object.values(run.stepResults).map(({ completedAt: _c, startedAt: _s, firstStartedAt: _f, ...rest }) => rest)).split(run.id).join("<run>");

describe("marker shadow", () => {
  it("the shadow leaves step_results byte-equal: one land run with the shadow on and one with it off", async () => {
    const [off, on] = [hostAt(dbFile()), hostAt(dbFile(), [])];
    const [plain, shadowed] = [await runToGate(off), await runToGate(on)];
    expect(withoutClock(shadowed)).toBe(withoutClock(plain));
    expect(markerHistory(on.db, { item: KEY, fact: "ci:green" })).toHaveLength(1);
    [off, on].forEach((host) => host.close());
  });

  it("a host opened without markerShadow writes no marker", async () => {
    const host = hostAt(dbFile());
    await runToGate(host);
    expect(host.db.prepare("SELECT count(*) AS n FROM factory_marker").get()).toEqual({ n: 0 });
    host.close();
  });

  it("a shadow failure is sent to the sink and the run completes", async () => {
    const events: ShadowEvent[] = [];
    const host = hostAt(dbFile(), events, () => Promise.reject(new Error("git is unavailable")));
    const run = await runToGate(host);
    expect(Object.keys(run.stepResults)).toEqual(["ci-wait:0", "sh-await-verdict:0"]);
    expect(events).toContainEqual(expect.objectContaining({ kind: "shadow-error", stepId: "sh-await-verdict", error: "git is unavailable" }));
    host.close();
  });

  it("a live ci-wait writes one ci:green marker joined to its run id and memo key", async () => {
    const host = hostAt(dbFile(), []);
    const run = await runToGate(host);
    expect(markerHistory(host.db, { item: KEY, fact: "ci:green" })).toEqual([
      expect.objectContaining({ pinClass: "tree", pin: `${SHA}@e1`, step: "ci-wait", runId: run.id, memoKey: "ci-wait:0", inputDigests: { "head:pushed": expect.objectContaining({ pin: `${SHA}@e1` }) } }),
    ]);
    host.close();
  });

  it("a replayed run appends no second marker", async () => {
    const dbPath = dbFile();
    const first = hostAt(dbPath, []);
    const run = await runToGate(first);
    first.close();
    const events: ShadowEvent[] = [];
    const second = hostAt(dbPath, events);
    await second.resume();
    expect(events.map((event) => event.stepId)).toContain("ci-wait");
    expect(markerHistory(second.db, { item: KEY, fact: "ci:green" }).map((row) => row.runId)).toEqual([run.id]);
    second.close();
  });

  it("the shadow reports would-fast-forward for a step whose marker is valid, and the step still runs live", async () => {
    const events: ShadowEvent[] = [];
    const host = hostAt(dbFile(), events);
    await runToGate(host);
    const before = ciRuns;
    await runToGate(host);
    const verdicts = events.filter((event) => event.kind === "verdict" && event.stepId === "ci-wait");
    expect(verdicts.map((event) => event.kind === "verdict" && event.wouldFastForward)).toEqual([false, true]);
    expect(ciRuns).toBe(before + 1);
    host.close();
  });

  it("a call to a step with no fact entry writes no marker", async () => {
    const events: ShadowEvent[] = [];
    const host = hostAt(dbFile(), events);
    await runToGate(host);
    expect(events.map((event) => event.stepId)).not.toContain("fixture-approve");
    expect(host.db.prepare("SELECT DISTINCT fact FROM factory_marker").all()).toEqual([{ fact: "ci:green" }]);
    host.close();
  });
});
