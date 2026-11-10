import type { ActionCall } from "./turn-action.js";

/** What the previous request in the same chain did last, before the gap that forced a rebuild. */
export const GAP_CAUSES = ["ci-wait", "other-bash", "end-of-turn"] as const;
export type GapCause = (typeof GAP_CAUSES)[number];

/** Command heads of the `gh pr checks` / `gh run` / `ci-wait` family, as session-read reduces them. */
const CI_WAIT_HEAD = /^(?:ci-wait|gh pr checks|gh run)\b/;

/**
 * The gap's cause from the tool calls the previous request issued. Only its last call counts, since
 * that is what the session was waiting on. A request with no calls ended the turn; a non-Bash last call
 * also reads as `end-of-turn`, so no gap is claimed as a CI wait or Bash wait without evidence.
 */
export function gapCauseOf(calls: readonly ActionCall[] | undefined): GapCause {
  const last = calls?.[calls.length - 1];
  if (last?.tool !== "Bash") return "end-of-turn";
  return (last.heads ?? []).some((head) => CI_WAIT_HEAD.test(head)) ? "ci-wait" : "other-bash";
}
