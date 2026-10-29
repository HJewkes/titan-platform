import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { silentLogger } from "@titan-design/daemon";
import { inProcessCaller, type InProcessCall } from "@titan-design/registry";
import type { ClassedCommand, ConsoleContext } from "../owner-guard.js";
import { createConsoleRegistry } from "../registry.js";
import { createSources } from "../upstreams.js";
import { budgetFor, RPC_BUDGETS, type RpcBudget } from "./budgets.js";
import { buildPerfFixture, type PerfFixture } from "./large-state.fixture.js";

const TIMED_RUNS = 7;
// Eight runs of the slowest read, twice on a miss, outlast the 30 s default a caller such as fix-proof passes.
const TIME_TEST_TIMEOUT_MS = 300_000;

let dir: string;
let fixture: PerfFixture;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "console-perf-budgets-"));
  fixture = await buildPerfFixture(dir);
});

afterAll(async () => {
  await fixture.close();
  await rm(dir, { recursive: true, force: true });
});

/** A fresh registry per read, so its first call is cold: no cache a previous read warmed. */
function freshCaller(): InProcessCall {
  const registry = createConsoleRegistry(createSources(fixture.config, silentLogger));
  return inProcessCaller(registry, (): ConsoleContext => ({ warnings: [], format: "json", surface: "in-process", auth: null, ownerWrites: false }));
}

function readCommandNames(): string[] {
  const commands = createConsoleRegistry(createSources(fixture.config, silentLogger)).list() as ClassedCommand[];
  return commands.filter((command) => command.commandClass === "read").map((command) => command.name);
}

async function callCounted(rpc: InProcessCall, budget: RpcBudget): Promise<{ envelope: unknown; calls: Record<string, number>; total: number }> {
  fixture.calls.reset();
  const envelope = await rpc(budget.rpc, budget.args);
  return { envelope, calls: fixture.calls.counts(), total: fixture.calls.total() };
}

/** One untimed warm-up, then the median of the timed runs. */
async function medianMs(budget: RpcBudget): Promise<number> {
  const rpc = freshCaller();
  await rpc(budget.rpc, budget.args);
  const times: number[] = [];
  for (let run = 0; run < TIMED_RUNS; run++) {
    const start = performance.now();
    await rpc(budget.rpc, budget.args);
    times.push(performance.now() - start);
  }
  return times.sort((a, b) => a - b)[Math.floor(TIMED_RUNS / 2)]!;
}

const rows = RPC_BUDGETS.map((budget) => [budget.rpc, budget] as const);

describe("console read budgets on the large-state fixture", () => {
  it("every read-classed command has a budget row", () => {
    const reads = readCommandNames();

    expect(reads.filter((name) => !budgetFor(name))).toEqual([]);
    expect(RPC_BUDGETS.map((budget) => budget.rpc).filter((name) => !reads.includes(name))).toEqual([]);
  });

  it.each(rows)("%s answers within its bytes and upstream-call budgets", async (_rpc, budget) => {
    const rpc = freshCaller();

    const cold = await callCounted(rpc, budget);
    const warm = await callCounted(rpc, budget);

    expect(cold.envelope, budget.fixtureGap ?? "a budgeted read must answer").toMatchObject({ ok: !budget.fixtureGap });
    expect(JSON.stringify(cold.envelope).length).toBeLessThanOrEqual(budget.maxBytes);
    expect(cold.total, JSON.stringify(cold.calls)).toBeLessThanOrEqual(budget.maxUpstreamCalls);
    expect(warm.total, JSON.stringify(warm.calls)).toBeLessThanOrEqual(budget.maxUpstreamCallsWarm ?? budget.maxUpstreamCalls);
  });

  // Wall time is the one noisy kind: a second median is taken before a miss counts.
  it.each(rows)("%s answers within its time budget", async (_rpc, budget) => {
    const first = await medianMs(budget);
    const median = first <= budget.maxMs ? first : await medianMs(budget);

    expect(median, `medians ${first.toFixed(1)} and ${median.toFixed(1)} ms`).toBeLessThanOrEqual(budget.maxMs);
  }, TIME_TEST_TIMEOUT_MS);
});
