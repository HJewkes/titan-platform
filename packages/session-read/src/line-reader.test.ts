import { describe, expect, it } from "vitest";
import type { EventOf } from "./events.js";
import { FIXTURE_LINES, SESSION, eventsForLines } from "./fixture.js";

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

const echoLine = (type: string, fields: Record<string, unknown>) => ({ type, sessionId: SESSION, ...fields });
const factsOf = (lines: Record<string, unknown>[]) => eventsForLines(lines).filter((e): e is EventOf<"fact"> => e.kind === "fact");

describe("LineReader echo lines", () => {
  it("emits no fact for atis-latch, bridge-session or last-prompt, and last-prompt still seeds the prompt", () => {
    const lines = [
      echoLine("atis-latch", { atis: "a1" }),
      echoLine("bridge-session", { bridgeSessionId: "b1", lastSequenceNum: 3 }),
      echoLine("last-prompt", { lastPrompt: "seed the demo" }),
    ];
    const events = eventsForLines(lines);

    expect(events.filter((e) => e.kind === "fact")).toEqual([]);
    expect(events.filter((e) => e.kind === "session").map((e) => e.patch)).toContainEqual({ seedPrompt: "seed the demo" });
  });

  it("carries each on-change kind's value from its own field", () => {
    const lines = [
      echoLine("ai-title", { aiTitle: "A title" }),
      echoLine("custom-title", { customTitle: "Custom" }),
      echoLine("agent-name", { agentName: "worker-1" }),
      echoLine("mode", { mode: "plan" }),
      echoLine("permission-mode", { permissionMode: "acceptEdits" }),
      echoLine("cost-state", { totalCostUSD: 1.25 }),
    ];

    expect(factsOf(lines).map((f) => [f.eventType, f.state])).toEqual([
      ["ai_title", { key: "ai_title", value: "A title" }],
      ["custom-title", { key: "custom-title", value: "Custom" }],
      ["agent-name", { key: "agent-name", value: "worker-1" }],
      ["mode", { key: "mode", value: "plan" }],
      ["permission_mode", { key: "permission_mode", value: "acceptEdits" }],
      ["cost-state", { key: "cost-state", value: "1.25" }],
    ]);
  });

  it("carries no state on an unknown line type or a line missing its value", () => {
    const facts = factsOf([echoLine("brand-new-kind", { value: "x" }), echoLine("agent-name", {})]);

    expect(facts.map((f) => [f.eventType, f.state])).toEqual([
      ["brand-new-kind", undefined],
      ["agent-name", undefined],
    ]);
  });
});
