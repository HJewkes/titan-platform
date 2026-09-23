import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { emptyResult } from "./python-tool.js";
import { auditRoot, relativeTo } from "./paths.js";
import type { CheckDiagnostic, ToolFailure } from "../orchestrator/types.js";
import type { RunnerResult } from "./types.js";

// A text scan, not a tokenizer: a marker inside a string literal counts too.
const NOQA = /#\s*noqa\b(?::\s*([A-Z]+\d+(?:[\s,]+[A-Z]+\d+)*))?/gi;
const TYPE_IGNORE = /#\s*type:\s*ignore\b(?:\[([^\]]*)\])?/g;

export const NOQA_RULE = "suppression/noqa";
export const TYPE_IGNORE_RULE = "suppression/type-ignore";

function codesOf(raw: string | undefined): string[] {
  return raw ? raw.split(/[\s,]+/).filter(Boolean) : [];
}

function marker(file: string, line: number, m: RegExpMatchArray, rule: string, label: string): CheckDiagnostic {
  const codes = codesOf(m[1]);
  const message = codes.length ? `${label} suppresses ${codes.join(", ")}` : `blanket ${label} suppresses every check on this line`;
  return { file, line, column: (m.index ?? 0) + 1, severity: "warn", message, category: "suppression", rule, fixable: false };
}

/** Every `# noqa` and `# type: ignore` marker in one file's text, one diagnostic per occurrence. */
export function findSuppressions(file: string, text: string): CheckDiagnostic[] {
  return text.split("\n").flatMap((content, i) => [
    ...[...content.matchAll(NOQA)].map((m) => marker(file, i + 1, m, NOQA_RULE, "noqa")),
    ...[...content.matchAll(TYPE_IGNORE)].map((m) => marker(file, i + 1, m, TYPE_IGNORE_RULE, "type: ignore")),
  ]);
}

/** Suppression markers across `files`, read from disk relative to `cwd`; no tool is run. */
export function countSuppressions(files: string[], options?: { cwd?: string }): RunnerResult {
  const root = auditRoot(options?.cwd);
  const diagnostics: CheckDiagnostic[] = [];
  const failures: ToolFailure[] = [];
  for (const file of files) {
    const shown = relativeTo(root, resolve(root, file));
    try {
      diagnostics.push(...findSuppressions(shown, readFileSync(resolve(root, file), "utf-8")));
    } catch (err) {
      failures.push({ tool: "suppressions", kind: "file-not-checked", file: shown, message: (err as Error).message });
    }
  }
  return emptyResult(0, { diagnostics, failures });
}

export interface SuppressionCounts {
  noqa: number;
  typeIgnore: number;
}

export interface SuppressionTotals extends SuppressionCounts {
  byFile: Record<string, SuppressionCounts>;
}

/** Totals of countSuppressions' diagnostics, overall and per file; other diagnostics are ignored. */
export function suppressionTotals(diagnostics: CheckDiagnostic[]): SuppressionTotals {
  const totals: SuppressionTotals = { noqa: 0, typeIgnore: 0, byFile: {} };
  for (const d of diagnostics) {
    const key = d.rule === NOQA_RULE ? "noqa" : d.rule === TYPE_IGNORE_RULE ? "typeIgnore" : undefined;
    if (!key) continue;
    const file = (totals.byFile[d.file] ??= { noqa: 0, typeIgnore: 0 });
    file[key] += 1;
    totals[key] += 1;
  }
  return totals;
}
