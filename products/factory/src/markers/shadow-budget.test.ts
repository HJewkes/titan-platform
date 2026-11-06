import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { StepRoute, WorkflowRun } from "@titan-design/workflow";
import { defineWorkflow, type WorkflowDefinition } from "../definition.js";
import { advanceEpoch } from "../head-guard/epoch-store.js";
import { unlessPast } from "../runner/not-after.js";
import { openFactoryHost, type FactoryHostOptions } from "../host.js";
import { markerHistory } from "./marker-store.js";
import type { ShadowEvent } from "./shadow.js";

const PARAMS = { repo: "Fixture/Repo", pr: "7" };
const SHA = "f".repeat(40);
const T0 = Date.parse("2026-11-01T12:00:00.000Z");
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const routes: StepRoute[] = [
  { match: "ci-wait", onRestart: "repeat", runner: { run: async () => ({ ok: true, output: JSON.stringify({ verdict: "green", headSha: SHA, mergeableState: "clean" }) }) } },
  { match: "sh-await-verdict", onRestart: "repeat", runner: { run: async () => ({ ok: true, output: JSON.stringify({ outcome: "MERGE", head: SHA }) }) } },
];

/** Three calls (two of them fact steps), then a gate, or a live call where a later revision replaced the gate. */
const threeCalls = (gate: boolean): WorkflowDefinition => defineWorkflow({
  name: "three-calls",
  steps: [
    { id: "ci-wait", kind: "dispatch" },
    { id: "sh-await-verdict", kind: "dispatch" },
    { id: "fixture-approve", kind: "assisted" },
  ],
  run: async (ctx) => {
    const schema = z.looseObject({});
    await ctx.dispatch("ci-wait", "wait", { schema });
    await ctx.dispatch("ci-wait", "wait", { schema });
    await ctx.dispatch("sh-await-verdict", "await", { schema });
    if (!gate) return void (await ctx.dispatch("sh-await-verdict", "await", { schema }));
    await ctx.assisted("fixture-approve", "Land it?", { brief: { summary: "Land the fixture PR? Nothing else waits on it.", evidenceRef: "$ git log -1" } });
  },
});

/** Two live advisory points after a first step that meets no fact, then two inserted steps each declaring notAfter on the fact `settle` meets. */
const advisory = defineWorkflow({
  name: "advisory",
  steps: [
    { id: "prepare", kind: "seed" },
    { id: "late-one", kind: "seed", notAfter: "landed" },
    { id: "late-two", kind: "seed", notAfter: "landed" },
  ],
  run: async (ctx) => {
    await unlessPast(ctx, "late-one", () => ctx.seed("late-one", async () => ({ data: {} })));
    await unlessPast(ctx, "late-two", () => ctx.seed("late-two", async () => ({ data: {} })));
  },
});

type Shadow = NonNullable<FactoryHostOptions["markerShadow"]>;

function hostAt(dbPath: string, options: { shadow?: Partial<Shadow>; now?: () => number; gate?: boolean } = {}) {
  const markerShadow = options.shadow && { sink: () => undefined, ...options.shadow };
  const host = openFactoryHost({ dbPath, workflows: [threeCalls(options.gate ?? false)], routes, gatePollMs: 10, now: options.now ?? (() => T0), ...(markerShadow ? { markerShadow } : {}) });
  advanceEpoch(host.db, { repo: PARAMS.repo, pr: 7, expectedEpoch: 0, head: SHA, by: "bootstrap", at: "2026-11-01T12:00:00.000Z" });
  return host;
}

function dbFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "shadow-budget-"));
  dirs.push(dir);
  return join(dir, "factory.sqlite3");
}

async function runUntil(host: ReturnType<typeof hostAt>, status: WorkflowRun["status"]): Promise<WorkflowRun> {
  const id = host.runtime.start("three-calls", PARAMS);
  await vi.waitFor(() => expect(host.runtime.status(id)?.status).toBe(status));
  return host.runtime.status(id)!;
}

const ofKind = <K extends ShadowEvent["kind"]>(events: ShadowEvent[], kind: K) => events.filter((event): event is Extract<ShadowEvent, { kind: K }> => event.kind === kind);
const withoutClock = (run: WorkflowRun): string =>
  JSON.stringify(Object.values(run.stepResults).map(({ completedAt: _c, startedAt: _s, firstStartedAt: _f, ...rest }) => rest)).split(run.id).join("<run>");

