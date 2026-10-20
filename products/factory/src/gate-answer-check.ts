import { createHash } from "node:crypto";
import type { GitHubPort } from "@titan-design/github";
import type { GateRecord } from "@titan-design/hitl";
import { z } from "zod";
import { acceptSetNote, approvedSetOf, type AfterDigest, type ApprovedSet } from "./approved-set.js";
import { MERGE_GATE, landGate, pinnedHead, stepOf, type LandGate } from "./coordinator-evidence.js";
import { stepIdMatches } from "./definition.js";
import { gateStaleness } from "./gate-batch.js";
import { pendingGateId, repeatedResolution } from "./gate-resolve.js";
import type { FactoryHost } from "./host.js";
import { ROUND_SUBMIT_MAX_AGE_MS, RoundFeedbackSchema, shipAtHead } from "./shepherd/round-merge.js";
import { VISUAL_ACCEPT_GATE } from "./shepherd/visual-accept.js";

/** A console Ship answer as the request names it; `choice` is checked against the owner's feedback, never trusted. */
export interface AnswerRequest {
  runId: string;
  gateId: string;
  headSha: string;
  tree: string;
  packetSha: string;
  roundId: string;
  choice: "merge" | "send-back" | "merge-pick-later" | "accept-set";
}

/** The factory's own packet dir for the accept gate's head, read by the caller; a string says why it could not be. */
export interface AcceptFiles {
  packet: Uint8Array;
  after: ReadonlyMap<string, AfterDigest>;
  /** The delivery record, absent when there is none. */
  delivery: Uint8Array | undefined;
}

interface AnswerInputs {
  host: FactoryHost;
  port: Pick<GitHubPort, "getPr" | "getCommit">;
  request: AnswerRequest;
  /** The exact bytes of the round's files, read by the caller. */
  files: { round: Uint8Array; packet: Uint8Array; feedback: Uint8Array; followUps?: Uint8Array };
  /** Read only for an `sh-visual-accept` gate. */
  accept?: AcceptFiles | string;
  now: Date;
}

type RefusalCode = "unknown-gate" | "not-land-gate" | "github-unreadable" | "tree-mismatch" | "packet" | "packet-unbound" | "set-too-large" | "feedback" | "choice";

export type AnswerPayload =
  | { decision: "merge"; headSha: string }
  | { decision: "send-back"; headSha: string; note: string }
  | { decision: "accept-set"; headSha: string; approvedSet: ApprovedSet; note: string };

type AnswerCheck =
  | { kind: "resolve"; gateId: string; choice: AnswerRequest["choice"]; payload: AnswerPayload }
  | { kind: "already"; gateId: string }
  | { kind: "moved"; currentHead: string | undefined; waitsOn?: string }
  | { kind: "gone"; reason: string }
  | { kind: "refused"; reason: RefusalCode; detail: string };

type Answered = "merge" | "send-back";

/** The answerable gate's step, and the PR and head its prompt and schema pin. */
type GateHead = Pick<LandGate, "repo" | "pr" | "head"> & { step: string };

interface Asked {
  gate: GateRecord;
  land: GateHead;
  /** Absent when the accept-set could not be built from the factory's packet, as after a cleanup. */
  payload: Record<string, unknown> | undefined;
}

/** Ship on approve-merge merges; on the accept gate it accepts the set. Send back is the same answer on both. */
const SHIP_CHOICES: Record<string, readonly AnswerRequest["choice"][]> = { [MERGE_GATE]: ["merge", "merge-pick-later"], [VISUAL_ACCEPT_GATE]: ["accept-set"] };
const ACCEPT_PROMPT = /^Accept the regenerated baselines of PR #(\d+) in (\S+) at head ([0-9a-f]{40})\? CI is red only on .+\.$/;
/** Only a round the sweep delivered binds a set; a shadow or withdrawn record never reached the owner as this round. */
const DeliveryBinding = z.looseObject({ state: z.literal("delivered"), packetId: z.string(), roundId: z.string() });
/** What a replay can still match when the set cannot be rebuilt: the accept-set given at this head for this packet. */
const AcceptedAnswer = z.looseObject({ decision: z.literal("accept-set"), headSha: z.string(), approvedSet: z.looseObject({ packetSha: z.string() }) });

const PACKET_SCHEMA = "titan-review/ci-packet@1";

/** Only the fields the binding checks; the packet's other fields pass through unread. */
const PacketBinding = z.object({ schema: z.literal(PACKET_SCHEMA), repo: z.string(), pr: z.number().int(), headSha: z.string(), headTree: z.string() });

const BoundMerge = z.object({ repo: z.string(), pr: z.number().int(), ship: z.array(z.string()) });
const RoundBindings = z.object({ questions: z.array(z.object({ id: z.string(), options: z.array(z.string()).optional(), merge: BoundMerge.optional() })) });

