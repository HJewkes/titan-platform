import { z } from "zod";
import { AnnotationSchema, VerdictSchema } from "../../server/review-schema-0.3/schema.js";
import type { FrameDraft } from "./frame-feedback.js";

/**
 * An unsent round's answers kept in localStorage, so a reload restores them (G14, a port of the review harness's
 * `page/draftStore.ts`). A draft is bound to the manifest sha it was typed against: answers to an older round.json
 * may name questions or options it no longer has.
 */
const QuestionAnswerSchema = z.union([
  z.strictObject({ pick: z.string() }),
  z.strictObject({ picks: z.array(z.string()) }),
  z.strictObject({ value: z.number() }),
  z.strictObject({ text: z.string() }),
  z.strictObject({ revisionRequested: z.literal(true) }),
]);

const FrameDraftSchema = z.strictObject({
  verdict: VerdictSchema,
  comment: z.string(),
  pins: z.array(AnnotationSchema),
  pinsIssued: z.number().int().min(0),
});

const DraftAnswersSchema = z.strictObject({
  answers: z.record(z.string(), QuestionAnswerSchema),
  comments: z.record(z.string(), z.string()),
  optionNotes: z.record(z.string(), z.record(z.string(), z.string())),
  general: z.string(),
  frames: z.record(z.string(), FrameDraftSchema),
});

const StoredDraftSchema = z.strictObject({ manifestSha256: z.string(), draft: DraftAnswersSchema });

export type DraftAnswers = Omit<z.infer<typeof DraftAnswersSchema>, "frames"> & { frames: Readonly<Record<string, FrameDraft>> };

/** The draft to restore, or none; `discarded` says one was dropped because the round changed under it. */
export interface LoadedDraft {
  draft?: DraftAnswers;
  discarded: boolean;
}

export const draftKey = (roundId: string): string => `titan-console.round-draft.${roundId}`;

/** Storage that is missing or throws (a private window, a full quota) keeps no draft rather than breaking the round. */
function attempt<T>(run: () => T, fallback: T): T {
  try {
    return run();
  } catch {
    return fallback;
  }
}

const parsed = (raw: string): unknown => attempt(() => JSON.parse(raw) as unknown, undefined);

/** The round's draft if it was typed against `manifestSha256`; corrupt JSON or a failed schema is ignored. */
export function loadDraft(storage: Storage, roundId: string, manifestSha256: string): LoadedDraft {
  const raw = attempt(() => storage.getItem(draftKey(roundId)), null);
  if (raw === null) return { discarded: false };
  const stored = StoredDraftSchema.safeParse(parsed(raw));
  if (!stored.success) return { discarded: false };
  if (stored.data.manifestSha256 === manifestSha256) return { draft: stored.data.draft, discarded: false };
  clearDraft(storage, roundId);
  return { discarded: true };
}

export function saveDraft(storage: Storage, roundId: string, manifestSha256: string, draft: DraftAnswers): void {
  attempt(() => storage.setItem(draftKey(roundId), JSON.stringify({ manifestSha256, draft })), undefined);
}

export function clearDraft(storage: Storage, roundId: string): void {
  attempt(() => storage.removeItem(draftKey(roundId)), undefined);
}

/** A draft holding nothing typed is not worth a storage entry. */
export const emptyDraft = ({ answers, comments, optionNotes, general, frames }: DraftAnswers): boolean =>
  Object.keys(answers).length === 0 &&
  Object.values(comments).every((text) => text.trim() === "") &&
  Object.values(optionNotes).every((notes) => Object.values(notes).every((text) => text.trim() === "")) &&
  general.trim() === "" &&
  Object.values(frames).every(({ verdict, comment, pins }) => verdict === null && comment.trim() === "" && pins.length === 0);
