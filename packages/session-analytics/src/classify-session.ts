export type SessionClass = "agent_spawned" | "human_interactive" | "headless_sdk" | "other_headless";

/** Human sessions only. A coordinator drives other agents; an adhoc session does not. */
export type HumanRole = "coordinator" | "adhoc";

/** The agent-chat spawn record for a session, as the origin resolver returns it. */
export interface SessionOrigin {
  depth: number;
  parentName?: string | null;
  /** "adopted" and "inherited" mark a pane the human took over, not a spawned worker. */
  originKind?: string | null;
  profile?: string | null;
}

export interface SessionFacts {
  /** The harness entrypoint. Agent-chat workers and `-p` miners both report "sdk-cli". */
  startType?: string | null;
  origin?: SessionOrigin | null;
  firstUserText?: string | null;
  humanTurnCount?: number;
  inboundKinds?: readonly string[];
  signalKinds?: readonly string[];
}

export interface SessionClassification {
  sessionClass: SessionClass;
  reason: string;
  humanRole: HumanRole | null;
}

const COORDINATOR_SIGNALS = new Set(["agent_spawn", "chat_send"]);

/**
 * Rule order matters. The origin row wins over `startType` because agent-chat workers
 * run `claude -p` and so report "sdk-cli" exactly like a headless miner does.
 */
export function classifySession(facts: SessionFacts): SessionClassification {
  const [sessionClass, reason] = classOf(facts);
  const humanRole = sessionClass === "human_interactive" ? humanRoleOf(facts) : null;
  return { sessionClass, reason, humanRole };
}

function classOf(facts: SessionFacts): [SessionClass, string] {
  const origin = facts.origin;
  if (origin) {
    if (isAdoptedPane(origin)) return ["human_interactive", "origin depth 0, human or adopted parent"];
    return ["agent_spawned", "origin depth >= 1"];
  }
  if (facts.startType === "sdk-cli") return ["headless_sdk", "start_type sdk-cli with no origin row"];
  if (isProgrammaticPrompt(facts)) return ["other_headless", "content-block prompt with <= 2 human turns"];
  return ["human_interactive", "no origin row, no headless marker"];
}

function isAdoptedPane(origin: SessionOrigin): boolean {
  if (origin.depth !== 0) return false;
  if (origin.parentName === "human") return true;
  if (origin.originKind === "adopted" || origin.originKind === "inherited") return true;
  return !origin.profile;
}

/** Cron and RemoteTrigger daemons inject a structured content block, never typed prose. */
function isProgrammaticPrompt(facts: SessionFacts): boolean {
  const text = (facts.firstUserText ?? "").trimStart();
  return text.startsWith("[{") && (facts.humanTurnCount ?? 0) <= 2;
}

function humanRoleOf(facts: SessionFacts): HumanRole {
  if (facts.inboundKinds?.includes("channel_message")) return "coordinator";
  if (facts.signalKinds?.some((kind) => COORDINATOR_SIGNALS.has(kind))) return "coordinator";
  return "adhoc";
}
