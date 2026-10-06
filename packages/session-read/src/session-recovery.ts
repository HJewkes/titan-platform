/**
 * Facts-only recovery of a session that ended with no wrap (reboot, crash, closed window).
 * Everything here is read from the transcript: no model call, no network, no write.
 */

import path from "node:path";
import type { ConversationIdentity } from "@titan-design/agent-protocol";
import { commandHeads } from "./command-heads.js";
import { findInjectedMarker } from "./injected-markers.js";
import type { NormalizedSessionObservation, NormalizedToolCallObservation, SessionSourceDescriptor } from "./normalized.js";
import { readRecentSessionTurns } from "./recent-session-turns.js";
import type { RecentSessionTurn } from "./recent-types.js";
import { oneLine, truncate } from "./recent-values.js";
import { readSessionObservations } from "./session-observations.js";
import { SessionSummaryAccumulator } from "./session-summary.js";
import { toolFamily } from "./tool-family.js";

export const RECOVERY_MESSAGE_CHARS = 2000;
export const RECOVERY_FIRST_LINE_CHARS = 200;
export const RECOVERY_OWNER_MESSAGES = 5;
export const RECOVERY_LIST_CAP = 50;
/** How far back the owner and assistant messages are looked for; earlier ones are outside the window. */
export const RECOVERY_TAIL_BYTES = 4 * 1024 * 1024;
const RECOVERY_TAIL_TURNS = 400;

export interface CappedList<T> {
  items: T[];
  /** Entries left out because the list reached its cap. */
  dropped: number;
}

export interface RecoveredCommand {
  /** A `commandHeads` head (`git push`, `active-work task done`); argument text never appears. */
  head: string;
  count: number;
  lastAt: string | null;
}

export interface RecoveredMessageTarget {
  /** The recipient of a chat_send, or the name given to agent_spawn; null when the call named none. */
  target: string | null;
  firstLine: string;
  at: string | null;
}

export interface RecoveredMessage {
  text: string;
  at: string | null;
}

export interface SessionRecovery {
  conversation: ConversationIdentity;
  startedAt: string | null;
  endedAt: string | null;
  /** The name of the session's last chat_register call. */
  agentName: string | null;
  /** Paths relative to `root`, in first-write order; the cap keeps the first ones. */
  filesWritten: CappedList<string>;
  activeWorkCalls: CappedList<RecoveredCommand>;
  gitCommands: CappedList<RecoveredCommand>;
  /** In call order; the cap keeps the most recent. */
  chatSends: CappedList<RecoveredMessageTarget>;
  agentSpawns: CappedList<RecoveredMessageTarget>;
  /** The last owner-typed messages, oldest first; tool results and injected blocks are excluded. */
  ownerMessages: RecoveredMessage[];
  lastAssistantMessage: RecoveredMessage | null;
  /** The message window began after the transcript's start, so older owner messages were not read. */
  messageWindowTruncated: boolean;
}

export interface RecoverSessionOptions {
  /** Only files written under this absolute path are reported. */
  root: string;
}

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const ACTIVE_WORK = /^active-work(?: |$)/;
const GIT_OR_GH = /^(?:git|gh)(?: |$)/;

export async function recoverSession(source: SessionSourceDescriptor, options: RecoverSessionOptions): Promise<SessionRecovery> {
  const summary = new SessionSummaryAccumulator(source.conversation);
  const facts = new RecoveryFacts(options.root);
  for await (const observation of readSessionObservations(source)) {
    summary.add(observation);
    facts.add(observation);
  }
  const span = summary.result().observationSpan;
  const recent = await readRecentSessionTurns(source, { maxBytes: RECOVERY_TAIL_BYTES,
    maxTurns: RECOVERY_TAIL_TURNS, maxCharsPerTurn: RECOVERY_MESSAGE_CHARS, projection: "text" });
  const messages = recent.turns.filter(turn => turn.sidechain !== true);
  const owner = messages.filter(isOwnerTurn).slice(-RECOVERY_OWNER_MESSAGES).map(toMessage);
  const assistant = messages.filter(turn => turn.role === "assistant").at(-1);
  return { conversation: source.conversation, startedAt: span.firstAt, endedAt: span.lastAt, ...facts.result(),
    ownerMessages: owner, lastAssistantMessage: assistant ? toMessage(assistant) : null,
    messageWindowTruncated: recent.truncatedBefore || recent.truncatedTurns };
}

