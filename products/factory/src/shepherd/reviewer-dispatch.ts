import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { BrokerUnavailableError, dispatchToAgentChat, listAgents, resumeAgent, type AgentRow } from "@titan-design/agent-dispatch";
import { ReviewerBrokerDown, type ReviewerAgent, type ReviewerDispatch } from "./review.js";

export const DEFAULT_ROSTER_TIMEOUT_MS = 10_000;
export const DEFAULT_SPAWN_TIMEOUT_MS = 30_000;
const HOME_PREFIXES = ["~/", "$HOME/", "${HOME}/"];

/** A roster row plus the transcript fields the verdict reader needs; `predecessor` and `fillTokens` stay absent, so no such agent is resumed. */
export interface ReviewerRosterRow extends ReviewerAgent {
  transcriptPath: string | null;
  transcriptExists: boolean;
}

export interface AgentChatReviewerDispatchOptions {
  /** Absolute path of the `agent-chat` executable. */
  agentChatBin: string;
  /** The one agent-chat profile a reviewer is spawned with; the profile is the reviewer's tool grant. */
  profile: string;
  /** The checkout of `repo` on this machine, where its reviewer starts; undefined when there is none. */
  cwdFor: (repo: string) => string | undefined;
  /** Claude config directory for the reviewer; absent means agent-chat's default. */
  configDir?: string;
  rosterTimeoutMs?: number;
  spawnTimeoutMs?: number;
}

export interface AgentChatReviewerDispatch extends ReviewerDispatch {
  roster(): Promise<readonly ReviewerRosterRow[]>;
}

/** Expands a leading home prefix only, without a shell; every other character stays literal. */
export function expandHome(path: string, home: string): string {
  const prefix = HOME_PREFIXES.find((candidate) => path.startsWith(candidate));
  return prefix === undefined ? path : join(home, path.slice(prefix.length));
}

/** The repo's configured checkout, home-expanded, when it is an absolute directory; otherwise why it cannot be started in. */
export function resolveCheckout(repo: string, configured: string | undefined, home: string = homedir()): { dir: string } | { problem: string } {
  if (configured === undefined || configured === "") return { problem: `no checkout path is configured for ${repo}` };
  const dir = expandHome(configured, home);
  if (!isAbsolute(dir)) return { problem: `the checkout path for ${repo} is not absolute: ${configured}` };
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return { problem: `the checkout path for ${repo} is not a directory: ${dir}` };
  return { dir };
}

/** Throws unless the repo has an absolute checkout path that is a directory, so a reviewer never starts in the factory's own cwd. */
function checkoutDir(repo: string, cwdFor: AgentChatReviewerDispatchOptions["cwdFor"]): string {
  const resolved = resolveCheckout(repo, cwdFor(repo));
  if ("problem" in resolved) throw new Error(resolved.problem);
  return resolved.dir;
}

/** Only an unreachable broker is safe to ask again; every other failure, a timeout included, stays a refusal. */
async function askBroker<T>(ask: () => T): Promise<T> {
  try {
    return ask();
  } catch (error) {
    if (error instanceof BrokerUnavailableError) throw new ReviewerBrokerDown(error.message, { cause: error });
    throw error;
  }
}

/** agent-dispatch checks only a row's required strings, so the optional fields are narrowed here. */
function rosterRow(row: AgentRow): ReviewerRosterRow {
  return {
    name: row.name,
    agentId: row.agentId,
    sessionId: row.sessionId,
    presence: row.presence,
    spawnedBy: typeof row.spawnedBy === "string" ? row.spawnedBy : null,
    transcriptPath: typeof row.transcriptPath === "string" ? row.transcriptPath : null,
    transcriptExists: row.transcriptExists === true,
  };
}

/** Shepherd's reviewer port over the `agent-chat` CLI: the brief of a spawn travels on stdin and the reviewer starts in the repo's checkout. */
export function agentChatReviewerDispatch(options: AgentChatReviewerDispatchOptions): AgentChatReviewerDispatch {
  const { agentChatBin, profile, cwdFor, configDir } = options;
  const rosterTimeoutMs = options.rosterTimeoutMs ?? DEFAULT_ROSTER_TIMEOUT_MS;
  const spawnTimeoutMs = options.spawnTimeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS;
  return {
    roster: () => askBroker(() => listAgents(agentChatBin, rosterTimeoutMs).map(rosterRow)),
    spawn: (name, brief, target) =>
      askBroker(() => {
        const cwd = checkoutDir(target.repo, cwdFor);
        const request = { agentChatBinPath: agentChatBin, peerName: name, profile, brief, cwd, ...(configDir !== undefined && { configDir }) };
        dispatchToAgentChat(request, spawnTimeoutMs, [profile]);
      }),
    resume: (name, brief) => askBroker(() => void resumeAgent(agentChatBin, name, brief, spawnTimeoutMs)),
  };
}
