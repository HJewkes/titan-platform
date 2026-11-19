import type { GitHubPort, PrFile } from "@titan-design/github";
import type { SourceTextLocator } from "@titan-design/session-read";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { partialFake } from "@titan-design/test-kit";
import type { WorkflowContext } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { CHECK_CANDIDATES_STEP, checkCandidatesBody, recordCheckCandidatesAt } from "./check-candidates-step.js";
import { checkCandidatesMigration, checkCandidatesTable, type CheckCandidates } from "./check-candidates-store.js";
import type { ShepherdStore, ShepherdStoreRef } from "./store.js";

const HEAD = "c".repeat(40);
const TARGET = { repo: "acme/widgets", pr: 7, head: HEAD };
const CANDIDATE = { classKey: "parser-edge-case", route: "test" as const, sketch: "a table test over the empty block" };

type Mode = "off" | "record" | "propose";

function verdict(extra: Record<string, unknown> = {}, agentId = "reviewer-1") {
  return { kind: "verdict" as const, verdict: "FIX_FIRST" as const, head: HEAD, locator: partialFake<SourceTextLocator>(), reviewer: { agentId, sessionId: `s-${agentId}` }, ...extra };
}

/** The step's own input, written by `recordCheckCandidatesAt` in the same test, so an object is all this checks. */
const isBodyInput = (value: unknown): value is Parameters<typeof checkCandidatesBody>[2] => typeof value === "object" && value !== null;

function harness(files: () => Promise<PrFile[]>, options: { mode?: Mode; recordedNext?: string } = {}) {
  const db = openDatabase(":memory:");
  runMigrations(db, [checkCandidatesMigration(1)]);
  const table: CheckCandidates = checkCandidatesTable(db, () => "2026-11-19T00:00:00.000Z");
  const store = partialFake<ShepherdStoreRef>({ get: () => partialFake<ShepherdStore>({ checkCandidates: () => table, byRun: () => undefined }) });
  const deps = { port: partialFake<GitHubPort>({ listPrFiles: files }), store };
  const dispatched: string[] = [];
  const dispatch = async (stepId: string, _template: string, sent: { vars: Record<string, string> }) => {
    dispatched.push(stepId);
    const input: unknown = JSON.parse(Object.values(sent.vars)[0] ?? "{}");
    if (!isBodyInput(input)) throw new Error("the step sent no input object");
    return { data: { result: await checkCandidatesBody(deps, () => options.mode ?? "record", input) } };
  };
  const ctx = Object.assign(partialFake<WorkflowContext>(), { runId: "run-7", dispatch, historyNext: () => options.recordedNext });
  return { ctx, table, dispatched };
}

const listing = (...files: [string, number, number][]) => async () => files.map(([path, additions, deletions]) => ({ path, status: "modified", additions, deletions }));
const ONE_FILE = listing(["packages/demo/src/a.ts", 3, 1]);

