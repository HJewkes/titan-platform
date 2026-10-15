import type { Finding } from "../../attribute.js";

/** A gather finding; `supportedFixes` names the repairs an operator or repair step may apply. */
export interface GatherDiagnostic extends Finding {
  supportedFixes?: string[];
}

interface CodeSpec {
  severity: Finding["severity"];
  supportedFixes?: string[];
}

export const GATHER_CODES = {
  "E-LABEL": { severity: "error", supportedFixes: ["finish-synthesis"] },
  "E-UNREAD": { severity: "error", supportedFixes: ["finish-coverage"] },
  "E-PIN-UNKNOWN": { severity: "error" },
  "E-CLONE": { severity: "error", supportedFixes: ["clone-repo"] },
  "E-PIN": { severity: "error", supportedFixes: ["checkout-pin"] },
  "E-TOPICS": { severity: "error", supportedFixes: ["finish-synthesis"] },
  "E-COLUMNS": { severity: "error" },
  "E-SECTION": { severity: "error" },
  "W-SECTION": { severity: "warning" },
  "W-NO-ENTRY": { severity: "warning" },
  "W-NO-PAIN": { severity: "warning", supportedFixes: ["anomaly-hook"] },
  "W-BAD-ROW": { severity: "warning" },
} as const satisfies Record<string, CodeSpec>;

export type GatherCode = keyof typeof GATHER_CODES;

/** Builds a diagnostic whose severity and fixes come from the code table, so callers cannot drift from it. */
export function diag(code: GatherCode, message: string, selector?: string): GatherDiagnostic {
  const spec: CodeSpec = GATHER_CODES[code];
  return {
    code,
    message,
    severity: spec.severity,
    ...(selector === undefined ? {} : { selector }),
    ...(spec.supportedFixes === undefined ? {} : { supportedFixes: [...spec.supportedFixes] }),
  };
}
