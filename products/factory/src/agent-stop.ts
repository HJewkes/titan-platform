import { alarmKey, type OwnerItemDeposit } from "@titan-design/owner-queue";
import type { AgentRow } from "@titan-design/agent-dispatch";
import type { TellOwner } from "./owner-ops/standing-answers.js";
import type { AgentChatAgents } from "./shepherd/agents.js";
import { latestRow } from "./shepherd/wake-roster.js";

const SUMMARY_MAX = 280;

interface AgentStopPorts {
  agents: Pick<AgentChatAgents, "roster" | "message" | "retire">;
  tellOwner: TellOwner;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  pollMs: number;
  /** Polls the agent gets to stop on its own after the stop message, before the retire is tried again. */
  stopGracePolls: number;
}

interface AgentStop {
  name: string;
  /** Finishes a sentence about the agent: "spent $2.00 of its $1.00 budget". */
  why: string;
  signal: AbortSignal;
  /** Sees each row of the grace, so the spend keeps being metered while the agent winds down. */
  observe: (row: AgentRow) => Promise<void>;
}

/** The step has ended but its agent has not, so whatever the step reports is a floor that may still be rising. */
export class AgentLeftRunning extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentLeftRunning";
  }
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Undefined once the agent is retired; otherwise why it was not. Never forced: a forced retire discards unpushed work. */
async function refusalOfRetire(ports: AgentStopPorts, name: string): Promise<string | undefined> {
  if (!ports.agents.retire) return "this adapter cannot retire agents";
  try {
    await ports.agents.retire(name);
    return undefined;
  } catch (error) {
    return messageOf(error);
  }
}

/** A roster that cannot be read says nothing about the agent, so the grace goes on. */
async function hasStopped(ports: AgentStopPorts, stop: AgentStop): Promise<boolean> {
  const rows = await ports.agents.roster().catch(() => undefined);
  if (!rows) return false;
  const row = latestRow(stop.name, rows);
  if (!row) return true;
  await stop.observe(row);
  return row.presence === "exited" || row.status === "retired";
}

async function stoppedWithinGrace(ports: AgentStopPorts, stop: AgentStop): Promise<boolean> {
  for (let poll = 0; poll < ports.stopGracePolls; poll++) {
    await ports.sleep(ports.pollMs, stop.signal);
    if (await hasStopped(ports, stop)) return true;
  }
  return false;
}

function liveAgentDeposit(name: string, why: string, refusal: string): OwnerItemDeposit {
  return {
    depositId: `agent-left-running-${name}`,
    asker: "titan-factory",
    kind: "do",
    door: "two-way",
    summary: `Agent ${name} is still running after its step was stopped`.slice(0, SUMMARY_MAX),
    context: `${name} ${why}. It was told to stop and did not, and its retire was refused: ${refusal}. Its spend is no longer counted against any budget. A forced retire discards its unpushed work, so that is left to you.`,
    command: `agent-chat agent retire ${name}`,
    keys: [alarmKey(`agent-left-running:${name}`)],
  };
}

/**
 * Ends the agent, or says plainly that it could not. A retire refused for unpushed work gets a stop message and a few
 * polls to push and exit, then one more retire; an agent still live after that is the owner's, on the inbox.
 */
export async function stopAgent(ports: AgentStopPorts, stop: AgentStop): Promise<never> {
  const { name, why } = stop;
  if ((await refusalOfRetire(ports, name)) === undefined) throw new Error(`${name} was retired: it ${why}`);
  await ports.agents.message(name, `Budget spent: ${name} ${why}. Commit, push your branch, and stop now.`).catch(() => undefined);
  if (await stoppedWithinGrace(ports, stop)) throw new Error(`${name} stopped when told to: it ${why}`);
  const refusal = await refusalOfRetire(ports, name);
  if (refusal === undefined) throw new Error(`${name} was retired: it ${why}`);
  const filed = await ports.tellOwner(liveAgentDeposit(name, why, refusal)).then(() => "the owner inbox has it", (error: unknown) => `the owner inbox item failed too: ${messageOf(error)}`);
  throw new AgentLeftRunning(`${name} ${why} and is still running after a stop message; its retire was refused: ${refusal}; ${filed}`);
}
