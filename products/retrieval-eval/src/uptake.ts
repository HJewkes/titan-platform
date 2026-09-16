import type { ToolUse } from "./corpus/transcripts.js";
import { streamToolUses } from "./corpus/transcripts.js";

/**
 * Arm 1: do agents actually reach for a recall tool?
 *
 * Ported from the scratchpad script that produced the 2026-09-15 baseline, so
 * the number stays reproducible after that scratchpad is swept. The question it
 * answers is narrow and worth stating: how often a session chose workspace
 * recall over grepping the filesystem, when both were available.
 */

export type UsageClass =
  | "fs-search"
  | "bash-search"
  | "recall-mcp"
  | "recall-cli"
  | "bash-other"
  | "mcp-other"
  | "read"
  | "web"
  | "other";

const BASH_SEARCH = /\b(rg|grep|find|fd|ag)\b/;
const RECALL_CLI = /active-work search|\baw search\b|brain search|playbook recall|titan-miner search/;
const RECALL_MCP = /search|recall|query|find|lookup/i;

export function classify(name: string, input: Record<string, unknown>): UsageClass {
  if (name === "Glob" || name === "Grep") return "fs-search";
  if (name === "Bash") return classifyBash(String(input.command ?? ""));
  if (name.startsWith("mcp__")) return RECALL_MCP.test(name) ? "recall-mcp" : "mcp-other";
  if (name === "Read") return "read";
  if (name === "WebSearch" || name === "WebFetch") return "web";
  return "other";
}

function classifyBash(command: string): UsageClass {
  if (RECALL_CLI.test(command)) return "recall-cli";
  if (BASH_SEARCH.test(command)) return "bash-search";
  return "bash-other";
}

/** Classes worth knowing the per-session reach of, not just the call count. */
const TRACKED: UsageClass[] = ["fs-search", "bash-search", "recall-mcp", "recall-cli"];

export interface UptakeReport {
  since?: string;
  transcripts: number;
  transcriptsWithToolUse: number;
  byClass: Record<string, number>;
  /** How many transcripts used each tracked class at least once. */
  sessionsWith: Record<string, number>;
  recallToolNames: Record<string, number>;
  topTools: Record<string, number>;
}

export interface UptakeOptions {
  /** ISO date; tool calls stamped before it are skipped. */
  since?: string;
}

export async function countUptake(files: string[], options: UptakeOptions = {}): Promise<UptakeReport> {
  const byClass = new Map<string, number>();
  const byName = new Map<string, number>();
  const recallNames = new Map<string, number>();
  const sessionsWith = new Map<string, number>();
  let withToolUse = 0;
  for (const file of files) {
    const seen = new Set<string>();
    let counted = false;
    for await (const tool of streamToolUses(file)) {
      if (!inWindow(tool, options.since)) continue;
      counted = true;
      const usage = classify(tool.name, tool.input);
      bump(byClass, usage);
      bump(byName, tool.name);
      if (usage.startsWith("recall")) bump(recallNames, tool.name);
      if (TRACKED.includes(usage)) seen.add(usage);
    }
    if (counted) withToolUse++;
    for (const usage of seen) bump(sessionsWith, usage);
  }
  return {
    ...(options.since ? { since: options.since } : {}),
    transcripts: files.length,
    transcriptsWithToolUse: withToolUse,
    byClass: descending(byClass),
    sessionsWith: descending(sessionsWith),
    recallToolNames: descending(recallNames),
    topTools: descending(byName, 25),
  };
}

function inWindow(tool: ToolUse, since?: string): boolean {
  if (since === undefined) return true;
  return tool.timestamp !== undefined && tool.timestamp >= since;
}

function bump(counter: Map<string, number>, key: string): void {
  counter.set(key, (counter.get(key) ?? 0) + 1);
}

function descending(counter: Map<string, number>, limit?: number): Record<string, number> {
  const sorted = [...counter.entries()].sort((a, b) => b[1] - a[1]);
  return Object.fromEntries(limit === undefined ? sorted : sorted.slice(0, limit));
}
