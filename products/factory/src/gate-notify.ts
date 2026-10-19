/**
 * Posts pending decision gates to agent-chat's human queue and resolves each from the owner's answer (CC-169 f).
 * Answers are read back by msg_id cursor, so the same answer can arrive twice: after a crash before the cursor
 * moved, or when the cursor is reset. The `gate_ask` row's `asked` state is the guard, claimed in the same
 * transaction as the resolve, so an answer resolves its gate at most once and a replay is a no-op.
 */

import type { AnswersPage, AskRequest, ServiceAnswer } from "@titan-design/agent-dispatch";
import type { ResolverClass } from "@titan-design/authority";
import { GateAlreadySettled, GateExpired, GateNotFound, GatePayloadInvalid, GateResolverRefused, type GateRecord, type GateResolver } from "@titan-design/hitl";
import type { GateAskState, GateAskStore } from "./gate-ask-store.js";
import { WAIVE_PROOF } from "./gate-brief.js";

export interface GateNotifyPorts {
  /** The agent-chat service label the asks are filed and read back under. */
  label: string;
  /** The class an agent-chat answer resolves as; only gates whose rule admits it are asked. */
  resolverClass: ResolverClass;
  pendingGates(): GateRecord[];
  getGate(gateId: string): GateRecord | undefined;
  resolve(gateId: string, payload: unknown, resolver: GateResolver): void;
  asks: GateAskStore;
  askHuman(req: AskRequest, signal?: AbortSignal): Promise<string>;
  readAnswers(label: string, since: string | undefined, signal?: AbortSignal): Promise<AnswersPage>;
  dismissAsk(msgId: string, signal?: AbortSignal): Promise<void>;
  /** Aborted when serve gives up on the tick at shutdown; each agent-chat call is passed it, so its child is killed and no later call starts one. */
  signal?: AbortSignal;
  log(line: string): void;
}

interface JsonObjectSchema {
  properties?: Record<string, { const?: unknown } | undefined>;
  required?: string[];
}

const DECISION = "decision";
const DECIDED = "decided";
const HUMAN_ENDORSED = "human-endorsed";

/** The decision question, when the gate is the factory's one-question decision convention. */
function decisionQuestion(gate: GateRecord) {
  const questions = gate.questions ?? [];
  return questions.length === 1 && questions[0]?.id === DECISION ? questions[0] : undefined;
}

/**
 * Fields the schema pins to one value, such as the head a merge gate was opened for. The question names that head,
 * so an answer to it is an answer at that head; a required field the schema does not pin cannot come from an answer.
 */
function pinnedFields(gate: GateRecord): Record<string, unknown> | undefined {
  const schema = (gate.schema ?? {}) as JsonObjectSchema;
  const pinned: Record<string, unknown> = {};
  for (const field of schema.required ?? []) {
    if (field === DECISION) continue;
    const property = schema.properties?.[field];
    if (property === undefined || !("const" in property)) return undefined;
    pinned[field] = property.const;
  }
  return pinned;
}

/** A pending decision gate an agent-chat answer can settle: the rule, when there is one, admits the class. */
export function askable(gate: GateRecord, resolverClass: ResolverClass): boolean {
  if (gate.status !== "pending" || decisionQuestion(gate) === undefined) return false;
  if (gate.rule !== undefined && !gate.rule.resolvers.includes(resolverClass)) return false;
  return pinnedFields(gate) !== undefined;
}

function askText(gate: GateRecord): string {
  const question = decisionQuestion(gate);
  const options = (question?.options ?? []).map((option) => `${option.id}: ${option.label}`).join("; ");
  return [gate.summary, gate.evidenceRef && `Evidence: ${gate.evidenceRef}`, question && `${question.question} (${options})`]
    .filter((line): line is string => typeof line === "string" && line !== "")
    .join("\n");
}

/** The payload for an answer naming one option by id or label; undefined for anything else, never a guess. */
export function answerPayload(gate: GateRecord, text: string): Record<string, unknown> | undefined {
  const said = text.trim().toLowerCase();
  const option = decisionQuestion(gate)?.options.find((candidate) => candidate.id.toLowerCase() === said || candidate.label.toLowerCase() === said);
  const pinned = pinnedFields(gate);
  if (option === undefined || pinned === undefined) return undefined;
  return { ...pinned, decision: option.id };
}

export async function notifyTick(ports: GateNotifyPorts): Promise<void> {
  await askPass(ports);
  await withdrawPass(ports);
  await answerPass(ports);
}

async function askPass(ports: GateNotifyPorts): Promise<void> {
  for (const gate of ports.pendingGates()) {
    if (!askable(gate, ports.resolverClass) || ports.asks.get(gate.id) !== undefined) continue;
    try {
      const msgId = await ports.askHuman(askRequest(ports.label, gate), ports.signal);
      ports.asks.record(gate.id, msgId);
    } catch (error) {
      ports.log(`gate notify: could not ask ${gate.id}: ${messageOf(error)}`);
    }
  }
}

