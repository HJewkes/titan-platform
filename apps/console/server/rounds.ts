/**
 * The review rounds the owner answers in the console: one `<round-id>/round.json` per directory
 * under the rounds dir, validated with review-schema 0.3's strict `RoundSchema` and its `feedback.json` with
 * 0.3's strict `FeedbackSchema`, both through `round-schema.ts`.
 * This module only reads; `rounds-submit.ts` is the one writer, of `feedback.json`.
 *
 * Another process writes the dir, so every read is defended: a round id is a plain name (no
 * dot, no slash), a round directory or file that is a symlink is refused, `round.json` and
 * `feedback.json` are read through `O_NOFOLLOW` and `O_NONBLOCK` (a planted FIFO cannot hang the
 * open) up to a size cap, and only `rounds.frame` opens a path a manifest names, through
 * `round-frames.ts`. A round is `sent` once a `feedback.json` sits beside it, and `withdrawn` when
 * `round-withdraw.ts` put a `withdrawn.json` there instead; an answer outranks a withdrawal.
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { isLoopbackUrl } from "@titan-design/review-schema";
import { EXIT } from "@titan-design/registry";
import { failure } from "./active-work.js";
import { readCommand } from "./owner-guard.js";
import { FeedbackSchema, RoundSchema, type Feedback, type Manifest, type Question } from "./round-schema.js";
import { gateAnswer, readAnswer, type GateAnswer } from "./round-answer.js";
import { hasUnboundMergeOffer } from "./round-merge-binding.js";
import { priorFeedbackList, readPriorFeedback } from "./prior-feedback.js";
import { UNWIRED_LINEAGE, shipLineage, type LineageReader, type ShipLineage } from "./ship-lineage.js";

export interface RoundsSource {
  dir: string;
  /** Absent, a Ship round's lineage reads as unknown; fixtures and tests never reach GitHub. */
  lineage?: LineageReader;
}

export const MAX_ROUND_BYTES = 1024 * 1024;
/** The list stops here, so a dir full of junk cannot make one read unbounded. */
const MAX_ROUNDS = 500;
export const ROUND_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const ROUND_FILE = "round.json";
export const FEEDBACK_FILE = "feedback.json";
export const WITHDRAWN_FILE = "withdrawn.json";
export const WITHDRAWN_SCHEMA_ID = "titan-console/withdrawn@1";
const MAX_WITHDRAWN_BYTES = 4096;
const MAX_REASON_ISSUES = 5;
export const OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

const roundStatus = z.enum(["open", "sent", "withdrawn"]);
type RoundStatus = z.infer<typeof roundStatus>;

const roundHead = { id: z.string(), status: roundStatus, updatedAt: z.string().nullable() };

const invalidRound = z.object({ ...roundHead, valid: z.literal(false), reason: z.string() });

const roundSummary = z.discriminatedUnion("valid", [
  z.object({
    ...roundHead,
    valid: z.literal(true),
    unit: z.string(),
    round: z.number(),
    questions: z.number(),
    design: z.boolean(),
    ship: z.boolean(),
    /** Present when a pick-one offers a merge with no binding: it is answerable, but its answer taps no merge. */
    unbound: z.literal(true).optional(),
    recommendations: z.enum(["after-answer", "shown"]),
  }),
  invalidRound,
]);

const roundNotes = z.object({
  general: z.string(),
  /** Each answered question's comment, by question id. */
  comments: z.record(z.string(), z.string()),
});

const roundDetail = z.discriminatedUnion("valid", [
  z.object({
    ...roundHead,
    valid: z.literal(true),
    /** A round with frames and no merge-bound question is a design round, answered in the harness. */
    design: z.boolean(),
    /** A round with a merge-bound pick-one: the console shows its frames and answers it with Ship or Send back. */
    ship: z.boolean(),
    /** The sha256 of the round.json shown, which `rounds.submit` binds an answer to. */
    manifestSha256: z.string(),
    /** True while an after-answer round is unsent: every question's recommendation is stripped. */
    recommendationsWithheld: z.boolean(),
    /** Null unless the manifest's Storybook host is loopback. */
    storybookUrl: z.string().nullable(),
    manifest: z.custom<Manifest>(),
    answer: gateAnswer.optional(),
    /** A Ship round's proven head against its PR base now; absent on any other round. */
    lineage: shipLineage.optional(),
    /** A sent round's free text from its feedback.json; absent while unsent or when that file does not parse. */
    notes: roundNotes.optional(),
    /** An open Ship round's earlier feedback on its unit, each to be ticked Addressed before Ship; absent when there is none. */
    priorFeedback: priorFeedbackList.optional(),
  }),
  invalidRound,
]);

export type RoundNotes = z.infer<typeof roundNotes>;
export type RoundSummary = z.infer<typeof roundSummary>;
export type RoundDetail = z.infer<typeof roundDetail>;

