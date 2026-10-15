import { z } from "zod";
import type { L0Result } from "./eval-l0.js";

const ids = z.array(z.string().min(1));

/** One check's labels. A beat or chapter in none of the three sets is unlabelled, not negative. */
const CheckLabelsSchema = z
  .object({
    check: z.string().min(1),
    /** Row check ids that score as this check, e.g. Q-E7 for M1; a row whose check_id is `check` itself also counts. */
    check_ids: ids,
    level: z.enum(["beat", "chapter"]),
    true: ids,
    false: ids,
    borderline: ids,
    note: z.string().optional(),
  })
  .strict()
  .superRefine((labels, ctx) => {
    const seen = [...labels.true, ...labels.false, ...labels.borderline];
    const twice = seen.filter((id, i) => seen.indexOf(id) !== i);
    if (twice.length > 0) ctx.addIssue({ code: "custom", message: `${labels.check}: ${twice.join(", ")} labelled more than once` });
  });

export const LabelsSchema = z
  .object({
    schema: z.literal("labels/v1"),
    script: z.string().min(1),
    source: z.string().min(1),
    checks: z.array(CheckLabelsSchema).min(1),
    owner_named: z.object({ true: ids.min(1), borderline: ids, note: z.string().optional() }).strict(),
    /** Items a cold viewer should be able to explain, with the beats that first use them. */
    items: z.array(z.object({ group: z.string().min(1), items: ids.min(1), first_used: ids.min(1) }).strict()),
  })
  .strict();

export type Labels = z.infer<typeof LabelsSchema>;
export type CheckLabels = Labels["checks"][number];

/** The part of a structure row the scorer reads; L1 judge flags are scored once they are written in the same shape. */
export type CalibrationRow = Pick<L0Result, "check_id" | "severity" | "pass" | "detail_beats">;

export interface CheckScore {
  check: string;
  /** False when no row carried this check, so its precision and recall are unknown rather than zero. */
  ran: boolean;
  flagged: string[];
  true_positives: string[];
  false_positives: string[];
  borderline: string[];
  unlabelled: string[];
  missed: string[];
  precision: number | null;
  recall: number | null;
}

export interface OwnerRecall {
  named: string[];
  caught: string[];
  recall: number | null;
}

export interface Calibration {
  script: string;
  checks: CheckScore[];
  owner: OwnerRecall;
}

const ratio = (hits: number, total: number): number | null => (total === 0 ? null : hits / total);

const failedIds = (rows: readonly CalibrationRow[]): string[] => [...new Set(rows.filter((row) => !row.pass).flatMap((row) => row.detail_beats))];

/** Borderline flags count as neither a hit nor a false positive, so they move neither precision nor recall. */
export function scoreCheck(labels: CheckLabels, rows: readonly CalibrationRow[]): CheckScore {
  const own = new Set([labels.check, ...labels.check_ids]);
  const mine = rows.filter((row) => own.has(row.check_id));
  const flagged = failedIds(mine);
  const within = (set: readonly string[]): string[] => flagged.filter((id) => set.includes(id));
  const truePositives = within(labels.true);
  const falsePositives = within(labels.false);
  const labelled = new Set([...labels.true, ...labels.false, ...labels.borderline]);
  const ran = mine.length > 0;
  return {
    check: labels.check,
    ran,
    flagged,
    true_positives: truePositives,
    false_positives: falsePositives,
    borderline: within(labels.borderline),
    unlabelled: flagged.filter((id) => !labelled.has(id)),
    missed: ran ? labels.true.filter((id) => !flagged.includes(id)) : [],
    precision: ratio(truePositives.length, truePositives.length + falsePositives.length),
    recall: ran ? ratio(truePositives.length, labels.true.length) : null,
  };
}

/** The L0 recall bar: an owner-named beat is caught when at least one error-severity row fails on it. */
export function ownerRecall(labels: Labels, rows: readonly CalibrationRow[]): OwnerRecall {
  const failedOnError = new Set(failedIds(rows.filter((row) => row.severity === "error")));
  const named = labels.owner_named.true;
  const caught = named.filter((id) => failedOnError.has(id));
  return { named, caught, recall: ratio(caught.length, named.length) };
}

export const calibrate = (labels: Labels, rows: readonly CalibrationRow[]): Calibration => ({
  script: labels.script,
  checks: labels.checks.map((check) => scoreCheck(check, rows)),
  owner: ownerRecall(labels, rows),
});