describe("the per-entry replay budget", () => {
  it("an entry over its evaluation cap sends one budget-exceeded and the run's step_results equal a shadow-off run", async () => {
    const events: ShadowEvent[] = [];
    const [off, on] = [hostAt(dbFile()), hostAt(dbFile(), { shadow: { sink: (event) => void events.push(event), entryBudget: { evaluations: 1, shadowMs: 60_000 } } })];

    const [plain, shadowed] = [await runUntil(off, "completed"), await runUntil(on, "completed")];

    expect(ofKind(events, "budget-exceeded")).toEqual([expect.objectContaining({ stepId: "ci-wait", memoKey: "ci-wait:0" })]);
    expect(ofKind(events, "verdict")).toHaveLength(1);
    expect(markerHistory(on.db, { item: "fixture/repo#7", fact: "ci:green" })).toEqual([]);
    expect(withoutClock(shadowed)).toBe(withoutClock(plain));
    [off, on].forEach((host) => host.close());
  });

  it("every entry sends entry-end with its replayed-call count", async () => {
    const dbPath = dbFile();
    const first = hostAt(dbPath, { shadow: {}, gate: true });
    const { id } = await runUntil(first, "paused");
    first.close();
    const events: ShadowEvent[] = [];
    const second = hostAt(dbPath, { shadow: { sink: (event) => void events.push(event) } });

    await second.adopt();
    await vi.waitFor(() => expect(ofKind(events, "entry-end")).toHaveLength(1));

    expect(Object.keys(second.runtime.status(id)!.stepResults)).toEqual(["ci-wait:0", "ci-wait:1", "sh-await-verdict:0", "sh-await-verdict:1"]);
    expect(ofKind(events, "entry-end")[0]).toMatchObject({ runId: id, counters: { replayed: 3 } });
    second.close();
  });

  it("the shadow's time is read from the injected clock, so the budget test counts work, not wall time", async () => {
    let now = T0;
    const events: ShadowEvent[] = [];
    // Each verdict the shadow reports costs 1.5 s on the host's clock, and nothing on the wall clock.
    const sink = (event: ShadowEvent) => {
      events.push(event);
      if (event.kind === "verdict") now += 1_500;
    };
    const host = hostAt(dbFile(), { now: () => now, shadow: { sink } });

    await runUntil(host, "completed");
    await vi.waitFor(() => expect(ofKind(events, "entry-end")).toHaveLength(1));

    expect(ofKind(events, "budget-exceeded").map((event) => [event.stepId, event.counters.shadowMs])).toEqual([["ci-wait", 3_000]]);
    expect(ofKind(events, "entry-end")[0]?.counters.shadowMs).toBe(3_000);
    host.close();
  });

  describe("the notAfter advisory evaluation", () => {
    async function advisoryEvents(entryBudget?: { evaluations: number; shadowMs: number }): Promise<ShadowEvent[]> {
      const events: ShadowEvent[] = [];
      const host = openFactoryHost({ dbPath: dbFile(), workflows: [advisory], registry: { entries: [{ name: "prepare", op: "seed" }, { name: "late-one", op: "seed" }, { name: "late-two", op: "seed" }, { name: "settle", op: "seed", fact: "landed" }] }, routes, now: () => T0, markerShadow: { sink: (event) => void events.push(event), ...(entryBudget ? { entryBudget } : {}) } });
      const id = host.runtime.start("advisory", PARAMS);
      await vi.waitFor(() => expect(host.runtime.status(id)?.status).toBe("completed"));
      await vi.waitFor(() => expect(ofKind(events, "entry-end")).toHaveLength(1));
      host.close();
      return events;
    }

    it("an advisory evaluation is counted in the entry-end counters", async () => {
      const events = await advisoryEvents();

      expect(ofKind(events, "entry-end")[0]?.counters.evaluations).toBe(2);
      expect(ofKind(events, "budget-exceeded")).toEqual([]);
    });

    it("a spent meter skips the advisory evaluation and writes one budget-exceeded", async () => {
      const events = await advisoryEvents({ evaluations: 1, shadowMs: 60_000 });

      expect(ofKind(events, "budget-exceeded")).toEqual([expect.objectContaining({ stepId: "late-one" })]);
      expect(ofKind(events, "entry-end")[0]?.counters.evaluations).toBe(1);
    });
  });
});
