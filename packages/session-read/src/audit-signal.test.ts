import { describe, expect, it } from "vitest";
import { bashSignals, toolUseSignals } from "./audit-signal.js";
import { parseGitIntent } from "./bash-parse.js";
import type { EventOf } from "./events.js";
import { AUDIT_FIXTURE_LINES, eventsForLines } from "./fixture.js";

const SIGNALS = eventsForLines(AUDIT_FIXTURE_LINES).filter((e): e is EventOf<"signal"> => e.kind === "signal");

function signalsAt(ts: string): [string, string | null, string | null, number][] {
  return SIGNALS.filter((s) => s.ts === ts).map((s) => [s.signal, s.detail, s.toolUseId, s.blockIndex]);
}

describe("signal emitter", () => {
  it('a chat_send whose text contains "Status: DONE" emits signal status_report with detail DONE', () => {
    expect(signalsAt("2026-07-01T00:00:21Z")).toEqual([
      ["chat_send", "coordinator", "t9", 0],
      ["status_report", "DONE", "t9", 0],
    ]);
    const chat = "mcp__plugin_agent-chat_agent-chat__chat_send";
    expect(toolUseSignals(chat, { to: "peer", text: "**Status:** DONE_WITH_CONCERNS" })).toContainEqual({ signal: "status_report", detail: "DONE_WITH_CONCERNS" });
    expect(toolUseSignals(chat, { to: "peer", text: "status is fine" })).toEqual([{ signal: "chat_send", detail: "peer" }]);
  });

  it("gh pr create, git commit, a Write to a .md path and an active-work wrap each emit their signal", () => {
    expect(signalsAt("2026-07-01T00:00:24Z")).toEqual([
      ["doc_written", "docs/notes.md", "t10", 0],
      ["commit", null, "t11", 1],
      ["push", null, "t11", 1],
      ["pr_create", null, "t11", 1],
    ]);
    expect(signalsAt("2026-07-01T00:00:26Z")[0]).toEqual(["task_wrap", "wrap", "t12", 0]);
    expect(toolUseSignals("Write", { file_path: "/tmp/app.ts" })).toEqual([]);
  });

  it("gh pr merge emits signal pr_merge", () => {
    expect(signalsAt("2026-07-01T00:00:16Z")).toEqual([["pr_merge", "42", "t8", 0]]);
  });

  it("an active-work Skill call emits task_wrap", () => {
    expect(signalsAt("2026-07-01T00:00:26Z")[1]).toEqual(["task_wrap", "skill", "t13", 1]);
    expect(toolUseSignals("Skill", { skill: "active-work:active-work" })).toEqual([{ signal: "task_wrap", detail: "skill" }]);
    expect(toolUseSignals("Skill", { skill: "agent-chat:agent-orchestration" })).toEqual([]);
  });

  it("a task done command emits task_done and a spawn emits agent_spawn", () => {
    expect(signalsAt("2026-07-01T00:00:13Z")).toEqual([["task_done", "AW-23", "t7", 0]]);
    expect(signalsAt("2026-07-01T00:00:09Z")).toEqual([["agent_spawn", "Explore", "t3", 0]]);
    expect(toolUseSignals("mcp__plugin_agent-chat_agent-chat__agent_spawn", { name: "sm-t7" })).toEqual([{ signal: "agent_spawn", detail: "sm-t7" }]);
  });

  it("a command with no act of interest emits no signal", () => {
    expect(bashSignals("ls -la", parseGitIntent("ls -la"))).toEqual([]);
    expect(bashSignals("git status", parseGitIntent("git status"))).toEqual([]);
  });
});
