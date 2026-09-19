import { runChecks, violationKey, type CheckRule, type CheckViolation, type RuleStore } from "@titan-design/code-graph";
import type { ModelEdge, ModelFinding, ModelRule } from "./query/model.js";
import type { Span } from "./query/schemas.js";
import { describeRule } from "./rule-text.js";
import type { SourceReader } from "./source-reader.js";

const IMPORT_KINDS = new Set(["imports", "re-exports"]);
const QUOTES = ['"', "'", "`"];

export function toModelRules(rules: readonly CheckRule[]): ModelRule[] {
  return rules.map((r) => ({ id: r.id, type: r.type, severity: r.severity ?? "error", text: describeRule(r) }));
}

const pairKey = (srcId: string, dstId: string): string => `${srcId}\n${dstId}`;

function specifiersOf(edges: readonly ModelEdge[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of edges) {
    if (IMPORT_KINDS.has(e.kind) && typeof e.attrs.specifier === "string") out.set(pairKey(e.srcId, e.dstId), e.attrs.specifier);
  }
  return out;
}

/** Lines naming the specifier in quotes: the import statement's last line, where `from "x"` sits. */
export function specifierLines(lines: readonly string[], specifier: string): Span[] {
  const quoted = QUOTES.map((q) => `${q}${specifier}${q}`);
  const out: Span[] = [];
  lines.forEach((line, i) => {
    if (quoted.some((q) => line.includes(q))) out.push({ startLine: i + 1, endLine: i + 1 });
  });
  return out;
}

export interface FindingInputs {
  snapshotId: number;
  edges: readonly ModelEdge[];
  read?: SourceReader;
}

interface Located extends FindingInputs {
  specifiers: ReadonlyMap<string, string>;
}

// Edges carry no line numbers, so an import finding's range comes from the source text, when it matches the snapshot.
function importRanges(v: CheckViolation, inputs: Located): Span[] | undefined {
  if (!v.destinationId || !inputs.read) return undefined;
  const specifier = inputs.specifiers.get(pairKey(v.nodeId, v.destinationId));
  if (specifier === undefined) return undefined;
  const source = inputs.read(inputs.snapshotId, v.nodeId);
  if ("unavailable" in source) return undefined;
  const ranges = specifierLines(source.lines, specifier);
  return ranges.length > 0 ? ranges : undefined;
}

function toModelFinding(v: CheckViolation, inputs: Located): ModelFinding {
  const f: ModelFinding = { id: violationKey(v), rule: v.ruleId, severity: v.severity, nodeId: v.nodeId, message: v.message };
  if (v.destinationId !== undefined) f.destinationId = v.destinationId;
  if (v.metric !== undefined) f.metric = v.metric;
  if (v.value !== undefined) f.value = v.value;
  if (v.threshold !== undefined) f.threshold = v.threshold;
  const ranges = importRanges(v, inputs);
  if (ranges) f.ranges = ranges;
  return f;
}

/** The snapshot's check-rule violations as findings, computed by the same engine and keyed as the ratchet keys them. */
export function deriveFindings(store: RuleStore, rules: readonly CheckRule[], inputs: FindingInputs): ModelFinding[] {
  if (rules.length === 0) return [];
  const { violations } = runChecks(store, { snapshotId: inputs.snapshotId, rules });
  const located: Located = { ...inputs, specifiers: specifiersOf(inputs.edges) };
  return violations.map((v) => toModelFinding(v, located));
}