/** The owner's words in feedback.json: the round's general note and each answer's comment. */
const FeedbackWords = z.object({ general: z.string().optional(), answers: z.array(z.object({ questionId: z.string(), comment: z.string().optional() })) });
/** The console's follow-ups.json sidecar: the answers the owner deferred to a later PR. Anything else reads as none. */
const FollowUps = z.object({ schema: z.literal("titan-console/follow-ups@1"), questionIds: z.array(z.string()), at: z.string() });
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
  const answerable = gate && Object.keys(SHIP_CHOICES).some((step) => stepIdMatches(`${request.runId}/${step}`, gate.id));
  if (!gate || !answerable) return refused("unknown-gate", `run ${request.runId} has no ${Object.keys(SHIP_CHOICES).join(" or ")} gate ${request.gateId}`);
  const land = gateHead(gate);
  if (!land) return refused("not-land-gate", `gate ${gate.id} does not pin a PR head`);
  const early = land.step === VISUAL_ACCEPT_GATE ? choiceRefusal(inputs, land) : undefined;
  if (early) return early;
  const answer = answerPayload(inputs, land);
  const payload = "kind" in answer ? undefined : answer;
  const item = { gate: gate.id, runId: request.runId, stepId: land.step, repo: land.repo, pr: land.pr, headSha: request.headSha, payload: payload ?? {} };
  const stale = (await gateStaleness(host, item, undefined)) ?? (land.head === request.headSha ? undefined : { detail: `the gate asks about head ${land.head}` });
  if (stale) return storeOutcome(host, request, { gate, land, payload }, stale.detail);
  if ("kind" in answer) return answer;
  const binding = (await githubOutcome(inputs, land)) ?? packetRefusal(inputs, land) ?? deliveryRefusal(inputs, answer) ?? choiceRefusal(inputs, land) ?? noteRefusal(answer);
  return binding ?? { kind: "resolve", gateId: gate.id, choice: request.choice, payload: answer };
}

/** A land approve-merge gate, or a red head's accept gate whose prompt and schema pin the same head. */
function gateHead(gate: GateRecord): GateHead | undefined {
  const step = stepOf(gate.id);
  const land = step === MERGE_GATE ? landGate(gate) : undefined;
  if (land) return { ...land, step };
  const match = step === VISUAL_ACCEPT_GATE ? ACCEPT_PROMPT.exec(gate.prompt) : null;
  return match && pinnedHead(gate.schema) === match[3] ? { step, repo: match[2]!, pr: Number(match[1]), head: match[3]! } : undefined;
}

/**
 * What the owner's feedback answers, worked out before the store is read so a replay of a send-back reads as `already`.
 * The note comes from feedback.json alone, never from the request: the general note, then the Ship question's comment.
 */
function answerPayload(inputs: AnswerInputs, land: GateHead): AnswerPayload | AnswerCheck {
  const { headSha } = inputs.request;
  const answered = feedbackChoice(inputs, land);
  if (answered === "send-back") return { decision: "send-back", headSha, note: capped(ownerNote(inputs, land)) };
  return land.step === VISUAL_ACCEPT_GATE && answered === "merge" ? acceptPayload(inputs, land) : { decision: "merge", headSha };
}

const capped = (note: string): string => [...note].slice(0, MAX_NOTE_CHARS).join("");

/** The set comes from the factory's own packet for the gate's head, so the owner accepts exactly the bytes they were shown. */
function acceptPayload(inputs: AnswerInputs, land: GateHead): AnswerPayload | AnswerCheck {
  const { accept, request } = inputs;
  if (typeof accept !== "object") return refused("packet", accept ?? "the factory's packet for this head was not read");
  const built = approvedSetOf({ packet: accept.packet, packetSha: request.packetSha, fromHead: request.headSha, after: accept.after });
  if ("reason" in built) return refused(built.reason, built.detail);
  const instruction = acceptSetNote(built, request.runId, MAX_NOTE_CHARS);
  if (typeof instruction !== "string") return refused(instruction.reason, instruction.detail);
  const note = [instruction, ownerNote(inputs, land)].filter((text) => text !== "").join("\n\n");
  return { decision: "accept-set", headSha: request.headSha, approvedSet: built.set, note: capped(note) };
}

/** The set's packet must be the one the delivery sweep linted and sent to the console for this head. */
function deliveryRefusal({ accept, request }: AnswerInputs, payload: AnswerPayload): AnswerCheck | undefined {
  if (payload.decision !== "accept-set") return undefined;
  const record = typeof accept === "object" && accept.delivery ? parseJson(DeliveryBinding, accept.delivery) : undefined;
  if (record?.packetId === payload.approvedSet.packetId && record.roundId === request.roundId) return undefined;
  const bound = record ? `round ${record.roundId} with packet ${record.packetId}` : "no delivered round";
  return refused("packet-unbound", `the delivery record names ${bound}, not round ${request.roundId} with packet ${payload.approvedSet.packetId}`);
}

