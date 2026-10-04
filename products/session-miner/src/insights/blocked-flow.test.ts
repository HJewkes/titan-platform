import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GhExec } from "@titan-design/github";
import type { BlockedFlowReport } from "@titan-design/session-analytics";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCli } from "../cli.js";
import { resolveConfig } from "../config.js";
import { startMiner } from "../serve.js";
import { fetchPulls } from "./blocked-flow-sources.js";
import { seedEventsDb } from "./fixture.js";

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const WINDOW = ["--since", "2026-09-12T00:00:00Z", "--until", "2026-09-12T12:00:00Z"];

const verdict = (word: string, pr: string, head: string) => `Verdict: ${word}\nPR: ${pr}\nHead: ${head}\n\nBlocking: none.`;
const message = (ts: string, target: string, body: string) => ({ ts, actor: "rev-1", target, body });

const MESSAGES = [
  message("2026-09-12T08:00:00Z", "seat-a", verdict("MERGE", "acme/widgets#1", HEAD_A)),
  message("2026-09-12T09:00:00Z", "seat-a", verdict("FIX_FIRST", "acme/widgets#2", HEAD_B)),
  message("2026-09-12T10:30:00Z", "seat-a", verdict("MERGE", "acme/widgets#2", HEAD_A)),
  message("2026-09-12T11:00:00Z", "seat-a", verdict("MERGE", "acme/gadgets#3", HEAD_A)),
  message("2026-09-12T11:00:00Z", "seat-a", verdict("MERGE", "acme/gadgets#4", HEAD_B)),
  message("2026-09-12T11:00:00Z", "seat-b", verdict("MERGE", "acme/widgets#5", HEAD_A)),
  message("2026-09-12T11:30:00Z", "seat-a", verdict("WAIT", "acme/widgets#6", HEAD_A)),
  message("2026-09-12T11:05:00Z", "seat-a", "Status: DONE\nPR: acme/widgets#5"),
];

const PULLS = [
  { repo: "acme/widgets", pr: 1, state: "closed", mergedAt: "2026-09-12T09:30:00Z", headSha: HEAD_A },
  { repo: "acme/widgets", pr: 2, state: "closed", mergedAt: "2026-09-12T10:31:00Z", headSha: HEAD_A },
  { repo: "acme/gadgets", pr: 3, state: "open", mergedAt: null, headSha: HEAD_A },
  { repo: "acme/gadgets", pr: 4, state: "open", mergedAt: null, headSha: HEAD_A },
  { repo: "acme/widgets", pr: 5, state: "closed", mergedAt: "2026-09-12T11:02:00Z", headSha: HEAD_A },
  { repo: "acme/widgets", pr: 6, state: "open", mergedAt: null, headSha: HEAD_A },
];

function transcriptLines(): string {
  const call = (id: string, name: string, input: unknown) => ({ timestamp: "2026-09-12T10:00:00Z", message: { content: [{ type: "tool_use", id, name, input }] } });
  const denied = (id: string, reason: string) => ({
    timestamp: "2026-09-12T10:00:01Z",
    message: { content: [{ type: "tool_result", tool_use_id: id, is_error: true, content: `Permission for this action was denied by the Claude Code auto mode classifier. Reason: [${reason}]. Continue.` }] },
  });
  const entries = [
    call("t1", "Bash", { command: "gh api -X PUT repos/acme/gadgets/pulls/3/merge" }),
    denied("t1", "Merge Without Review"),
    call("t2", "mcp__plugin_demo__agent_retire", { name: "demo-1" }),
    denied("t2", "Merge Without Review"),
  ];
  return entries.map((e) => JSON.stringify(e)).join("\n");
}

const JOURNAL = ["# seat-a", "06:00 tick: impl 1/3. No dispatch: rest gated", "06:20 tick: impl 3/3", "06:30 done"].join("\n");

let dir: string;
let env: NodeJS.ProcessEnv;
let files: { pulls: string; transcripts: string; journal: string };

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "titan-miner-blocked-flow-"));
  env = { TITAN_MINER_EVENTS_DB: seedEventsDb(path.join(dir, "events.db"), MESSAGES) };
  files = { pulls: path.join(dir, "pulls.json"), transcripts: path.join(dir, "transcripts"), journal: path.join(dir, "2026-09-12.md") };
  writeFileSync(files.pulls, JSON.stringify(PULLS));
  mkdirSync(files.transcripts);
  writeFileSync(path.join(files.transcripts, "seat-a.jsonl"), transcriptLines());
  writeFileSync(files.journal, JOURNAL);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function cli(args: string[]): Promise<{ code: number; stdout: string }> {
  let stdout = "";
  const io = { stdout: (t: string) => void (stdout += t), stderr: () => undefined, env };
  const code = await runCli(["--state", path.join(dir, "state"), "--corpus", path.join(dir, "corpus"), ...args], io);
  return { code, stdout };
}

