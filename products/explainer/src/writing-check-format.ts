import type { Band } from "./lint-register.js";
import type { WritingMetric } from "./lint-writing.js";
import type { HumanStanding, WritingDimension, WritingReport, WritingRow } from "./writing-check.js";
import type { WritingStatus } from "./writing-status.js";

const NONE = "—";
const DIMENSION_LABEL: Record<WritingDimension, string> = { "AI-isms": "AI-isms", rhythm: "rhythm", specificity: "specific.", register: "register" };
const STATUS_LABEL: Record<WritingStatus, string> = { gate: "GATE", warning: "warning", "report-only": "report", drop: "dropped" };
const WIDTHS = { dimension: 10, metric: 15, value: 13, band: 13, human: 10, status: 8, verdict: 5 } as const;

const UNIT_OF: Partial<Record<WritingMetric, string>> = { "sentence-mean": "", "sentence-cv": "", "adjacent-delta": "", "not-x-tails": "/script" };

const valueText = ({ metric, value }: WritingRow): string => (value === null ? NONE : `${value.toFixed(2)}${UNIT_OF[metric] ?? "/1k"}`);
const bandText = ({ min, max }: Band): string => (min === undefined ? `<=${max}` : `${min}-${max}`);

function humanText(human: HumanStanding | null): string {
  if (human === null) return NONE;
  if (human.percentile === null) return `flags ${Math.round(human.flaggedShare * 100)}%`;
  return `${human.percentile.above ? ">" : "<="}p${human.percentile.edge}`;
}

function verdictText(row: WritingRow): string {
  if (row.verdict === "fail") return "FAIL";
  if (row.verdict === "pass") return "pass";
  return row.verdict === "unmeasured" ? "n/a" : NONE;
}

function rowLine(row: WritingRow, label: string): string {
  const head = label.padEnd(WIDTHS.dimension) + row.metric.padEnd(WIDTHS.metric);
  if (row.status === "drop") return `${head}${"".padEnd(WIDTHS.value + WIDTHS.band + WIDTHS.human)}${STATUS_LABEL.drop}`;
  const cells = [
    valueText(row).padEnd(WIDTHS.value), bandText(row.band).padEnd(WIDTHS.band), humanText(row.human).padEnd(WIDTHS.human),
    STATUS_LABEL[row.status].padEnd(WIDTHS.status), verdictText(row).padEnd(WIDTHS.verdict),
  ];
  return `${head}${cells.join("")}${row.spans.map((span) => `"${span.text}" (${span.beat})`).join(", ")}`.trimEnd();
}

const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** The one line that states the outcome and the exit code it maps to. */
function verdictLine(report: WritingReport): string {
  const { pass, gateFails, warnings, reportOnly, gatesUnmeasured } = report.verdict;
  if (report.bucket === null) return "verdict: report only, under 150 words; exit 0";
  const outcome = pass ? "PASS" : `FAIL (${plural(gateFails, "gate row")})`;
  const unmeasured = gatesUnmeasured > 0 ? `, ${gatesUnmeasured} unmeasured gate row${gatesUnmeasured === 1 ? "" : "s"}` : "";
  return `verdict: ${outcome}, ${plural(warnings, "warning")}, ${reportOnly} report-only${unmeasured}; exit ${pass ? 0 : 1}`;
}

/** The report as the fixed-width table `eval writing` prints. */
export function formatWritingReport(report: WritingReport, source: { script: string; tableSha: string }): string {
  const header = `writing  ${source.script}  ${report.words} words  bucket ${report.bucket ?? "none"}  writing-check.json @ ${source.tableSha}  human reference: ${report.humanReference}`;
  const shortNote = report.bucket === null ? ["under 150 words: every row is reported only and none can fail"] : [];
  const seen = new Set<WritingDimension>();
  const rows = report.rows.map((row) => {
    const label = seen.has(row.dimension) ? "" : DIMENSION_LABEL[row.dimension];
    seen.add(row.dimension);
    return rowLine(row, label);
  });
  return [header, ...shortNote, ...rows, verdictLine(report)].join("\n");
}
