import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeTurnState, readClaudeTurnState } from "./turn-state.js";

/** Trimmed copies of real transcript record shapes; all text is a placeholder. */
const at = (second: number): string => `2026-11-01T10:00:${String(second).padStart(2, "0")}.000Z`;
const prompt = (second: number) => ({ type: "user", isSidechain: false, timestamp: at(second), message: { role: "user", content: "do the thing" } });
const toolUse = (second: number) => ({ type: "assistant", isSidechain: false, timestamp: at(second), message: { stop_reason: "tool_use", content: [{ type: "tool_use" }] } });
const toolResult = (second: number) => ({ type: "user", isSidechain: false, timestamp: at(second), message: { content: [{ type: "tool_result" }] } });
const endTurn = (second: number) => ({ type: "assistant", isSidechain: false, timestamp: at(second), message: { stop_reason: "end_turn", content: [{ type: "text" }] } });
const system = (second: number) => ({ type: "system", subtype: "turn_duration", timestamp: at(second) });
const queued = (operation: string) => ({ type: "queue-operation", operation, timestamp: at(50) });

describe("claudeTurnState", () => {
  it("reads a session whose last turn ended as idle since that turn's end", () => {
    const state = claudeTurnState([prompt(1), toolUse(2), toolResult(3), endTurn(4), system(5), { type: "last-prompt" }]);

    expect(state).toEqual({ kind: "idle", sinceMs: Date.parse(at(4)) });
  });

  it("reads a session waiting on a tool result as busy", () => {
    expect(claudeTurnState([prompt(1), endTurn(2), prompt(3), toolUse(4)])).toEqual({ kind: "busy" });
  });

  it("reads a session that has a prompt but no reply yet as busy", () => {
    expect(claudeTurnState([endTurn(2), prompt(3)])).toEqual({ kind: "busy" });
  });

  it("reads a queued prompt after a turn end as busy", () => {
    expect(claudeTurnState([endTurn(2), system(3), queued("enqueue")])).toEqual({ kind: "busy" });
  });

  it("ignores a sidechain turn end while the main chain is mid-tool", () => {
    const sidechain = { ...endTurn(5), isSidechain: true };

    expect(claudeTurnState([prompt(1), toolUse(2), sidechain])).toEqual({ kind: "busy" });
  });

  it("reads a turn the user interrupted as idle since the interrupt", () => {
    const interrupt = { type: "user", timestamp: at(9), message: { content: [{ type: "text", text: "[Request interrupted by user]" }] } };

    expect(claudeTurnState([prompt(1), toolUse(2), interrupt])).toEqual({ kind: "idle", sinceMs: Date.parse(at(9)) });
  });

  it("reads a tail with no conversational record as unknown", () => {
    expect(claudeTurnState([system(1), { type: "custom-title" }]).kind).toBe("unknown");
  });
});

describe("readClaudeTurnState", () => {
  it("classifies the transcript file's tail", () => {
    const file = join(mkdtempSync(join(tmpdir(), "turn-state-")), "session.jsonl");
    writeFileSync(file, `${[prompt(1), endTurn(4)].map((r) => JSON.stringify(r)).join("\n")}\n`);

    expect(readClaudeTurnState(file)).toEqual({ kind: "idle", sinceMs: Date.parse(at(4)) });
  });

  it("skips the line a short window cuts and a final line still being written", () => {
    const file = join(mkdtempSync(join(tmpdir(), "turn-state-")), "session.jsonl");
    const lines = [prompt(1), toolUse(2), endTurn(4)].map((r) => JSON.stringify(r));
    writeFileSync(file, `${lines.join("\n")}\n{"type":"user","timest`);

    const window = lines[2]!.length + 40;

    expect(readClaudeTurnState(file, window)).toEqual({ kind: "idle", sinceMs: Date.parse(at(4)) });
  });

  it("reads a missing transcript as unknown, never idle", () => {
    expect(readClaudeTurnState(join(tmpdir(), "no-such-dir-for-turn-state", "x.jsonl")).kind).toBe("unknown");
  });
});