function isOwnerTurn(turn: RecentSessionTurn): boolean {
  return turn.role === "user" && findInjectedMarker(turn.text) === null;
}

function toMessage(turn: RecentSessionTurn): RecoveredMessage {
  return { text: turn.text, at: turn.timestamp };
}

/** A storage-free fold of the tool calls a recovery record reports. */
export class RecoveryFacts {
  private agentName: string | null = null;
  private readonly files = new Set<string>();
  private readonly activeWork = new Map<string, RecoveredCommand>();
  private readonly git = new Map<string, RecoveredCommand>();
  private readonly chatSends: RecoveredMessageTarget[] = [];
  private readonly agentSpawns: RecoveredMessageTarget[] = [];

  constructor(private readonly root: string) {
    if (!path.isAbsolute(root)) throw new TypeError("recovery root must be an absolute path");
  }

  add(observation: NormalizedSessionObservation): void {
    if (observation.historyOrigin || observation.kind !== "tool_call") return;
    const input = asRecord(observation.input);
    if (WRITE_TOOLS.has(observation.name)) this.addFile(field(input, "file_path") ?? field(input, "notebook_path"));
    else if (observation.name === "Bash") this.addCommand(field(input, "command"), observation.timestamp);
    else if (toolFamily(observation.name).family === "mcp_agentchat") this.addChat(observation, input);
  }

  result(): Pick<SessionRecovery, "agentName" | "filesWritten" | "activeWorkCalls" | "gitCommands" | "chatSends" | "agentSpawns"> {
    return { agentName: this.agentName, filesWritten: capped([...this.files]),
      activeWorkCalls: capped([...this.activeWork.values()].map(entry => ({ ...entry }))),
      gitCommands: capped([...this.git.values()].map(entry => ({ ...entry }))),
      chatSends: latest(this.chatSends), agentSpawns: latest(this.agentSpawns) };
  }

  private addFile(filePath: string | null): void {
    if (!filePath || !path.isAbsolute(filePath)) return;
    const relative = path.relative(this.root, filePath);
    const outside = relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
    if (relative && !outside) this.files.add(relative);
  }

  private addCommand(command: string | null, at: string | null): void {
    if (!command) return;
    for (const head of commandHeads(command)) {
      if (ACTIVE_WORK.test(head)) count(this.activeWork, head, at);
      else if (GIT_OR_GH.test(head)) count(this.git, head, at);
    }
  }

  private addChat(observation: NormalizedToolCallObservation, input: Record<string, unknown> | null): void {
    const verb = observation.name.slice(observation.name.lastIndexOf("__") + 2);
    const at = observation.timestamp;
    if (verb === "chat_register") this.agentName = field(input, "name") ?? this.agentName;
    if (verb === "chat_send") {
      const text = field(input, "text") ?? field(input, "message");
      this.chatSends.push({ target: field(input, "to") ?? field(input, "to_tag"), firstLine: firstLine(text), at });
    }
    if (verb === "agent_spawn") this.agentSpawns.push({ target: field(input, "name"), firstLine: firstLine(field(input, "brief")), at });
  }
}

function count(heads: Map<string, RecoveredCommand>, head: string, at: string | null): void {
  const entry = heads.get(head) ?? { head, count: 0, lastAt: null };
  entry.count++;
  entry.lastAt = at ?? entry.lastAt;
  heads.set(head, entry);
}

function capped<T>(items: T[]): CappedList<T> {
  return { items: items.slice(0, RECOVERY_LIST_CAP), dropped: Math.max(0, items.length - RECOVERY_LIST_CAP) };
}

/** A session's last messages say most about where it stopped, so the cap drops the oldest. */
function latest<T>(items: readonly T[]): CappedList<T> {
  return { items: items.slice(-RECOVERY_LIST_CAP), dropped: Math.max(0, items.length - RECOVERY_LIST_CAP) };
}

function firstLine(text: string | null): string {
  const line = text?.split("\n").find(candidate => candidate.trim()) ?? "";
  return truncate(oneLine(line), RECOVERY_FIRST_LINE_CHARS);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function field(input: Record<string, unknown> | null, name: string): string | null {
  const value = input?.[name];
  return typeof value === "string" && value.trim() ? value : null;
}
