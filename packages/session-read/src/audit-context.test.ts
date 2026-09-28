import { describe, expect, it } from "vitest";
import { MIN_ATTACHMENT_CHARS } from "./audit-context.js";
import type { EventOf } from "./events.js";
import { AUDIT_FIXTURE_LINES, CHANNEL_PROMPT, SESSION, SKILL_LISTING, eventsForLines } from "./fixture.js";

function contextBlocks(lines: Record<string, unknown>[]): EventOf<"context_block">[] {
  return eventsForLines(lines).filter((e): e is EventOf<"context_block"> => e.kind === "context_block");
}

function fixtureBlocksAt(ts: string): EventOf<"context_block">[] {
  return contextBlocks(AUDIT_FIXTURE_LINES).filter((b) => b.ts === ts);
}

function attachmentLine(attachment: Record<string, unknown>): Record<string, unknown> {
  return { type: "attachment", sessionId: SESSION, timestamp: "2026-07-01T01:00:00Z", attachment };
}

describe("context_block emitter", () => {
  it("an image block is is_media", () => {
    expect(fixtureBlocksAt("2026-07-01T00:00:27Z").map((b) => [b.source, b.blockIndex, b.chars, b.isMedia])).toEqual([
      ["human", 0, "see this".length, false],
      ["image", 1, "aGVsbG8=".length, true],
    ]);
    const imageResult = {
      type: "user",
      sessionId: SESSION,
      timestamp: "2026-07-01T01:00:00Z",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "r1", content: [{ type: "image", source: { type: "base64", data: "AAAA" } }] }] },
    };
    expect(contextBlocks([imageResult])).toEqual([expect.objectContaining({ source: "tool_result", toolUseId: "r1", chars: 4, isMedia: true })]);
  });

  it("attachments under 256 characters emit no context_block", () => {
    expect(fixtureBlocksAt("2026-07-01T00:00:14Z")).toEqual([]);
    expect(fixtureBlocksAt("2026-07-01T00:00:22Z")).toEqual([]);
    expect(fixtureBlocksAt("2026-07-01T00:00:23Z")).toEqual([
      expect.objectContaining({ source: "skill_listing", attachmentType: "skill_listing", chars: "skill_listing".length + SKILL_LISTING.length }),
    ]);
    const padding = (total: number) => "a".repeat(total - "note".length);
    expect(contextBlocks([attachmentLine({ type: "note", text: padding(MIN_ATTACHMENT_CHARS - 1) })])).toEqual([]);
    expect(contextBlocks([attachmentLine({ type: "note", text: padding(MIN_ATTACHMENT_CHARS) })])).toEqual([
      expect.objectContaining({ source: "attachment", attachmentType: "note", toolUseId: null, chars: MIN_ATTACHMENT_CHARS }),
    ]);
    expect(contextBlocks([attachmentLine({ type: "note", text: padding(MIN_ATTACHMENT_CHARS), toolUseID: "u1" })])[0]?.toolUseId).toBe("u1");
  });

  it("assistant text, thinking and tool input are separate context_block sources", () => {
    const input = { command: "ls -la" };
    const line = {
      type: "assistant",
      sessionId: SESSION,
      timestamp: "2026-07-01T01:00:00Z",
      message: {
        model: "claude-opus-5",
        content: [
          { type: "thinking", thinking: "plan it" },
          { type: "text", text: "listing" },
          { type: "tool_use", id: "c1", name: "Bash", input },
        ],
      },
    };
    expect(contextBlocks([line]).map((b) => [b.source, b.blockIndex, b.toolUseId, b.chars])).toEqual([
      ["assistant_thinking", 0, null, "plan it".length],
      ["assistant_text", 1, null, "listing".length],
      ["assistant_tool_input", 2, "c1", JSON.stringify(input).length],
    ]);
  });

  it("labels user text by what delivered it", () => {
    expect(fixtureBlocksAt("2026-07-01T00:00:20Z")).toEqual([expect.objectContaining({ source: "channel", chars: CHANNEL_PROMPT.length })]);
    expect(fixtureBlocksAt("2026-07-01T00:00:19Z")).toEqual([expect.objectContaining({ source: "human" })]);
    const reminder = { type: "user", isMeta: true, sessionId: SESSION, timestamp: "t", message: { role: "user", content: "<system-reminder>x</system-reminder>" } };
    expect(contextBlocks([reminder])).toEqual([expect.objectContaining({ source: "system_reminder" })]);
  });
});
