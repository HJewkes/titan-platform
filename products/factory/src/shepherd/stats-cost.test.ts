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
const dispatched = (session: string, minutes: number) => ({ kind: "dispatched", head: "h", reviewer: "rv", mode: "spawn", at: T0 + minutes * 60_000, agentId: "r", sessionId: session, startedAt: T0 + minutes * 60_000 });
const timedOut = { kind: "none", reason: "timeout" };

type Step = [string, number, Record<string, unknown>];

/** Steps as [key, minutes after T0, the dispatch answer], recorded in this order. */
function runOf(id: string, pr: string, steps: Step[]): WorkflowRun {
  const stepResults: WorkflowRun["stepResults"] = {};
  steps.forEach(([key, minutes, result], index) => {
    stepResults[key] = { stepId: key.split(":")[0]!, iteration: index, agentId: null, signal: null, completedAt: iso(minutes), data: { result } };
  });
  return { id, workflowName: "shepherd-pr", params: { repo: "acme/widgets", pr }, status: "completed", currentStep: null, stepResults, activeSteps: {}, revision: 0, ownerGeneration: 0, startedAt: iso(0), completedAt: null, error: null };
}

/** A dispatch at `at` and its on-time verdict at `verdictAt`, keyed by `head`. */
const reviewed = (head: string, session: string, at: number, verdictAt: number, value = "MERGE"): Step[] => [
  [`sh-review:${head}:0`, at, dispatched(session, at)],
  [`sh-await-verdict:${head}:0`, verdictAt, verdict(session, value)],
];
const merged = (minutes: number): Step => ["merge:0", minutes, { done: true }];

const request = (responseId: string, model: string, tokens: { input?: number; cacheRead?: number; cacheWrite5m?: number; output?: number }, minutes = 1) => ({
  responseId,
  model,
  at: iso(minutes),
  tokens: { input: tokens.input ?? 0, cacheRead: tokens.cacheRead ?? 0, cacheWrite5m: tokens.cacheWrite5m ?? 0, cacheWrite1h: 0, output: tokens.output ?? 0 },
});
const haiku = (responseId: string, minutes: number, output = MTOK) => request(responseId, "claude-haiku-4-5", { output }, minutes);
const transcript = (session: string, requests: ReturnType<typeof request>[]): [string, SessionRead] => [`/transcripts/${session}.jsonl`, { ok: true, requests }];

function portOf(reads: Record<string, SessionRead>): TranscriptPort & { paths: string[] } {
  const paths: string[] = [];
  return { paths, read: async (path) => (paths.push(path), reads[path] ?? { ok: false, reason: "missing transcript" }) };
}

const MTOK = 1_000_000;

