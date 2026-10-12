import { BrokerUnavailableError, DispatchTimeoutError, type AgentRow } from "@titan-design/agent-dispatch";
import type { ShepherdDeps } from "./phases.js";
import { SpawnDeferred } from "./spawn-gate.js";

const DEFAULT_POLL_MS = 30_000;

/** How long one wake's asks may only be waited out, from its first ask, before the wake fails and its seat is told. */
export const WAKE_ASK_MS = 5 * 60_000;

/** Waited out: nothing was asked of the broker, or what was asked is checked on the next roster read. */
const brokerDown = (error: unknown): boolean => error instanceof BrokerUnavailableError || error instanceof DispatchTimeoutError;

/** Why an ask was waited out instead of answered. */
export type Wait = "timeout" | "deferred" | "broker-down";

/** Fixed words, never the error's text, since the reason reaches the seat and a PR comment. */
const WAIT_WORDS: Record<Wait, string> = { timeout: "agent-chat timed out", deferred: "the spawn gate deferred it", "broker-down": "the broker was unavailable" };

export function waitOf(error: unknown): Wait | undefined {
  if (error instanceof SpawnDeferred) return "deferred";
  if (error instanceof DispatchTimeoutError) return "timeout";
  return error instanceof BrokerUnavailableError ? "broker-down" : undefined;
}

/** A spawn gate that defers the resume is waited out on the poll, as a broker that is down is, until `deadlineMs` passes. */
export async function whileDeferred(deps: ShepherdDeps, deadlineMs: number, signal: AbortSignal, ask: () => Promise<void>): Promise<void> {
  const until = deps.now() + deadlineMs;
  for (;;) {
    try {
      return await ask();
    } catch (error) {
      if (!(error instanceof SpawnDeferred) || deps.now() >= until) throw error;
    }
    await deps.sleep(deps.pollMs ?? DEFAULT_POLL_MS, signal);
  }
}

/** The asks of one wake that were only waited out: since the first ask, and why the latest one was. */
export interface Waiting {
  since: number;
  wait: Wait;
}

export async function waitAPoll(deps: ShepherdDeps, waiting: Waiting, signal: AbortSignal): Promise<Waiting> {
  await deps.sleep(deps.pollMs ?? DEFAULT_POLL_MS, signal);
  return waiting;
}

export async function rosterWhileBrokerDown(deps: ShepherdDeps, agents: { roster(): Promise<readonly AgentRow[]> }, signal: AbortSignal): Promise<readonly AgentRow[]> {
  for (;;) {
    signal.throwIfAborted();
    try {
      return await agents.roster();
    } catch (error) {
      if (!brokerDown(error)) throw error;
    }
    await deps.sleep(deps.pollMs ?? DEFAULT_POLL_MS, signal);
  }
}

/** "<minutes> minutes: <why>" once the asks have only been waited out for `deadlineMs`, else undefined. */
export function expiredWait(deps: ShepherdDeps, deadlineMs: number, waiting: Waiting): string | undefined {
  return deps.now() - waiting.since < deadlineMs ? undefined : `${deadlineMs / 60_000} minutes: ${WAIT_WORDS[waiting.wait]}`;
}
