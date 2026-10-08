import { createHash } from "node:crypto";
import type { GateRecord } from "@titan-design/hitl";
import { z } from "zod";
import { landGate, stepOf } from "./coordinator-evidence.js";
import { GATE_ID, HEAD_SHA } from "./gate-resolve.js";
import type { FactoryHost } from "./host.js";
import { parsePrRef } from "./registry.js";

/** One merge-gate resolve in a batch: answer `merge` at exactly `headSha`, or not at all. */
export interface BatchItem {
  gate: string;
  runId: string;
  /** Without a repeat suffix, so the resolve finds the run's pending gate the way `gate resolve` does. */
  stepId: string;
  repo: string;
  pr: number;
  headSha: string;
}

/** Enough for every Shepherd run waiting at once, and small enough to read before signing. */
export const MAX_BATCH_ITEMS = 200;

const ItemLine = z.strictObject({ gate: z.string().regex(GATE_ID), pr: z.string(), headSha: z.string().regex(HEAD_SHA) });

/** After-stage gates follow a merge into deploy, release or activation; those stay one at a time at the Mac. */
const RELEASE_STEPS: ReadonlySet<string> = new Set(["after-stages"]);
const HARDWARE_STEP = /device|hardware/;
const RELEASE_TABLE = "shepherd-release/";

/**
 * Parses and checks the whole list before anything is shown or signed: any malformed line, unknown or duplicate gate,
 * gate that is not a merge gate at a pinned head, or item naming another PR makes the batch an error message.
 */
export function planBatch(host: FactoryHost, source: string): BatchItem[] | string {
  const lines = parseLines(source);
  if (typeof lines === "string") return lines;
  if (lines.length === 0) return "the batch lists no items";
  if (lines.length > MAX_BATCH_ITEMS) return `the batch lists ${lines.length} items, over the limit of ${MAX_BATCH_ITEMS}`;
  const items: BatchItem[] = [];
  for (const [index, raw] of lines.entries()) {
    const item = planItem(host, raw);
    if (typeof item === "string") return `item ${index + 1}: ${item}`;
    if (items.some(({ gate }) => gate === item.gate)) return `item ${index + 1}: ${item.gate} is listed twice`;
    items.push(item);
  }
  return items;
}

/** A JSON array, or JSON lines with blank lines ignored. */
function parseLines(source: string): unknown[] | string {
  const text = source.trim();
  try {
    if (text.startsWith("[")) {
      const parsed: unknown = JSON.parse(text);
      return Array.isArray(parsed) ? parsed : "the batch is not a JSON array";
    }
    return text === "" ? [] : text.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as unknown);
  } catch {
    return "the batch is not JSON lines or a JSON array";
  }
}

function planItem(host: FactoryHost, raw: unknown): BatchItem | string {
  const parsed = ItemLine.safeParse(raw);
  if (!parsed.success) return "expected exactly {gate, pr: owner/repo#N, headSha: 40 hex}";
  const { gate: gateId, pr: ref, headSha } = parsed.data;
  let target: { repo: string; pr: number };
  try {
    target = parsePrRef(ref);
  } catch (error) {
    return (error as Error).message;
  }
  const gate = host.gates.get(gateId);
  if (gate === undefined) return `no gate ${gateId}`;
  const asks = mergeTarget(gate);
  if (typeof asks === "string") return `${gateId} is ${asks}; it stays one at a time`;
  if (asks.repo.toLowerCase() !== target.repo.toLowerCase() || asks.pr !== target.pr) return `${gateId} asks about ${asks.repo}#${asks.pr}, not ${ref}`;
  return { gate: gateId, runId: gateId.slice(0, gateId.indexOf("/")), stepId: stepOf(gateId), repo: asks.repo, pr: asks.pr, headSha };
}

/** The PR a batchable gate asks about, or what kind of gate it is instead. */
function mergeTarget(gate: GateRecord): { repo: string; pr: number } | string {
  const step = stepOf(gate.id);
  if (HARDWARE_STEP.test(step)) return "a hardware gate";
  if (RELEASE_STEPS.has(step)) return "a release gate";
  const land = landGate(gate);
  if (land === undefined) return "not a merge gate at a pinned head";
  return land.rule.startsWith(RELEASE_TABLE) ? "a release gate" : land;
}

/** What the owner signs: every item in order, so the record proves which list the one presence check covered. */
export function digestOf(items: readonly BatchItem[]): string {
  const canonical = JSON.stringify(items.map(({ gate, repo, pr, headSha }) => [gate, repo, pr, headSha]));
  return createHash("sha256").update(canonical).digest("hex");
}

export function formatPlan(items: readonly BatchItem[], digest: string): string {
  const lines = items.map((item, index) => `  ${index + 1}. ${item.gate}  ${item.repo}#${item.pr}  ${item.headSha}`);
  return [`batch ${digest.slice(0, 16)}: answer merge to ${items.length} merge gates, each only at the head listed`, ...lines, ""].join("\n");
}