function askRequest(label: string, gate: GateRecord): AskRequest {
  const options = decisionQuestion(gate)?.options ?? [];
  const recommended = options.find((option) => option.recommended)?.id;
  return {
    as: label,
    text: askText(gate),
    task: `gate:${gate.id}`,
    options: options.map((option) => option.id),
    ...(recommended !== undefined && { recommended }),
  };
}

/** Settles first, so a dismiss that fails still leaves the row closed and a late answer ignored. */
async function withdrawPass(ports: GateNotifyPorts): Promise<void> {
  for (const ask of ports.asks.open()) {
    if (ports.getGate(ask.gateId)?.status === "pending") continue;
    if (!ports.asks.settle(ask.gateId, "withdrawn", "gate settled by another route")) continue;
    try {
      await ports.dismissAsk(ask.msgId, ports.signal);
    } catch (error) {
      ports.log(`gate notify: could not dismiss the ask for ${ask.gateId}: ${messageOf(error)}`);
    }
  }
}

async function answerPass(ports: GateNotifyPorts): Promise<void> {
  let page: AnswersPage;
  try {
    page = await ports.readAnswers(ports.label, ports.asks.cursor(ports.label), ports.signal);
  } catch (error) {
    ports.log(`gate notify: could not read answers: ${messageOf(error)}`);
    return;
  }
  for (const answer of page.answers) {
    if (!applyAnswer(ports, answer)) return;
  }
  if (page.next !== undefined) ports.asks.advance(ports.label, page.next);
}

/** False stops the page before the cursor moves, so an answer that hit an unexpected fault is read again. */
function applyAnswer(ports: GateNotifyPorts, answer: ServiceAnswer): boolean {
  const ask = ports.asks.byMsg(answer.questionId);
  if (ask === undefined || ask.state !== "asked") return true;
  if (answer.outcome === "dismissed") {
    ports.asks.settle(ask.gateId, "dismissed");
    return true;
  }
  const gate = ports.getGate(ask.gateId);
  const payload = gate && answerPayload(gate, answer.text);
  if (gate?.status !== "pending") {
    ports.asks.settle(ask.gateId, "withdrawn", "gate settled by another route");
    return true;
  }
  const refusal = provenanceRefusal(answer, payload);
  if (refusal !== undefined) {
    ports.asks.settle(ask.gateId, "refused", refusal);
    return true;
  }
  if (payload === undefined) {
    ports.asks.settle(ask.gateId, "unmappable", answer.text);
    return true;
  }
  return resolveOnce(ports, ask.gateId, payload, resolverFor(ports, answer));
}

/**
 * Every answer here resolves as the owner, which the decider answering on the human's behalf is not, so a decided answer
 * settles no gate. A waive-proof also needs the broker to say a human approved the words: an unmarked answer may come from
 * any caller on the socket (Q1), so it fails closed and the waiver stays with the terminal.
 */
function provenanceRefusal(answer: ServiceAnswer, payload: Record<string, unknown> | undefined): string | undefined {
  if (answer.provenance === DECIDED) return "a decided answer is the decider's, not the owner's; answer at the terminal";
  if (payload?.[DECISION] === WAIVE_PROOF && answer.provenance !== HUMAN_ENDORSED) return `${WAIVE_PROOF} is the owner's own and the answer is not human-endorsed; answer at the terminal`;
  return undefined;
}

function resolverFor(ports: GateNotifyPorts, answer: ServiceAnswer): GateResolver {
  return { class: ports.resolverClass, id: "agent-chat", channel: `agent-chat:${answer.channel ?? "unknown"}` };
}

function resolveOnce(ports: GateNotifyPorts, gateId: string, payload: unknown, resolver: GateResolver): boolean {
  try {
    ports.asks.atomically(() => {
      if (ports.asks.settle(gateId, "resolved")) ports.resolve(gateId, payload, resolver);
    });
    return true;
  } catch (error) {
    const state = refusedState(error);
    if (state === undefined) {
      ports.log(`gate notify: could not resolve ${gateId}: ${messageOf(error)}`);
      return false;
    }
    ports.asks.settle(gateId, state, messageOf(error));
    return true;
  }
}

function refusedState(error: unknown): Exclude<GateAskState, "asked" | "resolved"> | undefined {
  if (error instanceof GateResolverRefused) return "refused";
  if (error instanceof GatePayloadInvalid) return "unmappable";
  if (error instanceof GateAlreadySettled || error instanceof GateExpired || error instanceof GateNotFound) return "withdrawn";
  return undefined;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
