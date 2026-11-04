/**
 * Listeners that run after the console writes something. The one here relays a merge-bound
 * answer to the factory: once `rounds.submit` has written a round's `feedback.json`, the owner's
 * Ship or Send back becomes a request to resolve the approve-merge gate the round showed.
 *
 * The request is built only from files the console wrote or imported (`round.json`, `packet.json`,
 * `feedback.json`) and from the factory's own status row, never from the browser. The row's head
 * must equal the head the round showed, or nothing is posted and the outcome is `moved`. The
 * result is kept in `<round>/answer.json`, written once, with one record per PR when the round has several; while the factory is unreachable nothing
 * is written, and `sweep` retries such rounds when the console starts.
 *
 * A plan round's approval goes the same way (`round-plan-approval.ts`): only the owner's fresh submit writes its action record,
 * and the sweep reposts only a record already written.
 *
 * The other tells the seat that filed a round, every seat subscribed to it, or else tp-operator, that the owner
 * answered it (`round-asker.ts`). It runs for every answered round, whether or not gate answers are on.
 */
import { createHash } from "node:crypto";
import { open, readdir, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { type AnswerChoice, type AnswerOutcome, type GateAnswerClient, type GateAnswerRequest } from "./gate-answer.js";
import { FeedbackSchema, RoundSchema, type Feedback, type Manifest, type Question } from "./round-schema.js";
import { ANSWER_FILE, ANSWER_SCHEMA_ID } from "./round-answer.js";
import { isVisualAccept, roundAnswers, sameHead, samePr } from "./round-gate-cover.js";
import { notifyRound } from "./round-asker.js";
import { approvedPlans, postPlanApprovals, writePlanApprovals, type PlanApprovalDeps } from "./round-plan-approval.js";
import type { SeatNotifier } from "./round-notice-transport.js";
import { markOperatorSince } from "./round-subscriptions.js";
import { FEEDBACK_FILE, MAX_ROUND_BYTES, OPEN_FLAGS, ROUND_FILE, ROUND_ID, readCapped } from "./rounds.js";
import type { ShepherdSource } from "./shepherd.js";

const PACKET_FILE = "packet.json";

const packetHead = z.looseObject({ headTree: z.string().regex(/^[0-9a-f]{40}$/) });

interface AnswerRecord {
  schema: typeof ANSWER_SCHEMA_ID;
  at: string;
  /** `runId` and `gateId` are absent when no status row or pending gate was found to name them. */
  request: { runId?: string; gateId?: string; headSha: string; choice: AnswerChoice };
  outcome: AnswerOutcome;
  /** Present only for a round with several merge questions: every PR's request and outcome. */
  answers?: { questionId: string; request: AnswerRecord["request"]; outcome: AnswerOutcome }[];
}
type ShipQuestion = Extract<Question, { kind: "pick-one" }>;
type Merge = NonNullable<ShipQuestion["merge"]>;

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
  /** Absent, a plan round's approval is recorded nowhere. */
  planApproval?: PlanApprovalDeps;
  /** Absent, no seat is told of an answer. */
  notify?: SeatNotifier;
  /** `rounds subscribe`'s store; absent, only the asker is told and an unclaimed answer goes nowhere. */
  subscriptionsDir?: string;
  now?: () => Date;
  logger?: { warn(fields: Record<string, unknown>, message: string): void };
}

