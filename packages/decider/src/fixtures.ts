import type { ExclusionPolicy } from "./exclusion.js";
import type { LedgerRowWire } from "./ledger.js";

/** Synthetic test data only: invented questions, names and paths. */

export const OPTIONS = ["Use a queue (Recommended)", "Use a cron job", "Do nothing"];

export function v1Row(overrides: Partial<LedgerRowWire> = {}): LedgerRowWire {
  return {
    key: "transcript:sess-0001:toolu_0001",
    source: "transcript",
    asked_at: "2026-01-02T03:04:05.000Z",
    session_id: "sess-0001",
    tool_use_id: "toolu_0001",
    initiative: "widgets",
    class: "tech_design",
    header: "Scheduler",
    question: "How should the widget refresh run?",
    options: OPTIONS,
    recommended: OPTIONS[0] ?? null,
    answer: OPTIONS[0] ?? null,
    pick_type: "recommended",
    free_text: null,
    ...overrides,
  };
}

export const POLICY: ExclusionPolicy = {
  humanOnlyInitiatives: ["garden-diary"],
  projectInitiatives: [
    { dir: "/home/example/projects", initiative: "workspace" },
    { dir: "/home/example/projects/garden/", initiative: "garden-diary" },
    { dir: "/home/example/projects/widgets", initiative: "widgets" },
  ],
  personalDataPatterns: ["Zorblat", /\bpayslip\b/i],
};
