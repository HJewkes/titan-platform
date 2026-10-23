import type { GitHubPort } from "@titan-design/github";
import type { GateResolver } from "@titan-design/hitl";

export type Status = 200 | 400 | 403 | 409 | 410 | 413 | 422 | 500 | 503;

type RefusalCode = "record" | "record-unreadable" | "class" | "mismatch" | "resolver" | "payload" | "github-unreadable" | "agent-chat-unavailable";
export type Outcome =
  | { outcome: "resolved"; gateId: string }
  | { outcome: "already"; gateId: string }
  | { outcome: "released"; runId: string; stillHeld: string | null }
  | { outcome: "already"; runId: string }
  /** A merge-at-head tap started (or found) the land run its standing answer waits on. */
  | { outcome: "accepted"; runId: string }
  | { outcome: "retired"; name: string; caveats: string[] }
  | { outcome: "already"; name: string }
  | { outcome: "moved"; currentHead: string | undefined }
  /** The name now belongs to a different agent than the one the owner confirmed. */
  | { outcome: "moved"; currentAgentId: string }
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
    case "retired":
    case "already":
      return 200;
    case "moved":
      return 409;
    case "gone":
      return 410;
    case "refused":
      return outcome.reason === "github-unreadable" || outcome.reason === "agent-chat-unavailable" ? 503 : outcome.reason === "class" || outcome.reason === "resolver" ? 403 : 422;
  }
}
