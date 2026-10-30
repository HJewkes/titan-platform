import { BrokerUnavailableError, DispatchError, DispatchTimeoutError, listAgents, retire, type AgentRow, type RetireResult } from "@titan-design/agent-dispatch";
import { refused, type Outcome } from "../console-action/outcome.js";
import type { OpRead } from "../console-action/record.js";
import type { FactoryHost } from "../host.js";
import { LIVE } from "../shepherd/gone-elsewhere.js";
import type { ShepherdStore, ShepherdStoreRef } from "../shepherd/store.js";

/** The name agent-chat records as the actor of every retire the console asks for. */
const CONSOLE_CALLER = "titan-console";
const AGENT_CHAT_TIMEOUT_MS = 30_000;

/**
 * agent-chat's `RECLAIM_GRACE_MS`: a plain retire refuses inside it, but `--force` skips it, so the console waits it out itself
 * before it forces (TP-3620 2.5).
 */
export const RECLAIM_GRACE_MS = 120_000;

/** The agent-chat CLI boundary a retire needs: the roster as it stands, and a retire by name. */
export interface AgentChatRetirePort {
  list(): Promise<AgentRow[]>;
  retire(name: string, force: boolean): Promise<RetireResult>;
}

export function agentChatRetirePort(agentChatBin: string, timeoutMs = AGENT_CHAT_TIMEOUT_MS): AgentChatRetirePort {
  return {
    list: () => listAgents(agentChatBin, timeoutMs),
    retire: (name, force) => retire(agentChatBin, name, timeoutMs, { force, caller: CONSOLE_CALLER }),
  };
}

export interface RetireAgentDeps {
  host: FactoryHost;
  services: { store: ShepherdStoreRef };
  /** Absent when serve has no `shepherd.agentChatBin`; every retire then answers 503. */
  agentChat: AgentChatRetirePort | undefined;
  /** The `done` results this action id already logged, so a replay of a record that retired reads back `already`. */
  done: (actionId: string) => Promise<object[]>;
  now?: () => number;
}

/**
 * A retire of one finished agent, as the owner confirmed it. Everything is re-read here: the agent must still hold the name under
 * the confirmed id, hold no live session, and author no live Shepherd run. `--force` discards work, so it also needs the roster's
 * exit time to be past agent-chat's grace.
 */
export async function retireAgent(actionId: string, { op }: OpRead, deps: RetireAgentDeps): Promise<Outcome> {
  if (op.kind !== "retire-agent") return refused("record", `retire-agent cannot run a ${op.kind} op`);
  if (deps.agentChat === undefined) return refused("agent-chat-unavailable", "serve has no shepherd.agentChatBin");
  const rows = await deps.agentChat.list().catch((error: unknown) => unavailable(error));
  if (!Array.isArray(rows)) return rows;
  const holder = nameHolder(rows, op.name);
  if (holder === undefined) {
    if (await retiredByThis(actionId, deps)) return { outcome: "already", name: op.name };
    return { outcome: "gone", reason: `${op.name} is already retired or unknown to agent-chat` };
  }
  if (holder.agentId !== op.agentId) return { outcome: "moved", currentAgentId: holder.agentId };
  const stop = retireStop(holder, deps) ?? (op.force ? forceStop(holder, (deps.now ?? Date.now)()) : undefined);
  if (stop !== undefined) return refused("class", stop);
  return deps.agentChat.retire(op.name, op.force).then(
    ({ name, caveats }): Outcome => ({ outcome: "retired", name, caveats }),
    (error: unknown) => (isUnavailable(error) ? unavailable(error) : refused("resolver", messageOf(error))),
  );
}

/** Why the console must not retire this agent, or undefined when nothing stops it. */
function retireStop(row: AgentRow, { host, services }: Pick<RetireAgentDeps, "host" | "services">): string | undefined {
  if (!hasExited(row)) return `${row.name} is ${row.state} (${row.status}); the console retires only an agent whose session has exited`;
  const run = liveRunOf(row.name, services.store.get(), host);
  if (run !== undefined) return `${row.name} works on Shepherd run ${run}, which is still live`;
  return undefined;
}

/**
 * Why the console must not force this agent's retire now, or undefined once its exit is past the grace. A row with no exit time
 * cannot show the grace has passed, so it is never forced.
 */
export function forceStop(row: AgentRow, now: number): string | undefined {
  if (!hasExited(row)) return `${row.name} is ${row.state} (${row.status}); only an exited agent is ever forced`;
  const exitedAt = row.exitedAt == null ? Number.NaN : Date.parse(row.exitedAt);
  if (Number.isNaN(exitedAt)) return `agent-chat reports no exit time for ${row.name}, so the grace a forced retire waits out cannot be checked; force it at the terminal`;
  const wait = exitedAt + RECLAIM_GRACE_MS - now;
  if (wait > 0) return `Wait ${Math.ceil(wait / 1000)} s: agent-chat keeps a just-exited agent's worktree for 2 minutes so unpushed work is not lost`;
  return undefined;
}

/** A detached or reconnecting agent may still run a process, so only an exited one with no connection counts as ended. */
export const hasExited = (row: AgentRow): boolean => row.state === "exited" && row.presence === "exited";

/** The agent that holds the name now: a retired row has freed it, so only an unretired one counts. */
export const nameHolder = (rows: readonly AgentRow[], name: string): AgentRow | undefined => rows.find((row) => row.name === name && row.state !== "retired" && row.status !== "retired");

/** A live Shepherd run the agent implements or authored code for, which a fix round may resume it into. */
export function liveRunOf(name: string, store: ShepherdStore, host: FactoryHost): string | undefined {
  const live = store.all().filter((registration) => LIVE.has(host.runtime.status(registration.runId)?.status ?? ""));
  return live.find((registration) => registration.implementer === name || store.authorsOf(registration.runId).some((author) => author.name === name))?.runId;
}

async function retiredByThis(actionId: string, { done }: Pick<RetireAgentDeps, "done">): Promise<boolean> {
  return (await done(actionId)).some((result) => (result as { outcome?: unknown }).outcome === "retired");
}

const isUnavailable = (error: unknown): boolean => error instanceof BrokerUnavailableError || error instanceof DispatchTimeoutError || !(error instanceof DispatchError);
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const unavailable = (error: unknown): Outcome => refused("agent-chat-unavailable", messageOf(error));
