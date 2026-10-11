/**
 * Consumer contract: agent-chat (TP-397). Each case calls session-read the way agent-chat does, with
 * its exact options, and asserts only the fields agent-chat reads. A failure here means a release
 * would break agent-chat; change agent-chat first or keep the behaviour.
 *
 * Call sites mirrored (agent-chat origin/main):
 * - src/agents/turns.ts readRecent: maxBytes 1 MiB, maxTurns limit, maxCharsPerTurn 700; reads role,
 *   timestamp, text, sidechain, status and branch; a TypeError is an empty read.
 * - src/agents/turns.ts finalAssistantText: projection 'text', maxCharsPerTurn 20_000; keeps own
 *   assistant rows with kind 'message'.
 * - src/agents/turns.ts readActivity: projection 'activity', maxTurns 50, maxCharsPerTurn 80; parses
 *   the tool name and a bare sleep out of `[tool <Name>] <json>`, pairs tool_call with tool_result.
 * - src/agents/transcript.ts observedModel: maxBytes 256 KiB, maxTurns 1, maxCharsPerTurn 1; reads
 *   model, relies on the `<synthetic>` skip, treats SessionIdentityError as a miss.
 * - src/agents/burndown/waste-source.ts verdictOf: parseVerdictBlock on a message body.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { SessionIdentityError, claudeSourceFromPath, parseVerdictBlock, readRecentSessionTurnsSync } from "../index.js";
import type { RecentSessionTurn } from "../index.js";

const SESSION = "0b6e1c5a-4f1d-4c5e-9a57-2f0f6a1d0c11";
const TURN_TAIL_BYTES = 1024 * 1024;
const MODEL_TAIL_BYTES = 256 * 1024;

/** Copied from agent-chat src/agents/turns.ts; the contract is that these keep matching. */
const toolName = (text: string): string => /\[tool (?!result)([^\]\s]+)\]/.exec(text)?.[1] ?? "?";
const SLEEP_CALL = /^\[tool Bash\] \{"command":"\s*sleep(?:\s+\d+(?:\.\d+)?[smhd]?)+\s*"[,}]/;

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("agent-chat readActivity contract", () => {
  it("renders a tool call that agent-chat's tool-name and sleep regexes parse", async () => {
    const path = await transcript([
      row("assistant", [{ type: "tool_use", name: "mcp__plugin_agent-chat__chat_inbox", input: {} }]),
      row("user", [{ type: "tool_result", content: "no messages" }]),
      row("assistant", [{ type: "tool_use", name: "Bash", input: { command: "sleep 30" } }]),
    ]);

    const turns = readActivity(path);

    expect(turns.map((turn) => [turn.role, turn.kind])).toEqual([
      ["assistant", "tool_call"],
      ["user", "tool_result"],
      ["assistant", "tool_call"],
    ]);
    expect(toolName(turns[0]!.text)).toBe("mcp__plugin_agent-chat__chat_inbox");
    expect(toolName(turns[1]!.text)).toBe("?");
    expect(turns[2]!.text).toMatch(SLEEP_CALL);
    expect(toolName(turns[2]!.text)).toBe("Bash");
  });

  it("marks a turn cut at 80 chars with a trailing ellipsis and keeps the tool marker", async () => {
    const path = await transcript([
      row("assistant", [{ type: "tool_use", name: "Bash", input: { command: `echo ${"x".repeat(200)}` } }]),
    ]);

    const [turn] = readActivity(path);

    expect(Array.from(turn!.text)).toHaveLength(80);
    expect(turn!.text.endsWith("…")).toBe(true);
    expect(toolName(turn!.text)).toBe("Bash");
  });
});

