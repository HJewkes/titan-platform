/**
 * What a landed tap left the PR's run doing, read again from live state rather than inferred from the factory's answer:
 * GitHub through the factory's `owner-op.preview`, and the PR's active Shepherd row. A resolve that lands may merge at
 * once, open a new review round when a push moved the head, or leave the run still waiting; the owner sees which.
 */
import type { ShepherdSource } from "./shepherd.js";

export interface NextState {
  state: "merged" | "closed" | "new-review" | "pending" | "unknown";
  detail: string;
}

interface PrAt {
  repo: string;
  pr: number;
  headSha: string;
}

type Row = Awaited<ReturnType<ShepherdSource["list"]>>[number];

const short = (sha: string): string => sha.slice(0, 7);

function openState(ref: string, at: PrAt, head: string, row: Row | undefined): NextState {
  if (head !== at.headSha) return { state: "new-review", detail: `${ref} moved to ${short(head)}, so its run reviews the new head` };
  if (row?.phase === "review") return { state: "new-review", detail: `${ref} is in a new review round at ${short(head)}` };
  if (row === undefined) return { state: "pending", detail: `${ref} is open at ${short(head)}; no active Shepherd run is watching it` };
  return { state: "pending", detail: `${ref} is still ${row.phase} at ${short(head)}: ${row.nextAction}` };
}

/** Never rejects: a read that fails is reported as `unknown`, since the tap itself already landed. */
export async function nextStateOf(shepherd: ShepherdSource, at: PrAt): Promise<NextState> {
  const ref = `${at.repo}#${at.pr}`;
  try {
    const [preview, rows] = await Promise.all([shepherd.previewOp({ kind: "merge-at-head", ...at }), shepherd.list("active")]);
    const { pr } = preview;
    if (pr === undefined) return { state: "unknown", detail: `the factory read no PR back for ${ref}` };
    if (pr.state === "merged") return { state: "merged", detail: `${ref} merged${pr.mergeSha === undefined ? "" : ` as ${short(pr.mergeSha)}`}` };
    if (pr.state === "closed" || pr.head === undefined) return { state: "closed", detail: `${ref} is closed without a merge` };
    const row = rows.find((each) => each.repo.toLowerCase() === at.repo.toLowerCase() && each.pr === at.pr);
    return openState(ref, at, pr.head, row);
  } catch (error) {
    return { state: "unknown", detail: `the next state of ${ref} could not be read: ${error instanceof Error ? error.message : String(error)}` };
  }
}
