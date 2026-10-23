import type { GatherDiagnostic } from "../repo-explainer/diagnostics.js";

interface CodeSpec {
  severity: GatherDiagnostic["severity"];
  supportedFixes?: string[];
}

/** `gatherPr`'s coded refusals (errors) and warnings; any error means no facts.jsonl is written. */
export const PR_GATHER_CODES = {
  "E-PR-REF": { severity: "error" },
  "E-PR-READ": { severity: "error", supportedFixes: ["gh-auth"] },
  "E-NO-CLONE": { severity: "error", supportedFixes: ["clone-repo"] },
  "E-LINKED-TASK": { severity: "error", supportedFixes: ["link-task"] },
  "E-EMPTY-DIFF": { severity: "error" },
  "E-CALLGRAPH": { severity: "error", supportedFixes: ["fetch-pr-head"] },
  "W-NO-FINDINGS": { severity: "warning" },
  "W-NO-EDGES": { severity: "warning" },
  "W-BAD-ROW": { severity: "warning" },
} as const satisfies Record<string, CodeSpec>;

export type PrGatherCode = keyof typeof PR_GATHER_CODES;

/** Severity and fixes come from the code table, so callers cannot drift from it. */
export function prDiag(code: PrGatherCode, message: string, selector?: string): GatherDiagnostic {
  const spec: CodeSpec = PR_GATHER_CODES[code];
  return {
    code,
    message,
    severity: spec.severity,
    ...(selector === undefined ? {} : { selector }),
    ...(spec.supportedFixes === undefined ? {} : { supportedFixes: [...spec.supportedFixes] }),
  };
}
