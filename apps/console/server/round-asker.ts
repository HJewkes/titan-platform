/**
 * Who hears that the owner answered a round, and the one notice each of them is sent. The asker comes first:
 * `decisions file` and `rounds import --seat` write `<round>/asker.json` beside the round. Every seat whose
 * subscription matches the round follows (`round-subscriptions.ts`), and a round with neither goes to tp-operator.
 * Once `rounds.submit` has written `feedback.json`, for a decision, design or Ship round alike, the round listener
 * messages each of them and keeps `<round>/notified-<seat>.json`, written once, so a seat hears once per answer. A failed
 * send writes nothing and `sweep` retries it at start. A TP-3729 `notified.json` still counts for the seat it names.
 *
 * The notice is fixed text built from the round id, the feedback path and whether the answer carries free text. The
 * transport (`round-notice-transport.ts`) delivers it from the human seat, so nothing the filing seat wrote (prompts,
 * option labels) is ever relayed under that provenance.
 */
import path from "node:path";
import { z } from "zod";
import { SEAT_NAME, type SeatNotifier } from "./round-notice-transport.js";
import { UNCLAIMED_SEAT, listSubscriptions, operatorSince, targetMatches, type RoundFacts } from "./round-subscriptions.js";
import { FEEDBACK_FILE, ROUND_FILE, parseManifest } from "./rounds.js";
import { exists, parseStateJson, readStateFile, readStateJson, writeJsonOnce, type StateFile } from "./state-file.js";

export const ASKER_FILE = "asker.json";
const LEGACY_NOTIFIED_FILE = "notified.json";
const ASKER_SCHEMA_ID = "titan-console/asker@1";
const NOTIFIED_SCHEMA_ID = "titan-console/notified@1";

const AskerRecord = z.strictObject({
  schema: z.literal(ASKER_SCHEMA_ID),
  seat: z.string().regex(SEAT_NAME),
  initiative: z.string().regex(SEAT_NAME).nullable(),
  filedAt: z.iso.datetime(),
});
type AskerRecord = z.infer<typeof AskerRecord>;

const NotifiedRecord = z.looseObject({ schema: z.literal(NOTIFIED_SCHEMA_ID), seat: z.string() });

/** Undefined for every way `asker.json` can be missing or wrong; never throws. */
const readAsker = (roundDir: string): Promise<AskerRecord | undefined> => readStateJson(path.join(roundDir, ASKER_FILE), AskerRecord);

/** Writes the round's asker once; returns the asker the round keeps, undefined when its asker.json is not one. */
export async function recordAsker(roundDir: string, asker: { seat: string; initiative: string | null }, now: Date): Promise<AskerRecord | undefined> {
  const record: AskerRecord = { schema: ASKER_SCHEMA_ID, ...asker, filedAt: now.toISOString() };
  return (await writeJsonOnce(path.join(roundDir, ASKER_FILE), record)) ? record : readAsker(roundDir);
}

type NoticeReason = "asker" | "subscriber" | "unclaimed";

const WHY: Record<NoticeReason, string> = { asker: "you filed it", subscriber: "you subscribed to it", unclaimed: "no seat filed or subscribed to it" };

export const answerNotice = (roundId: string, feedbackPath: string, reason: NoticeReason, freeText: boolean): string =>
  `titan-console: the owner answered round ${roundId} (${WHY[reason]}). The answers are in ${feedbackPath} (titan-review/feedback@1). ` +
  (freeText ? "The answer carries free text (a comment, note or written answer); read it." : "The answer carries no free text.");

const FreeTextFields = z.looseObject({
  general: z.string().optional(),
  answers: z.array(z.looseObject({ text: z.string().optional(), comment: z.string().optional(), optionNotes: z.array(z.unknown()).optional() })).optional(),
  variants: z.array(z.looseObject({ comment: z.string().optional(), annotations: z.array(z.looseObject({ note: z.string().optional() })).optional() })).optional(),
});

const written = (text: string | undefined): boolean => text !== undefined && text.trim() !== "";