/** The owner's choice on one merge-bound question, with everything the round files bind it to. */
interface RoundAnswer {
  roundId: string;
  questionId: string;
  merge: Merge;
  verdict: Verdict;
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

type RoundRead = { manifest: Manifest; invalid?: undefined } | { manifest?: undefined; invalid: string } | { manifest?: undefined; invalid?: undefined };

/** A round.json that is there but fails the strict facade is `invalid`, with the first issue as its reason. */
async function readRound(file: string): Promise<RoundRead> {
  const bytes = await readFileCapped(file);
  return bytes === undefined ? {} : roundOf(bytes);
}

function roundOf(bytes: Buffer): RoundRead {
  try {
    const parsed = RoundSchema.safeParse(JSON.parse(bytes.toString("utf8")));
    return parsed.success ? { manifest: parsed.data } : { invalid: parsed.error.issues[0]?.message ?? "invalid" };
  } catch (error) {
    return { invalid: error instanceof Error ? error.message : String(error) };
  }
}

type Verdict = "ship" | "send-back";

/**
 * Ship ships; the one other option sends back. A question with more options than that is not one this relays.
 * The feedback writes a pick of the round's `revisionOption` as a revision request, which sends back too.
 */
function verdictOf(question: ShipQuestion, merge: Merge, answer: Feedback["answers"][number]): Verdict | undefined {
  if (answer.revisionRequested) return "send-back";
  const { pick } = answer;
  if (pick === undefined) return undefined;
  if (merge.ship.includes(pick)) return "ship";
  const others = question.options.filter((option) => !merge.ship.includes(option));
  return others.length === 1 && others[0] === pick ? "send-back" : undefined;
}

/** One answer per merge-bound question the owner answered, in round order; none unless the packet is beside the round. */
async function readRoundAnswers(deps: ListenerDeps, roundId: string): Promise<RoundAnswer[]> {
  const dir = path.join(deps.roundsDir, roundId);
  const [round, feedback, packetBytes] = await Promise.all([
    readRound(path.join(dir, ROUND_FILE)),
    readJson(path.join(dir, FEEDBACK_FILE), FeedbackSchema),
    readFileCapped(path.join(dir, PACKET_FILE)),
  ]);
  if (round.invalid !== undefined && feedback) deps.logger?.warn({ roundId }, `${roundId}: round.json invalid; answer not relayed (${round.invalid})`);
  const { manifest } = round;
  const tree = packetBytes && packetHeadTree(packetBytes);
  if (!manifest || !feedback || !packetBytes || tree === undefined) return [];
  const packetSha = sha256(packetBytes);
  return manifest.questions.flatMap((question) => {
    const answer = feedback.answers.find((each) => each.questionId === question.id);
    if (question.kind !== "pick-one" || !question.merge || answer === undefined) return [];
    const verdict = verdictOf(question, question.merge, answer);
    return verdict === undefined ? [] : [{ roundId, questionId: question.id, merge: question.merge, verdict, tree, packetSha }];
  });
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
  const row = rows.find((candidate) => samePr(candidate, merge));
  if (!row) return { outcome: { status: "gone", reason: `no shepherd row for ${merge.repo}#${merge.pr}` } };
  if (!sameHead(row.headSha, merge.headSha)) return { outcome: { status: "moved", currentHead: row.headSha } };
  const gate = row.pendingGate;
  if (!roundAnswers(gate)) return { outcome: { status: "gone", reason: "no pending approve-merge or visual accept gate" } };
  // Decided here, where the gate is known: Ship on the accept gate must never post `merge`.
  const choice: AnswerChoice = answer.verdict === "send-back" ? "send-back" : isVisualAccept(gate) ? "accept-set" : "merge";
  const { roundId, tree, packetSha } = answer;
  return { request: { runId: row.runId, gateId: gate.gateId, headSha: merge.headSha, tree, packetSha, roundId, choice } };
}

function recordOf(answer: RoundAnswer, decision: Decision, outcome: AnswerOutcome, at: Date): AnswerRecord {
  // With no gate to post to, the record names the pick-level choice.
  const { runId, gateId, choice } = decision.request ?? {};
  return {
    schema: ANSWER_SCHEMA_ID,
    at: at.toISOString(),
    request: { ...(runId !== undefined && { runId }), ...(gateId !== undefined && { gateId }), headSha: answer.merge.headSha, choice: choice ?? (answer.verdict === "ship" ? "merge" : "send-back") },
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

type Answered = { answer: RoundAnswer; record: AnswerRecord };

/** The factory's verdict on one PR's answer; undefined while it cannot be reached. */
async function answerQuestion(deps: ListenerDeps, answer: RoundAnswer, at: Date): Promise<Answered | undefined> {
  const decision = await bindGate(deps.shepherd, answer);
  const outcome = decision.request ? await deps.answer.post(decision.request) : decision.outcome;
  return outcome.status === "unreachable" ? undefined : { answer, record: recordOf(answer, decision, outcome, at) };
}

/**
 * A round with one merge question keeps the one-record file. With several (TP-3329), the first PR's record stays on top,
 * where `readAnswer` reads it, and `answers` holds every PR's, each under its question id.
 */
function fileOf(first: Answered, answered: readonly Answered[]): AnswerRecord {
  if (answered.length < 2) return first.record;
  return { ...first.record, answers: answered.map(({ answer, record }) => ({ questionId: answer.questionId, request: record.request, outcome: record.outcome })) };
}

/** Every PR's answer is posted before the file is written, so one unreachable PR leaves the whole round to the sweep. */
async function answerRound(deps: ListenerDeps, roundId: string): Promise<void> {
  const dir = path.join(deps.roundsDir, roundId);
  if (await exists(path.join(dir, ANSWER_FILE))) return;
  const answers = await readRoundAnswers(deps, roundId);
  const at = (deps.now ?? (() => new Date()))();
  const answered: Answered[] = [];
  for (const answer of answers) {
    const each = await answerQuestion(deps, answer, at);
    if (each === undefined) return;
    answered.push(each);
  }
  const [first] = answered;
  if (first !== undefined) await writeOnce(path.join(dir, ANSWER_FILE), fileOf(first, answered));
}

/** Approvals only from the round.json bytes the owner's feedback names, so an edit after the answer approves nothing. */
async function planApprovalsOf(deps: ListenerDeps, roundId: string): Promise<ReturnType<typeof approvedPlans>> {
  const dir = path.join(deps.roundsDir, roundId);
  const [bytes, feedback] = await Promise.all([readFileCapped(path.join(dir, ROUND_FILE)), readJson(path.join(dir, FEEDBACK_FILE), FeedbackSchema)]);
  if (!bytes || !feedback || sha256(bytes) !== feedback.manifestSha256) return [];
  const { manifest } = roundOf(bytes);
  return manifest ? approvedPlans(roundId, manifest, feedback) : [];
}

async function approvePlans(deps: ListenerDeps, roundId: string, live: boolean): Promise<void> {
  if (deps.planApproval === undefined) return;
  const plans = await planApprovalsOf(deps, roundId);
  if (live) await writePlanApprovals(deps.planApproval, plans);
  await postPlanApprovals(deps.planApproval, plans, (deps.now ?? (() => new Date()))());
}

async function tellSeats(deps: ListenerDeps, roundId: string, live: boolean): Promise<void> {
  if (deps.notify === undefined) return;
  const { roundsDir, subscriptionsDir, notify } = deps;
  const now = (deps.now ?? (() => new Date()))();
  try {
    const failures = await notifyRound({ roundsDir, ...(subscriptionsDir !== undefined && { subscriptionsDir }), notify, now, live }, roundId);
    for (const { seat, reason } of failures) deps.logger?.warn({ roundId, seat }, `${roundId}: ${seat} was not told of the answer (${reason})`);
  } catch (error) {
    deps.logger?.warn({ roundId }, `${roundId}: no seat was told of the answer (${error instanceof Error ? error.message : String(error)})`);
  }
}

/** A failure here must never fail the submit that already wrote the owner's answer; the sweep retries it. */
async function attempt(deps: ListenerDeps, roundId: string, live: boolean): Promise<void> {
  if (deps.enabled) await answerRound(deps, roundId).catch(() => undefined);
  await approvePlans(deps, roundId, live).catch(() => undefined);
  await tellSeats(deps, roundId, live);
}

export function createRoundListeners(deps: ListenerDeps): RoundListeners {
  return {
    async afterRoundSubmit(roundId, result) {
      if (result.status !== "submitted") return;
      await attempt(deps, roundId, true);
    },
    async sweep() {
      if (!deps.enabled && deps.notify === undefined && deps.planApproval === undefined) return;
      // Before the first sweep, so the answers already on disk stay older than the operator watermark.
      if (deps.subscriptionsDir !== undefined) await markOperatorSince(deps.subscriptionsDir, (deps.now ?? (() => new Date()))()).catch(() => undefined);
      const entries = await readdir(deps.roundsDir).catch(() => []);
      for (const roundId of entries.filter((name) => ROUND_ID.test(name))) await attempt(deps, roundId, false);
    },
  };
}
