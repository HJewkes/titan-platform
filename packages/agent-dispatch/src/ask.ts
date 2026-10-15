/**
 * Put a question on agent-chat's human queue from a process that is not a
 * Claude session, and read what the owner did with it later (CC-169). The
 * asker can exit between the two: answers are read back by label and msg_id
 * cursor from the broker's log, not pushed to a live connection.
 *
 * The question text travels on stdin, never argv, for the same reason a brief
 * does (R-68): argv is world-readable through `ps`.
 */

import { z } from "zod";

import { refusal, runAgentChatAsync } from "./agents.js";
import { BrokerUnavailableError, DispatchError } from "./dispatch.js";
import type { SafeExecResult } from "./exec.js";

/** agent-chat's `ask` and `answers` exit this when no broker listens or it predates the verbs. */
export const BROKER_UNAVAILABLE_EXIT = 69;
/** agent-chat's `ask` and `answers` exit this on a usage error, apart from a refusal (1). */
export const USAGE_EXIT = 2;

/** The label shape agent-chat's broker accepts, checked before a call is spent on it. */
export const ASK_LABEL_PATTERN = /^[a-z0-9][a-z0-9._-]{0,47}$/;

export interface AskRequest {
  /** The service label answers are read back under. */
  as: string;
  text: string;
  /** The task or gate the question is about; the owner's queue groups by it. */
  task?: string;
  /** Answers to offer the owner. */
  options?: string[];
  recommended?: string;
}

/** One answer or dismissal to an ask, as agent-chat's `answers --json` prints it. */
export interface ServiceAnswer {
  msgId: string;
  /** The msg_id `askHuman` returned for the ask this settles. */
  questionId: string;
  outcome: "answered" | "dismissed";
  text: string;
  by: "human";
  /** Where the owner answered from, when agent-chat knows. */
  channel?: string;
  at: number;
}

/** Pass `next` back as `since` to read only what is new. */
export interface AnswersPage {
  answers: ServiceAnswer[];
  next?: string;
}

const serviceAnswerSchema: z.ZodType<ServiceAnswer> = z.object({
  msgId: z.string(),
  questionId: z.string(),
  outcome: z.enum(["answered", "dismissed"]),
  text: z.string(),
  by: z.literal("human"),
  channel: z.string().optional(),
  at: z.number(),
});

const answersPageSchema: z.ZodType<AnswersPage> = z.object({
  answers: z.array(serviceAnswerSchema),
  next: z.string().optional(),
});

export function buildAskArgs(req: AskRequest): string[] {
  return [
    "ask",
    "--as",
    req.as,
    "--text-stdin",
    "--json",
    ...(req.task === undefined ? [] : ["--task", req.task]),
    ...(req.options ?? []).flatMap((option) => ["--option", option]),
    ...(req.recommended === undefined ? [] : ["--recommended", req.recommended]),
  ];
}

export function buildAnswersArgs(label: string, since?: string): string[] {
  return ["answers", label, ...(since === undefined ? [] : ["--since", since]), "--json"];
}

/** Files the question and returns its msg_id, the id its answer is read back by. */
export async function askHuman(
  agentChatBinPath: string,
  req: AskRequest,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  requireLabel(req.as);
  const result = await runAgentChatAsync(agentChatBinPath, buildAskArgs(req), timeoutMs, req.text, signal);
  if (result.status !== 0) throw askFailure("ask", result);
  const parsed = z.object({ msgId: z.string().min(1) }).safeParse(parseJson("ask", result.stdout));
  if (!parsed.success) throw new DispatchError("agent-chat ask --json printed no msgId");
  return parsed.data.msgId;
}

/** Answers and dismissals to `label`'s asks after `since`, oldest first. */
export async function readAnswers(
  agentChatBinPath: string,
  label: string,
  since: string | undefined,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<AnswersPage> {
  requireLabel(label);
  const result = await runAgentChatAsync(agentChatBinPath, buildAnswersArgs(label, since), timeoutMs, undefined, signal);
  if (result.status !== 0) throw askFailure("answers", result);
  const parsed = answersPageSchema.safeParse(parseJson("answers", result.stdout));
  if (!parsed.success) {
    throw new DispatchError(`agent-chat answers --json printed an unexpected shape: ${parsed.error.message}`);
  }
  return parsed.data;
}

/** Withdraws an ask nobody needs answered any more. A refusal means it is already closed. */
export async function dismissAsk(
  agentChatBinPath: string,
  msgId: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (msgId === "" || msgId.startsWith("-")) throw new DispatchError(`invalid msg_id: '${msgId}'`);
  const result = await runAgentChatAsync(agentChatBinPath, ["dismiss", msgId], timeoutMs, undefined, signal);
  if (result.status !== 0) throw askFailure("dismiss", result);
}

function requireLabel(label: string): void {
  if (!ASK_LABEL_PATTERN.test(label)) throw new DispatchError(`invalid ask label: '${label}'`);
}

function parseJson(verb: string, stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new DispatchError(`agent-chat ${verb} --json printed invalid JSON`);
  }
}

/** A down broker is worth retrying later; a refusal or usage error is not. */
function askFailure(verb: string, result: SafeExecResult): DispatchError {
  const reason = result.stderr.trim() || result.stdout.trim();
  if (result.status === BROKER_UNAVAILABLE_EXIT) {
    return new BrokerUnavailableError(`agent-chat ${verb} could not reach the broker: ${reason}`);
  }
  if (result.status === USAGE_EXIT) return new DispatchError(`agent-chat ${verb} usage error: ${reason}`);
  return refusal(verb, result);
}
