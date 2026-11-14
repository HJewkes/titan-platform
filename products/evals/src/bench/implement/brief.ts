import { leaksAnswer } from "../../implement-task/select.js";

interface TaskBriefFields {
  title: string;
  doneWhen: string;
}

type ScrubResult = { ok: true; brief: string } | { ok: false; reason: "brief-leaks-answer" | "brief-leaks-history" };

/** Notes are dropped: they carry "closed by Shepherd: #N at <sha>" and the follow-up lines filed after the merge. */
const taskBrief = (task: TaskBriefFields): string => `Task: ${task.title.trim()}\nDone when: ${task.doneWhen.trim()}`;

/** A PR number, a commit sha or Shepherd's own closing words in a brief point at how the task was answered. */
const HISTORY_MARKERS = /#\d{3,}|\b[0-9a-f]{7,40}\b|closed by Shepherd|Follow-up TP-/;

/** The arm's brief, or why the case cannot be briefed without naming its answer. */
export function scrubBrief(task: TaskBriefFields, merge: { pr: number; mergeSha: string }): ScrubResult {
  const brief = taskBrief(task);
  if (leaksAnswer(brief, { pr_number: merge.pr, merge_commit: merge.mergeSha })) return { ok: false, reason: "brief-leaks-answer" };
  if (HISTORY_MARKERS.test(brief)) return { ok: false, reason: "brief-leaks-history" };
  return { ok: true, brief };
}
