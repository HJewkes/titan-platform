import { listAgents, retire } from "@titan-design/agent-dispatch";
import { createRpcClient, liveSource } from "@titan-design/rpc-client";
import type { CleanupAgents, CleanupTasks, TaskState } from "./cleanup.js";

export const DEFAULT_AGENT_CHAT_TIMEOUT_MS = 30_000;
export const DEFAULT_ACTIVE_WORK_PORT = 7400;

export interface AgentChatCalls {
  listAgents: typeof listAgents;
  retire: typeof retire;
}

/** Roster and retire over the `agent-chat` CLI; the retire passes no options, so it is never forced. */
export function agentChatCleanupAgents(agentChatBin: string, calls: AgentChatCalls = { listAgents, retire }, timeoutMs = DEFAULT_AGENT_CHAT_TIMEOUT_MS): CleanupAgents {
  return {
    roster: async () => calls.listAgents(agentChatBin, timeoutMs).map(({ name, presence, status }) => ({ name, presence, status })),
    retire: async (name) => void calls.retire(agentChatBin, name, timeoutMs),
  };
}

type ActiveWorkCommands = {
  "task.list": { args: { slug: string; status: "all" }; result: { tasks: { id: string; status: string }[] } };
  "task.done": { args: { slug: string; id: string }; result: unknown };
};

/** The active-work daemon's own port rule: `AW_PORT` when it parses, else 7400. */
export function activeWorkOrigin(env: NodeJS.ProcessEnv): string {
  const port = Number.parseInt(env.AW_PORT ?? "", 10);
  return `http://127.0.0.1:${Number.isFinite(port) ? port : DEFAULT_ACTIVE_WORK_PORT}`;
}

/** Tasks over the active-work daemon's loopback rpc; it has no `task.show`, so a task's state is read from its initiative's list. */
export function activeWorkTasks(options: { origin: string; fetch?: typeof fetch }): CleanupTasks {
  const client = createRpcClient<ActiveWorkCommands>(liveSource(options));
  return {
    state: async (slug, id): Promise<TaskState> => {
      const { tasks } = await client.call("task.list", { slug, status: "all" });
      const found = tasks.find((task) => task.id === id);
      return found === undefined ? "missing" : found.status === "done" ? "done" : "open";
    },
    done: async (slug, id) => void (await client.call("task.done", { slug, id })),
  };
}
