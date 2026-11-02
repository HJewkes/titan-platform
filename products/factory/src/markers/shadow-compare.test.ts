import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { StepRoute, WorkflowRun } from "@titan-design/workflow";
import { defineWorkflow } from "../definition.js";
import { advanceEpoch } from "../head-guard/epoch-store.js";
import { openFactoryHost } from "../host.js";
import { isFactEntry } from "../registry/entry.js";
import { entryFor } from "../registry/registry.js";
import { factoryRegistry } from "../registry/steps/index.js";
import { fakeOwnerHelper } from "../test-support/owner-edges.js";
import { projectionDigest } from "./projection.js";
import { logSink, readLog } from "./shadow-diff/log.js";
import type { ShadowEvent, ShadowSink } from "./shadow.js";

const PARAMS = { repo: "Fixture/Repo", pr: "7" };
const SHA = "d".repeat(40);
const GREEN = { verdict: "green", headSha: SHA, mergeableState: "clean" };
const RED = { verdict: "red", headSha: SHA, mergeableState: "clean" };
const NOW = "2026-11-01T12:00:00.000Z";
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** Awaits the verdict only on green, so a run that saw a different CI answer records different step_results. */
const ciFixture = defineWorkflow({
  name: "ci-fixture",
  steps: [
    { id: "ci-wait", kind: "dispatch" },
    { id: "sh-await-verdict", kind: "dispatch" },
    { id: "fixture-approve", kind: "assisted" },
  ],
  run: async (ctx) => {
    const ci = await ctx.dispatch("ci-wait", "wait", { schema: z.looseObject({ verdict: z.string() }) });
    if (ci.data?.verdict !== "green") return;
    await ctx.dispatch("sh-await-verdict", "await", { schema: z.looseObject({ outcome: z.string() }) });
    await ctx.assisted("fixture-approve", "Land it?", { brief: { summary: "Land the fixture PR? Nothing else waits on it.", evidenceRef: "$ git log -1" } });
  },
});

function dbFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "shadow-compare-"));
  dirs.push(dir);
  return join(dir, "factory.sqlite3");
}

type Shadow = "off" | "log" | ShadowSink;

/** `ci-wait` answers from `answers` in order and then green; "log" persists every event to the host's own log table. */
function hostAt(dbPath: string, shadow: Shadow, answers: object[] = []) {
  const routes: StepRoute[] = [
    { match: "ci-wait", onRestart: "repeat", runner: { run: async () => ({ ok: true, output: JSON.stringify(answers.shift() ?? GREEN) }) } },
    { match: "sh-await-verdict", onRestart: "repeat", runner: { run: async () => ({ ok: true, output: JSON.stringify({ outcome: "MERGE", head: SHA }) }) } },
  ];
  let sink: ShadowSink = typeof shadow === "function" ? shadow : () => undefined;
  const markerShadow = shadow === "off" ? {} : { markerShadow: { sink: (event: ShadowEvent) => sink(event) } };
  const host = openFactoryHost({ dbPath, workflows: [ciFixture], routes, gatePollMs: 10, ...markerShadow });
  if (shadow === "log") sink = logSink(host.db, () => NOW);
  advanceEpoch(host.db, { repo: PARAMS.repo, pr: 7, expectedEpoch: 0, head: SHA, by: "bootstrap", at: NOW });
  return host;
}

async function drive(host: ReturnType<typeof hostAt>): Promise<WorkflowRun> {
  void fakeOwnerHelper(undefined);
  const id = host.runtime.start("ci-fixture", PARAMS);
  await vi.waitFor(() => expect(host.runtime.status(id)?.status).toMatch(/^(paused|completed)$/));
  return host.runtime.status(id)!;
}

const compareRows = (host: ReturnType<typeof hostAt>, runId: string) => readLog(host.db, { sinceIso: "" }).filter((row) => row.kind === "compare" && row.runId === runId);