async function ask(flags: string[]): Promise<BlockedFlowReport> {
  const { code, stdout } = await cli(["--json", "insights", "blocked-flow", "--pulls", files.pulls, ...flags]);
  expect(code).toBe(0);
  return (JSON.parse(stdout) as { data: { answer: BlockedFlowReport } }).data.answer;
}

describe("insights blocked-flow", () => {
  it("splits a seat's verdict-to-merge at a grant and counts open PRs as censored", async () => {
    const answer = await ask([...WINDOW, "--seat", "seat-a", "--split-at", "2026-09-12T10:00:00Z"]);
    const all = answer.verdictToMerge.rows.at(-1)!;

    expect(all).toMatchObject({ repo: "all", prs: 4, staleHead: 1 });
    expect([all.before!.medianMin, all.after!.medianMin, all.after!.censored]).toEqual([90, 1, 1]);
    expect(answer.openHoldingMerge.rows).toMatchObject([{ repo: "acme/gadgets", pr: 3, seat: "seat-a", ageMin: 60 }]);
  });

  it("never counts a WAIT verdict as a MERGE: its PR has no wait, no row and no open hold", async () => {
    const answer = await ask([...WINDOW, "--seat", "seat-a"]);
    const prs = answer.verdictToMerge.rows.filter((row) => row.repo === "acme/widgets").map((row) => row.prs);

    expect(answer.verdictToMerge.rows.at(-1)).toMatchObject({ repo: "all", prs: 4 });
    expect(prs).toEqual([2]);
    expect(answer.openHoldingMerge.rows.map((row) => row.pr)).not.toContain(6);
  });

  it("counts transcript denials by reason and the action actually refused", async () => {
    const answer = await ask([...WINDOW, "--transcript", `seat-a=${files.transcripts}`]);

    expect(answer.denials.rows).toEqual([
      { reason: "Merge Without Review", action: "mcp:agent_retire", seat: "seat-a", count: 1 },
      { reason: "Merge Without Review", action: "merge", seat: "seat-a", count: 1 },
    ]);
  });

  it("reports idle implementer slot-minutes by the journal's stated reason", async () => {
    const answer = await ask(["--journal", `seat-a=${files.journal}`]);

    expect(answer.idleSlots.rows).toEqual([{ seat: "seat-a", reason: "rest gated", slotMinutes: 40, ticks: 1, lines: [2] }]);
  });

  it("prints each table with the field it cites", async () => {
    const { code, stdout } = await cli(["insights", "blocked-flow", "--pulls", files.pulls, ...WINDOW]);

    expect(code).toBe(0);
    expect(stdout).toContain("[verdictToMerge.rows[].all]");
    expect(stdout).toContain("acme/gadgets");
  });

  it("refuses the session filters it cannot honour", async () => {
    const { code, stdout } = await cli(["--json", "insights", "blocked-flow", "--pulls", files.pulls, "--agent-prefix", "seat-"]);

    expect(code).not.toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ ok: false, error: expect.stringMatching(/--seat/) });
  });

  it("refuses a transcript path over HTTP", async () => {
    const handle = await startMiner(resolveConfig({ stateDir: path.join(dir, "state"), corpusRoot: path.join(dir, "corpus") }, env), { port: 0 });
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/rpc/insights.blocked-flow`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-titan-client": "test" },
        body: JSON.stringify({ transcript: [`seat-a=${files.transcripts}`] }),
      });

      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(/only on the CLI/);
    } finally {
      await handle.close();
    }
  });
});

describe("fetchPulls", () => {
  it("reads state, merged_at and the head sha once per PR, and skips a PR GitHub cannot find", async () => {
    const calls: string[] = [];
    const exec: GhExec = async (args) => {
      calls.push(args[1]!);
      if (args[1]!.endsWith("/2")) return { code: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" };
      return { code: 0, stdout: JSON.stringify({ state: "closed", merged_at: "2026-09-12T09:30:00Z", head: { sha: HEAD_A } }), stderr: "" };
    };

    const pulls = await fetchPulls([{ repo: "acme/w", pr: 1 }, { repo: "acme/w", pr: 1 }, { repo: "acme/w", pr: 2 }], exec);

    expect(calls).toEqual(["repos/acme/w/pulls/1", "repos/acme/w/pulls/2"]);
    expect(pulls).toEqual([{ repo: "acme/w", pr: 1, state: "closed", mergedAt: "2026-09-12T09:30:00.000Z", headSha: HEAD_A }]);
  });

  it("raises any other GitHub failure", async () => {
    const exec: GhExec = async () => ({ code: 1, stdout: "", stderr: "API rate limit exceeded (HTTP 403)" });

    await expect(fetchPulls([{ repo: "acme/w", pr: 1 }], exec)).rejects.toThrow(/rate limit/);
  });
});
