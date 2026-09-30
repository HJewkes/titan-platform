import type { SignalKind } from "./audit-events.js";
import { IGNORED_PATH, commandHeads, parseTaskIntents, type GitIntent } from "./bash-parse.js";
import type { LineContext, LineReader } from "./line-reader.js";
import { toRepoRelative } from "./refs.js";
import { str, type Json } from "./text.js";
import { toolFamily } from "./tool-family.js";

/** Provisional vocabulary: every signal is read from one `tool_use` block, never across lines. */
export interface AuditSignal {
  readonly signal: SignalKind;
  /** A short structural token (status word, PR number, task id, path), never prose. */
  readonly detail: string | null;
}

const STATUS = /\bStatus:\**\s*(DONE_WITH_CONCERNS|DONE|BLOCKED|NEEDS_[A-Z_]+)\b/;
const WRAP = /\b(?:active-work|aw)\s+(?:session\s+)?(wrap|record)\b/;
const PR_CREATE = /\bgh\s+pr\s+create\b/;
const ACTIVE_WORK_SKILL = /(^|:)active-work$/;
const MARKDOWN = /\.md$/i;
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const DETAIL_CAP = 256;

/** Signals any tool call can carry; Bash command verbs are read separately by `bashSignals`. */
export function toolUseSignals(name: string, input: Json | null): AuditSignal[] {
  return [...fileSignals(name, input), ...actSignals(name, input)];
}

function actSignals(name: string, input: Json | null): AuditSignal[] {
  if (name === "Write") return markdownSignal(str(input, "file_path"));
  if (name === "Skill") return ACTIVE_WORK_SKILL.test(str(input, "skill") ?? "") ? [{ signal: "task_wrap", detail: "skill" }] : [];
  if (name === "Agent" || name === "Task") return [{ signal: "agent_spawn", detail: str(input, "subagent_type") }];
  if (toolFamily(name).family !== "mcp_agentchat") return [];
  const verb = name.slice(name.lastIndexOf("__") + 2);
  if (verb === "agent_spawn") return [{ signal: "agent_spawn", detail: str(input, "name") }];
  if (verb === "chat_send") return chatSendSignals(input);
  return [];
}

/** `git` is the caller's already-parsed intent, so commit and push agree with the session counters. */
export function bashSignals(command: string, git: GitIntent | null): AuditSignal[] {
  const signals: AuditSignal[] = [];
  if (git?.commit) signals.push({ signal: "commit", detail: null });
  if (git?.push) signals.push({ signal: "push", detail: null });
  if (PR_CREATE.test(command)) signals.push({ signal: "pr_create", detail: null });
  if (git?.mergedPr) signals.push({ signal: "pr_merge", detail: String(git.mergedPr) });
  const wrap = WRAP.exec(command)?.[1];
  if (wrap) signals.push({ signal: "task_wrap", detail: wrap });
  for (const task of parseTaskIntents(command)) {
    if (task.status === "done") signals.push({ signal: "task_done", detail: task.taskId });
  }
  const heads = commandHeads(command);
  if (heads.length > 0) signals.push({ signal: "command_heads", detail: joinCapped(heads) });
  return signals;
}

export function emitSignals(reader: LineReader, ctx: LineContext, block: Json, blockIndex: number, signals: AuditSignal[]): void {
  const toolUseId = str(block, "id");
  for (const { signal, detail } of signals) reader.emit({ ...reader.base(ctx), kind: "signal", blockIndex, signal, detail, toolUseId });
}

/** Whole heads only, so a consumer's pattern never matches a truncated head. */
function joinCapped(heads: readonly string[]): string {
  let joined = "";
  for (const head of heads) {
    const next = joined ? `${joined};${head}` : head;
    if (next.length > DETAIL_CAP) break;
    joined = next;
  }
  return joined || capCodePoints(heads[0] ?? "");
}

/** Cuts on code points so a surrogate pair is never split. */
function capCodePoints(text: string): string {
  let capped = "";
  for (const char of text) {
    if (capped.length + char.length > DETAIL_CAP) break;
    capped += char;
  }
  return capped;
}

function fileSignals(name: string, input: Json | null): AuditSignal[] {
  const signal = name === "Read" ? "file_read" : WRITE_TOOLS.has(name) ? "file_write" : null;
  const filePath = str(input, "file_path") ?? str(input, "notebook_path");
  if (!signal || !filePath || IGNORED_PATH.test(filePath)) return [];
  return [{ signal, detail: toRepoRelative(filePath).path }];
}

function markdownSignal(filePath: string | null): AuditSignal[] {
  if (!filePath || !MARKDOWN.test(filePath)) return [];
  return [{ signal: "doc_written", detail: toRepoRelative(filePath).path }];
}

function chatSendSignals(input: Json | null): AuditSignal[] {
  const signals: AuditSignal[] = [{ signal: "chat_send", detail: str(input, "to") ?? str(input, "to_tag") }];
  const status = STATUS.exec(str(input, "text") ?? "")?.[1];
  if (status) signals.push({ signal: "status_report", detail: status });
  return signals;
}
