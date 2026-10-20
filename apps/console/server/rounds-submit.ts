/**
 * `rounds.submit`: the owner's answers to one round, written once as that round's `feedback.json`
 * as the harness builds it (`round-feedback.ts`): each answer echoes its recommendation, `agreed` and the
 * picked option's `after`, and the file is refused whole when `feedbackProblems` finds it at odds with
 * the round. It resolves no gate and calls no factory; a listener reads the file later.
 *
 * The answer is bound to what the owner was shown: the request names the sha256 of `round.json`
 * and is refused when the file on disk differs, and a merge-bound Ship names the head sha the
 * question carried. The round id resolves only to a real directory in the rounds dir, as
 * `rounds.get` does. The file is created with `wx` (O_CREAT|O_EXCL, which also refuses a symlink
 * planted at the name) and mode 0600, so a second submit finds it and is told so; nothing is
 * ever overwritten. A Ship pick is refused while `ship-blockers.ts` finds a reason against it: earlier
 * feedback on the unit not named in `addressed`, or a change request in this answer. The strict feedback@1
 * schema has no field for the Addressed ticks, so they go to an `addressed.json` sidecar once the feedback is
 * written. Side answers marked follow-up never block Ship; they get a `follow-ups.json` sidecar and an owner-inbox
 * item each (`round-follow-ups.ts`). A design round is answered here only when it has a valid `frames/frames.json`, as the page then
 * shows its frames; without one the review harness answers it. A withdrawn round is refused before anything is written, so neither the decision
 * log nor a listener hears of it. A same-user process could still swap the round directory between the check
 * and the write; the OS account is the trust boundary, as in `owner-guard.ts`.
 */
import { createHash } from "node:crypto";
import { open, rm, type FileHandle } from "node:fs/promises";
import { depositItemId } from "@titan-design/owner-queue";
import { writeDeposit } from "@titan-design/owner-queue/spool";
import path from "node:path";
import { z } from "zod";
import { EXIT } from "@titan-design/registry";
import { failure } from "./active-work.js";
import { decisionLogResult, type DecisionLog } from "./decision-log.js";
import type { RoundListeners } from "./listeners.js";
import { ownerWriteCommand } from "./owner-guard.js";
import { roundDecisions, type SubmittedRound } from "./round-decisions.js";
import { hasFramesIndex } from "./round-frames.js";
import { buildRoundFeedback, feedbackProblems } from "./round-feedback.js";
import { FeedbackSchema, type Manifest, type Question } from "./round-schema.js";
import { SubmittedAnswer } from "./round2-adapter.js";
import { FEEDBACK_FILE, MAX_ROUND_BYTES, OPEN_FLAGS, ROUND_FILE, parseManifest, readCapped, readQueueRounds, roundDirExists, statusOf, type RoundsSource } from "./rounds.js";
import { readPriorFeedback } from "./prior-feedback.js";
import { ADDRESSED_FILE, ADDRESSED_SCHEMA_ID } from "./round-notes.js";
import { FOLLOW_UPS_FILE, followUpDeposit, followUpsBytes } from "./round-follow-ups.js";
import { sendBackBlocker, shipBlockers } from "./ship-blockers.js";

export const MAX_FEEDBACK_BYTES = 64 * 1024;
export { ADDRESSED_FILE };
const SHA256 = /^[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40}$/;

const submitArgs = z.strictObject({
  id: z.string().min(1).max(64),
  manifestSha256: z.string().regex(SHA256),
  /** The head sha a merge-bound question named; required when an answer picks its Ship option. */
  headSha: z.string().regex(GIT_SHA).optional(),
  answers: z.array(SubmittedAnswer),
  general: z.string().default(""),
  /** The earlier rounds of this unit whose feedback the owner ticked Addressed; a Ship needs every one. */
  addressed: z.array(z.number().int()).max(100).default([]),
  /** The side questions the owner marked follow-up: filed for later, never blocking Ship. */
  followUps: z.array(z.string().min(1)).max(100).default([]),
});

type SubmitArgs = z.infer<typeof submitArgs>;

const submitResult = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("submitted"),
    path: z.string(),
    sha256: z.string(),
    headSha: z.string().nullable(),
    /** Present when Addressed ticks were sent: whether `addressed.json` holds them. */
    addressed: z.enum(["recorded", "unrecorded"]).optional(),
    /** Present when an answered question was marked follow-up: whether the sidecar holds the marks, and each inbox item, null where none was filed. */
    followUps: z.object({ sidecar: z.enum(["recorded", "unrecorded"]), filed: z.array(z.object({ questionId: z.string(), item: z.string().nullable() })) }).optional(),
    /** One decision-log result per answered question; absent when the console has no decision log. */
    log: z.array(decisionLogResult.extend({ questionId: z.string() })).optional(),
  }),
  z.object({ status: z.literal("already-submitted") }),
]);

