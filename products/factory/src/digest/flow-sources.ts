import { createRpcClient, liveSource } from "@titan-design/rpc-client";
import { z } from "zod";
import type { AgentSpan, FlowPorts } from "./flow.js";
import { AGENT_CHAT_TIMEOUT_MS, type Exec } from "./sources.js";

type TaskDates = { "task.list": { args: { slug: string; status: "all" }; result: { tasks: { id: string; created: string }[] } } };

/** Each initiative's task list is read once per digest; `<initiative>/<ID>` is the form a Shepherd run's task carries. */
export function activeWorkTaskDates(options: { origin: string; fetch?: typeof fetch }): FlowPorts["taskCreated"] {
  const client = createRpcClient<TaskDates>(liveSource(options));
  const lists = new Map<string, Promise<Map<string, string>>>();
  return async (task) => {
    const [slug, id] = task.split("/");
    if (!slug || !id) return undefined;
    if (!lists.has(slug)) {
      lists.set(slug, client.call("task.list", { slug, status: "all" }).then(({ tasks }) => new Map(tasks.map((t) => [t.id, t.created]))));
    }
    return (await lists.get(slug)!.catch(() => undefined))?.get(id);
  };
}

const RosterRow = z.object({ profile: z.string(), presence: z.string(), spawnedAt: z.string(), endedAt: z.string().optional() });

/** `agent-chat agent ls --json`; a row without `endedAt` is live only when the broker says a session holds it. */
export function agentChatSpans(exec: Exec, bin: string): FlowPorts["roster"] {
  return async () => {
    const result = await exec(bin, ["agent", "ls", "--json"], AGENT_CHAT_TIMEOUT_MS);
    if (result.code !== 0) throw new Error(`exit ${result.code}: ${result.stderr.trim().split("\n")[0] ?? ""}`);
    const rows = z.array(RosterRow).safeParse(JSON.parse(result.stdout));
    if (!rows.success) throw new Error(`unexpected JSON: ${rows.error.issues[0]?.message ?? "invalid"}`);
    return rows.data.map((row): AgentSpan => ({ profile: row.profile, startedAt: row.spawnedAt, live: row.presence === "live", ...(row.endedAt !== undefined && { endedAt: row.endedAt }) }));
  };
}
