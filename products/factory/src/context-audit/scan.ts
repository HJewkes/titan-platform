import { priceRequest } from "@titan-design/session-analytics";
import { queuedWake, userWake, type Wake } from "./wakes.js";

export interface Spend {
  calls: number;
  turn1: number;
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  usd: number;
  /** Calls on a model the price table does not cover; their usd counts as zero. */
  unpriced: number;
}

export interface Snapshot {
  at: string;
  systemBlocks: number[];
  systemPrompt: string;
  tools: { name: string; chars: number }[];
}

export interface InstructionFile {
  path: string;
  type: string;
  chars: number;
}

export interface SessionScan {
  name: string | null;
  spend: Spend;
  snapshot: Snapshot | null;
  instructions: InstructionFile[];
  /** Tool-result and attachment chars by kind, raw and weighted by the later calls that re-read them. */
  carried: Map<string, { raw: number; carried: number }>;
  /** Pushed messages that start or join a turn, each with the trigger that sent it. */
  wakes: Wake[];
}

type Rec = Record<string, unknown>;
const CARRIED_ATTACHMENTS = new Set(["skill_listing", "deferred_tools_record", "deferred_tools_delta", "queued_command", "file", "instructions", "mcp_instructions_delta", "total_tokens_reminder"]);
const SUBCOMMANDED = new Set(["git", "gh", "agent-chat", "active-work", "npm", "pnpm", "npx", "bun"]);

const isRec = (value: unknown): value is Rec => typeof value === "object" && value !== null && !Array.isArray(value);
const rec = (value: unknown): Rec => (isRec(value) ? value : {});
const num = (value: unknown): number => (typeof value === "number" ? value : 0);
const str = (value: unknown): string => (typeof value === "string" ? value : "");
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** A Bash call's kind is its program, plus the subcommand for the multi-verb CLIs, after any leading VAR=value. */
function bashKind(command: string): string {
  const match = /^\s*(?:[A-Z_]+=\S+\s+)*([\w./-]+)(?:\s+([\w-]+))?/.exec(command);
  if (!match) return "bash:?";
  const program = match[1]!.split("/").at(-1)!;
  return SUBCOMMANDED.has(program) && match[2] ? `bash:${program} ${match[2]}` : `bash:${program}`;
}

function textLength(content: unknown): number {
  if (typeof content === "string") return content.length;
  return list(content).reduce<number>((n, block) => n + (typeof block === "string" ? block.length : str(rec(block).text).length), 0);
}

function snapshotOf(attachment: Rec, at: string): Snapshot | null {
  if (!Array.isArray(attachment.tools)) return null;
  const blocks = list(attachment.systemPrompt).map(str);
  const tools = list(attachment.tools).map((tool) => ({ name: str(rec(tool).name), chars: JSON.stringify(tool).length }));
  return { at, systemBlocks: blocks.map((b) => b.length), systemPrompt: blocks.join("\n"), tools };
}

class Scanner {
  readonly scan: SessionScan = {
    name: null,
    spend: { calls: 0, turn1: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, usd: 0, unpriced: 0 },
    snapshot: null,
    instructions: [],
    carried: new Map(),
    wakes: [],
  };
  private readonly seen = new Set<string>();
  private readonly toolKinds = new Map<string, string>();
  private readonly events: [call: number, kind: string, chars: number][] = [];

  line(j: Rec): void {
    if (j.type === "agent-name") this.scan.name ??= str(j.agentName) || null;
    else if (j.type === "attachment") this.attachment(rec(j.attachment), j);
    else if (j.type === "assistant") this.assistant(rec(j.message), str(j.timestamp));
    else if (j.type === "user") this.user(j);
  }

  private attachment(a: Rec, j: Rec): void {
    const kind = str(a.type);
    if (kind === "prompt_snapshot") this.scan.snapshot = snapshotOf(a, str(j.timestamp)) ?? this.scan.snapshot;
    if (kind === "instructions") this.scan.instructions = list(a.files).map((f) => ({ path: str(rec(f).path), type: str(rec(f).type), chars: str(rec(f).content).length }));
    if (kind === "queued_command") this.scan.wakes.push({ at: str(a.timestamp) || str(j.timestamp), trigger: queuedWake(a) });
    if (CARRIED_ATTACHMENTS.has(kind)) this.events.push([this.scan.spend.calls, `att:${kind}`, JSON.stringify(j.rendered ?? a).length]);
  }

  private assistant(m: Rec, at: string): void {
    for (const block of list(m.content).map(rec)) {
      if (block.type !== "tool_use") continue;
      const name = str(block.name);
      this.toolKinds.set(str(block.id), name === "Bash" ? bashKind(str(rec(block.input).command)) : name);
    }
    const id = str(m.id);
    if (!m.usage || this.seen.has(id)) return;
    this.seen.add(id);
    this.count(rec(m.usage), str(m.model), at);
  }

  private count(u: Rec, model: string, at: string): void {
    const s = this.scan.spend;
    const split = rec(u.cache_creation);
    const tokens = { inputTokens: num(u.input_tokens), cacheReadTokens: num(u.cache_read_input_tokens), cacheCreationTokens: num(u.cache_creation_input_tokens) };
    const ttlSplit = { cacheCreation5mTokens: num(split.ephemeral_5m_input_tokens) || undefined, cacheCreation1hTokens: num(split.ephemeral_1h_input_tokens) || undefined };
    const priced = priceRequest({ ...tokens, ...ttlSplit, outputTokens: num(u.output_tokens) }, model, at);
    if (s.calls === 0) s.turn1 = tokens.inputTokens + tokens.cacheCreationTokens + tokens.cacheReadTokens;
    s.calls += 1;
    s.input += tokens.inputTokens;
    s.cacheWrite += tokens.cacheCreationTokens;
    s.cacheRead += tokens.cacheReadTokens;
    s.output += num(u.output_tokens);
    s.usd += priced.costUsd;
    if (!priced.priced) s.unpriced += 1;
  }

  private user(j: Rec): void {
    const content = rec(j.message).content;
    const trigger = userWake(j);
    if (trigger) this.scan.wakes.push({ at: str(j.timestamp), trigger });
    if (typeof content === "string" && content.includes("<channel")) this.events.push([this.scan.spend.calls, "channel-msg", content.length]);
    for (const block of list(content).map(rec)) {
      if (block.type === "tool_result") this.events.push([this.scan.spend.calls, this.toolKinds.get(str(block.tool_use_id)) ?? "?", textLength(block.content)]);
      else if (block.type === "text" && str(block.text).includes("<channel")) this.events.push([this.scan.spend.calls, "channel-msg", str(block.text).length]);
    }
  }

  finish(): SessionScan {
    for (const [call, kind, chars] of this.events) {
      const row = this.scan.carried.get(kind) ?? { raw: 0, carried: 0 };
      row.raw += chars;
      row.carried += chars * Math.max(this.scan.spend.calls - call, 0);
      this.scan.carried.set(kind, row);
    }
    return this.scan;
  }
}

/** One transcript's spend, newest prompt snapshot, loaded instructions and carried chars; unparseable lines are skipped. */
export function scanTranscript(text: string): SessionScan {
  const scanner = new Scanner();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      scanner.line(rec(JSON.parse(line)));
    } catch {
      continue;
    }
  }
  return scanner.finish();
}
