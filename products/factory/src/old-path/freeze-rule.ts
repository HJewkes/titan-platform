import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PrFile } from "@titan-design/github";
import { z } from "zod";
import { findSunsetManifest } from "../dispatch/old-paths.js";

/** A1's old-path roots, pinned to the sunset manifest by a test. The agent-chat `src` fold root is not frozen. */
export const A1_FROZEN_ROOTS: readonly { repo: string; path: string }[] = [
  { repo: "titan-platform", path: "products/factory/src/shepherd" },
  { repo: "agent-chat", path: "src/agents/burndown" },
  { repo: "agent-chat", path: "scripts/seat" },
];

/** The milestone whose exit turns the freeze from advisory into a gate. */
const FREEZE_MILESTONE = "M1b";

const MILESTONES = "milestones.json";
const MILESTONE_ID = /^M\d+[ab]?$/;
const FOLD_TASK = /^(TP|CC|TD)-\d+$/;

const Milestones = z.object({
  milestones: z.array(z.object({ id: z.string(), exited: z.union([z.boolean(), z.string().min(1)]) })),
});

export type CarveOut = { tag: string } | { stale: string } | undefined;
export type ExitedRead = { exited: Set<string> } | { unread: string };

/** What the task read yielded; the pure rule takes it as data so it never reads a task itself. */
export type TaskRead = { tags: string[] } | { absent: true } | { unread: string };

export type OldPathVerdict =
  | { status: "clear" }
  | { status: "carved"; touches: string[]; tag: string; active: boolean }
  | {
      status: "untagged" | "stale-tag" | "no-task" | "task-unread";
      touches: string[];
      reason: string;
      active: boolean;
    };

export interface OldPathInput {
  repo: string;
  files: PrFile[];
  task: TaskRead;
  exited: ExitedRead;
}

const repoName = (repo: string): string => (repo.split("/").pop() ?? repo).toLowerCase();

const underRoot = (root: string, path: string): boolean => path.startsWith(`${root}/`);

function inFrozenRoot(repo: string, path: string): boolean {
  const name = repoName(repo);
  return A1_FROZEN_ROOTS.some((root) => root.repo === name && underRoot(root.path, path));
}

function fileTouches(repo: string, file: PrFile): string[] {
  const touched: string[] = [];
  if (file.status !== "removed" && inFrozenRoot(repo, file.path)) touched.push(file.path);
  const movedOut = file.status === "renamed" && !inFrozenRoot(repo, file.path);
  if (file.previousPath !== undefined && !movedOut && inFrozenRoot(repo, file.previousPath)) {
    touched.push(file.previousPath);
  }
  return touched;
}

/** Frozen paths a PR changes. Pure deletions and renames out of the root touch nothing. */
export function frozenTouches(repo: string, files: PrFile[]): string[] {
  return [...new Set(files.flatMap((file) => fileTouches(repo, file)))];
}

/** The tag that carves a task out of the freeze, or the stale `superseded-at` that names an exited milestone. */
export function carveOutOf(tags: string[], exited: Set<string>): CarveOut {
  let stale: string | undefined;
  for (const raw of tags) {
    const tag = raw.trim();
    if (tag === "survives" || (tag.startsWith("survives:") && tag.length > "survives:".length)) return { tag };
    if (!tag.startsWith("superseded-at:")) continue;
    const target = tag.slice("superseded-at:".length);
    if (FOLD_TASK.test(target)) return { tag };
    if (!MILESTONE_ID.test(target)) continue;
    if (exited.has(target)) stale ??= tag;
    else return { tag };
  }
  return stale === undefined ? undefined : { stale };
}

/** Which milestones have exited, read beside the sunset manifest. An unreadable file is reported, not guessed. */
export function readExited(dir: string | undefined = manifestDir()): { exited: Set<string> } | { unread: string } {
  if (dir === undefined) return { unread: `${MILESTONES} unread: no sunset manifest found` };
  const file = join(dir, MILESTONES);
  if (!existsSync(file)) return { unread: `${MILESTONES} unread: not found` };
  try {
    const parsed = Milestones.parse(JSON.parse(readFileSync(file, "utf8")));
    return { exited: new Set(parsed.milestones.filter((m) => m.exited !== false).map((m) => m.id)) };
  } catch (error) {
    return { unread: `${MILESTONES} unread: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function manifestDir(): string | undefined {
  const manifest = findSunsetManifest();
  return manifest === undefined ? undefined : dirname(manifest);
}

const SHOWN = 5;

function shown(touches: string[]): string {
  const rest = touches.length - SHOWN;
  return touches.slice(0, SHOWN).join(", ") + (rest > 0 ? ` and ${rest} more` : "");
}

/** The verdict on a PR's files against its task's tags. Gates only when `active`; callers record it otherwise. */
export function oldPathVerdict(input: OldPathInput): OldPathVerdict {
  const touches = frozenTouches(input.repo, input.files);
  if (touches.length === 0) return { status: "clear" };
  const read = input.exited;
  const exited = "exited" in read ? read.exited : new Set<string>();
  const active = "unread" in read || exited.has(FREEZE_MILESTONE);
  const note = "unread" in read ? ` (${read.unread})` : "";
  const refuse = (status: "untagged" | "stale-tag" | "no-task" | "task-unread", why: string): OldPathVerdict => ({
    status,
    touches,
    reason: `${shown(touches)} are old path; ${why}${note}`,
    active,
  });
  if ("unread" in input.task) return refuse("task-unread", `its task was unread: ${input.task.unread}`);
  if ("absent" in input.task) return refuse("no-task", "no task was found");
  const carve = carveOutOf(input.task.tags, exited);
  if (carve === undefined) return refuse("untagged", "its task has no superseded-at or survives carve-out tag");
  if ("stale" in carve) return refuse("stale-tag", `${carve.stale} names an exited milestone`);
  return { status: "carved", touches, tag: carve.tag, active };
}
