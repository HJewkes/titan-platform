import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowRun } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { claudeTranscripts, formatReviewCost, reviewCost, type SessionRead, type TranscriptPort } from "./stats-cost.js";

const T0 = Date.parse("2026-10-05T10:00:00Z");
const iso = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString();
const SESSION = { a: "aaaaaaaa-0000-4000-8000-000000000001", b: "bbbbbbbb-0000-4000-8000-000000000002", c: "cccccccc-0000-4000-8000-000000000003" };

const locator = (session: string) => ({ source: { path: `/transcripts/${session}.jsonl`, conversation: { nativeId: session } } });
const verdict = (session: string | null, value = "MERGE") => ({ kind: "verdict", verdict: value, head: "h", locator: session === null ? {} : locator(session), reviewer: { agentId: "r", sessionId: session ?? "x" } });

/** Steps as [key, minutes after T0, the dispatch answer]. */
function runOf(id: string, pr: string, steps: [string, number, Record<string, unknown>][]): WorkflowRun {
  const stepResults: WorkflowRun["stepResults"] = {};
  steps.forEach(([key, minutes, result], index) => {
    stepResults[key] = { stepId: key.split(":")[0]!, iteration: index, agentId: null, signal: null, completedAt: iso(minutes), data: { result } };
  });
  return { id, workflowName: "shepherd-pr", params: { repo: "acme/widgets", pr }, status: "completed", currentStep: null, stepResults, activeSteps: {}, revision: 0, ownerGeneration: 0, startedAt: iso(0), completedAt: null, error: null };
}

const request = (responseId: string, model: string, tokens: { input?: number; cacheRead?: number; cacheWrite5m?: number; output?: number }) => ({
  responseId,
  model,
  at: iso(1),
  tokens: { input: tokens.input ?? 0, cacheRead: tokens.cacheRead ?? 0, cacheWrite5m: tokens.cacheWrite5m ?? 0, cacheWrite1h: 0, output: tokens.output ?? 0 },
});

function portOf(reads: Record<string, SessionRead>): TranscriptPort & { paths: string[] } {
  const paths: string[] = [];
  return { paths, read: async (path) => (paths.push(path), reads[path] ?? { ok: false, reason: "missing transcript" }) };
}

const MTOK = 1_000_000;

describe("reviewCost", () => {
  it("sums every review round of a PR into its cost and tokens", async () => {
    const run = runOf("r1", "7", [
      ["sh-await-verdict:h1", 10, verdict(SESSION.a, "FIX_FIRST")],
      ["sh-await-verdict:h2", 30, verdict(SESSION.b)],
      ["merge:0", 40, { done: true }],
    ]);
    const port = portOf({
      [`/transcripts/${SESSION.a}.jsonl`]: { ok: true, requests: [request("m1", "claude-opus-5-5", { input: MTOK, output: MTOK })] },
      [`/transcripts/${SESSION.b}.jsonl`]: { ok: true, requests: [request("m2", "claude-opus-5-5", { cacheRead: MTOK, cacheWrite5m: MTOK })] },
    });

    const report = await reviewCost([run], port);

    expect(report.prs).toEqual([
      { repo: "acme/widgets", pr: 7, week: "2026-W41", rounds: 2, sessions: 2, usd: 4 + 20 + 0.2 + 5, tokens: { input: MTOK, cacheRead: MTOK, cacheWrite: MTOK, output: MTOK }, unreadable: [] },
    ]);
  });

  it("prices two models at their own rates", async () => {
    const run = runOf("r1", "8", [["sh-await-verdict:h1", 10, verdict(SESSION.a)], ["merge:0", 20, { done: true }]]);
    const port = portOf({
      [`/transcripts/${SESSION.a}.jsonl`]: { ok: true, requests: [request("m1", "claude-opus-5-5", { output: MTOK }), request("m2", "claude-haiku-4-5", { output: MTOK })] },
    });

    const report = await reviewCost([run], port);

    expect(report.prs[0]!.usd).toBe(20 + 5);
  });

  it("counts an unreadable session with its reason and never as zero", async () => {
    const run = runOf("r1", "9", [
      ["sh-await-verdict:h1", 10, verdict(SESSION.a, "FIX_FIRST")],
      ["sh-await-verdict:h2", 20, verdict(SESSION.b, "FIX_FIRST")],
      ["sh-await-verdict:h3", 30, verdict(SESSION.c)],
      ["merge:0", 40, { done: true }],
    ]);
    const port = portOf({
      [`/transcripts/${SESSION.b}.jsonl`]: { ok: true, requests: [request("m1", "claude-unheard-of-9", { output: MTOK })] },
      [`/transcripts/${SESSION.c}.jsonl`]: { ok: true, requests: [request("m2", "claude-haiku-4-5", { output: MTOK })] },
    });

    const report = await reviewCost([run], port);

    expect(report.prs[0]!.unreadable).toEqual([
      { session: SESSION.a, reason: "missing transcript" },
      { session: SESSION.b, reason: "unknown model claude-unheard-of-9" },
    ]);
    expect(report.prs[0]!.usd).toBe(5);
    expect(report.totals).toMatchObject({ prs: 1, completePrs: 0, unreadable: 1 * 2, p50Usd: null, p90Usd: null });
  });

  it("names a verdict with no transcript, such as an external review, as unreadable", async () => {
    const run = runOf("r1", "10", [["sh-await-verdict:h1", 10, verdict(null)], ["merge:0", 20, { done: true }]]);

    const report = await reviewCost([run], portOf({}));

    expect(report.prs[0]!.unreadable).toEqual([{ session: "x", reason: "no transcript path" }]);
  });

  it("reads a session once and a request once when rounds share them", async () => {
    const run = runOf("r1", "11", [["sh-await-verdict:h1", 10, verdict(SESSION.a, "FIX_FIRST")], ["sh-await-verdict:h2", 30, verdict(SESSION.a)], ["merge:0", 40, { done: true }]]);
    const port = portOf({ [`/transcripts/${SESSION.a}.jsonl`]: { ok: true, requests: [request("m1", "claude-haiku-4-5", { output: MTOK }), request("m1", "claude-haiku-4-5", { output: MTOK })] } });

    const report = await reviewCost([run], port);

    expect(port.paths).toHaveLength(1);
    expect(report.prs[0]).toMatchObject({ rounds: 2, sessions: 1, usd: 5 });
  });

  it("rolls PRs up per repo and ISO week with p50 and p90 over the PRs read in full", async () => {
    const runs = [1, 2, 3].map((n) => runOf(`r${n}`, String(n), [["sh-await-verdict:h", 10, verdict(SESSION.a)], ["merge:0", 20, { done: true }]]));
    runs.push(runOf("open", "4", [["sh-await-verdict:h", 10, verdict(SESSION.a)]]));
    const port = portOf({ [`/transcripts/${SESSION.a}.jsonl`]: { ok: true, requests: [request("m1", "claude-haiku-4-5", { output: MTOK })] } });

    const report = await reviewCost(runs, port, { from: "2026-10-05", to: "2026-10-05" });

    expect(report.weeks).toEqual([{ repo: "acme/widgets", week: "2026-W41", prs: 3, usd: 15, tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 3 * MTOK }, unreadable: 0, p50Usd: 5, p90Usd: 5 }]);
    expect(report.totals).toMatchObject({ prs: 3, completePrs: 3, usd: 15, unreadable: 0, p50Usd: 5, p90Usd: 5 });
  });
});

