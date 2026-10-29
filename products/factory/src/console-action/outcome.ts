import type { GitHubPort } from "@titan-design/github";
import type { GateResolver } from "@titan-design/hitl";

export type Status = 200 | 400 | 403 | 409 | 410 | 413 | 422 | 500 | 503;

type RefusalCode = "record" | "record-unreadable" | "class" | "mismatch" | "resolver" | "payload" | "github-unreadable" | "agent-chat-unavailable" | "deploying";
export type Outcome =
  | { outcome: "resolved"; gateId: string }
  | { outcome: "already"; gateId: string }
  | { outcome: "released"; runId: string; stillHeld: string | null }
  | { outcome: "already"; runId: string }
  /** A merge-at-head tap started (or found) the land run its standing answer waits on. */
  | { outcome: "accepted"; runId: string }
  /** A merge-at-head tap that waits out a g10 hold left the owner's approval standing on the PR's Shepherd run. */
  | { outcome: "approved"; runId: string }
  | { outcome: "retired"; name: string; caveats: string[] }
  | { outcome: "already"; name: string }
  /** A close-pr tap closed the PR at the confirmed head, leaving its branch in place. */
  | { outcome: "pr-closed"; closedHead: string }
  | { outcome: "already"; closedHead: string }
  /** A deploy-pause-clear tap removed the failure pause it named; a manual hold, never cleared by the op, may still stand. */
  | { outcome: "pause-cleared"; clearedPause: string; stillHeld: string | null }
  | { outcome: "already"; clearedPause: string }
  /** A plan-approval tap recorded the owner's plan-time answer; `claimedRun` is the one live run of the task it bound to, or null until a registration claims it. */
  | { outcome: "plan-approved"; task: string; gate: string; claimedRun: string | null }
  | { outcome: "already"; task: string }
  | { outcome: "moved"; currentHead: string | undefined }
  /** The name now belongs to a different agent than the one the owner confirmed. */
  | { outcome: "moved"; currentAgentId: string }
  /** A newer failure pause than the one the record names stands, and stays. */
  | { outcome: "moved"; currentPause: string }
  | { outcome: "gone"; reason: string }
  | { outcome: "refused"; reason: RefusalCode; detail: string };

interface PrAt {
  repo: string;
  pr: number;
  headSha: string;
}

export const refused = (reason: RefusalCode, detail: string): Outcome => ({ outcome: "refused", reason, detail });

/** The console's one identity in every resolve and release it asks for; the record never chooses it. */
export const consoleResolver = (confirmEvent: string): GateResolver => ({ class: "owner-remote", id: "titan-console", channel: "console:inbox", confirmEvent });

/** GitHub's own head, read fresh: the gate prompt is Shepherd's earlier read and may be behind the PR. */
export async function githubOutcome(port: GitHubPort, { repo, pr, headSha }: PrAt): Promise<Outcome | undefined> {
  try {
    const pull = await port.getPr(repo, pr);
    if (pull.state !== "open") return { outcome: "gone", reason: `${repo}#${pr} is ${pull.merged ? "merged" : "closed"} on GitHub` };
    return pull.headSha === headSha ? undefined : { outcome: "moved", currentHead: pull.headSha };
  } catch (error) {
    return refused("github-unreadable", `${repo}#${pr} could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function statusOf(outcome: Outcome): Status {
  switch (outcome.outcome) {
    case "resolved":
    case "released":
    case "accepted":
    case "approved":
    case "retired":
    case "pr-closed":
    case "pause-cleared":
    case "plan-approved":
    case "already":
      return 200;
    case "moved":
      return 409;
    case "gone":
      return 410;
    case "refused":
      return refusalStatus(outcome.reason);
  }
}

/** A running deployer is a conflict that passes, so a later tap may land; a record or class fault never will. */
function refusalStatus(reason: RefusalCode): Status {
  if (reason === "github-unreadable" || reason === "agent-chat-unavailable") return 503;
  if (reason === "deploying") return 409;
  return reason === "class" || reason === "resolver" ? 403 : 422;
}
