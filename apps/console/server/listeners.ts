/**
 * Listeners that run after the console writes something. The one here relays a merge-bound
 * answer to the factory: once `rounds.submit` has written a round's `feedback.json`, the owner's
 * Ship or Send back becomes a request to resolve the approve-merge gate the round showed.
 *
 * The request is built only from files the console wrote or imported (`round.json`, `packet.json`,
 * `feedback.json`) and from the factory's own status row, never from the browser. The row's head
 * must equal the head the round showed, or nothing is posted and the outcome is `moved`. The
 * result is kept in `<round>/answer.json`, written once; while the factory is unreachable nothing
 * is written, and `sweep` retries such rounds when the console starts.
 */
import { createHash } from "node:crypto";
import { open, readdir, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { type AnswerChoice, type AnswerOutcome, type GateAnswerClient, type GateAnswerRequest } from "./gate-answer.js";
import { FeedbackDocument, Round2Manifest, type Round2Question } from "./round2-adapter.js";
import { ANSWER_FILE, ANSWER_SCHEMA_ID } from "./round-answer.js";
import { FEEDBACK_FILE, MAX_ROUND_BYTES, OPEN_FLAGS, ROUND_FILE, ROUND_ID, readCapped } from "./rounds.js";
import type { ShepherdSource } from "./shepherd.js";

const PACKET_FILE = "packet.json";
const APPROVE_MERGE = /(^|\/)approve-merge(:\d+)?$/;

const packetHead = z.looseObject({ headTree: z.string().regex(/^[0-9a-f]{40}$/) });

interface AnswerRecord {
  schema: typeof ANSWER_SCHEMA_ID;
  at: string;
  /** `runId` and `gateId` are absent when no status row or pending gate was found to name them. */
  request: { runId?: string; gateId?: string; headSha: string; choice: AnswerChoice };
  outcome: AnswerOutcome;
}
type Merge = NonNullable<Round2Question["merge"]>;

/** What `rounds.submit` returned; only a fresh `submitted` can start an answer. */
interface SubmitOutcome {
  status: "submitted" | "already-submitted";
}

export interface RoundListeners {
  afterRoundSubmit(roundId: string, result: SubmitOutcome): Promise<void>;
  /** Answers every round that has a `feedback.json` and no `answer.json`; for the console's start-up. */
  sweep(): Promise<void>;
}

export interface ListenerDeps {
  /** `TITAN_CONSOLE_GATE_ANSWERS`; off, the listener reads and posts nothing. */
  enabled: boolean;
  roundsDir: string;
  shepherd: Pick<ShepherdSource, "list">;
  answer: GateAnswerClient;
  now?: () => Date;
}

/** The owner's choice on one merge-bound question, with everything the round files bind it to. */
interface RoundAnswer {
  roundId: string;
  merge: Merge;
  choice: AnswerChoice;
  tree: string;
  packetSha: string;
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const errnoOf = (error: unknown): unknown => (error instanceof Error && "code" in error ? error.code : undefined);

async function readFileCapped(file: string): Promise<Buffer | undefined> {
  let handle: FileHandle;
  try {
    handle = await open(file, OPEN_FLAGS);
  } catch {
    return undefined;
  }
  try {
    const stats = await handle.stat();
    return stats.isFile() && stats.size <= MAX_ROUND_BYTES ? ((await readCapped(handle, MAX_ROUND_BYTES)) ?? undefined) : undefined;
  } finally {
    await handle.close();
  }
}

async function readJson<T>(file: string, schema: z.ZodType<T>): Promise<T | undefined> {
  const bytes = await readFileCapped(file);
  if (bytes === undefined) return undefined;
  try {
    const parsed = schema.safeParse(JSON.parse(bytes.toString("utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Ship merges; the one other option sends back. A question with more options than that is not one this relays. */
function choiceOf(question: Round2Question, merge: Merge, pick: string): AnswerChoice | undefined {
  if (merge.ship.includes(pick)) return "merge";
  const others = (question.options ?? []).filter((option) => !merge.ship.includes(option));
  return others.length === 1 && others[0] === pick ? "send-back" : undefined;
}

/** Undefined unless the round is merge-bound, answered, and has the packet beside it. */
async function readRoundAnswer(roundsDir: string, roundId: string): Promise<RoundAnswer | undefined> {
  const dir = path.join(roundsDir, roundId);
  const [manifest, feedback, packetBytes] = await Promise.all([
    readJson(path.join(dir, ROUND_FILE), Round2Manifest),
    readJson(path.join(dir, FEEDBACK_FILE), FeedbackDocument),
    readFileCapped(path.join(dir, PACKET_FILE)),
  ]);
  if (!manifest || !feedback || !packetBytes) return undefined;
  for (const question of manifest.questions) {
    const pick = feedback.answers.find((answer) => answer.questionId === question.id)?.pick;
    if (!question.merge || pick === undefined) continue;
    const choice = choiceOf(question, question.merge, pick);
    const tree = packetHeadTree(packetBytes);
    if (choice === undefined || tree === undefined) return undefined;
    return { roundId, merge: question.merge, choice, tree, packetSha: sha256(packetBytes) };
  }
  return undefined;
}

function packetHeadTree(bytes: Buffer): string | undefined {
  try {
    const parsed = packetHead.safeParse(JSON.parse(bytes.toString("utf8")));
    return parsed.success ? parsed.data.headTree : undefined;
  } catch {
    return undefined;
  }
}

type Decision = { request: GateAnswerRequest; outcome?: undefined } | { outcome: AnswerOutcome | { status: "unreachable"; detail: string }; request?: undefined };

/** The factory's status row for the PR, used only while its head is the one the round showed. */
async function bindGate(shepherd: ListenerDeps["shepherd"], answer: RoundAnswer): Promise<Decision> {
  const { merge } = answer;
  let rows: Awaited<ReturnType<ListenerDeps["shepherd"]["list"]>>;
  try {
    rows = await shepherd.list("active");
  } catch (error) {
    return { outcome: { status: "unreachable", detail: error instanceof Error ? error.message : String(error) } };
  }
  const row = rows.find((candidate) => candidate.repo === merge.repo && candidate.pr === merge.pr);
  if (!row) return { outcome: { status: "gone", reason: `no shepherd row for ${merge.repo}#${merge.pr}` } };
  if (row.headSha !== merge.headSha) return { outcome: { status: "moved", currentHead: row.headSha } };
  const gate = row.pendingGate;
  if (!gate || !(APPROVE_MERGE.test(gate.stepId) || APPROVE_MERGE.test(gate.gateId))) {
    return { outcome: { status: "gone", reason: "no pending approve-merge gate" } };
  }
  const { roundId, choice, tree, packetSha } = answer;
  return { request: { runId: row.runId, gateId: gate.gateId, headSha: merge.headSha, tree, packetSha, roundId, choice } };
}

function recordOf(answer: RoundAnswer, decision: Decision, outcome: AnswerOutcome, at: Date): AnswerRecord {
  const { runId, gateId } = decision.request ?? {};
  return {
    schema: ANSWER_SCHEMA_ID,
    at: at.toISOString(),
    request: { ...(runId !== undefined && { runId }), ...(gateId !== undefined && { gateId }), headSha: answer.merge.headSha, choice: answer.choice },
    outcome,
  };
}

/** `wx`, so a second writer or a planted symlink finds the file and nothing is overwritten. */
async function writeOnce(file: string, record: AnswerRecord): Promise<void> {
  let handle: FileHandle;
  try {
    handle = await open(file, "wx", 0o600);
  } catch (error) {
    if (errnoOf(error) === "EEXIST") return;
    throw error;
  }
  try {
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`);
  } finally {
    await handle.close();
  }
}

const exists = (file: string): Promise<boolean> =>
  open(file, OPEN_FLAGS).then(
    (handle) => handle.close().then(() => true),
    (error: unknown) => errnoOf(error) !== "ENOENT",
  );

async function answerRound(deps: ListenerDeps, roundId: string): Promise<void> {
  const dir = path.join(deps.roundsDir, roundId);
  if (await exists(path.join(dir, ANSWER_FILE))) return;
  const answer = await readRoundAnswer(deps.roundsDir, roundId);
  if (!answer) return;
  const decision = await bindGate(deps.shepherd, answer);
  const outcome = decision.request ? await deps.answer.post(decision.request) : decision.outcome;
  if (outcome.status === "unreachable") return;
  await writeOnce(path.join(dir, ANSWER_FILE), recordOf(answer, decision, outcome, (deps.now ?? (() => new Date()))()));
}

/** A failure here must never fail the submit that already wrote the owner's answer; the sweep retries it. */
const attempt = (deps: ListenerDeps, roundId: string): Promise<void> => answerRound(deps, roundId).catch(() => undefined);

export function createRoundListeners(deps: ListenerDeps): RoundListeners {
  return {
    async afterRoundSubmit(roundId, result) {
      if (!deps.enabled || result.status !== "submitted") return;
      await attempt(deps, roundId);
    },
    async sweep() {
      if (!deps.enabled) return;
      const entries = await readdir(deps.roundsDir).catch(() => []);
      for (const roundId of entries.filter((name) => ROUND_ID.test(name))) await attempt(deps, roundId);
    },
  };
}
