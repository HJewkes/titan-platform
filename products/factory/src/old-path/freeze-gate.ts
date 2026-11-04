import type { PrFile } from "@titan-design/github";
import type { OldPathJudgment } from "./task-tags.js";

/** S2a's `judgeOldPath`, called with the changed files the evidence step already read; it never throws. */
type OldPathJudge = (repo: string, files: PrFile[], task: string, kind: string) => Promise<OldPathJudgment>;

/** The verdict at one head with the registered task it judged; kept whole so a later decide at the head reads the same. */
export type OldPathRecord = OldPathJudgment & { task: string };

export interface OldPathWiring {
  /** Judges a head's changed files against its task's carve-out tags; absent judges none. */
  oldPath?: OldPathJudge;
}

export interface OldPathField {
  oldPath?: OldPathRecord;
}

const NO_TASK = "";
const UNKNOWN_KIND = "unknown";

/**
 * Unread files already gate as files-unread, so the judge is not called on them. A registration with no readable task
 * is judged with none, which refuses under an active freeze. The kind is recorded beside the verdict, never gated (O2).
 */
export async function oldPathOf(judge: OldPathJudge | undefined, repo: string, files: PrFile[] | string, registered: { task?: string; kind?: string }): Promise<OldPathField> {
  if (judge === undefined || typeof files === "string") return {};
  const task = registered.task ?? NO_TASK;
  return { oldPath: { ...(await judge(repo, files, task, registered.kind ?? UNKNOWN_KIND)), task } };
}

/** Only a refusing verdict under an exited M1b gates; before that the verdict is recorded and advisory. */
export function oldPathGate(judged: OldPathRecord | undefined): { row: "old-path-untagged"; reason: string } | undefined {
  if (judged === undefined || judged.status === "clear" || judged.status === "carved" || !judged.active) return undefined;
  const task = judged.task === NO_TASK ? "no task" : `task ${judged.task}`;
  return {
    row: "old-path-untagged",
    reason: `${judged.reason} (A1 freeze since M1b exit; ${task}). Tag the task superseded-at:<M> or survives:<area> and push, or decide it here`,
  };
}

/** The evidence comment's one old-path line; a head that touches no old path shows none. */
export function oldPathLine(judged: OldPathRecord | undefined): string[] {
  if (judged === undefined || judged.status === "clear") return [];
  const advisory = judged.active ? "" : " (advisory until M1b exit)";
  const what = judged.status === "carved" ? `${judged.touches.length} old-path files carved out by ${judged.tag}` : judged.reason;
  return ["", `Old path: ${judged.status}: ${what}${advisory}.`];
}
