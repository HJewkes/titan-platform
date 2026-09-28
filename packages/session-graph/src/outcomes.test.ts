import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DiscoveredTranscript } from "@titan-design/session-read";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openSessionGraph, type SessionGraph } from "./graph.js";
import { prsNeedingOutcome, type PrKey, type PrResolution, type PrResolver } from "./outcomes.js";
import { refreshCorpus } from "./refresh.js";

const PR_REF = "pr:acme/demo#7";
const line = (fields: Record<string, unknown>) => ({ sessionId: "s1", cwd: "/scratch", gitBranch: "main", ...fields });
const prLink = line({ type: "pr-link", timestamp: "2026-09-01T00:00:01Z", prNumber: 7, prRepository: "acme/demo", prUrl: "https://github.com/acme/demo/pull/7" });
const mergeCommand = line({
  type: "assistant", timestamp: "2026-09-01T00:00:05Z", requestId: "req-merge",
  message: { role: "assistant", model: "m", usage: { input_tokens: 1, output_tokens: 2 }, content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "gh pr merge 7 --squash" } }] },
});
const laterSighting = line({
  type: "assistant", timestamp: "2026-09-03T00:00:00Z", requestId: "req-merge-2",
  message: { role: "assistant", model: "m", usage: { input_tokens: 1, output_tokens: 2 }, content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "gh pr merge 7 --squash" } }] },
});

let dir: string;
let graph: SessionGraph;