function ownerNote({ files }: AnswerInputs, land: GateHead): string {
  const words = parseJson(FeedbackWords, files.feedback);
  const deferred = new Set(files.followUps && parseJson(FollowUps, files.followUps)?.questionIds);
  const bound = new Set(boundQuestions(files.round, land).map((question) => question.id).filter((id) => !deferred.has(id)));
  const comments = words?.answers.filter((answer) => bound.has(answer.questionId)).map((answer) => answer.comment) ?? [];
  return [words?.general, ...comments].map((text) => text?.trim() ?? "").filter((text) => text !== "").join("\n\n");
}

/** The gate's send-back answer must carry the owner's words, so a revision with none is refused rather than sent. */
function noteRefusal(payload: AnswerPayload): AnswerCheck | undefined {
  return payload.decision === "send-back" && payload.note === "" ? refused("feedback", "the owner asked for a revision but wrote no note for the implementer") : undefined;
}

/** The gate store says the answer is late: the run waits on a newer gate, the gate pins another head, or it is settled. */
function storeOutcome(host: FactoryHost, request: AnswerRequest, { gate, land, payload }: Asked, detail: string): AnswerCheck {
  const waiting = pendingGateId(host, request.runId, land.step);
  if (waiting !== undefined && waiting !== gate.id) return { kind: "moved", currentHead: headOf(host, waiting), waitsOn: waiting };
  if (gate.status === "pending") return { kind: "moved", currentHead: land.head };
  const repeated = payload ? repeatedResolution(host, request.runId, land.step, payload) === gate.id : acceptedAt(gate, request);
  return repeated ? { kind: "already", gateId: gate.id } : { kind: "gone", reason: detail };
}

function acceptedAt(gate: GateRecord, { headSha, packetSha }: AnswerRequest): boolean {
  const answer = gate.status === "resolved" ? AcceptedAnswer.safeParse(gate.payload).data : undefined;
  return answer?.headSha === headSha && answer.approvedSet.packetSha === packetSha;
}

function headOf(host: FactoryHost, gateId: string): string | undefined {
  const gate = host.gates.get(gateId);
  return gate ? gateHead(gate)?.head : undefined;
}

/** GitHub's own head and its tree, read fresh: the gate prompt is Shepherd's earlier read and may be behind. */
async function githubOutcome({ port, request }: AnswerInputs, land: GateHead): Promise<AnswerCheck | undefined> {
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
function packetRefusal({ files, request }: AnswerInputs, land: GateHead): AnswerCheck | undefined {
  if (sha256(files.packet) !== request.packetSha) return refused("packet", "packet.json does not hash to the request's packetSha");
  const packet = parseJson(PacketBinding, files.packet);
  if (!packet) return refused("packet", `packet.json does not read as a ${PACKET_SCHEMA} packet`);
  if (packet.repo !== land.repo || packet.pr !== land.pr) return refused("packet", `the packet is for ${packet.repo}#${packet.pr}, the gate for ${land.repo}#${land.pr}`);
  if (packet.headSha === request.headSha && packet.headTree === request.tree) return undefined;
  return refused("packet", `the packet binds ${packet.headSha} tree ${packet.headTree}, the request ${request.headSha} tree ${request.tree}`);
}

/** The choice is what the owner's feedback answered; the request's choice only has to agree with it. */
function choiceRefusal(inputs: AnswerInputs, land: GateHead): AnswerCheck | undefined {
  const answered = feedbackChoice(inputs, land);
  if (typeof answered !== "string") return answered;
  const { choice } = inputs.request;
  const agrees = choice === "send-back" ? answered === "send-back" : answered === "merge" && SHIP_CHOICES[land.step]!.includes(choice);
  return agrees ? undefined : refused("choice", `the owner's feedback answers ${answered} on ${land.step}, the request says ${choice}`);
}

function feedbackChoice({ files, request, now }: AnswerInputs, land: GateHead): Answered | AnswerCheck {
  const feedback = parseJson(RoundFeedbackSchema, files.feedback);
  if (!feedback) return refused("feedback", "feedback.json does not read as round feedback");
  const ship = shipAtHead(files.round, feedback, { repo: land.repo, pr: land.pr, headSha: request.headSha }, now, ROUND_SUBMIT_MAX_AGE_MS);
  if (ship.shipped) return "merge";
  return sendBackRequested(files.round, feedback.answers, land) ? "send-back" : refused("feedback", ship.reason);
}

const boundQuestions = (roundBytes: Uint8Array, land: GateHead) =>
  parseJson(RoundBindings, roundBytes)?.questions.filter((q) => q.merge?.repo === land.repo && q.merge.pr === land.pr) ?? [];

/**
 * The console never writes `revisionRequested` (rounds.submit refuses it beside a pick), so its Send back is the pick of the
 * question's one non-ship option. `revisionRequested` still reads, for older feedback and the harness. Two or more non-ship
 * options leave the pick ambiguous, so it is not read as a send-back.
 */
function sendBackRequested(roundBytes: Uint8Array, answers: z.infer<typeof RoundFeedbackSchema>["answers"], land: GateHead): boolean {
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
