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

type Field = "fingerprint" | "class" | "rootCause" | "fix" | "patch" | "task" | "resolves";
const FIELDS: ReadonlyMap<string, Field> = new Map([
  ["Fingerprint", "fingerprint"],
  ["Class", "class"],
  ["Root-cause", "rootCause"],
  ["Fix", "fix"],
  ["Patch", "patch"],
  ["Task", "task"],
  ["Resolves", "resolves"],
] as const);
type Draft = Partial<Record<Field, string>> & { evidence: string[] };

/** Folds one body line into the draft; `Evidence` alone may repeat, one line per cited place. */
function takeLine(draft: Draft, line: string): FixerReportRefusal | null {
  if (line === "") return null;
  const match = /^([A-Za-z-]+): (.+)$/.exec(line);
  if (!match) return "unknown_line";
  if (match[1] === "Evidence") return draft.evidence.push(match[2]!), null;
  const field = FIELDS.get(match[1]!);
  if (field === undefined) return "unknown_line";
  if (draft[field] !== undefined) return "duplicate_field";
  draft[field] = match[2]!;
  return null;
}

const isFix = (value: string | undefined): value is FixerFix => FIXER_FIXES.some((fix) => fix === value);
const isClass = (value: string | undefined): value is FailureClass => FAILURE_CLASSES.some((failure) => failure === value);

/** A config or profile-field fix carries the proposed patch, a code-task fix the filed task, and `none` neither. */
function detailFits(fix: FixerFix, draft: Draft): boolean {
  const wantsPatch = fix === "config" || fix === "profile-field";
  return wantsPatch === (draft.patch !== undefined) && (fix === "code-task") === (draft.task !== undefined);
}

function readDraft(draft: Draft, expected: string | undefined): FixerReportRead {
  const { fingerprint, class: failure, rootCause, fix, patch, task, resolves } = draft;
  const refuse = (refusal: FixerReportRefusal): FixerReportRead => ({ ok: false, refusal });
  if (fingerprint === undefined) return refuse("missing_fingerprint");
  if (expected !== undefined && fingerprint !== expected) return refuse("wrong_fingerprint");
  if (!isClass(failure)) return refuse("bad_class");
  if (rootCause === undefined) return refuse("missing_root_cause");
  if (draft.evidence.length === 0) return refuse("missing_evidence");
  if (!isFix(fix)) return refuse("bad_fix");
  if (!detailFits(fix, draft)) return refuse("fix_detail_mismatch");
  if (resolves !== "yes" && resolves !== "no") return refuse("bad_resolves");
  const report: FixerReport = { fingerprint, failure, rootCause, evidence: draft.evidence, fix, resolves: resolves === "yes" };
  return { ok: true, report: { ...report, ...(patch !== undefined && { patch }), ...(task !== undefined && { task }) } };
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
  return readDraft(draft, expectedFingerprint);
}
