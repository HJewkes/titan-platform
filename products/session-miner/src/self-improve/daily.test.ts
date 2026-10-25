import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PROMPT_FAMILIES } from "./families.js";
import { FIXTURES, crashAt, fakeClassifier, rowsAnswer, workspace, type FakeClassifier, type Workspace } from "./fake-classifier.test-helpers.js";
import { runSelfImproveDaily, type DailyHost } from "./run.js";

let ws: Workspace;

beforeEach(() => {
  ws = workspace();
});

afterEach(() => ws.cleanup());

const run = (fake: FakeClassifier, maxBudgetUsd = 3, extra: Partial<DailyHost> = {}) =>
  runSelfImproveDaily({ chunks: ws.chunks, prompts: ws.prompts, out: ws.out, maxBudgetUsd }, { stateDir: ws.state, runnerFor: fake.runnerFor, ...extra });

const followups = () => readFileSync(path.join(ws.out, "c2_followups.jsonl"), "utf8");

function writeChunks(count: number): void {
  for (let n = 3; n <= count; n++) ws.writeChunk(`c2_followups_${n}`, `F${n + 10} a buoy seat asked about rope number ${n}.\n`);
}

describe("self-improve daily classification", () => {
  it("writes each family's rows with _chunk in the shell collector's row shape", async () => {
    const result = await run(fakeClassifier());

    expect(result.status).toBe("completed");
    expect(followups()).toBe(readFileSync(path.join(FIXTURES, "expected-c2_followups.jsonl"), "utf8"));
    expect(result.summary).toMatchObject({ rows: { c2_followups: 3 }, unparsed: { c2_followups: 0 }, cost: { c2_followups: 0.1 }, skipped: [], failed: [] });
    expect(existsSync(path.join(ws.out, "c1_owner.jsonl"))).toBe(false);
  });

  it("sends each chunk to claude-print with its family's model, output schema and call ceiling", async () => {
    const fake = fakeClassifier();

    await run(fake);

    const family = PROMPT_FAMILIES.find((candidate) => candidate.id === "c2_followups")!;
    expect(fake.options).toContainEqual({ cwd: expect.any(String), maxTurns: 1, maxBudgetUsd: family.callBudgetUsd, defaults: { harness: "claude-print", model: "haiku", outputSchema: family.outputSchema } });
    expect(fake.chunks).toEqual([["F1", "F2"], ["F3"]]);
  });

  it("resumes a killed run without re-classifying the chunks it finished", async () => {
    writeChunks(3);
    const crash = new AbortController();
    const first = await run(fakeClassifier(crashAt(2, crash)), 3, { signal: crash.signal });
    const second = fakeClassifier();

    const resumed = await run(second);

    expect(first.status).toBe("running");
    expect(resumed).toMatchObject({ runId: first.runId, status: "completed", newCalls: 2 });
    expect(second.chunks).toEqual([["F3"], ["F13"]]);
    expect(resumed.summary?.rows).toEqual({ c2_followups: 4 });
  });

  it("re-runs only the edited chunk and the unfinished ones when a killed run resumes", async () => {
    writeChunks(3);
    const crash = new AbortController();
    await run(fakeClassifier(crashAt(3, crash)), 3, { signal: crash.signal });
    ws.writeChunk("c2_followups_1", "F1 the lighthouse keeper asked again, with new wording.\n");
    const second = fakeClassifier();

    const resumed = await run(second);

    expect(second.chunks).toEqual([["F1"], ["F13"]]);
    expect(resumed.summary?.rows).toEqual({ c2_followups: 3 });
  });

  it("reports a finished run on a rerun without calling the model", async () => {
    await run(fakeClassifier());
    const second = fakeClassifier();

    const rerun = await run(second);

    expect(rerun).toMatchObject({ status: "completed", newCalls: 0, summary: { rows: { c2_followups: 3 } } });
    expect(second.chunks).toEqual([]);
  });

  it("stops launching chunks once the next call's ceiling could carry the run past its budget", async () => {
    writeChunks(5);

    const result = await run(fakeClassifier(rowsAnswer(0.3)), 1);

    expect(result.newCalls).toBe(3);
    expect(result.summary?.spentUsd).toBeCloseTo(0.9);
    expect(result.summary?.skipped).toEqual([
      { chunk: "c2_followups_4", reason: "budget" },
      { chunk: "c2_followups_5", reason: "budget" },
    ]);
  });

  it("counts rows the family schema refuses as unparsed and leaves them out of the jsonl", async () => {
    const answer = (_: unknown, call: number) =>
      call === 1
        ? { ok: true as const, output: JSON.stringify({ rows: [{ item: "F1", cls: "status-ping", mechanical: "yes", could_be_owned_by: "none", theme: "t" }] }), usage: { costUsd: 0.05 } }
        : { ok: false as const, error: "schema_invalid: no rows", retryable: false, code: "schema_invalid" as const, usage: { costUsd: 0.05 } };

    const result = await run(fakeClassifier(answer));

    expect(result.summary).toMatchObject({ rows: { c2_followups: 0 }, unparsed: { c2_followups: 2 }, cost: { c2_followups: 0.1 }, failed: [] });
    expect(existsSync(path.join(ws.out, "c2_followups.jsonl"))).toBe(false);
  });
});