type Parsed = { ok: true; manifest: Manifest; sha256: string } | { ok: false; reason: string };

interface LoadedRound {
  id: string;
  status: RoundStatus;
  updatedAt: string | null;
  parsed: Parsed;
}

const errnoOf = (error: unknown): string | undefined =>
  error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;

function schemaReason(error: z.ZodError): string {
  const issues = error.issues.slice(0, MAX_REASON_ISSUES).map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
  const more = error.issues.length - issues.length;
  return more > 0 ? `${issues.join("; ")}; and ${more} more` : issues.join("; ");
}

export function parseManifest(bytes: Buffer): Parsed {
  let json: unknown;
  try {
    json = JSON.parse(bytes.toString("utf8"));
  } catch {
    return { ok: false, reason: `${ROUND_FILE} is not JSON` };
  }
  const result = RoundSchema.safeParse(json);
  if (!result.success) return { ok: false, reason: schemaReason(result.error) };
  return { ok: true, manifest: result.data, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/** Reads at most one byte past the cap, so a file that grew after its fstat is still refused. */
export async function readCapped(handle: FileHandle, cap: number): Promise<Buffer | null> {
  const buffer = Buffer.alloc(cap + 1);
  let filled = 0;
  for (;;) {
    const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
    if (filled > cap) return null;
  }
  return buffer.subarray(0, filled);
}

function unreadableReason(error: unknown): string {
  const code = errnoOf(error);
  if (code === "ENOENT") return `no ${ROUND_FILE}`;
  if (code === "ELOOP") return `${ROUND_FILE} is a symlink`;
  return `${ROUND_FILE} could not be read`;
}

export async function readManifest(roundDir: string): Promise<{ parsed: Parsed; updatedAt: string | null }> {
  let handle: FileHandle;
  try {
    handle = await open(path.join(roundDir, ROUND_FILE), OPEN_FLAGS);
  } catch (error) {
    return { parsed: { ok: false, reason: unreadableReason(error) }, updatedAt: null };
  }
  try {
    const stats = await handle.stat();
    const updatedAt = stats.mtime.toISOString();
    if (!stats.isFile()) return { parsed: { ok: false, reason: `${ROUND_FILE} is not a regular file` }, updatedAt };
    const tooBig = { ok: false as const, reason: `${ROUND_FILE} is over ${MAX_ROUND_BYTES} bytes` };
    if (stats.size > MAX_ROUND_BYTES) return { parsed: tooBig, updatedAt };
    const bytes = await readCapped(handle, MAX_ROUND_BYTES);
    return { parsed: bytes === null ? tooBig : parseManifest(bytes), updatedAt };
  } finally {
    await handle.close();
  }
}

const isRegularFile = async (file: string): Promise<boolean> => (await lstat(file).catch(() => null))?.isFile() ?? false;

/** Only a regular file marks a round sent or withdrawn; a symlink there proves nothing. */
export async function statusOf(roundDir: string): Promise<RoundStatus> {
  if (await isRegularFile(path.join(roundDir, FEEDBACK_FILE))) return "sent";
  return (await isRegularFile(path.join(roundDir, WITHDRAWN_FILE))) ? "withdrawn" : "open";
}

async function loadRound(dir: string, id: string): Promise<LoadedRound> {
  const roundDir = path.join(dir, id);
  const [{ parsed, updatedAt }, status] = await Promise.all([readManifest(roundDir), statusOf(roundDir)]);
  return { id, status, updatedAt, parsed };
}

/** False for a bad id, a missing entry, or anything that is not a real directory, a symlink included. */
export async function roundDirExists(dir: string, id: string): Promise<boolean> {
  if (!ROUND_ID.test(id)) return false;
  const stats = await lstat(path.join(dir, id)).catch(() => null);
  return stats?.isDirectory() ?? false;
}

const isShip = (manifest: Manifest): boolean => manifest.questions.some((question) => question.kind === "pick-one" && question.merge !== undefined);
const isDesign = (manifest: Manifest): boolean => manifest.variants.length > 0 && !isShip(manifest);

function summaryOf({ id, status, updatedAt, parsed }: LoadedRound): RoundSummary {
  if (!parsed.ok) return { id, status, updatedAt, valid: false, reason: parsed.reason };
  const { manifest } = parsed;
  return {
    id, status, updatedAt, valid: true, unit: manifest.unit, round: manifest.round,
    questions: manifest.questions.length, design: isDesign(manifest), ship: isShip(manifest), recommendations: manifest.recommendations,
    ...(hasUnboundMergeOffer(manifest.questions) && { unbound: true as const }),
  };
}

function withoutRecommendation(question: Question): Question {
  if (!("recommendation" in question)) return question;
  const stripped = { ...question };
  delete stripped.recommendation;
  return stripped;
}

interface DetailExtras {
  answer?: GateAnswer;
  lineage?: ShipLineage;
  notes?: RoundNotes;
}

function detailOf({ id, status, updatedAt, parsed }: LoadedRound, { answer, lineage, notes }: DetailExtras): RoundDetail {
  if (!parsed.ok) return { id, status, updatedAt, valid: false, reason: parsed.reason };
  const withheld = parsed.manifest.recommendations === "after-answer" && status !== "sent";
  const manifest = withheld ? { ...parsed.manifest, questions: parsed.manifest.questions.map(withoutRecommendation) } : parsed.manifest;
  return {
    id, status, updatedAt, valid: true, design: isDesign(manifest), ship: isShip(manifest), manifestSha256: parsed.sha256,
    recommendationsWithheld: withheld, storybookUrl: isLoopbackUrl(manifest.storybookUrl) ? manifest.storybookUrl : null, manifest,
    ...(answer !== undefined && { answer }),
    ...(lineage !== undefined && { lineage }),
    ...(notes !== undefined && { notes }),
  };
}

function notesOf(feedback: Feedback): RoundNotes {
  const commented = feedback.answers.flatMap((answer) => (answer.comment?.trim() ? [[answer.questionId, answer.comment] as const] : []));
  return { general: feedback.general, comments: Object.fromEntries(commented) };
}

/** Only a sent round has notes; a feedback.json that does not parse shows none rather than failing the page. */
async function readNotes(roundDir: string): Promise<RoundNotes | undefined> {
  const read = await readFeedback(roundDir);
  return read.ok && read.feedback !== null ? notesOf(read.feedback) : undefined;
}

async function lineageOf(source: RoundsSource, parsed: Parsed): Promise<ShipLineage | undefined> {
  const binding = parsed.ok ? parsed.manifest.questions.flatMap((question) => (question.kind === "pick-one" && question.merge ? [question.merge] : []))[0] : undefined;
  if (binding === undefined) return undefined;
  return source.lineage ? source.lineage(binding) : UNWIRED_LINEAGE;
}

const newestFirst = (a: RoundSummary, b: RoundSummary): number => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") || a.id.localeCompare(b.id);

/**
 * A missing rounds dir is no rounds yet; a symlinked round directory is skipped, as `isDirectory` is false for it.
 * The dir is returned so an empty page can say where rounds are read from.
 */
export async function listRounds({ dir }: RoundsSource): Promise<{ rounds: RoundSummary[]; truncated: boolean; dir: string }> {
  const entries = await readdir(dir, { withFileTypes: true }).catch((error: unknown) => {
    if (errnoOf(error) === "ENOENT") return [];
    throw failure("the rounds dir could not be read", EXIT.UNAVAILABLE);
  });
  const ids = entries.filter((entry) => entry.isDirectory() && ROUND_ID.test(entry.name)).map((entry) => entry.name).sort();
  const loaded = await Promise.all(ids.slice(0, MAX_ROUNDS).map((id) => loadRound(dir, id)));
  return { rounds: loaded.map(summaryOf).sort(newestFirst), truncated: ids.length > MAX_ROUNDS, dir };
}

export async function getRound(source: RoundsSource, id: string): Promise<RoundDetail> {
  const { dir } = source;
  if (!(await roundDirExists(dir, id))) throw failure(`No round named "${id}"`, EXIT.NOINPUT);
  const roundDir = path.join(dir, id);
  const [round, answer, notes] = await Promise.all([loadRound(dir, id), readAnswer(roundDir), readNotes(roundDir)]);
  const prior = round.parsed.ok && round.status === "open" ? await readPriorFeedback(round.parsed.manifest, () => readQueueRounds(source)) : [];
  return { ...detailOf(round, { answer, lineage: await lineageOf(source, round.parsed), notes }), ...(prior.length > 0 && { priorFeedback: prior }) };
}

const WithdrawalSchema = z.object({ schema: z.literal(WITHDRAWN_SCHEMA_ID), reason: z.string().min(1).max(200), at: z.string() });
export type Withdrawal = { reason: string; at: string | null };

/**
 * A valid round as the owner queue reads it: `feedback` is the validated feedback.json, or null while unsent;
 * `withdrawn` is non-null when a regular withdrawn.json sits beside it.
 */
export interface QueueRound {
  id: string;
  updatedAt: string;
  manifest: Manifest;
  feedback: Feedback | null;
  withdrawn: Withdrawal | null;
}

type FeedbackRead = { ok: true; feedback: Feedback | null } | { ok: false; reason: string };

export function parseFeedback(text: string): FeedbackRead {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, reason: `${FEEDBACK_FILE} is not JSON` };
  }
  const result = FeedbackSchema.safeParse(json);
  return result.success ? { ok: true, feedback: result.data } : { ok: false, reason: `${FEEDBACK_FILE}: ${schemaReason(result.error)}` };
}

