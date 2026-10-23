import { BrokerUnavailableError, DispatchError, DispatchTimeoutError, listAgents, retire, type AgentRow, type RetireResult } from "@titan-design/agent-dispatch";
import { refused, type Outcome } from "../console-action/outcome.js";
import type { OpRead } from "../console-action/record.js";
import type { FactoryHost } from "../host.js";
import { LIVE } from "../shepherd/gone-elsewhere.js";
import type { ShepherdStore, ShepherdStoreRef } from "../shepherd/store.js";

/** The name agent-chat records as the actor of every retire the console asks for. */
const CONSOLE_CALLER = "titan-console";
const AGENT_CHAT_TIMEOUT_MS = 30_000;

/** The agent-chat CLI boundary a retire needs: the roster as it stands, and a plain retire by name. */
export interface AgentChatRetirePort {
  list(): Promise<AgentRow[]>;
  retire(name: string): Promise<RetireResult>;
}

export function agentChatRetirePort(agentChatBin: string, timeoutMs = AGENT_CHAT_TIMEOUT_MS): AgentChatRetirePort {
  return {
    list: () => listAgents(agentChatBin, timeoutMs),
    retire: (name) => retire(agentChatBin, name, timeoutMs, { caller: CONSOLE_CALLER }),
  };
}

export interface RetireAgentDeps {
  host: FactoryHost;
  services: { store: ShepherdStoreRef };
  /** Absent when serve has no `shepherd.agentChatBin`; every retire then answers 503. */
  agentChat: AgentChatRetirePort | undefined;
  /** The `done` results this action id already logged, so a replay of a record that retired reads back `already`. */
  done: (actionId: string) => Promise<object[]>;
}

/**
 * A plain retire of one finished agent, as the owner confirmed it. Everything is re-read here: the agent must still hold the
 * name under the confirmed id, hold no live session, and author no live Shepherd run. `--force` discards work, and agent-chat
 * keeps no exit time on the roster to check its grace against, so the console never sends it.
 */
export async function retireAgent(actionId: string, { op }: OpRead, deps: RetireAgentDeps): Promise<Outcome> {
  if (op.kind !== "retire-agent") return refused("record", `retire-agent cannot run a ${op.kind} op`);
  if (op.force) return refused("class", "the console never retires with --force; a forced retire discards work and stays at the terminal");
  if (deps.agentChat === undefined) return refused("agent-chat-unavailable", "serve has no shepherd.agentChatBin");
  const rows = await deps.agentChat.list().catch((error: unknown) => unavailable(error));
  if (!Array.isArray(rows)) return rows;
  const holder = nameHolder(rows, op.name);
  if (holder === undefined) {
    if (await retiredByThis(actionId, deps)) return { outcome: "already", name: op.name };
    return { outcome: "gone", reason: `${op.name} is already retired or unknown to agent-chat` };
  }
  if (holder.agentId !== op.agentId) return { outcome: "moved", currentAgentId: holder.agentId };
  const stop = retireStop(holder, deps);
  if (stop !== undefined) return refused("class", stop);
  return deps.agentChat.retire(op.name).then(
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
