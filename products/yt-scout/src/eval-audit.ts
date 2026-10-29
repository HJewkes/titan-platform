import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { caseExists, readStoredCard, type CardFile } from "./eval-cases.js";
import { rescore, type RescoreInput } from "./rescore.js";
import { totalOf } from "./score-card.js";
import { transcriptForScoring } from "./score.js";
import { writeCase } from "./step-rows.js";

const AUDIT_SAMPLE = 5;
/** A difference this large in total files a case even when both totals fall on the same side. */
const AUDIT_TOTAL_GAP = 3;

const RowSchema = z.looseObject({ step: z.string(), outcome: z.string(), video_id: z.string(), started_at: z.string(), output_path: z.string().nullable() });

export interface AuditCandidate {
  id: string;
  cardPath: string;
  transcriptPath: string;
}

/** Scored cards come from the step rows: the latest `score` row per video that kept a card. The transcript sits beside it as `<id>.md`. */
export function auditCandidates(rowsDir: string, since: Date, casesDir: string): AuditCandidate[] {
  if (!existsSync(rowsDir)) return [];
  const latest = new Map<string, string>();
  for (const f of readdirSync(rowsDir).filter((n) => n.startsWith("steps-")).sort()) {
    for (const line of readFileSync(path.join(rowsDir, f), "utf8").split("\n").filter(Boolean)) {
      const row = RowSchema.parse(JSON.parse(line));
      const kept = row.step === "score" && (row.outcome === "ok" || row.outcome === "fallback") && row.output_path;
      if (kept && new Date(row.started_at) >= since) latest.set(row.video_id, row.output_path!);
    }
  }
  return [...latest]
    .filter(([id]) => !caseExists(casesDir, "score", id))
    .map(([id, cardPath]) => ({ id, cardPath, transcriptPath: path.join(path.dirname(cardPath), `${id}.md`) }));
}

/** A hash order seeded by the week, so a rerun of the same week picks the same cards. */
export function selectAuditSample(candidates: AuditCandidate[], seed: string, n = AUDIT_SAMPLE): AuditCandidate[] {
  const key = (c: AuditCandidate) => createHash("sha256").update(`${seed}:${c.id}`).digest("hex");
  return [...candidates].sort((a, b) => key(a).localeCompare(key(b))).slice(0, n);
}

export function disagrees(original: number, audited: number, thresholdTotal: number): boolean {
  return Math.abs(original - audited) >= AUDIT_TOTAL_GAP || original >= thresholdTotal !== audited >= thresholdTotal;
}

interface AuditOptions extends Omit<RescoreInput, "title" | "transcriptPath" | "partial"> {
  thresholdTotal: number;
  casesDir: string;
}

interface AuditReport {
  sampled: number;
  filed: string[];
  stale: number;
  failed: number;
  costUsd: number;
}

export async function runAudit(sample: AuditCandidate[], opts: AuditOptions): Promise<AuditReport> {
  const report: AuditReport = { sampled: sample.length, filed: [], stale: 0, failed: 0, costUsd: 0 };
  for (const c of sample) {
    const stored = readStoredCard(c.cardPath);
    const r = await rescore({ ...opts, title: stored.title, transcriptPath: c.transcriptPath, partial: stored.partial });
    if (r.kind === "stale") report.stale++;
    else if (r.kind === "failed") report.failed++;
    else {
      report.costUsd += r.costUsd;
      const audited = totalOf(r.card);
      if (disagrees(stored.total, audited, opts.thresholdTotal)) {
        report.filed.push(fileDisagreement(opts, c, stored, { audited, card: r.card }));
      }
    }
  }
  return report;
}

function fileDisagreement(opts: AuditOptions, c: AuditCandidate, stored: CardFile, audit: { audited: number; card: unknown }): string {
  const transcript = readFileSync(c.transcriptPath, "utf8");
  return writeCase(opts.casesDir, {
    step: "score",
    video_id: c.id,
    label: "audit-disagree",
    inputs: { transcript_path: path.resolve(c.transcriptPath), transcript_sha256: createHash("sha256").update(transcriptForScoring(transcript, stored.partial)).digest("hex") },
    prompt_sha: stored.prompt_sha,
    model: stored.model,
    output: { ...stored, audit: { model: opts.model, total: audit.audited, card: audit.card } },
  });
}