describe("sh-check-candidates", () => {
  it("a verdict without the block records nothing", async () => {
    const { ctx, table, dispatched } = harness(ONE_FILE);

    await recordCheckCandidatesAt(ctx, TARGET, verdict());

    expect(dispatched).toEqual([]);
    expect(table.since("2000-01-01")).toEqual([]);
  });

  it("area is the dir with most changed lines", async () => {
    const files = listing(["packages/small/src/a.ts", 6, 0], ["products/big/src/x.ts", 3, 2], ["products/big/README.md", 4, 0], ["README.md", 7, 0]);
    const { ctx, table } = harness(files);

    await recordCheckCandidatesAt(ctx, TARGET, verdict({ checkCandidates: [CANDIDATE] }));

    expect(table.since("2000-01-01").map((row) => row.area)).toEqual(["products/big"]);
  });

  it("two members, one class, one head is one row", async () => {
    const { ctx, table, dispatched } = harness(ONE_FILE);

    await recordCheckCandidatesAt(ctx, TARGET, verdict({ checkCandidates: [CANDIDATE] }));
    await recordCheckCandidatesAt(ctx, TARGET, verdict({ verdict: "MERGE", checkCandidates: [CANDIDATE] }, "reviewer-2"), ":adversary", "adversary");

    const rows = table.since("2000-01-01");
    expect(dispatched).toEqual([`${CHECK_CANDIDATES_STEP}:${HEAD}`, `${CHECK_CANDIDATES_STEP}:${HEAD}:adversary`]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.members).toEqual([
      { shape: "correctness", agentId: "reviewer-1", verdict: "FIX_FIRST" },
      { shape: "adversary", agentId: "reviewer-2", verdict: "MERGE" },
    ]);
    expect(rows[0]?.verdict).toBe("FIX_FIRST");
  });

  it("off records nothing", async () => {
    const { ctx, table, dispatched } = harness(ONE_FILE, { mode: "off" });

    await recordCheckCandidatesAt(ctx, TARGET, verdict({ checkCandidates: [CANDIDATE] }));

    expect(dispatched).toEqual([`${CHECK_CANDIDATES_STEP}:${HEAD}`]);
    expect(table.since("2000-01-01")).toEqual([]);
  });

  it("a replayed run recorded before the step skips it", async () => {
    const { ctx, table, dispatched } = harness(ONE_FILE, { recordedNext: `sh-merge-evidence:${HEAD}` });

    await recordCheckCandidatesAt(ctx, TARGET, verdict({ checkCandidates: [CANDIDATE] }));

    expect(dispatched).toEqual([]);
    expect(table.since("2000-01-01")).toEqual([]);
  });

  it("a replayed run whose ledger holds the step replays it", async () => {
    const { ctx, dispatched } = harness(ONE_FILE, { recordedNext: `${CHECK_CANDIDATES_STEP}:${HEAD}` });

    await recordCheckCandidatesAt(ctx, TARGET, verdict({ checkCandidates: [CANDIDATE] }));

    expect(dispatched).toEqual([`${CHECK_CANDIDATES_STEP}:${HEAD}`]);
  });

  it("an unreadable file list records rows with no area", async () => {
    const { ctx, table } = harness(() => Promise.reject(new Error("list unreadable")));

    await recordCheckCandidatesAt(ctx, TARGET, verdict({ checkCandidates: [CANDIDATE] }));

    expect(table.since("2000-01-01").map((row) => [row.classKey, row.area])).toEqual([["parser-edge-case", null]]);
  });

  it("a file list that never answers records rows with no area once the bound passes", async () => {
    const { table } = harness(ONE_FILE);
    const deps = { port: partialFake<GitHubPort>({ listPrFiles: () => new Promise<PrFile[]>(() => undefined) }), store: partialFake<ShepherdStoreRef>({ get: () => partialFake<ShepherdStore>({ checkCandidates: () => table, byRun: () => undefined }) }) };
    const member = { shape: "correctness", agentId: "reviewer-1", verdict: "FIX_FIRST" as const };

    const result = await checkCandidatesBody(deps, () => "record", { runId: "run-7", ...TARGET, member, checkCandidates: [CANDIDATE] }, 5);

    expect(result).toEqual({ recorded: 1 });
    expect(table.since("2000-01-01").map((row) => row.area)).toEqual([null]);
  });

  it("a store that throws records the error and does not throw", async () => {
    const store = partialFake<ShepherdStoreRef>({ get: () => { throw new Error("store unbound"); } });
    const member = { shape: "correctness", agentId: "reviewer-1", verdict: "MERGE" as const };

    const result = await checkCandidatesBody({ port: partialFake<GitHubPort>({ listPrFiles: ONE_FILE }), store }, () => "record", { runId: "run-7", ...TARGET, member, checkCandidates: [CANDIDATE] });

    expect(result).toEqual({ recorded: 0, error: "Error: store unbound" });
  });

  it("a dropped block records its warning and no rows", async () => {
    const { ctx, table, dispatched } = harness(ONE_FILE);

    await recordCheckCandidatesAt(ctx, TARGET, verdict({ checkCandidatesWarning: "too_many" }));

    expect(dispatched).toEqual([`${CHECK_CANDIDATES_STEP}:${HEAD}`]);
    expect(table.since("2000-01-01")).toEqual([]);
  });
});
