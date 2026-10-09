import type { GateBrief } from "@titan-design/hitl";
import type { MeasurementAudit } from "@titan-design/health/metrics";

/** The counts line the owner reads at the gate and the CLI prints. */
export function countsLine({ counts }: MeasurementAudit): string {
  return `${counts.proposed} metrics: ${counts.Y} Y, ${counts.P} P, ${counts.N} N; ${counts.slices} slices`;
}

/** Two-way: a discard writes nothing, and a later audit can be published instead. */
export function reviewBrief(report: MeasurementAudit, runId: string): GateBrief {
  return {
    summary: `${report.system} measurement audit at ${report.codeRev.slice(0, 12)}: ${countsLine(report)}. Publish writes the report.`,
    evidenceRef: `run ${runId}: step results audit-propose, audit-baseline and audit-gaps`,
    questions: [
      {
        id: "decision",
        question: `Publish the ${report.system} measurement audit?`,
        options: [
          { id: "publish", label: "Write the report", recommended: true },
          { id: "discard", label: "Write nothing" },
        ],
      },
    ],
  };
}
