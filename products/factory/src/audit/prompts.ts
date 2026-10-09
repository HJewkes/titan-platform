import { METRIC_FAMILIES } from "@titan-design/health/metrics";
import type { AgentStepName } from "./manifest.js";

const TASKS: Record<AgentStepName, string> = {
  "inventory-code":
    "Map each emitter in the code roots (store writes, step ids, gate kinds, log calls, health fields) to file:line. Mark persisted false for what is computed but never stored.",
  purpose:
    "Write the system's purpose, its users (owner, seats, agents) and the 15 questions they most likely ask. For each question say whether a listed surface answers it now (yes, partly, no) and give the exact command when one does. Cite prior sources; do not redo them.",
  propose: `Propose metrics in these families, every family at least once: ${METRIC_FAMILIES.join(", ")}. Each metric gets a definition, a source anchor (a symbol, never a line), a read-only query against a listed store id, a starting SLO, an alert, surfaces and the question ids it answers. Mark source.captured Y only when the query can answer today.`,
  gaps: "Turn the metrics that are not captured (P or N) into slices: a title, a testable done_when, an estimate of 1 to 3, the metric ids it closes and the question ids it unblocks. Do not add a slice for the registry entry; code adds it.",
  plan: "Plan the reports: which audit reports exist, the metric ids each shows, and the view or command that shows it.",
};

/** Agent steps get the inventory as data and must answer with JSON only. */
export function agentPrompt(step: AgentStepName, input: unknown): string {
  return [
    "You are one step of a measurement audit. Read-only: never change code, config or seat files.",
    TASKS[step],
    "Answer with JSON matching the output schema and nothing else.",
    "Input:",
    JSON.stringify(input),
  ].join("\n\n");
}
