/**
 * A g10 hold's release from the inbox. The owner may release a `g10-review` or `g10-adversary` hold whether or not a reviewer
 * MERGE is on record, as they may at the terminal, so the verdicts are a signal in the read-back, never a gate: it lists every
 * verdict Shepherd's timeline recorded, counts the MERGEs at the live head, and when they fall short says so in the effect and
 * labels the confirm "Release without a MERGE". Shepherd's `shepherd.release` stays the authority on the head and the hold.
 */
import { z } from "zod";
import { EXIT } from "@titan-design/registry";
import type { InboxItem } from "./inbox-view.js";
import type { ActionOutcome, Unreachable } from "./owner-action.js";
import type { ShepherdSource } from "./shepherd.js";

/** MERGEs at the head each g10 class releases on: an opus reviewer's for `g10-review`, a correctness and an adversary reviewer's for `g10-adversary`. */
const MERGES_NEEDED: Readonly<Record<string, number>> = { "g10-review": 1, "g10-adversary": 2 };

export type G10Action = Extract<InboxItem["action"], { kind: "hold-release" }>;

export const isG10Release = (action: InboxItem["action"]): action is G10Action => action.kind === "hold-release" && Object.hasOwn(MERGES_NEEDED, action.holdClass);

/** The MERGEs a hold class releases on, or undefined for a class no reviewer verdict releases. */
export const mergesNeededFor = (holdClass: string): number | undefined => (Object.hasOwn(MERGES_NEEDED, holdClass) ? MERGES_NEEDED[holdClass] : undefined);

export interface RecordedVerdict {
  stepId: string;
  reviewer: string | null;
  verdict: "MERGE" | "FIX_FIRST";
  headSha: string | null;
  atHead: boolean;
}

export interface G10Signal {
  verdicts: RecordedVerdict[];
  mergesAtHead: number;
  mergesNeeded: number;
  confirmLabel: string;
  effect: string;
}

/** Pinned to the timeline's `verdict` entry; a `none` verdict, or any other entry, is no verdict to show. */
const verdictEntry = z.looseObject({ kind: z.literal("verdict"), stepId: z.string(), verdict: z.enum(["MERGE", "FIX_FIRST"]), headSha: z.string().nullable(), reviewer: z.string().nullable() });

export function recordedVerdicts(entries: readonly unknown[], head: string): RecordedVerdict[] {
  return entries.flatMap((entry) => {
    const parsed = verdictEntry.safeParse(entry);
    if (!parsed.success) return [];
    const { stepId, reviewer, verdict, headSha } = parsed.data;
    return [{ stepId, reviewer, verdict, headSha, atHead: headSha === head }];
  });
}

/** Two MERGEs count as two only from two reviewers; one whose reviewer is not named counts once for its own step. */
export const mergesAt = (verdicts: readonly RecordedVerdict[]): number => new Set(verdicts.filter((each) => each.atHead && each.verdict === "MERGE").map((each) => each.reviewer ?? `step:${each.stepId}`)).size;

function confirmLabelOf(merges: number, needed: number): string {
  if (merges >= needed) return "Release hold";
  return merges === 0 ? "Release without a MERGE" : "Release without both MERGEs";
}

function shortfallOf(merges: number, needed: number): string {
  if (merges >= needed) return needed === 1 ? "the reviewer's MERGE stands at this head" : "both MERGEs stand at this head";
  return merges === 0 ? "no reviewer MERGE is recorded at this head" : `only ${merges} of the ${needed} MERGEs it needs is recorded at this head`;
}

export function g10Signal(entries: readonly unknown[], action: G10Action): G10Signal {
  const verdicts = recordedVerdicts(entries, action.headSha);
  const mergesNeeded = MERGES_NEEDED[action.holdClass]!;
  const mergesAtHead = mergesAt(verdicts);
  const effect = `Release the ${action.holdClass} hold on ${action.repo}#${action.pr} at ${action.headSha.slice(0, 7)}; ${shortfallOf(mergesAtHead, mergesNeeded)}`;
  return { verdicts, mergesAtHead, mergesNeeded, confirmLabel: confirmLabelOf(mergesAtHead, mergesNeeded), effect };
}

const ACTOR = "owner-remote:titan-console";
const MOVED = /is at ([0-9a-f]{40}), not [0-9a-f]{40}/;
const RETRYABLE: ReadonlySet<unknown> = new Set([EXIT.UNAVAILABLE, EXIT.TEMPFAIL, EXIT.SOFTWARE, undefined]);

/** Shepherd refuses a moved head with the head it read in the message; a down or still-recording factory may answer on a retry. */
function releaseRefusal(error: unknown): ActionOutcome | Unreachable {
  const detail = error instanceof Error ? error.message : String(error);
  const moved = MOVED.exec(detail);
  if (moved !== null) return { status: "moved", currentHead: moved[1]! };
  const code = error instanceof Error && "code" in error ? error.code : undefined;
  return RETRYABLE.has(code) ? { status: "unreachable", detail } : { status: "refused", reason: "shepherd", detail };
}

/** Never rejects. The release event's actor names the console and the action record it carried out. */
export async function releaseG10(shepherd: ShepherdSource, action: G10Action, actionId: string): Promise<ActionOutcome | Unreachable> {
  try {
    const after = await shepherd.release({ repo: action.repo, pr: action.pr, head: action.headSha, holdClass: action.holdClass, actor: `${ACTOR} action:${actionId}` });
    return { status: "released", runId: after.runId, stillHeld: after.held?.reason ?? null };
  } catch (error) {
    return releaseRefusal(error);
  }
}
