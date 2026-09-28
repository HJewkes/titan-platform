import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DiscoveredTranscript } from "@titan-design/session-read";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openSessionGraph, type SessionGraph } from "./graph.js";
import type { OriginResolver, ResolvedOrigin } from "./origin.js";
import type { PrResolver, ResolvedPr } from "./outcomes.js";
import { refreshCorpus, type RefreshOptions } from "./refresh.js";

const DEMO = "pr:acme/demo#7";
const TOOLS = "pr:other/tools#7";
const COMMITS = ["2026-09-01T01:00:00Z", "2026-09-01T03:00:00Z"];
const BEFORE_LAST_COMMIT = "2026-09-01T02:00:00Z";

let dir: string;
let graph: SessionGraph;
let files: Map<string, unknown[]>;
let origins: Record<string, ResolvedOrigin>;

const line = (sessionId: string, fields: Record<string, unknown>, cwd = "/scratch") => ({ sessionId, cwd, gitBranch: "main", ...fields });
const prLink = (sessionId: string, repo: string) =>
  line(sessionId, { type: "pr-link", timestamp: "2026-09-01T00:00:00Z", prNumber: 7, prRepository: repo, prUrl: `https://github.com/${repo}/pull/7` });
const chatSend = (sessionId: string, id: string, ts: string, text: string, cwd?: string) =>
  line(sessionId, {
    type: "assistant", timestamp: ts, requestId: `req-${id}`,
    message: { role: "assistant", model: "m", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "tool_use", id, name: "mcp__plugin_agent-chat_agent-chat__chat_send", input: { to: "lead", text } }] },
  }, cwd);

function add(sessionId: string, ...lines: unknown[]): void {
  files.set(sessionId, [...(files.get(sessionId) ?? []), ...lines]);
}