describe("agent-chat observedModel contract", () => {
  it("skips a newest <synthetic> row and reports the previous real model", async () => {
    const path = await transcript([
      row("assistant", "working", { message: { model: "claude-opus-5-5" } }),
      row("assistant", "API Error: overloaded", { message: { model: "<synthetic>" } }),
    ]);

    const model = readRecentSessionTurnsSync(claudeSourceFromPath(path, "local"), {
      maxBytes: MODEL_TAIL_BYTES,
      maxTurns: 1,
      maxCharsPerTurn: 1,
    }).model;

    expect(model).toMatchObject({ status: "observed", value: "claude-opus-5-5" });
  });

  it("throws a SessionIdentityError, which is a TypeError, for a window naming another session", async () => {
    const path = await transcript([row("user", "hello"), row("assistant", "hi", { sessionId: "another-session" })]);

    const read = () => readRecentSessionTurnsSync(claudeSourceFromPath(path, "local"), {
      maxBytes: MODEL_TAIL_BYTES,
      maxTurns: 1,
      maxCharsPerTurn: 1,
    });

    expect(read).toThrow(SessionIdentityError);
    expect(read).toThrow(TypeError);
  });
});

describe("agent-chat readRecent contract", () => {
  it("reports the observed branch and the turn fields agent-chat maps", async () => {
    const path = await transcript([
      row("user", "start", { gitBranch: "feat/contract", isSidechain: false }),
      row("assistant", "done", { isSidechain: false }),
    ]);

    const recent = readRecentSessionTurnsSync(claudeSourceFromPath(path, "local"), {
      maxBytes: TURN_TAIL_BYTES,
      maxTurns: 10,
      maxCharsPerTurn: 700,
    });

    expect(recent.status).toBe("read");
    expect(recent.branch).toMatchObject({ status: "observed", value: "feat/contract" });
    expect(recent.turns.map(({ role, timestamp, text, sidechain }) => ({ role, timestamp, text, sidechain }))).toEqual([
      { role: "user", timestamp: "2026-10-11T10:00:00Z", text: "start", sidechain: false },
      { role: "assistant", timestamp: "2026-10-11T10:00:00Z", text: "done", sidechain: false },
    ]);
  });
});

describe("agent-chat finalAssistantText contract", () => {
  it("returns the own thread's last assistant message under the text projection", async () => {
    const path = await transcript([
      row("assistant", [{ type: "text", text: "Status: DONE" }], { isSidechain: false }),
      row("assistant", [{ type: "tool_use", name: "Bash", input: { command: "ls" } }], { isSidechain: false }),
      row("assistant", [{ type: "text", text: "subagent chatter" }], { isSidechain: true }),
    ]);

    const recent = readRecentSessionTurnsSync(claudeSourceFromPath(path, "local"), {
      maxBytes: TURN_TAIL_BYTES,
      maxTurns: 20,
      maxCharsPerTurn: 20_000,
      projection: "text",
    });
    const own = recent.turns.filter((turn) => turn.role === "assistant" && turn.sidechain !== true && turn.kind === "message");

    expect(own.at(-1)?.text).toBe("Status: DONE");
  });
});

describe("agent-chat waste-source contract", () => {
  it("reads a reviewer verdict block into the repo, pr, head and verdict it records", () => {
    const head = "0123456789abcdef0123456789abcdef01234567";

    const block = parseVerdictBlock(`Reviewed.\nVerdict: MERGE\nPR: HJewkes/agent-chat#42\nHead: ${head}`);

    expect(block).toMatchObject({ ok: true, verdict: "MERGE", repo: "HJewkes/agent-chat", pr: 42, head });
  });
});

function readActivity(path: string): readonly RecentSessionTurn[] {
  return readRecentSessionTurnsSync(claudeSourceFromPath(path, "local"), {
    maxBytes: TURN_TAIL_BYTES,
    maxTurns: 50,
    maxCharsPerTurn: 80,
    projection: "activity",
  }).turns;
}

function row(type: "user" | "assistant", content: unknown, extra: Record<string, unknown> = {}) {
  const message = { ...(typeof extra.message === "object" ? extra.message : {}), content };
  const rowExtra = Object.fromEntries(Object.entries(extra).filter(([name]) => name !== "message"));
  return { type, sessionId: SESSION, timestamp: "2026-10-11T10:00:00Z", ...rowExtra, message };
}

async function transcript(rows: readonly unknown[]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "titan-agent-chat-contract-"));
  directories.push(directory);
  const path = join(directory, `${SESSION}.jsonl`);
  await writeFile(path, `${rows.map((value) => JSON.stringify(value)).join("\n")}\n`);
  return path;
}
