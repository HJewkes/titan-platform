import { MemoryGateStore } from "@titan-design/hitl";
import type { QueueRow } from "../needs/agent-chat-item.js";

export const RUN_A = "11111111-2222-4333-8444-555555555555";
export const RUN_B = "66666666-7777-4888-9999-aaaaaaaaaaaa";
const AT = Date.parse("2026-01-05T09:00:00Z");

const row = (n: number, kind: string, text: string, meta: Record<string, string> = {}): QueueRow => ({
  msgId: `m-${n}`,
  kind,
  from: `agent-${n % 3}`,
  text,
  at: AT + n * 60_000,
  meta,
});

/**
 * Synthetic, shaped like a real broker snapshot: notices and messages to the owner far outnumber the asks,
 * and only some asks carry the chat_ask item shape.
 */
export function brokerSnapshot(): QueueRow[] {
  const notices = Array.from({ length: 9 }, (_, i) => row(i, "notice", `Example notice ${i}: a run finished.`));
  const messages = Array.from({ length: 5 }, (_, i) => row(20 + i, "message", `Example message ${i}`));
  return [
    ...notices,
    ...messages,
    row(30, "question", `Which retry budget for run ${RUN_A}?\nMore detail on a second line.`, {
      kind: "decision",
      task: "EX-1",
      options: JSON.stringify(["two", "three"]),
      recommended: "three",
      on_no_answer: "keep two",
    }),
    row(31, "question", "A bare question with no shape."),
    row(32, "notice", "example/widgets#4 is green at the reviewed head.", { kind: "ready-to-merge", task: "EX-2" }),
    row(33, "approval_request", "Bash: example command", { tool_name: "Bash", input_preview: "example command" }),
    row(34, "endorse_request", "Endorse a spawn", { recipient: "agent-1", agent_id: "agent-9" }),
  ];
}

/** Three pending gates: with and without a brief, and one with two questions; plus a resolved and a cancelled one that must not list. */
export function gateSnapshot(): MemoryGateStore {
  const gates = new MemoryGateStore({ now: () => AT + 3_600_000 });
  gates.create({
    id: `${RUN_A}/approve-merge`,
    prompt: "Merge example/widgets#4 at its reviewed head?",
    summary: "Merge example/widgets#4: CI green, review clean. Recommend merge.",
    evidenceRef: "https://example.invalid/pull/4",
    questions: [{ id: "decision", question: "Merge it?", options: [{ id: "merge", label: "Merge", recommended: true }, { id: "hold", label: "Hold" }] }],
    rule: { table: "example-table", version: "1", ruleId: "merge-approval", resolvers: ["owner-terminal"] },
    expiresAt: "2026-02-01T00:00:00.000Z",
  });
  gates.create({ id: `${RUN_B}/ci-failed:2`, prompt: "CI failed twice on example/widgets#5.\nRetry or stop?" });
  gates.create({
    id: "bare-gate",
    prompt: "Two things to settle.",
    questions: [
      { id: "first", question: "First?", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] },
      { id: "second", question: "Second?", options: [{ id: "c", label: "C" }, { id: "d", label: "D" }] },
    ],
  });
  gates.create({ id: `${RUN_B}/sent-back`, prompt: "Already answered." });
  gates.resolve(`${RUN_B}/sent-back`, {}, { class: "owner-terminal", id: "owner", channel: "test" });
  gates.create({ id: `${RUN_A}/conflict`, prompt: "Withdrawn." });
  gates.cancel(`${RUN_A}/conflict`, "run ended");
  return gates;
}
