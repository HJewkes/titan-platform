/**
 * `rounds.submit`: the owner's answers to one round, written once as that round's `feedback.json`
 * in the harness `feedback@1` shape. It resolves no gate and calls no factory; a listener reads
 * the file later.
 *
 * The answer is bound to what the owner was shown: the request names the sha256 of `round.json`
 * and is refused when the file on disk differs, and a merge-bound Ship names the head sha the
 * question carried. The round id resolves only to a real directory in the rounds dir, as
 * `rounds.get` does. The file is created with `wx` (O_CREAT|O_EXCL, which also refuses a symlink
 * planted at the name) and mode 0600, so a second submit finds it and is told so; nothing is
 * ever overwritten. A same-user process could still swap the round directory between the check
 * and the write; the OS account is the trust boundary, as in `owner-guard.ts`.
 */
import { createHash } from "node:crypto";
import { open, rm, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { EXIT } from "@titan-design/registry";
import { failure } from "./active-work.js";
import { ownerWriteCommand } from "./owner-guard.js";
import {
  FEEDBACK_SCHEMA_ID,
  FeedbackDocument,
  Round2Manifest,
  SubmittedAnswer,
  type Round2Question,
} from "./round2-adapter.js";
import { FEEDBACK_FILE, MAX_ROUND_BYTES, OPEN_FLAGS, ROUND_FILE, readCappedBytes, roundDirExists, type RoundsSource } from "./rounds.js";

export const MAX_FEEDBACK_BYTES = 64 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40}$/;

const submitArgs = z.strictObject({
  id: z.string().min(1).max(64),
  manifestSha256: z.string().regex(SHA256),
  /** The head sha a merge-bound question named; required when an answer picks its Ship option. */
  headSha: z.string().regex(GIT_SHA).optional(),
  answers: z.array(SubmittedAnswer),
  general: z.string().default(""),
});

type SubmitArgs = z.infer<typeof submitArgs>;

const submitResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("submitted"), path: z.string(), sha256: z.string(), headSha: z.string().nullable() }),
  z.object({ status: z.literal("already-submitted") }),
]);

type SubmitResult = z.infer<typeof submitResult>;

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const refuse = (message: string): never => {
  throw failure(message, EXIT.DATAERR);
};

async function readManifestBytes(roundDir: string): Promise<Buffer> {
  let handle: FileHandle;
  try {
    handle = await open(path.join(roundDir, ROUND_FILE), OPEN_FLAGS);
  } catch {
    throw failure(`${ROUND_FILE} could not be read`, EXIT.NOINPUT);
  }
  try {
    const stats = await handle.stat();
    const bytes = stats.isFile() && stats.size <= MAX_ROUND_BYTES ? await readCappedBytes(handle) : null;
    return bytes ?? refuse(`${ROUND_FILE} is not a regular file of at most ${MAX_ROUND_BYTES} bytes`);
  } finally {
    await handle.close();
  }
}

function parseManifest(bytes: Buffer): Round2Manifest {
  let json: unknown;
  try {
    json = JSON.parse(bytes.toString("utf8"));
  } catch {
    return refuse(`${ROUND_FILE} is not JSON`);
  }
  const parsed = Round2Manifest.safeParse(json);
  return parsed.success ? parsed.data : refuse(`${ROUND_FILE} is not a round@2 manifest`);
}

/** Each field an answer may carry, by the question kinds that take it; `comment` and `optionNotes` go anywhere. */
const FIELD_KINDS: Record<string, readonly string[]> = {
  pick: ["pick-one"],
  revisionRequested: ["pick-one"],
  picks: ["pick-many"],
  value: ["scale"],
  text: ["text"],
};

function answerProblem(question: Round2Question, answer: SubmittedAnswer): string | null {
  const misplaced = Object.keys(answer).find((field) => FIELD_KINDS[field] && !FIELD_KINDS[field].includes(question.kind));
  if (misplaced) return `${misplaced} does not answer a ${question.kind} question`;
  if (answer.pick !== undefined && answer.revisionRequested) return "a revision request carries no pick";
  const offered = question.options ?? [];
  const chosen = [...(answer.pick === undefined ? [] : [answer.pick]), ...(answer.picks ?? [])];
  const unknown = chosen.find((option) => !offered.includes(option));
  return unknown === undefined ? null : `"${unknown}" is not one of its options`;
}

