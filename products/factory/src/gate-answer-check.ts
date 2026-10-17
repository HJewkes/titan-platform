import { createHash } from "node:crypto";
import type { GitHubPort } from "@titan-design/github";
import type { GateRecord } from "@titan-design/hitl";
import { z } from "zod";
import { MERGE_GATE, landGate, type LandGate } from "./coordinator-evidence.js";
import { stepIdMatches } from "./definition.js";
import { gateStaleness } from "./gate-batch.js";
import { pendingGateId, repeatedResolution } from "./gate-resolve.js";
import type { FactoryHost } from "./host.js";
import { ROUND_SUBMIT_MAX_AGE_MS, RoundFeedbackSchema, shipAtHead } from "./shepherd/round-merge.js";

/** A console Ship answer as the request names it; `choice` is checked against the owner's feedback, never trusted. */
export interface AnswerRequest {
  runId: string;
  gateId: string;
  headSha: string;
  tree: string;
  packetSha: string;
  roundId: string;
  choice: "merge" | "send-back" | "merge-pick-later";
}

interface AnswerInputs {
  host: FactoryHost;
  port: Pick<GitHubPort, "getPr" | "getCommit">;
  request: AnswerRequest;
  /** The exact bytes of the round's files, read by the caller. */
  files: { round: Uint8Array; packet: Uint8Array; feedback: Uint8Array };
  now: Date;
}

type RefusalCode = "unknown-gate" | "not-land-gate" | "github-unreadable" | "tree-mismatch" | "packet" | "feedback" | "choice";

export type AnswerPayload = { decision: "merge"; headSha: string } | { decision: "send-back"; headSha: string; note: string };

type AnswerCheck =
  | { kind: "resolve"; gateId: string; choice: AnswerRequest["choice"]; payload: AnswerPayload }
  | { kind: "already"; gateId: string }
  | { kind: "moved"; currentHead: string | undefined; waitsOn?: string }
  | { kind: "gone"; reason: string }
  | { kind: "refused"; reason: RefusalCode; detail: string };

type Answered = "merge" | "send-back";

interface Asked {
  gate: GateRecord;
  land: LandGate;
  payload: Record<string, unknown>;
}

const PACKET_SCHEMA = "titan-review/ci-packet@1";

/** Only the fields the binding checks; the packet's other fields pass through unread. */
const PacketBinding = z.object({ schema: z.literal(PACKET_SCHEMA), repo: z.string(), pr: z.number().int(), headSha: z.string(), headTree: z.string() });

const BoundMerge = z.object({ repo: z.string(), pr: z.number().int(), ship: z.array(z.string()) });
const RoundBindings = z.object({ questions: z.array(z.object({ id: z.string(), options: z.array(z.string()).optional(), merge: BoundMerge.optional() })) });

/** The owner's words in feedback.json: the round's general note and each answer's comment. */
const FeedbackWords = z.object({ general: z.string().optional(), answers: z.array(z.object({ questionId: z.string(), comment: z.string().optional() })) });
/** The most of the owner's note the gate payload carries; the rest stays in feedback.json. */
export const MAX_NOTE_CHARS = 4000;

const refused = (reason: RefusalCode, detail: string): AnswerCheck => ({ kind: "refused", reason, detail });
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/**
 * Whether a console Ship answer may resolve the approve-merge gate it names, and with what. The gate is the request's own
 * gate id, never the one the run waits on now: an answer shown for one gate never resolves a newer one. The answer stands
 * only while the gate, GitHub's head and tree, the packet the owner saw and the owner's feedback all name the same head.
 * Writes nothing; the caller resolves on `resolve`.
 */
export async function checkAnswer(inputs: AnswerInputs): Promise<AnswerCheck> {
  const { host, request } = inputs;
  const gate = host.gates.get(request.gateId);
  if (!gate || !stepIdMatches(`${request.runId}/${MERGE_GATE}`, gate.id)) return refused("unknown-gate", `run ${request.runId} has no approve-merge gate ${request.gateId}`);
  const land = landGate(gate);
  if (!land) return refused("not-land-gate", `gate ${gate.id} does not pin a PR head`);
  const payload = answerPayload(inputs, land);
  const item = { gate: gate.id, runId: request.runId, stepId: MERGE_GATE, repo: land.repo, pr: land.pr, headSha: request.headSha, payload };
  const stale = await gateStaleness(host, item, undefined);
  if (stale) return storeOutcome(host, request.runId, { gate, land, payload }, stale.detail);
  const binding = (await githubOutcome(inputs, land)) ?? packetRefusal(inputs, land) ?? choiceRefusal(inputs, land) ?? noteRefusal(payload);
  return binding ?? { kind: "resolve", gateId: gate.id, choice: request.choice, payload };
}

/**
 * What the owner's feedback answers, worked out before the store is read so a replay of a send-back reads as `already`.
 * The note comes from feedback.json alone, never from the request: the general note, then the Ship question's comment.
 */
function answerPayload(inputs: AnswerInputs, land: LandGate): AnswerPayload {
  const { headSha } = inputs.request;
  if (feedbackChoice(inputs, land) !== "send-back") return { decision: "merge", headSha };
  return { decision: "send-back", headSha, note: [...ownerNote(inputs, land)].slice(0, MAX_NOTE_CHARS).join("") };
}

