import { describe, expect, it } from "vitest";
import type { EventOf } from "./events.js";
import { FIXTURE_LINES, eventsForLines } from "./fixture.js";

function spanFields(lines: Record<string, unknown>[], toolSpans: boolean): string[] {
  const spans = eventsForLines(lines, { toolSpans, contextBlocks: true }).filter((e): e is EventOf<"span"> => e.kind === "span");
  return [...new Set(spans.map((s) => s.field))].sort();
}

describe("LineReader emit policy", () => {
  it("emits prompt and assistant spans but no tool span when tool spans are off", () => {
    expect(spanFields(FIXTURE_LINES, false)).toEqual(["assistant_response", "prompt"]);
  });

  it("emits every span field when tool spans are on", () => {
    expect(spanFields(FIXTURE_LINES, true)).toEqual(["assistant_response", "prompt", "tool_input", "tool_result"]);
  });
});
