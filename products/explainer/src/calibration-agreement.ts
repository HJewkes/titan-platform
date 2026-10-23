import { z } from "zod";
import { AGREEMENT_BAR, CALIBRATION_JUDGES, MIN_LABELS_PER_JUDGE, type CalibrationJudge, type KeyEntry } from "./calibration-queue.js";

const LABEL_OPTIONS = { yes: "Yes", no: "No", unsure: "Can't tell" } as const;
export type OwnerLabel = keyof typeof LABEL_OPTIONS;

const FeedbackSchema = z.object({
  schema: z.literal("titan-review/feedback@1"),
  answers: z.array(z.object({ questionId: z.string(), pick: z.string().optional() }).loose()),
}).loose();

export const OWNER_LABELS: readonly OwnerLabel[] = ["yes", "no", "unsure"];

/** The console refuses an option text that two questions share, so each option names its item. */
export const optionText = (label: OwnerLabel, item: string): string => `${LABEL_OPTIONS[label]} (${item})`;

/** The owner's labels from a round's feedback.json; a question left blank or answered off the options is unlabelled. */
export function labelsFromFeedback(feedback: unknown): Map<string, OwnerLabel> {
  const answers = FeedbackSchema.parse(feedback).answers;
  return new Map(answers.flatMap((a) => {
    const label = OWNER_LABELS.find((l) => a.pick === optionText(l, a.questionId));
    return label ? [[a.questionId, label] as const] : [];
  }));
}

const JudgeAgreementSchema = z.object({
  judge: z.enum(CALIBRATION_JUDGES),
  items: z.number().int(),
  labelled: z.number().int(),
  unsure: z.number().int(),
  agreed: z.number().int(),
  agreement: z.number().nullable(),
  /** Owner "no" items the judge also failed, over all owner "no" items. */
  fail_recall: z.number().nullable(),
}).strict();
export type JudgeAgreement = z.infer<typeof JudgeAgreementSchema>;

export const AgreementRecordSchema = z.object({
  schema: z.literal("judge-agreement/v1"),
  round: z.string().min(1),
  recorded_at: z.string().min(1),
  judges: z.array(JudgeAgreementSchema),
}).strict();
export type AgreementRecord = z.infer<typeof AgreementRecordSchema>;

const ratio = (hits: number, total: number): number | null => (total === 0 ? null : hits / total);

function judgeAgreement(judge: CalibrationJudge, entries: readonly KeyEntry[], labels: ReadonlyMap<string, OwnerLabel>): JudgeAgreement {
  const mine = entries.filter((e) => e.judge === judge);
  const decided = mine.flatMap((e) => {
    const label = labels.get(e.id);
    return label === "yes" || label === "no" ? [{ owner: label === "yes", judge: e.pass }] : [];
  });
  const agreed = decided.filter((d) => d.owner === d.judge).length;
  const ownerFails = decided.filter((d) => !d.owner);
  return {
    judge,
    items: mine.length,
    labelled: decided.length,
    unsure: mine.filter((e) => labels.get(e.id) === "unsure").length,
    agreed,
    agreement: ratio(agreed, decided.length),
    fail_recall: ratio(ownerFails.filter((d) => !d.judge).length, ownerFails.length),
  };
}

/** "Can't tell" is neither agreement nor disagreement, so it only shrinks the labelled count. */
export const agreement = (entries: readonly KeyEntry[], labels: ReadonlyMap<string, OwnerLabel>): JudgeAgreement[] =>
  CALIBRATION_JUDGES.map((judge) => judgeAgreement(judge, entries, labels));

/** Why a judge may not become a climb target or gate, or null once its recorded agreement clears the bar. */
export function promotionRefusal(judge: CalibrationJudge, record: AgreementRecord | undefined): string | null {
  const row = record?.judges.find((j) => j.judge === judge);
  if (!row) return `${judge}: no agreement recorded; label the calibration round first`;
  if (row.labelled < MIN_LABELS_PER_JUDGE) return `${judge}: ${row.labelled} labelled items, at least ${MIN_LABELS_PER_JUDGE} needed`;
  if (row.agreement === null || row.agreement < AGREEMENT_BAR) return `${judge}: agreement ${row.agreement?.toFixed(2) ?? "-"} is below ${AGREEMENT_BAR}`;
  return null;
}
