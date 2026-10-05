import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { BrokerUnavailableError, DispatchError, type AgentRow } from "@titan-design/agent-dispatch";
import { agentChatAgents } from "./agents.js";
import { agentChatRoster, type RosterReader } from "./roster.js";
import { ReviewerBrokerBusy, ReviewerBrokerDown, type ReviewerAgent, type ReviewerDispatch } from "./review.js";
import { toPresence } from "./presence.js";
import { ReviewerMachineHold } from "./review-wait.js";

export const DEFAULT_ROSTER_TIMEOUT_MS = 10_000;
export const DEFAULT_SPAWN_TIMEOUT_MS = 30_000;
const HOME_PREFIXES = ["~/", "$HOME/", "${HOME}/"];

/** A roster row plus its transcript fields; `predecessor` and `fillTokens` stay absent, so no such agent is resumed, and `lastWrittenAt` comes from the transcript file. */
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
  /** The serve process's shared roster reader; absent means one of this dispatch's own. */
  roster?: RosterReader;
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

/** Named so a step reason, which carries only an error's class, still says the checkout was the problem; the message holds a local path. */
class ReviewCheckoutUnusable extends Error {
  override readonly name = "ReviewCheckoutUnusable";
}

/** Throws unless the repo has an absolute checkout path that is a directory, so a reviewer never starts in the factory's own cwd. */
function checkoutDir(repo: string, cwdFor: AgentChatReviewerDispatchOptions["cwdFor"]): string {
  const resolved = resolveCheckout(repo, cwdFor(repo));
  if ("problem" in resolved) throw new ReviewCheckoutUnusable(resolved.problem);
  return resolved.dir;
}

/** The trailer agent-chat prints after a coded refusal; only `retryable: true` marks one that clears with time. */
const RETRYABLE_TRAILER = /\n\s*code: (\S+) retryable: true$/;
/** An agent-chat older than the trailer refuses by its machine guard with no code, so the reason prefix is the marker. */
const MACHINE_GUARD = /(?:^|: )(machine guard: .*)$/s;
const REFUSAL_PREFIX = /^agent-chat refused the \w+: (?:Not spawned: )?/;

/** The code the broker refuses with while the machine stop holds (CC-487). */
const MACHINE_HOLD_CODE = "machine_hold";

/** The reason a refusal that clears with time gives, without the CLI's prefixes or trailer, and its code; undefined for any other refusal. */
function busyReason(message: string): { reason: string; code?: string } | undefined {
  const text = message.trim();
  const trailer = RETRYABLE_TRAILER.exec(text);
  const reason = trailer ? text.slice(0, trailer.index) : text;
  const code = trailer?.[1];
  const guard = MACHINE_GUARD.exec(reason)?.[1];
  if (guard !== undefined) return { reason: guard, code };
  return trailer ? { reason: `${reason.replace(REFUSAL_PREFIX, "")} (${code})`, code } : undefined;
}

/** Only an unreachable broker or a refusal that clears with time is safe to ask again; every other failure, a timeout included, stays a refusal. */
async function askBroker<T>(ask: () => T | Promise<T>): Promise<T> {
  try {
    return await ask();
  } catch (error) {
    if (error instanceof BrokerUnavailableError) throw new ReviewerBrokerDown(error.message, { cause: error });
    const busy = error instanceof DispatchError ? busyReason(error.message) : undefined;
    if (busy?.code === MACHINE_HOLD_CODE) throw new ReviewerMachineHold(busy.reason, { cause: error });
    if (busy !== undefined) throw new ReviewerBrokerBusy(busy.reason, { cause: error });
    throw error;
  }
}

/** The broker reports no session times, so a resume shows as the write it makes to the transcript; absent when there is no file. */
function lastWrittenAt(transcriptPath: string | null): { lastWrittenAt?: number } {
  try {
    const written = transcriptPath === null ? undefined : statSync(transcriptPath, { throwIfNoEntry: false })?.mtimeMs;
    return written === undefined ? {} : { lastWrittenAt: Math.floor(written) };
  } catch {
    return {};
  }
}

/** agent-dispatch checks only a row's required strings, so the optional fields are narrowed here. */
function rosterRow(row: AgentRow): ReviewerRosterRow {
  const transcriptPath = typeof row.transcriptPath === "string" ? row.transcriptPath : null;
  return {
    name: row.name,
    agentId: row.agentId,
    sessionId: row.sessionId,
    presence: toPresence(row.presence),
    spawnedBy: typeof row.spawnedBy === "string" ? row.spawnedBy : null,
    transcriptPath,
    transcriptExists: row.transcriptExists === true,
    ...lastWrittenAt(transcriptPath),
  };
}

/** Shepherd's reviewer port over the `agent-chat` CLI: the brief of a spawn travels on stdin and the reviewer starts in the repo's checkout. */
export function agentChatReviewerDispatch(options: AgentChatReviewerDispatchOptions): AgentChatReviewerDispatch {
  const { agentChatBin, profile, cwdFor, configDir } = options;
  const roster = options.roster ?? agentChatRoster(agentChatBin, { timeoutMs: options.rosterTimeoutMs ?? DEFAULT_ROSTER_TIMEOUT_MS });
  const spawnTimeoutMs = options.spawnTimeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS;
  const agents = agentChatAgents(agentChatBin, { configDir, timeoutMs: spawnTimeoutMs, roster });
  return {
    roster: () => askBroker(async () => (await roster.rows()).map(rosterRow)),
    spawn: (name, brief, target) => askBroker(() => agents.spawn({ name, profile, brief, cwd: checkoutDir(target.repo, cwdFor) })),
    resume: (name, brief) => askBroker(() => agents.resume(name, brief)),
  };
}
