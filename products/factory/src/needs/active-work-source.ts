import type { OwnerItem, QueueSource } from "@titan-design/owner-queue";
import { createRpcClient, liveSource } from "@titan-design/rpc-client";
import { pollTail } from "./poll-tail.js";

export const NEEDS_DECISION_TAG = "needs-decision";

export interface DecisionTask {
  slug: string;
  id: string;
  title: string;
  status: string;
  tags?: string[];
  done_when?: string;
  notes?: string;
  created: string;
  updated: string;
}

type ActiveWorkReads = {
  "task.list": { args: { all_initiatives: true; status: "open"; tag: string }; result: { tasks: DecisionTask[] } };
  inventory: { args: Record<string, never>; result: { initiatives: { slug: string; human_only: boolean }[]; human_only_known: boolean } };
};

export interface ActiveWorkSourceOptions {
  origin: string;
  fetch?: typeof fetch;
  /** Personal (charter `human_only`) initiatives are left out unless asked for. */
  includePersonal?: boolean;
  pollMs?: number;
}

const SUMMARY_MAX = 280;

function clip(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= SUMMARY_MAX ? line : `${line.slice(0, SUMMARY_MAX - 1)}…`;
}

/** The question usually sits in the notes, so they lead the context; done_when says what an answer unblocks. */
export function decisionTaskItem(task: DecisionTask, personal: boolean): OwnerItem {
  const context = [task.notes, task.done_when && `Done when: ${task.done_when}`].filter(Boolean).join("\n\n");
  return {
    id: `task:${task.id}`,
    sources: [{ system: "active-work", ref: `${task.slug}/${task.id}` }],
    kind: "decide",
    door: "two-way",
    summary: clip(`${task.id}: ${task.title}`),
    context,
    keys: [`task:${task.id}`],
    initiative: task.slug,
    personal,
    lens: "planning",
    unblocks: [`task:${task.id}`],
    openedAt: `${task.created}T00:00:00Z`,
    status: "open",
  };
}

/** An unreadable charter makes every initiative personal, so nothing private leaks on a bad read. */
function personalSlugs(inventory: ActiveWorkReads["inventory"]["result"]): (slug: string) => boolean {
  if (!inventory.human_only_known) return () => true;
  const personal = new Set(inventory.initiatives.filter((entry) => entry.human_only).map((entry) => entry.slug));
  return (slug) => personal.has(slug);
}

/** Open `needs-decision` tasks over the active-work daemon's loopback rpc, the reader the factory's Shepherd already uses. */
export function createActiveWorkSource(options: ActiveWorkSourceOptions): QueueSource {
  const client = createRpcClient<ActiveWorkReads>(liveSource(options));
  const open = async (): Promise<OwnerItem[]> => {
    const [{ tasks }, inventory] = await Promise.all([
      client.call("task.list", { all_initiatives: true, status: "open", tag: NEEDS_DECISION_TAG }),
      client.call("inventory", {}),
    ]);
    const isPersonal = personalSlugs(inventory);
    return tasks
      .filter((task) => options.includePersonal === true || !isPersonal(task.slug))
      .map((task) => decisionTaskItem(task, isPersonal(task.slug)));
  };
  return {
    system: "active-work",
    open,
    tail: (cursor, signal) => pollTail(open, cursor, signal, options.pollMs),
    resolve: async () => ({ ok: false, reason: "rejected", detail: "needs-decision tasks are answered by a note on the task" }),
  };
}