type SubmitResult = z.infer<typeof submitResult>;
type LogEntry = NonNullable<Extract<SubmitResult, { status: "submitted" }>["log"]>[number];

interface Submission {
  result: SubmitResult;
  /** Null unless this call wrote the feedback file. */
  round: SubmittedRound | null;
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const refuse = (message: string): never => {
  throw failure(message, EXIT.DATAERR);
};

async function readManifest(roundDir: string): Promise<{ bytes: Buffer; modifiedAt: string }> {
  let handle: FileHandle;
  try {
    handle = await open(path.join(roundDir, ROUND_FILE), OPEN_FLAGS);
  } catch {
    throw failure(`${ROUND_FILE} could not be read`, EXIT.NOINPUT);
  }
  try {
    const stats = await handle.stat();
    const bytes = stats.isFile() && stats.size <= MAX_ROUND_BYTES ? await readCapped(handle, MAX_ROUND_BYTES) : null;
    return { bytes: bytes ?? refuse(`${ROUND_FILE} is not a regular file of at most ${MAX_ROUND_BYTES} bytes`), modifiedAt: stats.mtime.toISOString() };
  } finally {
    await handle.close();
  }
}

/** The same strict parse the lister and detail use, so submit never accepts a round they call invalid. */
function validManifest(bytes: Buffer): Manifest {
  const parsed = parseManifest(bytes);
  return parsed.ok ? parsed.manifest : refuse(`${ROUND_FILE} is not a valid round: ${parsed.reason}`);
}

/** Each field an answer may carry, by the question kinds that take it; `comment` and `optionNotes` go anywhere. */
const FIELD_KINDS: Record<string, readonly string[]> = {
  pick: ["pick-one"],
  revisionRequested: ["pick-one"],
  picks: ["pick-many"],
  value: ["scale"],
  text: ["text"],
};

function answerProblem(question: Question, answer: SubmittedAnswer): string | null {
  const misplaced = Object.keys(answer).find((field) => FIELD_KINDS[field] && !FIELD_KINDS[field].includes(question.kind));
  if (misplaced) return `${misplaced} does not answer a ${question.kind} question`;
  if (answer.pick !== undefined && answer.revisionRequested) return "a revision request carries no pick";
  const offered = "options" in question ? question.options : [];
  const chosen = [...(answer.pick === undefined ? [] : [answer.pick]), ...(answer.picks ?? [])];
  const unknown = chosen.find((option) => !offered.includes(option));
  return unknown === undefined ? null : `"${unknown}" is not one of its options`;
}

/** A follow-up names a side question once; the merge question is the PR's own answer, never a follow-up. */
function checkFollowUps(manifest: Manifest, followUps: readonly string[]): void {
  const questions = new Map(manifest.questions.map((question) => [question.id, question]));
  for (const [index, id] of followUps.entries()) {
    const question = questions.get(id) ?? refuse(`no question "${id}" to mark follow-up`);
    if (question.kind === "pick-one" && question.merge) refuse(`question "${id}" is the Ship decision and cannot be a follow-up`);
    if (followUps.indexOf(id) !== index) refuse(`question "${id}" is marked follow-up twice`);
  }
}

function checkAnswers(manifest: Manifest, answers: SubmittedAnswer[]): void {
  const questions = new Map(manifest.questions.map((question) => [question.id, question]));
  const seen = new Set<string>();
  for (const answer of answers) {
    const question = questions.get(answer.questionId) ?? refuse(`no question "${answer.questionId}" in this round`);
    if (seen.has(answer.questionId)) refuse(`question "${answer.questionId}" is answered twice`);
    seen.add(answer.questionId);
    const problem = answerProblem(question, answer);
    if (problem !== null) refuse(`question "${answer.questionId}": ${problem}`);
  }
}

/** Null when no answer ships a merge-bound question; otherwise the head sha every shipped question named. */
function shippedHead(manifest: Manifest, { answers, headSha }: SubmitArgs): string | null {
  const shipped = manifest.questions.flatMap((question) =>
    question.kind === "pick-one" && question.merge && answers.some((answer) => answer.questionId === question.id && question.merge?.ship.includes(answer.pick ?? ""))
      ? [{ id: question.id, merge: question.merge }]
      : [],
  );
  if (shipped.length === 0) return null;
  if (headSha === undefined) return refuse("a Ship answer must carry the head sha its question names");
  const stale = shipped.find(({ merge }) => merge.headSha !== headSha);
  return stale === undefined ? headSha : refuse(`question "${stale.id}" names a different head sha`);
}

const isShipRound = (manifest: Manifest): boolean => manifest.questions.some((question) => question.kind === "pick-one" && question.merge);

/**
 * The harness's feedback document for these answers, refused whole if it disagrees with its round. Any round may go
 * with questions unanswered (decisions 166 and 513), so every submit is built partial: it lists what it left out.
 */
function feedbackBytes(manifest: Manifest, args: SubmitArgs, now: Date): Buffer {
  const document = FeedbackSchema.parse(buildRoundFeedback(manifest, args.manifestSha256, args, now, true));
  const problems = feedbackProblems(document, manifest);
  if (problems.length > 0) refuse(`the feedback does not fit its round: ${problems.join("; ")}`);
  const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`);
  return bytes.length <= MAX_FEEDBACK_BYTES ? bytes : refuse(`the feedback is over ${MAX_FEEDBACK_BYTES} bytes`);
}

async function refuseBlockedShip(source: RoundsSource, manifest: Manifest, args: SubmitArgs): Promise<void> {
  const blockers = shipBlockers(manifest, await readPriorFeedback(manifest, () => readQueueRounds(source)), args);
  if (blockers.length > 0) refuse(`Ship refused: ${blockers.join("; ")}`);
}

/** A merge-bound question answered with anything but its Ship option: a pick outside `ship`, or a revision request. */
function sendsBack(manifest: Manifest, answers: readonly SubmittedAnswer[]): boolean {
  return manifest.questions.some(
    (question) => question.kind === "pick-one" && question.merge !== undefined &&
      answers.some((answer) => answer.questionId === question.id && (answer.revisionRequested === true || (answer.pick !== undefined && !question.merge?.ship.includes(answer.pick)))),
  );
}

function refuseEmptySendBack(manifest: Manifest, args: SubmitArgs): void {
  const blocker = sendsBack(manifest, args.answers) ? sendBackBlocker(manifest, args) : undefined;
  if (blocker !== undefined) refuse(`Send back refused: ${blocker}`);
}

const errnoOf =(error: unknown): unknown => (error instanceof Error && "code" in error ? error.code : undefined);

/** Null when the file already exists. A failed write removes the file it created, so it cannot block a retry. */
async function writeOnce(file: string, bytes: Buffer): Promise<string | null> {
  let handle: FileHandle;
  try {
    handle = await open(file, "wx", 0o600);
  } catch (error) {
    if (errnoOf(error) === "EEXIST") return null;
    throw failure(`${path.basename(file)} could not be created`, EXIT.UNAVAILABLE);
  }
  try {
    await handle.writeFile(bytes);
  } catch {
    await handle.close();
    await rm(file, { force: true });
    throw failure(`${path.basename(file)} could not be written`, EXIT.UNAVAILABLE);
  }
  await handle.close();
  return file;
}

/** The feedback is already on disk, so a sidecar that cannot be written is reported, never thrown. */
async function recordAddressed(roundDir: string, addressed: readonly number[], now: Date): Promise<{ addressed?: "recorded" | "unrecorded" }> {
  if (addressed.length === 0) return {};
  const bytes = Buffer.from(`${JSON.stringify({ schema: ADDRESSED_SCHEMA_ID, rounds: addressed, at: now.toISOString() }, null, 2)}\n`);
  const written = await writeOnce(path.join(roundDir, ADDRESSED_FILE), bytes).catch(() => null);
  return { addressed: written === null ? "unrecorded" : "recorded" };
}

type FollowUpsRecord = Extract<SubmitResult, { status: "submitted" }>["followUps"];

/** A deposit that cannot be written leaves its item null; the answer is already on disk. */
async function fileFollowUp(inboxDir: string | undefined, deposit: ReturnType<typeof followUpDeposit>): Promise<string | null> {
  if (inboxDir === undefined) return null;
  return writeDeposit(inboxDir, deposit).then(() => depositItemId(deposit.asker, deposit.depositId), () => null);
}

/** Only an answered follow-up is recorded and filed; a mark on an untouched question carries nothing to file. */
async function recordFollowUps(roundDir: string, inboxDir: string | undefined, manifest: Manifest, args: SubmitArgs, now: Date): Promise<{ followUps?: FollowUpsRecord }> {
  const answered = args.answers.filter((answer) => args.followUps.includes(answer.questionId));
  if (answered.length === 0) return {};
  const written = await writeOnce(path.join(roundDir, FOLLOW_UPS_FILE), followUpsBytes(answered.map((answer) => answer.questionId), now)).catch(() => null);
  const filed = [];
  for (const answer of answered) {
    const question = manifest.questions.find((each) => each.id === answer.questionId);
    if (question !== undefined) filed.push({ questionId: answer.questionId, item: await fileFollowUp(inboxDir, followUpDeposit(args.id, manifest, question, answer)) });
  }
  return { followUps: { sidecar: written === null ? "unrecorded" : "recorded", filed } };
}

async function submitRound({ source, inboxDir }: SubmitTarget, args: SubmitArgs, now = new Date()): Promise<Submission> {
  const { dir } = source;
  if (!(await roundDirExists(dir, args.id))) throw failure(`No round named "${args.id}"`, EXIT.NOINPUT);
  const roundDir = path.join(dir, args.id);
  if ((await statusOf(roundDir)) === "withdrawn") refuse("refused: withdrawn; this round was superseded and takes no answer");
  const { bytes: manifestBytes, modifiedAt } = await readManifest(roundDir);
  if (sha256(manifestBytes) !== args.manifestSha256) refuse(`${ROUND_FILE} has changed since it was shown; reload the round`);
  const manifest = validManifest(manifestBytes);
  // A Ship round's variants are the PR's changed images; a design round's frames show only through a valid frames.json.
  const design = manifest.variants.length > 0 && !isShipRound(manifest);
  if (design && !(await hasFramesIndex(roundDir))) refuse("a design round without frames/frames.json is answered in the review harness");
  checkAnswers(manifest, args.answers);
  checkFollowUps(manifest, args.followUps);
  const headSha = shippedHead(manifest, args);
  if (headSha !== null) await refuseBlockedShip(source, manifest, args);
  refuseEmptySendBack(manifest, args);
  const bytes = feedbackBytes(manifest, args, now);
  const written = await writeOnce(path.join(roundDir, FEEDBACK_FILE), bytes);
  if (written === null) return { result: { status: "already-submitted" }, round: null };
  const round = { roundId: args.id, manifest, answers: args.answers, openedAt: modifiedAt, submittedAt: now.toISOString() };
  const addressed = await recordAddressed(roundDir, args.addressed, now);
  const followUps = await recordFollowUps(roundDir, inboxDir, manifest, args, now);
  return { result: { status: "submitted", path: written, sha256: sha256(bytes), headSha, ...addressed, ...followUps }, round };
}

async function logRound(decisionLog: DecisionLog, round: SubmittedRound): Promise<LogEntry[]> {
  const entries: LogEntry[] = [];
  for (const { questionId, item, answer } of roundDecisions(round)) entries.push({ questionId, ...(await decisionLog.record(item, answer)) });
  return entries;
}

/** Runs only once the feedback file is written; a log failure shows in `log` and never undoes the submit. */
async function recordDecisions(decisionLog: DecisionLog | undefined, { result, round }: Submission): Promise<SubmitResult> {
  if (decisionLog === undefined || round === null || result.status !== "submitted") return result;
  return { ...result, log: await logRound(decisionLog, round) };
}

/** The listener runs after the answer is on disk and never changes what the owner is told. */
async function afterSubmit(hooks: SubmitHooks, id: string, submission: Submission): Promise<SubmitResult> {
  const result = await recordDecisions(hooks.decisionLog, submission);
  await hooks.listeners?.afterRoundSubmit(id, result);
  return result;
}

interface SubmitTarget {
  source: RoundsSource;
  /** The owner-inbox spool follow-ups are filed into; absent, they are recorded but not filed. */
  inboxDir?: string;
}

interface SubmitHooks {
  decisionLog?: DecisionLog;
  listeners?: RoundListeners;
}

export function roundsSubmitCommands(source: RoundsSource, decisionLog?: DecisionLog, listeners?: RoundListeners, inboxDir?: string) {
  return {
    "rounds.submit": ownerWriteCommand({
      name: "rounds.submit",
      description: "Write the owner's answers to one round as its feedback.json, once, bound to the round.json sha256 and any Ship's head sha",
      args: submitArgs,
      result: submitResult,
      ownerWrite: true,
      run: async (args) => afterSubmit({ decisionLog, listeners }, args.id, await submitRound({ source, ...(inboxDir !== undefined && { inboxDir }) }, args)),
    }),
  };
}
