import { z } from "zod";
import { AGREEMENT_BAR, CALIBRATION_JUDGES, MIN_LABELS_PER_JUDGE, type CalibrationJudge, type ItemKind, type KeyEntry } from "./calibration-queue.js";

/** A pair's "A" is a yes, since a pair entry passes when its judge prefers A. */
const LABEL_OPTIONS = {
  verdict: { yes: "Yes", no: "No", unsure: "Can't tell" },
  pair: { yes: "A", no: "B", unsure: "Can't tell" },
  listener: { yes: "Yes", no: "No", unsure: "Can't tell" },
} as const;
export type OwnerLabel = keyof (typeof LABEL_OPTIONS)["verdict"];

const FeedbackSchema = z.object({
  schema: z.literal("titan-review/feedback@1"),
  answers: z.array(z.object({ questionId: z.string(), pick: z.string().optional() }).loose()),
}).loose();

export const OWNER_LABELS: readonly OwnerLabel[] = ["yes", "no", "unsure"];

/** The console refuses an option text that two questions share, so each option names its item. */
export const optionText = (label: OwnerLabel, item: string, kind: ItemKind = "verdict"): string => `${LABEL_OPTIONS[kind][label]} (${item})`;

const KINDS: readonly ItemKind[] = ["verdict", "pair", "listener"];

/** The owner's labels from a round's feedback.json; a question left blank or answered off the options is unlabelled. */
export function labelsFromFeedback(feedback: unknown): Map<string, OwnerLabel> {
  const answers = FeedbackSchema.parse(feedback).answers;
  return new Map(answers.flatMap((a) => {
    const label = OWNER_LABELS.find((l) => KINDS.some((kind) => a.pick === optionText(l, a.questionId, kind)));
    return label ? [[a.questionId, label] as const] : [];
  }));
}

/** One labelled threshold example for the listener screen: the owner's yes or no beside the chapter's density. */
export interface ListenerLabel {
  case: string;
  chapter: string;
  density: number;
  clear: boolean;
  eval_version: string;
}

/** The round's listener items the owner answered yes or no; a "Can't tell" places no threshold. */
export const listenerLabels = (entries: readonly KeyEntry[], labels: ReadonlyMap<string, OwnerLabel>): ListenerLabel[] =>
  entries.flatMap((e) => {
    const label = labels.get(e.id);
    if (e.judge !== "listener" || e.density === undefined || (label !== "yes" && label !== "no")) return [];
    return [{ case: e.case, chapter: e.target, density: e.density, clear: label === "yes", eval_version: e.evalVersion ?? "" }];
  });

const JudgeAgreementSchema = z.object({
  judge: z.enum(CALIBRATION_JUDGES),
  items: z.number().int(),
  labelled: z.number().int(),
  unsure: z.number().int(),
  agreed: z.number().int(),
  agreement: z.number().nullable(),
  /** Owner "no" items the judge also failed, over all owner "no" items. */
  fail_recall: z.number().nullable(),
  /** Earlier rounds' items left out because the judge has since changed version; absent from records before pooling. */
  stale: z.number().int().optional(),
  eval_versions: z.array(z.string()).optional(),
}).strict();
export type JudgeAgreement = z.infer<typeof JudgeAgreementSchema>;

export const AgreementRecordSchema = z.object({
  schema: z.literal("judge-agreement/v1"),
  round: z.string().min(1),
  recorded_at: z.string().min(1),
  /** The rounds a pooled record scores, oldest first. */
  rounds: z.array(z.string()).optional(),
  judges: z.array(JudgeAgreementSchema),
}).strict();
export type AgreementRecord = z.infer<typeof AgreementRecordSchema>;

const ratio = (hits: number, total: number): number | null => (total === 0 ? null : hits / total);

/** One round's answer key with the owner's labels for it; question ids only mean something within their round. */
interface LabelledRound {
  entries: readonly KeyEntry[];
  labels: ReadonlyMap<string, OwnerLabel>;
}

interface Labelled {
  entry: KeyEntry;
  label: OwnerLabel | undefined;
}

/**
 * A judge's newest round counts whole; an earlier round's item counts only at a version the newest round ran, so
 * labels of two versions of a judge never pool. An item with no version (round 1 predates it) cannot match.
 */
function current(rounds: readonly Labelled[][]): { kept: Labelled[]; stale: number } {
  const newest = rounds.at(-1) ?? [];
  const versions = new Set(newest.map((l) => l.entry.evalVersion));
  const earlier = rounds.slice(0, -1).flat();
  const matching = earlier.filter((l) => l.entry.evalVersion !== undefined && versions.has(l.entry.evalVersion));
  return { kept: [...matching, ...newest], stale: earlier.length - matching.length };
}

function judgeAgreement(judge: CalibrationJudge, rounds: readonly LabelledRound[]): JudgeAgreement {
  const mine = rounds.map((r) => r.entries.filter((e) => e.judge === judge).map((entry) => ({ entry, label: r.labels.get(entry.id) }))).filter((r) => r.length > 0);
  const { kept, stale } = current(mine);
  const decided = kept.flatMap(({ entry, label }) => (label === "yes" || label === "no" ? [{ owner: label === "yes", judge: entry.pass }] : []));
  const agreed = decided.filter((d) => d.owner === d.judge).length;
  const ownerFails = decided.filter((d) => !d.owner);
  return {
    judge,
    items: kept.length,
    labelled: decided.length,
    unsure: kept.filter((l) => l.label === "unsure").length,
    agreed,
    agreement: ratio(agreed, decided.length),
    fail_recall: ratio(ownerFails.filter((d) => !d.judge).length, ownerFails.length),
    stale,
    eval_versions: [...new Set(kept.flatMap((l) => l.entry.evalVersion ?? []))].sort(),
  };
}

/** Rounds oldest first. "Can't tell" is neither agreement nor disagreement, so it only shrinks the labelled count. */
export const pooledAgreement = (rounds: readonly LabelledRound[]): JudgeAgreement[] =>
  CALIBRATION_JUDGES.map((judge) => judgeAgreement(judge, rounds));

export const agreement = (entries: readonly KeyEntry[], labels: ReadonlyMap<string, OwnerLabel>): JudgeAgreement[] =>
  pooledAgreement([{ entries, labels }]);

/** Why a judge may not become a climb target or gate, or null once its recorded agreement clears the bar. */
export function promotionRefusal(judge: CalibrationJudge, record: AgreementRecord | undefined): string | null {
  const row = record?.judges.find((j) => j.judge === judge);
  if (!row) return `${judge}: no agreement recorded; label the calibration round first`;
  if (row.labelled < MIN_LABELS_PER_JUDGE) return `${judge}: ${row.labelled} labelled items, at least ${MIN_LABELS_PER_JUDGE} needed`;
  if (row.agreement === null || row.agreement < AGREEMENT_BAR) return `${judge}: agreement ${row.agreement?.toFixed(2) ?? "-"} is below ${AGREEMENT_BAR}`;
  return null;
}
