import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiffPin } from "@titan-design/github";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { StepRoute, WorkflowRun } from "@titan-design/workflow";
import { defineWorkflow } from "../definition.js";
import { advanceEpoch } from "../head-guard/epoch-store.js";
import { openFactoryHost } from "../host.js";
import type { CarryProbe } from "./shadow-diff/carry-rows.js";
import { logSink, readLog } from "./shadow-diff/log.js";
import type { ShadowEvent, ShadowSink } from "./shadow.js";

const PARAMS = { repo: "Fixture/Repo", pr: "7" };
const [REVIEWED, WS_HEAD, OTHER_HEAD, SHA] = ["a".repeat(40), "b".repeat(40), "c".repeat(40), "d".repeat(40)];
const NOW = "2026-11-01T12:00:00.000Z";
const PROBE_MS = 500;
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const evidence = (head: string) => ({ result: { record: { head, carry: { fromHead: REVIEWED, head, rule: "remerge-empty" } } } });

/** Records one carried MERGE's evidence per head, as Shepherd's evidence step does, then a fact step for the miss test. */
const fixture = defineWorkflow({
  name: "carry-fixture",
  steps: [
    { id: "sh-merge-evidence", kind: "dispatch" },
    { id: "ci-wait", kind: "dispatch" },
  ],
  run: async (ctx) => {
    for (const head of z.array(z.string()).parse(JSON.parse(ctx.param("carried") ?? "[]"))) await ctx.dispatch(`sh-merge-evidence:${head}`, "evidence", { schema: z.looseObject({ result: z.unknown() }) });
    await ctx.dispatch("ci-wait", "wait", { schema: z.looseObject({ verdict: z.string() }) });
  },
});

const exact = (full: string, core: string): DiffPin => ({ kind: "exact", head: WS_HEAD, base: "m1", main: "m1", full, core });
const whitespaceOnly = { reviewed: exact("f1", "c1"), current: exact("f2", "c2"), mergeUp: { ok: false, reason: "conflict" }, headIsMerge: false, wsBlindCoreEqual: true } as const;

/** Each probe call moves the host clock by PROBE_MS, so the entry meter shows whether it timed the probe. */
function hostAt(sink: ShadowSink, carryProbe?: CarryProbe) {
  const green = { verdict: "green", headSha: SHA, mergeableState: "clean" };
  const routes: StepRoute[] = [
    { match: "sh-merge-evidence", onRestart: "repeat", runner: { run: async (step) => ({ ok: true, output: JSON.stringify(evidence(step.stepId.split(":")[1]!)) }) } },
    { match: "ci-wait", onRestart: "repeat", runner: { run: async () => ({ ok: true, output: JSON.stringify(green) }) } },
  ];
  const dir = mkdtempSync(join(tmpdir(), "shadow-carry-"));
  dirs.push(dir);
  const clock = { offset: 0 };
  const probe = carryProbe && { carryProbe: (...args: Parameters<CarryProbe>) => ((clock.offset += PROBE_MS), carryProbe(...args)) };
  const host = openFactoryHost({ dbPath: join(dir, "factory.sqlite3"), workflows: [fixture], routes, gatePollMs: 10, now: () => Date.now() + clock.offset, markerShadow: { sink, ...probe } });
  advanceEpoch(host.db, { repo: PARAMS.repo, pr: 7, expectedEpoch: 0, head: SHA, by: "bootstrap", at: NOW });
  return host;
}

async function drive(host: ReturnType<typeof hostAt>, carried: string[]): Promise<WorkflowRun> {
  const id = host.runtime.start("carry-fixture", { ...PARAMS, carried: JSON.stringify(carried) });
  await vi.waitFor(() => expect(host.runtime.status(id)?.status).toMatch(/^(completed|failed)$/));
  return host.runtime.status(id)!;
}

describe("the marker shadow logs each carried MERGE at entry end", () => {
  it("a Shepherd run that carries a MERGE across a whitespace-only change logs one pin-differs row with cause whitespace", async () => {
    const events: ShadowEvent[] = [];
    let log: ShadowSink = () => undefined;
    const host = hostAt((event) => (events.push(event), log(event)), async () => whitespaceOnly);
    log = logSink(host.db, () => NOW);
    const run = await drive(host, [WS_HEAD]);
    const rows = readLog(host.db, { sinceIso: "" }).filter((row) => row.kind === "compare" && row.memoKey?.startsWith("carry:"));
    expect(rows).toEqual([expect.objectContaining({ runId: run.id, memoKey: `carry:${WS_HEAD}`, family: "diff", fact: "verdict:merge", class: "pin-differs", cause: "whitespace", item: "fixture/repo#7" })]);
    const entryEnd = events.find((event) => event.kind === "entry-end");
    expect(entryEnd?.kind === "entry-end" && entryEnd.counters.shadowMs).toBeGreaterThanOrEqual(PROBE_MS);
    host.close();
  });

  it("a probe that throws logs shadow-error and the run completes on the blob", async () => {
    const events: ShadowEvent[] = [];
    const probe: CarryProbe = async (_item, _from, head) => {
      if (head === WS_HEAD) throw new Error("the mirror is unreachable");
      return whitespaceOnly;
    };
    const host = hostAt((event) => void events.push(event), probe);
    const run = await drive(host, [WS_HEAD, OTHER_HEAD]);
    expect(run.status).toBe("completed");
    expect(events).toContainEqual(expect.objectContaining({ kind: "shadow-error", memoKey: `carry:${WS_HEAD}`, error: "the mirror is unreachable" }));
    expect(events.filter((event) => event.kind === "compare" && event.memoKey.startsWith("carry:")).map((event) => event.memoKey)).toEqual([`carry:${OTHER_HEAD}`]);
    host.close();
  });

  it("a miss whose live projection equals the previous marker's logs miss-same-output", async () => {
    const events: ShadowEvent[] = [];
    const host = hostAt((event) => void events.push(event));
    await drive(host, []);
    advanceEpoch(host.db, { repo: PARAMS.repo, pr: 7, expectedEpoch: 1, head: SHA, by: "fast-forward", at: NOW });
    const second = await drive(host, []);
    const compared = events.filter((event) => event.kind === "compare" && event.runId === second.id);
    expect(compared).toEqual([expect.objectContaining({ stepId: "ci-wait", row: expect.objectContaining({ class: "miss-same-output" }) })]);
    host.close();
  });
});