function carriesFreeText(feedback: StateFile): boolean {
  const fields = parseStateJson(feedback, FreeTextFields);
  if (fields === undefined) return false;
  const answers = fields.answers ?? [];
  const frames = fields.variants ?? [];
  return (
    written(fields.general) ||
    answers.some((answer) => written(answer.text) || written(answer.comment) || (answer.optionNotes?.length ?? 0) > 0) ||
    frames.some((frame) => written(frame.comment) || (frame.annotations ?? []).some((pin) => written(pin.note)))
  );
}

async function roundFacts(dir: string, id: string): Promise<RoundFacts> {
  const file = await readStateFile(path.join(dir, ROUND_FILE));
  const parsed = file === undefined ? undefined : parseManifest(file.bytes);
  if (!parsed?.ok) return { id, unit: null, prs: [] };
  const prs = parsed.manifest.questions.flatMap((question) => (question.kind === "pick-one" && question.merge ? [{ repo: question.merge.repo, pr: question.merge.pr }] : []));
  return { id, unit: parsed.manifest.unit, prs };
}

interface NoticeDeps {
  roundsDir: string;
  /** Absent, only the asker is told, as before subscriptions. */
  subscriptionsDir?: string;
  notify: SeatNotifier;
  now: Date;
  /** True when a submit just wrote the answer; the start-up sweep passes false. */
  live: boolean;
}

interface Recipient {
  seat: string;
  reason: NoticeReason;
}

async function subscribersOf(subscriptionsDir: string, dir: string, roundId: string, answeredAt: Date): Promise<string[]> {
  const heard = (await listSubscriptions(subscriptionsDir)).filter((subscription) => new Date(subscription.at) <= answeredAt);
  if (heard.length === 0) return [];
  const facts = await roundFacts(dir, roundId);
  return heard.filter((subscription) => targetMatches(subscription.target, facts)).map((subscription) => subscription.seat);
}

async function goesToOperator(subscriptionsDir: string, live: boolean, answeredAt: Date): Promise<boolean> {
  if (live) return true;
  const since = await operatorSince(subscriptionsDir);
  return since !== undefined && answeredAt >= since;
}

async function recipientsOf(deps: NoticeDeps, roundId: string, answeredAt: Date): Promise<Recipient[]> {
  const dir = path.join(deps.roundsDir, roundId);
  const seats = new Map<string, NoticeReason>();
  const asker = await readAsker(dir);
  if (asker !== undefined) seats.set(asker.seat, "asker");
  if (deps.subscriptionsDir === undefined) return [...seats].map(([seat, reason]) => ({ seat, reason }));
  for (const seat of await subscribersOf(deps.subscriptionsDir, dir, roundId, answeredAt)) if (!seats.has(seat)) seats.set(seat, "subscriber");
  if (seats.size === 0 && (await goesToOperator(deps.subscriptionsDir, deps.live, answeredAt))) seats.set(UNCLAIMED_SEAT, "unclaimed");
  return [...seats].map(([seat, reason]) => ({ seat, reason }));
}

const notifiedFile = (dir: string, seat: string): string => path.join(dir, `notified-${seat}.json`);

async function wasNotified(dir: string, seat: string): Promise<boolean> {
  if (await exists(notifiedFile(dir, seat))) return true;
  return (await readStateJson(path.join(dir, LEGACY_NOTIFIED_FILE), NotifiedRecord))?.seat === seat;
}

interface NoticeFailure {
  seat: string;
  reason: string;
}

/** Messages each seat that has not yet heard of this round's answer; a round with no answer yet is left alone. */
export async function notifyRound(deps: NoticeDeps, roundId: string): Promise<NoticeFailure[]> {
  const dir = path.join(deps.roundsDir, roundId);
  const feedbackPath = path.join(dir, FEEDBACK_FILE);
  const feedback = await readStateFile(feedbackPath);
  if (feedback === undefined) return [];
  const failures: NoticeFailure[] = [];
  for (const { seat, reason } of await recipientsOf(deps, roundId, feedback.modifiedAt)) {
    if (await wasNotified(dir, seat)) continue;
    try {
      await deps.notify(seat, answerNotice(roundId, feedbackPath, reason, carriesFreeText(feedback)));
      await writeJsonOnce(notifiedFile(dir, seat), { schema: NOTIFIED_SCHEMA_ID, seat, reason, at: deps.now.toISOString() });
    } catch (error) {
      failures.push({ seat, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return failures;
}