type FileRead = { state: "absent" | "unreadable" | "too-big" } | { state: "read"; text: string };

/** A missing or symlinked file, or one that is not regular, is absent, as `statusOf` already treats it. */
async function readRoundFile(roundDir: string, name: string, cap: number): Promise<FileRead> {
  let handle: FileHandle;
  try {
    handle = await open(path.join(roundDir, name), OPEN_FLAGS);
  } catch (error) {
    const code = errnoOf(error);
    return { state: code === "ENOENT" || code === "ELOOP" ? "absent" : "unreadable" };
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) return { state: "absent" };
    const bytes = stats.size > cap ? null : await readCapped(handle, cap);
    return bytes === null ? { state: "too-big" } : { state: "read", text: bytes.toString("utf8") };
  } catch {
    return { state: "unreadable" };
  } finally {
    await handle.close();
  }
}

async function readFeedback(roundDir: string): Promise<FeedbackRead> {
  const read = await readRoundFile(roundDir, FEEDBACK_FILE, MAX_ROUND_BYTES);
  if (read.state === "read") return parseFeedback(read.text);
  if (read.state === "absent") return { ok: true, feedback: null };
  return { ok: false, reason: read.state === "too-big" ? `${FEEDBACK_FILE} is over ${MAX_ROUND_BYTES} bytes` : `${FEEDBACK_FILE} could not be read` };
}