function corpus(): DiscoveredTranscript[] {
  return [...files].map(([sessionId, lines]) => {
    const absolutePath = path.join(dir, `${sessionId}.jsonl`);
    writeFileSync(absolutePath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    return { projectDir: "p", absolutePath, displayPath: absolutePath, subagentId: null, account: null };
  });
}

const resolveOrigins: OriginResolver = () => ({ origins });
const forge = (answers: Record<string, ResolvedPr>): PrResolver => () => new Map(Object.entries(answers));
const refresh = (options: RefreshOptions = {}) => refreshCorpus(graph, corpus(), { resolveOrigins, ...options });
const rounds = (prRef = DEMO) => graph.db.prepare("SELECT review_rounds, review_rounds_gh, review_rounds_chat FROM pr WHERE pr_ref = ?").get(prRef);
const verdictRefs = () => (graph.db.prepare("SELECT pr_ref FROM pr_review WHERE surface = 'chat' ORDER BY source_key").all() as { pr_ref: string | null }[]).map((r) => r.pr_ref);

function reviewTeam(): void {
  origins = {
    lead: { originSystem: "agent-chat", profile: "coordinator" },
    impl: { originSystem: "agent-chat", profile: "implementer", parentSessionId: "lead" },
    rev: { originSystem: "agent-chat", profile: "relay-reviewer", parentSessionId: "lead" },
    rev2: { originSystem: "agent-chat", profile: "reviewer", parentSessionId: "lead" },
  };
  add("impl", prLink("impl", "acme/demo"));
  add("other", prLink("other", "other/tools"));
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "titan-session-graph-rounds-"));
  graph = openSessionGraph(":memory:");
  files = new Map();
  reviewTeam();
});
afterEach(() => {
  graph.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("review rounds", () => {
  it("a changes-requested chat verdict answered by a later commit counts one round", async () => {
    add("rev", chatSend("rev", "cs1", BEFORE_LAST_COMMIT, "acme/demo#7 — Verdict: CHANGES REQUESTED"));

    const summary = await refresh({ resolvePrs: forge({ [DEMO]: { commitTimes: COMMITS, reviews: [] } }) });

    expect(rounds()).toEqual({ review_rounds: 1, review_rounds_gh: 0, review_rounds_chat: 1 });
    expect(summary.reviews).toEqual({ resolved: 1, unresolved: 0 });
  });

  it("two changes-requested verdicts on the same head count once, across reviewers and surfaces", async () => {
    add("rev", chatSend("rev", "cs1", BEFORE_LAST_COMMIT, "acme/demo#7 — Verdict: CHANGES REQUESTED"));
    add("rev2", chatSend("rev2", "cs2", "2026-09-01T02:10:00Z", "acme/demo#7 — Verdict: REQUEST CHANGES"));
    const reviews = [{ state: "CHANGES_REQUESTED", submittedAt: "2026-09-01T02:30:00Z" }];

    await refresh({ resolvePrs: forge({ [DEMO]: { commitTimes: COMMITS, reviews } }) });

    expect(rounds()).toEqual({ review_rounds: 1, review_rounds_gh: 1, review_rounds_chat: 1 });
  });

  it("an approve verdict never adds a round", async () => {
    add("rev", chatSend("rev", "cs1", BEFORE_LAST_COMMIT, "acme/demo#7 — Verdict: APPROVE"));
    const reviews = [{ state: "APPROVED", submittedAt: BEFORE_LAST_COMMIT }];

    await refresh({ resolvePrs: forge({ [DEMO]: { commitTimes: COMMITS, reviews } }) });

    expect(rounds()).toEqual({ review_rounds: 0, review_rounds_gh: 0, review_rounds_chat: 0 });
    expect(graph.db.prepare("SELECT surface, verdict FROM pr_review WHERE pr_ref = ? ORDER BY surface").all(DEMO)).toEqual([
      { surface: "chat", verdict: "approve" },
      { surface: "github", verdict: "approve" },
    ]);
  });

  it("a verdict from a coordinator profile does not count; a relay-reviewer does", async () => {
    add("lead", chatSend("lead", "cs0", "2026-09-01T01:30:00Z", "acme/demo#7 — Verdict: CHANGES REQUESTED"));
    const resolvePrs = forge({ [DEMO]: { commitTimes: COMMITS, reviews: [] } });
    await refresh({ resolvePrs });
    expect(rounds()).toMatchObject({ review_rounds_chat: 0 });

    add("rev", chatSend("rev", "cs1", BEFORE_LAST_COMMIT, "acme/demo#7 — Verdict: CHANGES REQUESTED"));
    await refresh({ resolvePrs });

    expect(rounds()).toMatchObject({ review_rounds_chat: 1 });
  });

  it("an unknown commit history leaves the forge count and no chat count", async () => {
    add("rev", chatSend("rev", "cs1", BEFORE_LAST_COMMIT, "acme/demo#7 — Verdict: CHANGES REQUESTED"));

    await refresh({ resolvePrs: forge({ [DEMO]: { reviewRounds: 2 } }) });

    expect(rounds()).toEqual({ review_rounds: 2, review_rounds_gh: 2, review_rounds_chat: null });
  });
});

describe("resolving the PR a chat verdict names", () => {
  it("a bare PR number resolves through the reviewer's sibling link, and stays unresolved when two repos remain", async () => {
    add("rev", chatSend("rev", "cs1", BEFORE_LAST_COMMIT, "PR #7 — Verdict: CHANGES REQUESTED"));
    await refresh();
    expect(verdictRefs()).toEqual([DEMO]);

    add("impl", prLink("impl", "other/tools"));
    add("rev", chatSend("rev", "cs2", "2026-09-01T02:30:00Z", "PR #7 — Verdict: CHANGES REQUESTED"));
    const summary = await refresh();

    expect(verdictRefs()).toEqual([DEMO, null]);
    expect(summary.reviews).toEqual({ resolved: 0, unresolved: 1 });
  });

  it("a hint that names no known repo resolves through the sibling link", async () => {
    add("rev", chatSend("rev", "cs1", BEFORE_LAST_COMMIT, "nowhere #7 — Verdict: CHANGES REQUESTED"));

    await refresh();

    expect(verdictRefs()).toEqual([DEMO]);
  });

  it("a hint picks the repo whose last path segment matches, in any case", async () => {
    add("rev", chatSend("rev", "cs1", BEFORE_LAST_COMMIT, "Tools #7 — Verdict: CHANGES REQUESTED"));

    await refresh();

    expect(verdictRefs()).toEqual([TOOLS]);
  });

  it("with no family link, the sender's working directory repo picks the PR", async () => {
    const repoDir = path.join(dir, "tools-checkout");
    mkdirSync(path.join(repoDir, ".git"), { recursive: true });
    writeFileSync(path.join(repoDir, ".git", "config"), '[remote "origin"]\n\turl = git@github.com:other/tools.git\n');
    origins = { ...origins, solo: { originSystem: "agent-chat", profile: "reviewer" } };
    add("solo", chatSend("solo", "cs1", BEFORE_LAST_COMMIT, "PR #7 — Verdict: CHANGES REQUESTED", repoDir));

    await refresh();

    expect(verdictRefs()).toEqual([TOOLS]);
  });

  it("an exact repo with no PR row stays unresolved rather than borrowing another repo's number", async () => {
    add("rev", chatSend("rev", "cs1", BEFORE_LAST_COMMIT, "acme/missing#7 — Verdict: CHANGES REQUESTED"));

    await refresh();

    expect(verdictRefs()).toEqual([null]);
  });
});
