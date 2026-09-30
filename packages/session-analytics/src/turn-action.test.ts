import { describe, expect, it } from "vitest";
import { classifyRequest, type ActionCall, type ActionClass } from "./turn-action.js";

const bash = (...heads: string[]): ActionCall => ({ tool: "Bash", heads });

const PER_CLASS: [ActionClass, ActionCall][] = [
  ["journal-write", { tool: "Write", writePaths: ["notes/session-log.md"] }],
  ["pr-ci-check", bash("gh pr checks")],
  ["merge", bash("gh pr merge")],
  ["dispatch", { tool: "mcp__srv__agent_spawn" }],
  ["retire", bash("agent-chat agent retire")],
  ["task-state", bash("active-work task")],
  ["budget-status", { tool: "mcp__srv__session_budget" }],
  ["scorer", bash("python scorer")],
  ["message", { tool: "mcp__srv__chat_send" }],
  ["read-investigate", { tool: "Read", readPaths: ["src/a.ts"] }],
];

describe("classifyRequest", () => {
  it.each(PER_CLASS)("classifies a synthetic %s request", (cls, call) => {
    expect(classifyRequest([call])).toBe(cls);
  });

  it("classifies a jsonl redirect as a journal write", () => {
    expect(classifyRequest([bash(">events.jsonl")])).toBe("journal-write");
  });

  it("classifies the pulls merge API as merge", () => {
    expect(classifyRequest([bash("gh api repos/o/r/pulls/5/merge")])).toBe("merge");
  });

  it("prefers merge over read when the read comes first", () => {
    const calls = [{ tool: "Read", readPaths: ["a.ts"] }, bash("gh pr merge")];
    expect(classifyRequest(calls)).toBe("merge");
  });

  it("classifies a request with no calls as text-only", () => {
    expect(classifyRequest([])).toBe("text-only");
  });

  it("classifies an unknown MCP tool as other", () => {
    expect(classifyRequest([{ tool: "mcp__srv__frobnicate" }])).toBe("other");
  });

  it("uses caller-supplied rules instead of the defaults", () => {
    expect(classifyRequest([bash("deploy")], [{ cls: "merge", head: /^deploy/ }])).toBe("merge");
  });
});
