import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LIST_PRICE_CAVEAT } from "@titan-design/session-analytics";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCli } from "../cli.js";
import { createMinerContext } from "../context.js";
import { resolveConfig } from "../config.js";
import { seedInsightGraph, seedToolResults, type FixtureToolResult } from "./fixture.js";
import type { ErrorClass, ToolErrorsReport } from "./tool-errors.js";

const DENIAL = "Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Merge Without Review]. Continue.";

/** One error line per class, each matching its own pattern and none listed before it. */
const CLASS_LINES: [ErrorClass, string][] = [
  ["classifier-denial", DENIAL],
  ["permission-denied", "Permission to use Write has been denied."],
  ["user-rejected", "The user doesn't want to proceed with this tool use."],
  ["sleep-block", "Blocked: sleep 60 is not allowed here"],
  ["wrong-tool-name", "Error: No such tool available: Frobnicate"],
  ["hook-block", "PreToolUse hook blocked this call"],
  ["edit-not-read", "File has not been read yet. Read it first before writing to it."],
  ["edit-no-match", "String to replace not found in file."],
  ["file-missing", "cat: notes.txt: No such file or directory"],
  ["gh-graphql-ratelimit", "GraphQL: API rate limit exceeded for user ID 1."],
  ["gh-secondary-ratelimit", "You have exceeded a secondary rate limit."],
  ["gh-other", "HTTP 404: Not Found (https://api.github.com/repos/acme/widgets)"],
  ["git-error", "fatal: not a git repository"],
  ["timeout", "Command timed out after 2m 0s"],
  ["mcp-tool-error", "InputValidationError: required property missing"],
  ["agent-chat-refused", "no active session named demo-1"],
  ["test-fail", "Tests  3 failed | 10 passed"],
  ["lint-type", "src/a.ts(1,1): error TS2322: Type 'string' is not assignable"],
  ["exit-code", "Exit code 2"],
  ["other", "something odd happened"],
];

const at = (minute: number) => `2026-09-10T12:${String(minute).padStart(2, "0")}:00Z`;

const RESULTS: FixtureToolResult[] = [
  ...CLASS_LINES.map(([cls, text], i): FixtureToolResult => ({ toolUseId: `tu-${cls}`, sessionId: i % 2 ? "impl-1" : "rev-1", ts: at(i), tool: `mcp__demo__tool_${cls}`, isError: true, text })),
  { toolUseId: "tu-fine", sessionId: "impl-1", ts: at(30), tool: "NotAnError", isError: false, text: "Exit code 1" },
  { toolUseId: "tu-early", sessionId: "impl-1", ts: "2026-09-09T23:59:00Z", tool: "BeforeWindow", isError: true, text: "Exit code 1" },
  { toolUseId: "tu-late", sessionId: "rev-1", ts: "2026-09-11T00:00:00Z", tool: "AfterWindow", isError: true, text: "Exit code 1" },
];

const WINDOW = ["--since", "2026-09-10", "--until", "2026-09-11"];

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "titan-miner-tool-errors-"));
  const ctx = createMinerContext(resolveConfig({ stateDir: path.join(dir, "state"), corpusRoot: path.join(dir, "corpus") }, {}));
  seedInsightGraph(ctx.graph().db);
  seedToolResults(ctx.graph().db, path.join(dir, "demo.jsonl"), RESULTS);
  ctx.close();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function cli(args: string[]): Promise<{ code: number; stdout: string }> {
  let stdout = "";
  const io = { stdout: (t: string) => void (stdout += t), stderr: () => undefined, env: {} };
  const code = await runCli(["--state", path.join(dir, "state"), "--corpus", path.join(dir, "corpus"), ...args], io);
  return { code, stdout };
}

async function ask(flags: string[] = []): Promise<ToolErrorsReport> {
  const { code, stdout } = await cli(["--json", "insights", "tool-errors", ...WINDOW, ...flags]);
  expect(code).toBe(0);
  const data = (JSON.parse(stdout) as { data: { question: string; caveat: string; answer: ToolErrorsReport } }).data;
  expect(data).toMatchObject({ question: "Q5", caveat: LIST_PRICE_CAVEAT });
  return data.answer;
}

const classCount = (answer: ToolErrorsReport, cls: ErrorClass) => answer.byClass.filter((r) => r.class === cls).reduce((n, r) => n + r.count, 0);
const tools = (answer: ToolErrorsReport) => answer.byTool.map((r) => r.tool);

describe("insights tool-errors (Q5)", () => {
  it.each(CLASS_LINES)("assigns its fixture line to %s", async (cls) => {
    const answer = await ask();

    expect(classCount(answer, cls)).toBe(1);
    expect(answer.byClass.find((r) => r.class === cls)).toMatchObject({ day: "2026-09-10", count: 1, sessions: 1, agents: 1 });
  });

  it("counts each error tool by its last name segment, and never a result that is not an error", async () => {
    const answer = await ask();

    expect(answer.totals).toMatchObject({ errors: CLASS_LINES.length, unreadable: 0, fromTranscripts: 0, sessions: 2, agents: 2 });
    expect(tools(answer)).toContain("tool_exit-code");
    expect(tools(answer)).not.toContain("NotAnError");
  });

  it("leaves out errors before --since and at or after --until", async () => {
    const answer = await ask();

    expect(tools(answer)).not.toContain("BeforeWindow");
    expect(tools(answer)).not.toContain("AfterWindow");
  });

  it("counts classifier denials by their bracketed reason", async () => {
    const answer = await ask();

    expect(answer.denials).toEqual([{ day: "2026-09-10", reason: "Merge Without Review", count: 1 }]);
  });

  it("narrows to sessions with --agent-prefix", async () => {
    const answer = await ask(["--agent-prefix", "impl-"]);

    expect(answer.totals).toMatchObject({ errors: CLASS_LINES.length / 2, sessions: 1, agents: 1 });
  });

  it("adds --transcript denials the graph lacks and skips the ones it already counted", async () => {
    const transcript = path.join(dir, "seat-a.jsonl");
    const denied = (id: string) => [
      { timestamp: at(40), message: { content: [{ type: "tool_use", id, name: "Bash", input: { command: "gh pr merge 3" } }] } },
      { timestamp: at(40), message: { content: [{ type: "tool_result", tool_use_id: id, is_error: true, content: DENIAL }] } },
    ];
    writeFileSync(transcript, [...denied("tu-classifier-denial"), ...denied("tu-seat-only")].map((e) => JSON.stringify(e)).join("\n"));

    const answer = await ask(["--transcript", `seat-a=${transcript}`]);

    expect(answer.totals).toMatchObject({ errors: CLASS_LINES.length + 1, fromTranscripts: 1, agents: 3 });
    expect(answer.denials).toEqual([{ day: "2026-09-10", reason: "Merge Without Review", count: 2 }]);
  });

  it("refuses --transcript together with a session filter", async () => {
    const { code, stdout } = await cli(["--json", "insights", "tool-errors", "--agent-prefix", "impl-", "--transcript", `seat-a=${path.join(dir, "demo.jsonl")}`]);

    expect(code).not.toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ ok: false, error: expect.stringMatching(/--transcript/) });
  });

  it("prints its tables with the list-price caveat", async () => {
    const { code, stdout } = await cli(["insights", "tool-errors", ...WINDOW]);

    expect(code).toBe(0);
    expect(stdout).toContain("| 2026-09-10 | exit-code | 1 |");
    expect(stdout).toContain(LIST_PRICE_CAVEAT);
  });
});