describe("reviewCost", () => {
  it("sums every review round of a PR into its cost and tokens", async () => {
    const run = runOf("r1", "7", [...reviewed("h1", SESSION.a, 0, 10, "FIX_FIRST"), ...reviewed("h2", SESSION.b, 20, 30), merged(40)]);
    const port = portOf({
      [`/transcripts/${SESSION.a}.jsonl`]: { ok: true, requests: [request("m1", "claude-opus-5-5", { input: MTOK, output: MTOK })] },
      [`/transcripts/${SESSION.b}.jsonl`]: { ok: true, requests: [request("m2", "claude-opus-5-5", { cacheRead: MTOK, cacheWrite5m: MTOK }, 21)] },
    });

    const report = await reviewCost([run], port);

    expect(report.prs).toEqual([
      { repo: "acme/widgets", pr: 7, week: "2026-W41", rounds: 2, sessions: 2, usd: 4 + 20 + 0.2 + 5, tokens: { input: MTOK, cacheRead: MTOK, cacheWrite: MTOK, output: MTOK }, unreadable: [] },
    ]);
  });

  it("prices two models at their own rates", async () => {
    const run = runOf("r1", "8", [...reviewed("h1", SESSION.a, 0, 10), merged(20)]);
    const port = portOf({
      [`/transcripts/${SESSION.a}.jsonl`]: { ok: true, requests: [request("m1", "claude-opus-5-5", { output: MTOK }), request("m2", "claude-haiku-4-5", { output: MTOK })] },
    });

    const report = await reviewCost([run], port);

    expect(report.prs[0]!.usd).toBe(20 + 5);
  });

  it("counts an unreadable round with its reason and never as zero", async () => {
    const run = runOf("r1", "9", [...reviewed("h1", SESSION.a, 0, 10, "FIX_FIRST"), ...reviewed("h2", SESSION.b, 10, 20, "FIX_FIRST"), ...reviewed("h3", SESSION.c, 20, 30), merged(40)]);
    const port = portOf(Object.fromEntries([transcript(SESSION.b, [request("m1", "claude-unheard-of-9", { output: MTOK }, 11)]), transcript(SESSION.c, [haiku("m2", 21)])]));

    const report = await reviewCost([run], port);

    expect(report.prs[0]!.unreadable).toEqual([
      { session: SESSION.a, reason: "missing transcript" },
      { session: SESSION.b, reason: "unknown model claude-unheard-of-9" },
    ]);
    expect(report.prs[0]!.usd).toBe(5);
    expect(report.totals).toMatchObject({ prs: 1, completePrs: 0, unreadable: 2, p50Usd: null, p90Usd: null });
  });

  it("names an external review, which has no transcript, as unreadable", async () => {
    const intent = { kind: "intent", head: "h", reviewer: "seat-x", mode: "external", at: T0 };
    const run = runOf("r1", "10", [["sh-review-intent:h:0", 0, intent], ["sh-await-verdict:h:0", 10, verdict(null)], merged(20)]);

    const report = await reviewCost([run], portOf({}));

    expect(report.prs[0]!.unreadable).toEqual([{ session: "x", reason: "no transcript path" }]);
  });

  it("reads a session once and a request once when rounds share them", async () => {
    const run = runOf("r1", "11", [...reviewed("h1", SESSION.a, 0, 10, "FIX_FIRST"), ...reviewed("h2", SESSION.a, 20, 30), merged(40)]);
    const port = portOf(Object.fromEntries([transcript(SESSION.a, [haiku("m1", 1), haiku("m1", 1), haiku("m2", 21)])]));

    const report = await reviewCost([run], port);

    expect(port.paths).toHaveLength(1);
    expect(report.prs[0]).toMatchObject({ rounds: 2, sessions: 1, usd: 10, unreadable: [] });
  });

  it("prices a round whose verdict came late, through the late read", async () => {
    const run = runOf("r1", "12", [["sh-review:h:0", 0, dispatched(SESSION.a, 0)], ["sh-await-verdict:h:0", 30, timedOut], ["sh-late-verdict:h:0", 40, verdict(SESSION.a)], merged(50)]);
    const port = portOf(Object.fromEntries([transcript(SESSION.a, [haiku("m1", 1), haiku("m2", 35)])]));

    const report = await reviewCost([run], port);

    expect(report.prs[0]).toMatchObject({ rounds: 1, usd: 10, unreadable: [] });
    expect(report.totals.completePrs).toBe(1);
  });

  it("prices a round through its correction reply", async () => {
    const run = runOf("r1", "13", [
      ["sh-review:h:0", 0, dispatched(SESSION.a, 0)],
      ["sh-await-verdict:h:0", 10, { kind: "none", malformed: { refusal: "no verdict line", writtenAt: T0 + 9 * 60_000 } }],
      ["sh-correct-verdict:h:0", 11, { kind: "asked", startedAt: T0 + 11 * 60_000 }],
      ["sh-await-verdict:h:corrected:0", 15, verdict(SESSION.a)],
      merged(20),
    ]);
    const port = portOf(Object.fromEntries([transcript(SESSION.a, [haiku("m1", 5), haiku("m2", 13)])]));

    const report = await reviewCost([run], port);

    expect(report.prs[0]).toMatchObject({ rounds: 1, usd: 10, unreadable: [] });
  });

  it("reads a timed-out round from the transcript its session's verdict named elsewhere", async () => {
    const runs = [
      runOf("r1", "14", [["sh-review:h:0", 0, dispatched(SESSION.a, 0)], ["sh-await-verdict:h:0", 10, timedOut], ["sh-late-verdict:h:0", 20, timedOut], merged(60)]),
      runOf("r2", "15", [...reviewed("h", SESSION.a, 30, 40), merged(60)]),
    ];
    const port = portOf(Object.fromEntries([transcript(SESSION.a, [haiku("m1", 5), haiku("m2", 35)])]));

    const report = await reviewCost(runs, port);

    expect(report.prs.map((pr) => [pr.pr, pr.usd, pr.unreadable])).toEqual([[14, 5, []], [15, 5, []]]);
  });

  it("lists a round with no verdict, no step resolving it, or no requests in its window as unreadable", async () => {
    const run = runOf("r1", "16", [
      ["sh-review:h1:0", 0, dispatched(SESSION.b, 0)],
      ["sh-await-verdict:h1:0", 10, timedOut],
      ["sh-late-verdict:h1:0", 20, timedOut],
      ...reviewed("h2", SESSION.a, 30, 40),
      ["sh-review:h3:0", 50, dispatched(SESSION.c, 50)],
      merged(60),
    ]);
    const port = portOf(Object.fromEntries([transcript(SESSION.a, [haiku("m1", 45)])]));

    const report = await reviewCost([run], port);

    expect(report.prs[0]).toMatchObject({ rounds: 3, sessions: 3, usd: 0 });
    expect(report.prs[0]!.unreadable).toEqual([
      { session: SESSION.b, reason: "no transcript path" },
      { session: SESSION.a, reason: "no requests in the round's window" },
      { session: SESSION.c, reason: "no step resolved the round" },
    ]);
    expect(report.totals).toMatchObject({ completePrs: 0, unreadable: 3 });
  });

  it("splits a reviewer session shared by two PRs by round, so the total is one session's cost", async () => {
    const runs = [runOf("r1", "21", [...reviewed("h", SESSION.a, 5, 10), merged(40)]), runOf("r2", "22", [...reviewed("h", SESSION.a, 20, 30), merged(40)])];
    const port = portOf(Object.fromEntries([transcript(SESSION.a, [haiku("m1", 6), haiku("m2", 25, 2 * MTOK), haiku("m3", 35, 4 * MTOK)])]));

    const report = await reviewCost(runs, port);

    expect(report.prs.map((pr) => [pr.pr, pr.usd])).toEqual([[21, 5], [22, 10]]);
    expect(report.totals.usd).toBe(15);
    expect(port.paths).toHaveLength(1);
  });

  it("prices a request once when two PRs' rounds overlap in one session", async () => {
    const runs = ["31", "32"].map((pr) => runOf(`r${pr}`, pr, [...reviewed("h", SESSION.a, 0, 10), merged(20)]));
    const port = portOf(Object.fromEntries([transcript(SESSION.a, [haiku("m1", 1)])]));

    const report = await reviewCost(runs, port);

    expect(report.totals.usd).toBe(5);
  });

  it("rolls PRs up per repo and ISO week with p50 and p90 over the PRs read in full", async () => {
    const sessions = [SESSION.a, SESSION.b, SESSION.c];
    const runs = sessions.map((session, n) => runOf(`r${n}`, String(n + 1), [...reviewed("h", session, 0, 10), merged(20)]));
    runs.push(runOf("open", "4", reviewed("h", SESSION.a, 0, 10)));
    const port = portOf(Object.fromEntries(sessions.map((session) => transcript(session, [haiku(`m-${session}`, 1)]))));

    const report = await reviewCost(runs, port, { from: "2026-10-05", to: "2026-10-05" });

    expect(report.weeks).toEqual([{ repo: "acme/widgets", week: "2026-W41", prs: 3, usd: 15, tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 3 * MTOK }, unreadable: 0, p50Usd: 5, p90Usd: 5 }]);
    expect(report.totals).toMatchObject({ prs: 3, completePrs: 3, usd: 15, unreadable: 0, p50Usd: 5, p90Usd: 5 });
  });
});

describe("formatReviewCost", () => {
  it("prints each PR with its unreadable rounds, then the weeks and the total", async () => {
    const run = runOf("r1", "7", [...reviewed("h1", SESSION.a, 0, 10, "FIX_FIRST"), ...reviewed("h2", SESSION.b, 10, 20), merged(30)]);
    const port = portOf(Object.fromEntries([transcript(SESSION.b, [haiku("m1", 11)])]));

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
