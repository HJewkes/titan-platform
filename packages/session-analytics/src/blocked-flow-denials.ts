/** One action the auto-mode classifier refused, read from a seat's transcript. */
export interface DenialRecord {
  seat: string;
  at: string;
  /** The classifier's bracketed reason, such as "Merge Without Review". */
  reason: string;
  /** What the refused call was doing, from its tool input; the reason label alone is loose. */
  action: string;
  tool: string;
  /** The refused call's id; a forked or resumed transcript repeats it, so it is counted once. */
  toolUseId?: string;
}

const DENIAL = /^Permission for this action (?:was|has been) denied by the Claude Code auto mode classifier\. Reason: \[([^\]]+)\]/;

const BASH_ACTIONS: readonly (readonly [string, RegExp])[] = [
  ["merge", /\bgh pr merge\b|\/pulls\/\d+\/merge\b/],
  ["retire", /\bagent[ _-]retire\b|\bagent\s+retire\b/],
  ["worktree-remove", /\bgit\b.*\bworktree (?:remove|prune)\b/],
  ["branch-delete", /\bgit branch -[dD]\b|\bpush\b.*--delete\b|\/git\/refs\/heads\/\S*.*-X DELETE|-X DELETE\b.*\/git\/refs\//],
  ["push", /\bgit\b.*\bpush\b/],
  ["github-write", /\bgh (?:pr|issue) (?:create|edit|comment|close)\b|\bgh api\b.*(?:-X|--method)\s*(?:POST|PATCH|PUT|DELETE)\b/],
  ["service-restart", /\bservice restart\b|\blaunchctl\b/],
  ["process-kill", /\b(?:pkill|kill)\b/],
  ["file-write", /\s>>?\s*(?!\/dev\/null|&)\S|\bopen\([^)]*["'][wa]["']\)|\bsed -i\b/],
];

const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** Classifies a refused call by what it did; MCP tools keep their own short name. */
export function classifyDeniedAction(tool: string, input: unknown): string {
  if (tool === "Bash") return bashAction(String((input as { command?: unknown } | null)?.command ?? ""));
  if (FILE_TOOLS.has(tool)) return "file-edit";
  if (tool.startsWith("mcp__")) return `mcp:${tool.split("__").at(-1)}`;
  return `tool:${tool}`;
}

function bashAction(command: string): string {
  return BASH_ACTIONS.find(([, pattern]) => pattern.test(command))?.[0] ?? "bash-other";
}

interface TranscriptEntry {
  timestamp?: string;
  message?: { content?: unknown };
}

interface ContentBlock {
  type?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
}

/** Scans transcript JSONL for classifier refusals and joins each to the tool call it refused. */
export function parseDenials(lines: Iterable<string>, seat: string): DenialRecord[] {
  const calls = new Map<string, { tool: string; input: unknown }>();
  const denials: DenialRecord[] = [];
  for (const line of lines) {
    if (!line.includes('"tool_use"') && !line.includes("auto mode classifier")) continue;
    const entry = parseLine(line);
    for (const block of blocksOf(entry)) {
      if (block.type === "tool_use" && block.id) calls.set(block.id, { tool: block.name ?? "unknown", input: block.input });
      const reason = block.type === "tool_result" ? DENIAL.exec(resultText(block.content))?.[1] : undefined;
      if (reason === undefined) continue;
      const call = calls.get(block.tool_use_id ?? "") ?? { tool: "unknown", input: null };
      const toolUseId = block.tool_use_id ? { toolUseId: block.tool_use_id } : {};
      denials.push({ seat, at: entry?.timestamp ?? "", reason, action: classifyDeniedAction(call.tool, call.input), tool: call.tool, ...toolUseId });
    }
  }
  return denials;
}

/** One denial per refused call; a record without a tool_use_id cannot be matched and is kept. */
export function dedupeDenials(denials: readonly DenialRecord[]): DenialRecord[] {
  const seen = new Set<string>();
  return denials.filter((d) => {
    if (d.toolUseId === undefined) return true;
    const key = `${d.seat}\u0000${d.toolUseId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseLine(line: string): TranscriptEntry | null {
  try {
    return JSON.parse(line) as TranscriptEntry;
  } catch {
    return null;
  }
}

function blocksOf(entry: TranscriptEntry | null): ContentBlock[] {
  const content = entry?.message?.content;
  return Array.isArray(content) ? (content as ContentBlock[]) : [];
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const first = (content as { type?: string; text?: string }[]).find((part) => part.type === "text");
  return first?.text ?? "";
}