const withoutClock = (run: WorkflowRun): string =>
  JSON.stringify(Object.values(run.stepResults).map(({ completedAt: _c, startedAt: _s, firstStartedAt: _f, ...rest }) => rest)).split(run.id).join("<run>");

describe("the marker shadow compares each live fact call", () => {
  it("a live ci-wait call with a valid marker and the same green answer logs one hit row in the tree family", async () => {
    const host = hostAt(dbFile(), "log");
    await drive(host);
    const second = await drive(host);
    expect(compareRows(host, second.id).filter((row) => row.memoKey === "ci-wait:0")).toEqual([
      expect.objectContaining({ family: "tree", class: "hit", step: "ci-wait", materialValid: true, fullValid: true, drift: [] }),
    ]);
    host.close();
  });

  it("the row's live projection equals projectionDigest of the step_results entry read back from the database", async () => {
    const host = hostAt(dbFile(), "log");
    const run = await drive(host);
    const stored = host.db.prepare<[string], { stepResults: string }>("SELECT step_results AS stepResults FROM workflow_run WHERE id = ?").get(run.id);
    const ciResult = z.record(z.string(), z.looseObject({ data: z.unknown() })).parse(JSON.parse(stored!.stepResults))["ci-wait:0"];
    const entry = entryFor(factoryRegistry, "ci-wait");
    if (!entry || !isFactEntry(entry)) throw new Error("ci-wait is a fact entry");
    const [row] = compareRows(host, run.id).filter((logged) => logged.memoKey === "ci-wait:0");
    expect(row?.detail).toEqual({ liveProjection: projectionDigest(entry, ciResult?.data) });
    host.close();
  });

  it("a fact step replayed from the record logs no compare row", async () => {
    const dbPath = dbFile();
    const first = hostAt(dbPath, "off");
    await drive(first);
    first.close();
    const events: ShadowEvent[] = [];
    const second = hostAt(dbPath, (event) => void events.push(event));
    await second.adopt();
    await vi.waitFor(() => expect(events.map((event) => event.stepId)).toContain("sh-await-verdict"));
    const live = await drive(second);
    const compared = events.filter((event) => event.kind === "compare").map((event) => [event.runId, event.stepId]);
    expect(compared).toEqual([
      [live.id, "ci-wait"],
      [live.id, "sh-await-verdict"],
    ]);
    second.close();
  });

  it("a second drive of the same run adds no compare row", async () => {
    const dbPath = dbFile();
    const first = hostAt(dbPath, "log");
    const run = await drive(first);
    const logged = compareRows(first, run.id);
    expect(logged.map((row) => row.step)).toEqual(["ci-wait", "sh-await-verdict"]);
    first.close();
    const second = hostAt(dbPath, "log");
    await second.adopt();
    await vi.waitFor(() => expect(readLog(second.db, { sinceIso: "" }).filter((row) => row.kind === "verdict" && row.step === "sh-await-verdict")).toHaveLength(2));
    expect(compareRows(second, run.id)).toEqual(logged);
    second.close();
  });

  it("A17: step_results are byte-equal with the shadow on and off on a run with a false-hit", async () => {
    const events: ShadowEvent[] = [];
    const brokenLog: ShadowSink = (event) => {
      events.push(event);
      if (event.kind === "compare") throw new Error("the log is unwritable");
    };
    const [off, on] = [hostAt(dbFile(), "off", [GREEN, RED]), hostAt(dbFile(), brokenLog, [GREEN, RED])];
    await Promise.all([drive(off), drive(on)]);
    const [plain, shadowed] = [await drive(off), await drive(on)];
    expect(events).toContainEqual(expect.objectContaining({ kind: "compare", runId: shadowed.id, row: expect.objectContaining({ class: "false-hit" }) }));
    expect(withoutClock(shadowed)).toBe(withoutClock(plain));
    expect(shadowed.status).toBe("completed");
    [off, on].forEach((host) => host.close());
  });
});
