import type { CheckResult, CheckViolation, Severity } from "./types.js";
import { CODE_GRAPH_TOOL } from "./violation-location.js";

/** One tool-neutral audit finding; every finding cites a path so a citation checker can verify it. */
export interface Finding {
  id: string;
  path: string;
  lineStart?: number;
  lineEnd?: number;
  symbol?: string;
  signal: string;
  value?: number;
  baseline?: number;
  threshold?: number;
  severity: Severity;
  evidence?: string;
  tool: string;
}

/** A diagnostic from an outside linter, shaped structurally so no linter package is imported. */
export interface ExternalDiagnostic {
  tool: string;
  rule: string;
  file: string;
  line: number;
  endLine?: number;
  message: string;
  severity: "error" | "warning";
}

export function toFindings(result: CheckResult): Finding[] {
  return result.violations.map(violationToFinding);
}

/** Ids key on node id, not line, so a finding keeps its id when code above it moves. */
function violationToFinding(v: CheckViolation): Finding {
  const tool = v.tool ?? CODE_GRAPH_TOOL;
  const target = v.destinationId ? `${v.nodeId}->${v.destinationId}` : v.nodeId;
  return withoutUndefined({
    id: `${tool}:${v.ruleId}:${target}`,
    path: v.path ?? v.nodeId,
    lineStart: v.lineStart,
    lineEnd: v.lineEnd,
    symbol: v.symbol,
    signal: v.ruleId,
    value: v.value,
    threshold: v.threshold,
    severity: v.severity,
    evidence: v.evidence ?? v.message,
    tool,
  });
}

export function externalToFinding(input: ExternalDiagnostic): Finding {
  return withoutUndefined({
    id: `${input.tool}:${input.rule}:${input.file}:${input.line}`,
    path: input.file,
    lineStart: input.line,
    lineEnd: input.endLine,
    signal: input.rule,
    severity: input.severity,
    evidence: input.message,
    tool: input.tool,
  });
}

function withoutUndefined(finding: Finding): Finding {
  return Object.fromEntries(Object.entries(finding).filter(([, v]) => v !== undefined)) as Finding;
}
