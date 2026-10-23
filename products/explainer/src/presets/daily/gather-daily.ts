import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GhExec } from "@titan-design/github";
import { DigestSchema, type Digest, type DigestItem } from "../../digest.js";
import { pullRequestItems } from "./github-source.js";
import { sessionItems, type DayWindow } from "./session-source.js";
import { readTaskSnapshot, type SnapshotTask, type TaskDelta } from "./task-snapshot.js";

export interface GatherDailyOptions {
  /** The UTC day, `YYYY-MM-DD`; the window is that day's 24 hours. */
  day: string;
  repos: readonly string[];
  /** Claude Code transcript roots, each holding `<project>/<session>.jsonl`. */
  transcriptRoots: readonly string[];
  initiative: string;
  snapshotDir: string;
  gh: GhExec;
  listTasks: (initiative: string) => Promise<SnapshotTask[]>;
  ownerGateTags?: Iterable<string>;
}

export interface GatherDailyResult {
  digest: Digest;
  notes: string[];
}

export function dayWindow(day: string): DayWindow {
  const since = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(since.getTime()) || since.toISOString().slice(0, 10) !== day) throw new Error(`not a calendar day: "${day}"`);
  return { since: since.toISOString(), until: new Date(since.getTime() + 86_400_000).toISOString() };
}

// A delta without a dated field of its own is stamped at the window's start, never at the time of the run.
function deltaAt(delta: TaskDelta, window: DayWindow): string {
  const dated = delta.change === "closed" ? delta.task.done_at : delta.change === "opened" ? delta.task.created : undefined;
  return dated && !Number.isNaN(Date.parse(dated)) && dated.includes("T") ? new Date(dated).toISOString() : window.since;
}

function taskItem(delta: TaskDelta, initiative: string, window: DayWindow): DigestItem {
  const move = delta.from === undefined ? `now ${delta.to}` : `${delta.from} to ${delta.to}`;
  return { id: delta.id, kind: "task", title: delta.task.title, at: deltaAt(delta, window), repo: initiative, summary: `${delta.task.id} ${delta.change}: ${move}`, change: delta.change };
}

/**
 * The daily briefing's facts: PRs opened and merged, sessions active, and task deltas against the latest earlier
 * snapshot. Every id comes from its source (repo and PR number, session id, task id with the change), and items
 * are sorted by id, so two runs over the same inputs write the same digest.
 */
export async function gatherDaily(options: GatherDailyOptions): Promise<GatherDailyResult> {
  const window = dayWindow(options.day);
  const prs = await pullRequestItems(options.gh, options.repos, options.day);
  const sessions = await sessionItems(options.transcriptRoots, window);
  const tasks = await readTaskSnapshot(options);
  const notes = [...prs.notes, ...(tasks.previousDay ? [] : [`no task snapshot before ${options.day}; task moves are unknown, opened and closed come from task dates`])];
  const items = [...prs.items, ...sessions, ...tasks.deltas.map((delta) => taskItem(delta, options.initiative, window))];
  const digest = DigestSchema.parse({ ...window, items: items.sort((a, b) => a.id.localeCompare(b.id)) });
  return { digest, notes };
}

const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();

/** `facts.md` for the script stage: one row per digest item, its id the fact id a script cites. */
export function dailyFactsMarkdown(digest: Digest): string {
  const rows = digest.items.map((item) => {
    const claim = [item.change ? `${item.kind} ${item.change}` : item.kind, item.repo, item.title, item.summary].filter(Boolean).join(" · ");
    return `| ${cell(item.id)} | ${cell(claim)} |`;
  });
  return [`# Facts: daily ${digest.since.slice(0, 10)}`, "", "| Id | Claim |", "|---|---|", ...rows, ""].join("\n");
}

export interface DailyGatherFiles {
  digest: string;
  facts: string;
}

/** Writes `digest.json` and `facts.md` into `dir`. */
export async function writeDailyGather(dir: string, digest: Digest): Promise<DailyGatherFiles> {
  await mkdir(dir, { recursive: true });
  const files = { digest: join(dir, "digest.json"), facts: join(dir, "facts.md") };
  await writeFile(files.digest, `${JSON.stringify(digest, null, 2)}\n`);
  await writeFile(files.facts, dailyFactsMarkdown(digest));
  return files;
}
