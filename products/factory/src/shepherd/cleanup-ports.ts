import { listAgents, retire } from "@titan-design/agent-dispatch";
import { createRpcClient, liveSource, RpcError, type RpcClient } from "@titan-design/rpc-client";
import type { CleanupAgents, CleanupTasks, TaskState } from "./cleanup.js";
import { FixTaskRefused, type FixTaskFields, type FixTasks, type FlakeFields } from "./main-red.js";
import { toPresence } from "./presence.js";
import { createRosterReader, mutating, type RosterReader } from "./roster.js";

export const DEFAULT_AGENT_CHAT_TIMEOUT_MS = 30_000;
export const DEFAULT_ACTIVE_WORK_PORT = 7400;

export interface AgentChatCalls {
  listAgents: typeof listAgents;
  retire: typeof retire;
}

/** Roster and retire over the `agent-chat` CLI; the retire passes no options, so it is never forced, and it invalidates `roster` so the settle check reads fresh. */
export function agentChatCleanupAgents(
  agentChatBin: string,
  calls: AgentChatCalls = { listAgents, retire },
  timeoutMs = DEFAULT_AGENT_CHAT_TIMEOUT_MS,
  roster: RosterReader = createRosterReader(async () => calls.listAgents(agentChatBin, timeoutMs)),
): CleanupAgents {
  return {
    roster: async () => (await roster.rows()).map(({ name, presence, status }) => ({ name, presence: toPresence(presence), status })),
    invalidate: () => roster.invalidate(),
    retire: (name) => mutating(roster, async () => void (await calls.retire(agentChatBin, name, timeoutMs))),
  };
}

type ActiveWorkCommands = {
  "task.list": { args: { slug: string; status: "all"; tag?: string }; result: { tasks: { id: string; status: string; done_when?: string; notes?: string; tags?: string[] }[] } };
  "source.list": { args: { slug: string }; result: { sources: { filename: string }[] } };
  "source.read": { args: { slug: string; path: string }; result: { content: string } };
  "task.add": { args: { slug: string } & FixTaskFields; result: { id: string } };
  "task.edit": { args: { slug: string; id: string; field: "notes" | "done_when" | "status"; value: string; force?: boolean } | { slug: string; id: string; add_tag: string }; result: unknown };
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
    slicing: async (slug, id) => {
      const { tasks } = await client.call("task.list", { slug, status: "all" });
      const task = tasks.find((candidate) => candidate.id === id);
      return { tags: task?.tags ?? [], notes: task?.notes ?? "", plan: await planText(client, slug, id) };
    },
    done: async (slug, id) => void (await client.call("task.done", { slug, id })),
    appendNote: async (slug, id, line) => {
      const { tasks } = await client.call("task.list", { slug, status: "all" });
      const notes = tasks.find((task) => task.id === id)?.notes ?? "";
      if (notes.includes(line)) return;
      await client.call("task.edit", { slug, id, field: "notes", value: notes === "" ? line : `${notes}\n${line}` });
    },
  };
}

/** Listed before it is read, so a plan that does not exist is told apart from a read that failed, which throws. */
async function planText(client: RpcClient<ActiveWorkCommands>, slug: string, id: string): Promise<string | undefined> {
  const filename = `${id}-plan.md`;
  const { sources } = await client.call("source.list", { slug });
  if (!sources.some((source) => source.filename === filename)) return undefined;
  return (await client.call("source.read", { slug, path: `sources/${filename}` })).content;
}

/** Fix tasks over the same loopback rpc; the notes travel in the request body, never in argv. */
export function activeWorkFixTasks(options: { origin: string; fetch?: typeof fetch }): FixTasks {
  const client = createRpcClient<ActiveWorkCommands>(liveSource(options));
  return {
    findByTag: (slug, tag) => refusalsFinal(async () => (await client.call("task.list", { slug, status: "all", tag })).tasks[0]?.id),
    add: (slug, fields) => refusalsFinal(async () => (await client.call("task.add", { slug, ...fields })).id),
    markFlake: (slug, id, flake) => refusalsFinal(() => markFlake(client, slug, id, flake)),
  };
}

/** sysexits USAGE, DATAERR and NOINPUT: active-work's own refusals (a guarded edit, a bad value, a missing task), never an outage. */
const REFUSAL_CODES = new Set([64, 65, 66]);

async function refusalsFinal<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof RpcError && REFUSAL_CODES.has(error.code)) throw new FixTaskRefused(`active-work refused ${error.command}: ${error.message}`);
    throw error;
  }
}

/**
 * Each write is idempotent, so a retry after a partial failure lands the same task. The filed done_when is replaced on
 * purpose, so the edit passes `force`. The notes say the freeze thawed, so they go last, after every write that can
 * be refused, and only once. A done task is reopened, because the flake is still in the code.
 */
async function markFlake(client: RpcClient<ActiveWorkCommands>, slug: string, id: string, flake: FlakeFields): Promise<void> {
  const { tasks } = await client.call("task.list", { slug, status: "all" });
  const task = tasks.find((candidate) => candidate.id === id);
  if (task === undefined) throw new FixTaskRefused(`fix task ${slug}/${id} is not in its initiative`);
  if (task.done_when !== flake.done_when) await client.call("task.edit", { slug, id, field: "done_when", value: flake.done_when, force: true });
  if (!(task.tags ?? []).includes(flake.tag)) await client.call("task.edit", { slug, id, add_tag: flake.tag });
  if (task.status === "done") await client.call("task.edit", { slug, id, field: "status", value: "open" });
  const notes = task.notes ?? "";
  if (!notes.includes(flake.notes)) await client.call("task.edit", { slug, id, field: "notes", value: notes === "" ? flake.notes : `${notes}\n\n${flake.notes}` });
}
