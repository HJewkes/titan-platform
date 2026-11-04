import type { PrFile } from "@titan-design/github";
import { createRpcClient, liveSource } from "@titan-design/rpc-client";
import { errorMessage } from "../narrow.js";
import type { ActiveWorkCommands } from "../shepherd/cleanup-ports.js";
import { frozenTouches, oldPathVerdict, readExited, type OldPathVerdict, type TaskRead } from "./freeze-rule.js";

const DEFAULT_TIMEOUT_MS = 3000;

const INITIATIVE_BY_PREFIX = new Map([ ["TP", "titan-platform"],
  ["CC", "claude-channels"],
  ["TD", "titan-design"],
]);
const BARE_ID = /^(TP|CC|TD)-\d+$/;

export interface TaskTagsPort {
  /** The task's tags, or `undefined` when the initiative has no such task. A failed read throws. */
  tags(initiative: string, id: string): Promise<string[] | undefined>;
}

export type OldPathJudgment = OldPathVerdict & { kind: string };

/** `<initiative>/<ID>` as given, or a bare TP/CC/TD id resolved to its initiative; any other name is no task. */
export function taskRef(task: string): { initiative: string; id: string } | undefined {
  const slash = task.indexOf("/");
  if (slash > 0 && slash < task.length - 1) return { initiative: task.slice(0, slash), id: task.slice(slash + 1) };
  const initiative = INITIATIVE_BY_PREFIX.get(BARE_ID.exec(task)?.[1] ?? "");
  return initiative === undefined ? undefined : { initiative, id: task };
}

/** One task's tags over the active-work loopback rpc; it has no `task.show`, so the initiative's list is filtered by id. */
export function activeWorkTaskTags(options: { origin: string; fetch?: typeof fetch; timeoutMs?: number }): TaskTagsPort {
  const client = createRpcClient<ActiveWorkCommands>(liveSource(options));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    tags: async (initiative, id) => {
      const signal = AbortSignal.timeout(timeoutMs);
      const { tasks } = await client.call("task.list", { slug: initiative, status: "all" }, { signal });
      const found = tasks.find((task) => task.id === id);
      return found === undefined ? undefined : (found.tags ?? []);
    },
  };
}

async function readTask(port: TaskTagsPort, task: string): Promise<TaskRead> {
  const ref = taskRef(task);
  if (ref === undefined) return { absent: true };
  try {
    const tags = await port.tags(ref.initiative, ref.id);
    return tags === undefined ? { absent: true } : { tags };
  } catch (error) {
    return { unread: errorMessage(error) };
  }
}

/** The freeze verdict for a PR, with the task read only when the PR touches a frozen root. Never throws. */
export function judgeOldPath(deps: { tags: TaskTagsPort; exitedDir?: string }) {
  return async (repo: string, files: PrFile[], task: string, kind: string): Promise<OldPathJudgment> => {
    try {
      if (frozenTouches(repo, files).length === 0) return { status: "clear", kind };
      const read = await readTask(deps.tags, task);
      return { ...oldPathVerdict({ repo, files, task: read, exited: readExited(deps.exitedDir) }), kind };
    } catch (error) {
      return { status: "task-unread", touches: frozenTouches(repo, files), reason: errorMessage(error), active: true, kind };
    }
  };
}
