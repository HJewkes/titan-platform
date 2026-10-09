import { AUDIT_SCHEMA_ID, METRIC_FAMILIES, measurementAuditSchema, type MeasurementAudit, type MetricSpec } from "@titan-design/health/metrics";
import { classify, type RankedGap } from "./classify.js";
import type { Baseline, Loaded, QuestionCheck, StoreInventory } from "./schemas.js";

export type AuditedMetric = MeasurementAudit["metrics"][number];

interface AuditFindings {
  loaded: Loaded;
  data: { stores: StoreInventory[] };
  emitters: unknown;
  purpose: { purpose: string; users: string[] };
  checks: readonly QuestionCheck[];
  metrics: readonly AuditedMetric[];
  gaps: readonly RankedGap[];
  reports: MeasurementAudit["reports"];
}

/** Each metric carries its baseline and the capture its baseline supports. */
export function classifyAll(metrics: readonly MetricSpec[], baselines: ReadonlyMap<string, Baseline>): AuditedMetric[] {
  return metrics.map((metric) => {
    const baseline = baselines.get(metric.id);
    return { ...metric, source: { ...metric.source, captured: classify(metric, baseline) }, ...(baseline && { baseline }) };
  });
}

/** A P or N metric names the first-ranked slice that closes it, as `S<rank>`. */
function withGapSlice(metric: AuditedMetric, gaps: readonly RankedGap[]): AuditedMetric {
  if (metric.source.captured === "Y") return metric;
  const gap = gaps.find((candidate) => candidate.metric.includes(metric.id));
  return gap ? { ...metric, source: { ...metric.source, gapSlice: `S${gap.rank}` } } : metric;
}

function countsOf(metrics: readonly AuditedMetric[], gaps: readonly RankedGap[]): MeasurementAudit["counts"] {
  const count = (captured: string) => metrics.filter((metric) => metric.source.captured === captured).length;
  return { proposed: metrics.length, Y: count("Y"), P: count("P"), N: count("N"), slices: gaps.length };
}

function extraOf(findings: AuditFindings, metrics: readonly AuditedMetric[]): Record<string, unknown> {
  const families = new Set(metrics.map((metric) => metric.family));
  return {
    answerability: findings.checks.filter((check) => check.outputHash ?? check.error).map(({ question, outputHash, error }) => ({ id: question.id, command: question.command, outputHash, error })),
    missingFamilies: METRIC_FAMILIES.filter((family) => !families.has(family)),
    uncoveredGaps: metrics.filter((metric) => metric.source.captured !== "Y" && metric.source.gapSlice === undefined).map((metric) => metric.id),
  };
}

/** The `titan.measurement-audit/v1` report, checked against the strict write schema. */
export function buildReport(findings: AuditFindings): MeasurementAudit {
  const { loaded } = findings;
  const metrics = findings.metrics.map((metric) => withGapSlice(metric, findings.gaps));
  return measurementAuditSchema.parse({
    schema: AUDIT_SCHEMA_ID,
    system: loaded.input.system,
    mode: loaded.input.mode,
    at: loaded.at,
    codeRev: loaded.codeRev,
    inputs: loaded.input,
    inventory: { data: findings.data, emitters: findings.emitters },
    purpose: findings.purpose.purpose,
    users: findings.purpose.users,
    questions: findings.checks.map((check) => check.question),
    metrics,
    counts: countsOf(metrics, findings.gaps),
    gaps: findings.gaps,
    reports: findings.reports,
    extra: extraOf(findings, metrics),
  });
}
