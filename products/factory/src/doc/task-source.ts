import { createRpcClient, liveSource } from "@titan-design/rpc-client";
import { z } from "zod";

/** The only task fields a doc draft may see; notes stay in the daemon, so they never reach a prompt or a PR body. */
export interface DocTask {
  slug: string;
  id: string;
  title: string;
  status: string;
  done_when: string;
}

interface DocTaskSource {
  read(slug: string, id: string): Promise<DocTask>;
}

type ActiveWorkReads = {
  "task.list": { args: { slug: string; status: "all" }; result: { tasks: unknown[] } };
};

const listedTask = z.object({ id: z.string(), title: z.string(), status: z.string(), done_when: z.string().trim().min(1).optional() });

/** A docs task over the active-work daemon's loopback rpc; it has no `task.show`, so the task is read from its initiative's list. */
export function activeWorkDocTasks(options: { origin: string; fetch?: typeof fetch }): DocTaskSource {
  const client = createRpcClient<ActiveWorkReads>(liveSource(options));
  return {
    read: async (slug, id) => {
      const { tasks } = await client.call("task.list", { slug, status: "all" });
      const found = tasks.map((task) => listedTask.safeParse(task)).find((parsed) => parsed.success && parsed.data.id === id);
      if (!found?.data) throw new Error(`no task ${slug}/${id}`);
      const { title, status, done_when } = found.data;
      if (done_when === undefined) throw new Error(`${slug}/${id} has no done_when`);
      return { slug, id, title, status, done_when };
    },
  };
}