describe("formatReviewCost", () => {
  it("prints each PR with its unreadable sessions, then the weeks and the total", async () => {
    const run = runOf("r1", "7", [["sh-await-verdict:h1", 10, verdict(SESSION.a, "FIX_FIRST")], ["sh-await-verdict:h2", 20, verdict(SESSION.b)], ["merge:0", 30, { done: true }]]);
    const port = portOf({ [`/transcripts/${SESSION.b}.jsonl`]: { ok: true, requests: [request("m1", "claude-haiku-4-5", { output: MTOK })] } });

    const text = formatReviewCost(await reviewCost([run], port));

    expect(text).toContain("acme/widgets#7  2026-W41  $5.00  rounds 2  sessions 2  unreadable 1");
    expect(text).toContain(`  unreadable ${SESSION.a}: missing transcript`);
    expect(text).toContain("acme/widgets  2026-W41  PRs 1  $5.00  p50 -  p90 -  unreadable 1");
    expect(text).toContain("total: PRs 1  $5.00");
  });
});

describe("claudeTranscripts", () => {
  const usageLine = (id: string, model: string, usage: Record<string, unknown>) =>
    JSON.stringify({ type: "assistant", uuid: `u-${id}`, sessionId: SESSION.a, timestamp: iso(1), message: { id, role: "assistant", model, content: [{ type: "text", text: "ok" }], usage } });

  it("reads each response's final usage with disjoint input and the cache write split", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "stats-cost-")), `${SESSION.a}.jsonl`);
    const usage = { input_tokens: 10, cache_read_input_tokens: 200, cache_creation_input_tokens: 30, cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 }, output_tokens: 5 };
    writeFileSync(path, `${usageLine("msg_1", "claude-haiku-4-5", { ...usage, output_tokens: 1 })}\n${usageLine("msg_1", "claude-haiku-4-5", usage)}\n`);

    const read = await claudeTranscripts("test").read(path);

    expect(read).toEqual({ ok: true, requests: [{ responseId: "msg_1", model: "claude-haiku-4-5", at: iso(1), tokens: { input: 10, cacheRead: 200, cacheWrite5m: 10, cacheWrite1h: 20, output: 5 } }] });
  });

  it("names a missing transcript", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "stats-cost-")), `${SESSION.a}.jsonl`);

    expect(await claudeTranscripts("test").read(path)).toEqual({ ok: false, reason: "missing transcript" });
  });

  it("names a transcript that does not parse", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "stats-cost-")), `${SESSION.a}.jsonl`);
    writeFileSync(path, "{not json\n");

    const read = await claudeTranscripts("test").read(path);

    expect(read).toMatchObject({ ok: false, reason: expect.stringMatching(/^parse error: malformed JSON/) });
  });
});