function transcriptOf(lines: unknown[]): DiscoveredTranscript {
  const absolutePath = path.join(dir, "s1.jsonl");
  writeFileSync(absolutePath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return { projectDir: "p", absolutePath, displayPath: absolutePath, subagentId: null, account: null };
}

const answer = (resolution: PrResolution, asked: PrKey[][] = []): PrResolver => (prs) => (asked.push([...prs]), resolution);
const prRow = () => graph.db.prepare("SELECT state, merged_at, closed_at, review_rounds, outcome_checked_at IS NOT NULL AS checked FROM pr").get();

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "titan-session-graph-outcomes-"));
  graph = openSessionGraph(":memory:");
});
afterEach(() => {
  graph.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("PR outcome resolver", () => {
  it("fills pr state, merged_at, closed_at and review_rounds from the resolver", async () => {
    const asked: PrKey[][] = [];
    const resolvePrs = answer(new Map([[PR_REF, { state: "MERGED", mergedAt: "2026-09-02T10:00:00Z", closedAt: "2026-09-02T10:00:00Z", reviewRounds: 2 }]]), asked);

    const summary = await refreshCorpus(graph, [transcriptOf([prLink])], { resolvePrs });

    expect(asked).toEqual([[{ prRef: PR_REF, repo: "acme/demo", number: 7 }]]);
    expect(summary.prs).toEqual({ requested: 1, applied: 1, failed: false });
    expect(prRow()).toEqual({ state: "merged", merged_at: "2026-09-02T10:00:00Z", closed_at: "2026-09-02T10:00:00Z", review_rounds: 2, checked: 1 });
  });

  it("a resolver that sends only reviewRounds still sets review_rounds", async () => {
    const resolvePrs = answer(new Map([[PR_REF, { reviewRounds: 2, commitTimes: ["2026-09-01T00:00:00Z"] }]]));

    await refreshCorpus(graph, [transcriptOf([prLink])], { resolvePrs });

    expect(graph.db.prepare("SELECT review_rounds, review_rounds_gh, review_rounds_chat FROM pr").get()).toEqual({ review_rounds: 2, review_rounds_gh: 2, review_rounds_chat: 0 });
  });

  it("a later answer replaces the PR's stored forge reviews", async () => {
    const transcript = transcriptOf([prLink]);
    const first = [{ state: "CHANGES_REQUESTED", submittedAt: "2026-09-01T01:00:00Z" }, { state: "COMMENTED", submittedAt: "2026-09-01T01:30:00Z" }];
    await refreshCorpus(graph, [transcript], { resolvePrs: answer(new Map([[PR_REF, { state: "open", reviews: first }]])) });
    await refreshCorpus(graph, [transcript], { resolvePrs: answer(new Map([[PR_REF, { state: "open", reviews: [{ state: "approved", submittedAt: "2026-09-01T02:00:00Z" }] }]])) });

    expect(graph.db.prepare("SELECT source_key, verdict, pr_ref FROM pr_review").all()).toEqual([
      { source_key: `gh:${PR_REF}:2026-09-01T02:00:00Z`, verdict: "approve", pr_ref: PR_REF },
    ]);
  });

  it("a resolver answer never downgrades merged to open", async () => {
    const resolvePrs = answer(new Map([[PR_REF, { state: "OPEN", reviewRounds: 1 }]]));

    await refreshCorpus(graph, [transcriptOf([prLink, mergeCommand])], { resolvePrs });

    expect(prRow()).toEqual({ state: "merged", merged_at: "2026-09-01T00:00:05Z", closed_at: null, review_rounds: 1, checked: 1 });
  });

  it("keeps the transcript's fields for everything the resolver omits", async () => {
    await refreshCorpus(graph, [transcriptOf([prLink])], { resolvePrs: answer(new Map([[PR_REF, null]])) });

    expect(prRow()).toEqual({ state: null, merged_at: null, closed_at: null, review_rounds: null, checked: 0 });
  });

  it("stops asking about a PR once it is merged and checked, but keeps asking about an open one", async () => {
    const asked: PrKey[][] = [];
    const transcript = transcriptOf([prLink]);
    await refreshCorpus(graph, [transcript], { resolvePrs: answer(new Map([[PR_REF, { state: "open" }]]), asked) });
    await refreshCorpus(graph, [transcript], { resolvePrs: answer(new Map([[PR_REF, { state: "merged", commitTimes: [] }]]), asked) });
    await refreshCorpus(graph, [transcript], { resolvePrs: answer(new Map(), asked) });

    expect(asked.map((prs) => prs.length)).toEqual([1, 1]);
  });

  it("a forge merged_at survives a later reconcile pass", async () => {
    const transcript = transcriptOf([prLink, mergeCommand]);
    const forgeMergedAt = "2026-09-02T10:00:00Z";
    await refreshCorpus(graph, [transcript], { resolvePrs: answer(new Map([[PR_REF, { state: "merged", mergedAt: forgeMergedAt }]])) });
    expect(prRow()).toMatchObject({ merged_at: forgeMergedAt, checked: 1 });

    appendFileSync(transcript.absolutePath, JSON.stringify(laterSighting) + "\n");
    await refreshCorpus(graph, [transcript], {});
    await refreshCorpus(graph, [transcript], {});

    expect(prRow()).toMatchObject({ merged_at: forgeMergedAt, checked: 1 });
  });

  it("survives a resolver that throws, reporting the failure instead of losing the pass", async () => {
    const summary = await refreshCorpus(graph, [transcriptOf([prLink, mergeCommand])], {
      resolvePrs: () => {
        throw new Error("gh is not authenticated");
      },
    });

    expect(summary).toMatchObject({ indexed: 1, prs: { requested: 1, applied: 0, failed: true, error: "gh is not authenticated" } });
    expect(prRow()).toEqual({ state: "merged", merged_at: "2026-09-01T00:00:05Z", closed_at: null, review_rounds: null, checked: 0 });
  });
});

describe("PR commit times", () => {
  const commitTimes = () => (graph.db.prepare("SELECT commit_times FROM pr").get() as { commit_times: string | null }).commit_times;

  it("a merged PR is offered again until a resolver sends commit times", async () => {
    const asked: PrKey[][] = [];
    const transcript = transcriptOf([prLink, mergeCommand]);
    await refreshCorpus(graph, [transcript], { resolvePrs: answer(new Map([[PR_REF, { state: "merged", reviewRounds: 1 }]]), asked) });
    await refreshCorpus(graph, [transcript], { resolvePrs: answer(new Map([[PR_REF, { state: "merged", commitTimes: ["2026-09-01T00:00:00Z"] }]]), asked) });
    await refreshCorpus(graph, [transcript], { resolvePrs: answer(new Map(), asked) });

    expect(asked.map((prs) => prs.map((pr) => pr.prRef))).toEqual([[PR_REF], [PR_REF]]);
    expect(commitTimes()).toBe('["2026-09-01T00:00:00Z"]');
  });

  it("a resolver that omits commitTimes does not erase stored commit times", async () => {
    const transcript = transcriptOf([prLink]);
    await refreshCorpus(graph, [transcript], { resolvePrs: answer(new Map([[PR_REF, { state: "open", commitTimes: ["2026-09-01T00:00:00Z"] }]])) });
    await refreshCorpus(graph, [transcript], { resolvePrs: answer(new Map([[PR_REF, { state: "open", reviewRounds: 2 }]])) });

    expect(commitTimes()).toBe('["2026-09-01T00:00:00Z"]');
  });

  it("stores an empty commit list as known, not missing", async () => {
    await refreshCorpus(graph, [transcriptOf([prLink])], { resolvePrs: answer(new Map([[PR_REF, { state: "merged", commitTimes: [] }]])) });

    expect(commitTimes()).toBe("[]");
    expect(prsNeedingOutcome(graph)).toEqual([]);
  });

  it("offers never-checked PRs first, then open PRs, then merged PRs missing commit times", () => {
    const insert = graph.db.prepare("INSERT INTO pr (pr_ref, repo, number, state, outcome_checked_at, commit_times) VALUES (?, 'acme/widgets', ?, ?, ?, ?)");
    insert.run("pr:acme/widgets#1", 1, "merged", "2026-09-02T00:00:00Z", null);
    insert.run("pr:acme/widgets#2", 2, "open", "2026-09-02T00:00:00Z", "[]");
    insert.run("pr:acme/widgets#3", 3, null, null, null);
    insert.run("pr:acme/widgets#4", 4, "merged", "2026-09-02T00:00:00Z", "[]");

    expect(prsNeedingOutcome(graph).map((pr) => pr.number)).toEqual([3, 2, 1]);
  });
});
