import { createHash } from "node:crypto";
import { pickControls } from "@titan-design/evidence";
import type { QuerySpec } from "../types.js";

/** A passage as the judge sees it. `ref` is the display ref with its series prefix. */
export interface ShownPassage {
  id: string;
  ref: string;
  text: string;
}

export type Canary = QuerySpec["canaries"][number];

export interface Batch {
  key: string;
  passages: ShownPassage[];
  canary?: ShownPassage & { expect: Canary["expect"] };
  /** The user message: passages in the order given, the canary last. */
  message: string;
}

/** Rough size of English prose in tokens; batches only need to land near their budget. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

const show = (p: ShownPassage): string => `=== PASSAGE ${p.id} (${p.ref}) ===\n${p.text}`;

export function batchKey(passageIds: readonly string[], prefixSha: string): string {
  const hash = createHash("sha256");
  hash.update(prefixSha);
  for (const id of [...passageIds].sort()) hash.update(`\n${id}`);
  return hash.digest("hex").slice(0, 16);
}

/** Packs passages, already in story order, into groups under the budget without splitting one. */
function pack(passages: readonly ShownPassage[], tokenBudget: number): ShownPassage[][] {
  const groups: ShownPassage[][] = [];
  let used = 0;
  for (const passage of passages) {
    const cost = estimateTokens(show(passage));
    const last = groups[groups.length - 1];
    if (last && used + cost <= tokenBudget) {
      last.push(passage);
      used += cost;
    } else {
      groups.push([passage]);
      used = cost;
    }
  }
  return groups;
}

export interface BatchOptions {
  tokenBudget: number;
  prefixSha: string;
  canaries: readonly Canary[];
  /** Words the batch message opens with, such as the grown lexicon. */
  preamble?: string;
}

/**
 * Splits passages into batches, each ending with one canary. The canary goes last because a
 * canary placed mid-batch was cited for its neighbour.
 */
export function buildBatches(passages: readonly ShownPassage[], options: BatchOptions): Batch[] {
  return pack(passages, options.tokenBudget).map((group) => {
    const key = batchKey(
      group.map((p) => p.id),
      options.prefixSha,
    );
    const [picked] = pickControls(options.canaries, key, 1);
    const canary = picked && { id: `canary-${key}`, ref: "CANARY", text: picked.text, expect: picked.expect };
    const shown = canary ? [...group, canary] : group;
    const head = options.preamble ? `${options.preamble}\n\n` : "";
    return { key, passages: group, canary, message: head + shown.map(show).join("\n\n") };
  });
}