function ownerNote({ files }: AnswerInputs, land: LandGate): string {
  const words = parseJson(FeedbackWords, files.feedback);
  const bound = new Set(boundQuestions(files.round, land).map((question) => question.id));
  const comments = words?.answers.filter((answer) => bound.has(answer.questionId)).map((answer) => answer.comment) ?? [];
  return [words?.general, ...comments].map((text) => text?.trim() ?? "").filter((text) => text !== "").join("\n\n");
}

/** The gate's send-back answer must carry the owner's words, so a revision with none is refused rather than sent. */
function noteRefusal(payload: AnswerPayload): AnswerCheck | undefined {
  return payload.decision === "send-back" && payload.note === "" ? refused("feedback", "the owner asked for a revision but wrote no note for the implementer") : undefined;
}

/** The gate store says the answer is late: the run waits on a newer gate, the gate pins another head, or it is settled. */
function storeOutcome(host: FactoryHost, runId: string, { gate, land, payload }: Asked, detail: string): AnswerCheck {
  const waiting = pendingGateId(host, runId, MERGE_GATE);
  if (waiting !== undefined && waiting !== gate.id) return { kind: "moved", currentHead: headOf(host, waiting), waitsOn: waiting };
  if (gate.status === "pending") return { kind: "moved", currentHead: land.head };
  if (repeatedResolution(host, runId, MERGE_GATE, payload) === gate.id) return { kind: "already", gateId: gate.id };
  return { kind: "gone", reason: detail };
}

function headOf(host: FactoryHost, gateId: string): string | undefined {
  const gate = host.gates.get(gateId);
  return gate ? landGate(gate)?.head : undefined;
}

/** GitHub's own head and its tree, read fresh: the gate prompt is Shepherd's earlier read and may be behind. */
async function githubOutcome({ port, request }: AnswerInputs, land: LandGate): Promise<AnswerCheck | undefined> {
  const ref = `${land.repo}#${land.pr}`;
  try {
    const pull = await port.getPr(land.repo, land.pr);
    if (pull.state !== "open") return { kind: "gone", reason: `${ref} is ${pull.merged ? "merged" : "closed"} on GitHub` };
    if (pull.headSha !== request.headSha) return { kind: "moved", currentHead: pull.headSha };
    const { tree } = await port.getCommit(land.repo, pull.headSha);
    return tree === request.tree ? undefined : refused("tree-mismatch", `GitHub has tree ${tree} at ${pull.headSha}, the request names ${request.tree}`);
  } catch (error) {
    return refused("github-unreadable", `${ref} could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The packet must be the exact bytes the request hashed, and bind the same PR, head and tree. */
function packetRefusal({ files, request }: AnswerInputs, land: LandGate): AnswerCheck | undefined {
  if (sha256(files.packet) !== request.packetSha) return refused("packet", "packet.json does not hash to the request's packetSha");
  const packet = parseJson(PacketBinding, files.packet);
  if (!packet) return refused("packet", `packet.json does not read as a ${PACKET_SCHEMA} packet`);
  if (packet.repo !== land.repo || packet.pr !== land.pr) return refused("packet", `the packet is for ${packet.repo}#${packet.pr}, the gate for ${land.repo}#${land.pr}`);
  if (packet.headSha === request.headSha && packet.headTree === request.tree) return undefined;
  return refused("packet", `the packet binds ${packet.headSha} tree ${packet.headTree}, the request ${request.headSha} tree ${request.tree}`);
}

/** The choice is what the owner's feedback answered; the request's choice only has to agree with it. */
function choiceRefusal(inputs: AnswerInputs, land: LandGate): AnswerCheck | undefined {
  const answered = feedbackChoice(inputs, land);
  if (typeof answered !== "string") return answered;
  const { choice } = inputs.request;
  return answered === (choice === "send-back" ? "send-back" : "merge") ? undefined : refused("choice", `the owner's feedback answers ${answered}, the request says ${choice}`);
}

function feedbackChoice({ files, request, now }: AnswerInputs, land: LandGate): Answered | AnswerCheck {
  const feedback = parseJson(RoundFeedbackSchema, files.feedback);
  if (!feedback) return refused("feedback", "feedback.json does not read as round feedback");
  const ship = shipAtHead(files.round, feedback, { repo: land.repo, pr: land.pr, headSha: request.headSha }, now, ROUND_SUBMIT_MAX_AGE_MS);
  if (ship.shipped) return "merge";
  return sendBackRequested(files.round, feedback.answers, land) ? "send-back" : refused("feedback", ship.reason);
}

const boundQuestions = (roundBytes: Uint8Array, land: LandGate) =>
  parseJson(RoundBindings, roundBytes)?.questions.filter((q) => q.merge?.repo === land.repo && q.merge.pr === land.pr) ?? [];

/**
 * The console never writes `revisionRequested` (rounds.submit refuses it beside a pick), so its Send back is the pick of the
 * question's one non-ship option. `revisionRequested` still reads, for older feedback and the harness. Two or more non-ship
 * options leave the pick ambiguous, so it is not read as a send-back.
 */
function sendBackRequested(roundBytes: Uint8Array, answers: z.infer<typeof RoundFeedbackSchema>["answers"], land: LandGate): boolean {
  return boundQuestions(roundBytes, land).some((q) => {
    const others = (q.options ?? []).filter((option) => !q.merge?.ship.includes(option));
    return answers.some((a) => a.questionId === q.id && (a.revisionRequested === true || (others.length === 1 && a.pick === others[0])));
  });
}

function parseJson<T>(schema: z.ZodType<T>, bytes: Uint8Array): T | undefined {
  try {
    const parsed = schema.safeParse(JSON.parse(Buffer.from(bytes).toString("utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
