import { statSync } from "node:fs";
import { streamRecords, textOf, toolUsesIn } from "../corpus/transcripts.js";
import type { ServedRef, Trigger } from "./blocks.js";
import { hasBootstrapBlock, hasSpawnBlock, parseBootstrapBlock, parseSpawnBlock } from "./blocks.js";

/**
 * One transcript reduced to what the served arm labels against: the blocks it
 * was served, and everything the agent did after each.
 */

export interface ServedBlock {
  trigger: Trigger;
  timestamp?: string;
  refs: ServedRef[];
  /** Serialised inputs of every tool call after the block, in order. */
  toolInputs: string[];
  /** Assistant prose after the block, where a ref can be cited without being opened. */
  assistantText: string[];
}

export interface ServedSession {
  file: string;
  blocks: ServedBlock[];
}

/** Half-open `[since, until)` over ISO timestamps; either end may be open. */
export interface Window {
  since?: string;
  until?: string;
}

const PARSERS: Record<Trigger, { has: (text: string) => boolean; parse: (text: string) => ServedRef[] }> = {
  bootstrap: { has: hasBootstrapBlock, parse: parseBootstrapBlock },
  spawn: { has: hasSpawnBlock, parse: parseSpawnBlock },
};

/**
 * Each trigger's block is the first user turn that renders one, as design §1.2
 * reads it. Activity at or after `until` is dropped, so a re-run over a closed
 * window counts the same opens even for a session that is still going.
 */
export async function readServedSession(file: string, window: Window = {}): Promise<ServedSession | undefined> {
  if (window.since !== undefined && statSync(file).mtime.toISOString() < window.since) return undefined;
  const blocks: ServedBlock[] = [];
  const pending = new Set<Trigger>(["bootstrap", "spawn"]);
  for await (const record of streamRecords(file)) {
    const timestamp = typeof record.timestamp === "string" ? record.timestamp : undefined;
    if (window.until !== undefined && timestamp !== undefined && timestamp >= window.until) break;
    if (record.type === "user") claimBlocks(textOf(record.message), timestamp, pending, blocks);
    else if (record.type === "assistant" && blocks.length > 0) recordActivity(record, blocks);
  }
  const inWindow = blocks.filter((block) => block.refs.length > 0 && startsInWindow(block, window));
  return inWindow.length > 0 ? { file, blocks: inWindow } : undefined;
}

function claimBlocks(text: string, timestamp: string | undefined, pending: Set<Trigger>, blocks: ServedBlock[]): void {
  for (const trigger of [...pending]) {
    const parser = PARSERS[trigger];
    if (!parser.has(text)) continue;
    pending.delete(trigger);
    blocks.push({ trigger, ...(timestamp ? { timestamp } : {}), refs: parser.parse(text), toolInputs: [], assistantText: [] });
  }
}

function recordActivity(record: Record<string, unknown>, blocks: ServedBlock[]): void {
  const inputs = toolUsesIn(record).map((tool) => JSON.stringify(tool.input));
  const text = textOf(record.message);
  for (const block of blocks) {
    block.toolInputs.push(...inputs);
    if (text.length > 0) block.assistantText.push(text);
  }
}

function startsInWindow(block: ServedBlock, window: Window): boolean {
  if (window.since === undefined) return true;
  return block.timestamp !== undefined && block.timestamp >= window.since;
}