function checkAnswers(manifest: Round2Manifest, answers: SubmittedAnswer[]): void {
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
function shippedHead(manifest: Round2Manifest, { answers, headSha }: SubmitArgs): string | null {
  const shipped = manifest.questions.filter(
    (question) => question.merge && answers.some((answer) => answer.questionId === question.id && question.merge?.ship.includes(answer.pick ?? "")),
  );
  if (shipped.length === 0) return null;
  if (headSha === undefined) return refuse("a Ship answer must carry the head sha its question names");
  const stale = shipped.find((question) => question.merge?.headSha !== headSha);
  return stale === undefined ? headSha : refuse(`question "${stale.id}" names a different head sha`);
}

/** In a `shown` round every recommendation was on screen, so an answer to a recommended question was not blind. */
function withSeen(manifest: Round2Manifest, answer: SubmittedAnswer) {
  const answered = answer.pick !== undefined || answer.picks !== undefined || answer.value !== undefined || answer.text !== undefined;
  const recommended = manifest.questions.find((question) => question.id === answer.questionId)?.recommendation !== undefined;
  return manifest.recommendations === "shown" && answered && recommended ? { ...answer, recommendationSeen: true as const } : answer;
}

function feedbackBytes(manifest: Round2Manifest, args: SubmitArgs, now: Date): Buffer {
  const document = FeedbackDocument.parse({
    schema: FEEDBACK_SCHEMA_ID,
    unit: manifest.unit,
    round: manifest.round,
    manifestSha256: args.manifestSha256,
    submittedAt: now.toISOString(),
    answers: args.answers.map((answer) => withSeen(manifest, answer)),
    variants: [],
    general: args.general,
  });
  const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`);
  return bytes.length <= MAX_FEEDBACK_BYTES ? bytes : refuse(`the feedback is over ${MAX_FEEDBACK_BYTES} bytes`);
}

const errnoOf = (error: unknown): unknown => (error instanceof Error && "code" in error ? error.code : undefined);

/** Null when the file already exists. A failed write removes the file it created, so it cannot block a retry. */
async function writeOnce(file: string, bytes: Buffer): Promise<string | null> {
  let handle: FileHandle;
  try {
    handle = await open(file, "wx", 0o600);
  } catch (error) {
    if (errnoOf(error) === "EEXIST") return null;
    throw failure(`${FEEDBACK_FILE} could not be created`, EXIT.UNAVAILABLE);
  }
  try {
    await handle.writeFile(bytes);
  } catch {
    await handle.close();
    await rm(file, { force: true });
    throw failure(`${FEEDBACK_FILE} could not be written`, EXIT.UNAVAILABLE);
  }
  await handle.close();
  return file;
}

export async function submitRound({ dir }: RoundsSource, args: SubmitArgs, now = new Date()): Promise<SubmitResult> {
  if (!(await roundDirExists(dir, args.id))) throw failure(`No round named "${args.id}"`, EXIT.NOINPUT);
  const roundDir = path.join(dir, args.id);
  const manifestBytes = await readManifestBytes(roundDir);
  if (sha256(manifestBytes) !== args.manifestSha256) refuse(`${ROUND_FILE} has changed since it was shown; reload the round`);
  const manifest = parseManifest(manifestBytes);
  if (manifest.variants.length > 0) refuse("a design round is answered in the review harness");
  checkAnswers(manifest, args.answers);
  const headSha = shippedHead(manifest, args);
  const bytes = feedbackBytes(manifest, args, now);
  const written = await writeOnce(path.join(roundDir, FEEDBACK_FILE), bytes);
  return written === null ? { status: "already-submitted" } : { status: "submitted", path: written, sha256: sha256(bytes), headSha };
}

export function roundsSubmitCommands(source: RoundsSource) {
  return {
    "rounds.submit": ownerWriteCommand({
      name: "rounds.submit",
      description: "Write the owner's answers to one round as its feedback.json, once, bound to the round.json sha256 and any Ship's head sha",
      args: submitArgs,
      result: submitResult,
      ownerWrite: true,
      run: (args) => submitRound(source, args),
    }),
  };
}