const jsonOrUndefined = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** Any regular withdrawn.json withdraws the round, as `statusOf` counts it; one that does not parse gives no reason. */
async function readWithdrawal(roundDir: string): Promise<Withdrawal | null> {
  const read = await readRoundFile(roundDir, WITHDRAWN_FILE, MAX_WITHDRAWN_BYTES);
  if (read.state === "absent") return null;
  const parsed = read.state === "read" ? WithdrawalSchema.safeParse(jsonOrUndefined(read.text)) : null;
  return parsed?.success ? { reason: parsed.data.reason, at: parsed.data.at } : { reason: "unreadable", at: null };
}

/** A feedback.json that cannot be read is a gap, and the round stays open so its questions are still asked. */
async function queueRound(dir: string, id: string): Promise<{ round?: QueueRound; gap?: string }> {
  const roundDir = path.join(dir, id);
  const [{ parsed, updatedAt }, read, withdrawn] = await Promise.all([readManifest(roundDir), readFeedback(roundDir), readWithdrawal(roundDir)]);
  if (!parsed.ok) return { gap: `${id}: ${parsed.reason}` };
  if (updatedAt === null) return { gap: `${id}: ${ROUND_FILE} has no modified time` };
  const round = { id, updatedAt, manifest: parsed.manifest, feedback: read.ok ? read.feedback : null, withdrawn };
  return read.ok ? { round } : { round, gap: `${id}: ${read.reason}` };
}

/**
 * Every valid round with its feedback, for the owner queue. Nothing here throws: an invalid round, an
 * unreadable feedback file or the dir itself becomes a gap line. A missing dir is no rounds and no gap.
 */
export async function readQueueRounds({ dir }: RoundsSource): Promise<{ rounds: QueueRound[]; gaps: string[] }> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    return { rounds: [], gaps: errnoOf(error) === "ENOENT" ? [] : ["the rounds dir could not be read"] };
  }
  const ids = entries.filter((entry) => entry.isDirectory() && ROUND_ID.test(entry.name)).map((entry) => entry.name).sort();
  const read = await Promise.all(ids.slice(0, MAX_ROUNDS).map((id) => queueRound(dir, id)));
  const gaps = read.flatMap(({ gap }) => (gap === undefined ? [] : [gap]));
  if (ids.length > MAX_ROUNDS) gaps.push(`only the first ${MAX_ROUNDS} of ${ids.length} rounds were read`);
  return { rounds: read.flatMap(({ round }) => (round === undefined ? [] : [round])), gaps };
}

export function roundsCommands(source: RoundsSource) {
  return {
    "rounds.list": readCommand({
      name: "rounds.list",
      description: "Every review round in the rounds dir, newest first: open, sent or withdrawn, and the schema's reason for any invalid one",
      args: z.object({}),
      result: z.object({ rounds: z.array(roundSummary), truncated: z.boolean(), dir: z.string() }),
      run: () => listRounds(source),
    }),
    "rounds.get": readCommand({
      name: "rounds.get",
      description: "One review round's manifest; an unsent after-answer round comes without its recommendations, and a Ship round with its proven head's lineage",
      args: z.object({ id: z.string().min(1).max(64) }),
      result: roundDetail,
      run: ({ id }) => getRound(source, id),
    }),
  };
}
