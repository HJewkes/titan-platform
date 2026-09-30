import { describe, expect, it } from "vitest";
import { parseHookEvent } from "./event.js";

const common = { session_id: "s-1", cwd: "/home/you/projects/app", tool_use_id: "t-1", hook_event_name: "PreToolUse" };
const meta = { cwd: "/home/you/projects/app", sessionId: "s-1", toolUseId: "t-1" };

describe("parseHookEvent", () => {
  it.each([
    ["Bash", { command: "ls", description: "list" }, { kind: "bash", command: "ls" }],
    ["Read", { file_path: "/home/you/.npmrc", offset: 1 }, { kind: "read", path: "/home/you/.npmrc" }],
    ["Grep", { pattern: "x", path: "/home/you/.ssh" }, { kind: "read", path: "/home/you/.ssh" }],
    ["Grep", { pattern: "x" }, { kind: "read", path: "." }],
    ["Edit", { file_path: "/a", old_string: "x", new_string: "y" }, { kind: "write", path: "/a" }],
    ["Write", { file_path: "/a", content: "x" }, { kind: "write", path: "/a" }],
    ["MultiEdit", { file_path: "/a", edits: [] }, { kind: "write", path: "/a" }],
    ["NotebookEdit", { notebook_path: "/a.ipynb", new_source: "x" }, { kind: "write", path: "/a.ipynb" }],
  ])("reads the %s tool's input", (toolName, toolInput, expected) => {
    expect(parseHookEvent({ ...common, tool_name: toolName, tool_input: toolInput })).toEqual({ ...expected, toolName, ...meta });
  });

  it("maps absent optional fields to null", () => {
    expect(parseHookEvent({ tool_name: "Bash", tool_input: { command: "ls" } })).toEqual({
      kind: "bash",
      command: "ls",
      toolName: "Bash",
      cwd: null,
      sessionId: null,
      toolUseId: null,
    });
  });

  it("returns other for a tool the classifier does not read", () => {
    expect(parseHookEvent({ ...common, tool_name: "WebFetch", tool_input: { url: "https://example.com" } })).toEqual({
      kind: "other",
      toolName: "WebFetch",
    });
  });

  it.each([
    ["a Read without a file_path string", { ...common, tool_name: "Read", tool_input: { file_path: 7 } }, "Read"],
    ["a Bash call without a command", { ...common, tool_name: "Bash", tool_input: {} }, "Bash"],
    ["a Write with an empty path", { ...common, tool_name: "Write", tool_input: { file_path: "" } }, "Write"],
    ["no tool_input", { ...common, tool_name: "Read" }, "Read"],
    ["no tool_name", { ...common, tool_input: {} }, null],
    ["a non-object", "not an event", null],
    ["null", null, null],
  ])("returns a malformed result, not a throw, for %s", (_what, raw, toolName) => {
    expect(parseHookEvent(raw)).toEqual({ kind: "malformed", toolName });
  });
});
