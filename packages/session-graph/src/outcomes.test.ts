import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DiscoveredTranscript } from "@titan-design/session-read";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openSessionGraph, type SessionGraph } from "./graph.js";
import type { PrKey, PrResolution, PrResolver } from "./outcomes.js";
import { refreshCorpus } from "./refresh.js";

const PR_REF = "pr:acme/demo#7";
const line = (fields: Record<string, unknown>) => ({ sessionId: "s1", cwd: "/scratch", gitBranch: "main", ...fields });
const prLink = line({ type: "pr-link", timestamp: "2026-09-01T00:00:01Z", prNumber: 7, prRepository: "acme/demo", prUrl: "https://github.com/acme/demo/pull/7" });
const mergeCommand = line({
  type: "assistant", timestamp: "2026-09-01T00:00:05Z", requestId: "req-merge",
  message: { role: "assistant", model: "m", usage: { input_tokens: 1, output_tokens: 2 }, content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "gh pr merge 7 --squash" } }] },
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
    await refreshCorpus(graph, [transcript], { resolvePrs: answer(new Map([[PR_REF, { state: "merged" }]]), asked) });
    await refreshCorpus(graph, [transcript], { resolvePrs: answer(new Map(), asked) });

    expect(asked.map((prs) => prs.length)).toEqual([1, 1]);
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
