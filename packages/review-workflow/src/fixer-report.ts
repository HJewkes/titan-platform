import { FAILURE_CLASSES, type FailureClass } from "./types.js";

export const FIXER_REPORT_START = "FIXER-REPORT";
export const FIXER_REPORT_END = "END-FIXER-REPORT";

/** What the fixer proposes; it applies none of them itself (propose-only, plan TP-3916 §(c) phase 1). */
export const FIXER_FIXES = ["config", "profile-field", "code-task", "none"] as const;
export type FixerFix = (typeof FIXER_FIXES)[number];

/** The parsed block. `patch` is set exactly when `fix` is config or profile-field, `task` exactly when it is code-task. */
export interface FixerReport {
  fingerprint: string;
  failure: FailureClass;
  rootCause: string;
  evidence: readonly string[];
  fix: FixerFix;
  patch?: string;
  task?: string;
  resolves: boolean;
}

export type FixerReportRefusal =
  | "no_block"
  | "multiple_blocks"
  | "unknown_line"
  | "duplicate_field"
  | "missing_fingerprint"
  | "missing_root_cause"
  | "missing_evidence"
  | "bad_class"
  | "bad_fix"
  | "bad_resolves"
  | "fix_detail_mismatch"
  | "wrong_fingerprint";

export type FixerReportRead = { ok: true; report: FixerReport } | { ok: false; refusal: FixerReportRefusal };

const FIELDS = { Fingerprint: "fingerprint", Class: "class", "Root-cause": "rootCause", Fix: "fix", Patch: "patch", Task: "task", Resolves: "resolves" } as const;
type Field = (typeof FIELDS)[keyof typeof FIELDS];
type Draft = Partial<Record<Field, string>> & { evidence: string[] };

/** Folds one body line into the draft; `Evidence` alone may repeat, one line per cited place. */
function takeLine(draft: Draft, line: string): FixerReportRefusal | null {
  if (line === "") return null;
  const match = /^([A-Za-z-]+): (.+)$/.exec(line);
  if (!match) return "unknown_line";
  if (match[1] === "Evidence") return draft.evidence.push(match[2]!), null;
  const field = Object.hasOwn(FIELDS, match[1]!) ? FIELDS[match[1] as keyof typeof FIELDS] : undefined;
  if (field === undefined) return "unknown_line";
  if (draft[field] !== undefined) return "duplicate_field";
  draft[field] = match[2]!;
  return null;
}

const isFix = (value: string | undefined): value is FixerFix => (FIXER_FIXES as readonly string[]).includes(value ?? "");
const isClass = (value: string | undefined): value is FailureClass => (FAILURE_CLASSES as readonly string[]).includes(value ?? "");

/** A config or profile-field fix carries the proposed patch, a code-task fix the filed task, and `none` neither. */
function detailFits(fix: FixerFix, draft: Draft): boolean {
  const wantsPatch = fix === "config" || fix === "profile-field";
  return wantsPatch === (draft.patch !== undefined) && (fix === "code-task") === (draft.task !== undefined);
}

function refusalOf(draft: Draft, expected: string | undefined): FixerReportRefusal | null {
  if (draft.fingerprint === undefined) return "missing_fingerprint";
  if (expected !== undefined && draft.fingerprint !== expected) return "wrong_fingerprint";
  if (!isClass(draft.class)) return "bad_class";
  if (draft.rootCause === undefined) return "missing_root_cause";
  if (draft.evidence.length === 0) return "missing_evidence";
  if (!isFix(draft.fix)) return "bad_fix";
  if (!detailFits(draft.fix, draft)) return "fix_detail_mismatch";
  if (draft.resolves !== "yes" && draft.resolves !== "no") return "bad_resolves";
  return null;
}

function reportOf(draft: Draft): FixerReport {
  return {
    ...{ fingerprint: draft.fingerprint!, failure: draft.class as FailureClass, rootCause: draft.rootCause!, evidence: draft.evidence },
    ...{ fix: draft.fix as FixerFix, resolves: draft.resolves === "yes" },
    ...(draft.patch !== undefined && { patch: draft.patch }),
    ...(draft.task !== undefined && { task: draft.task }),
  };
}

/**
 * The one FIXER-REPORT block in a fixer's final message. With `expectedFingerprint` set, a report about another
 * fingerprint is refused, so one fixer's report can never resume runs parked on a different cause.
 */
export function readFixerReport(text: string, expectedFingerprint?: string): FixerReportRead {
  const lines = text.split("\n").map((line) => line.trim());
  const starts = lines.flatMap((line, index) => (line === FIXER_REPORT_START ? [index] : []));
  if (starts.length === 0) return { ok: false, refusal: "no_block" };
  if (starts.length > 1) return { ok: false, refusal: "multiple_blocks" };
  const end = lines.indexOf(FIXER_REPORT_END, starts[0]);
  const draft: Draft = { evidence: [] };
  for (const line of lines.slice(starts[0]! + 1, end < 0 ? undefined : end)) {
    const refusal = takeLine(draft, line);
    if (refusal !== null) return { ok: false, refusal };
  }
  const refusal = refusalOf(draft, expectedFingerprint);
  return refusal === null ? { ok: true, report: reportOf(draft) } : { ok: false, refusal };
}
