import { mergeByKeys, type OwnerItem, type QueueSource } from "@titan-design/owner-queue";
import { tally } from "./counts.js";
import { overlapReport, renderOverlapReport, type Overlap } from "./overlap.js";

/** The owner's one list: every source's open items, personal initiatives dropped, duplicates folded by exact key. */
export interface NeedsList {
  items: OwnerItem[];
  /** Open items each source system read, before merging. */
  counts: Record<string, number>;
  /** Subjects two or more sources name, and whether merging folded each. */
  overlaps: Overlap[];
  /** One line per source that could not be read, so an outage is never an empty queue. */
  gaps: string[];
}

async function readSource(source: QueueSource): Promise<{ items: OwnerItem[]; gap?: string }> {
  try {
    return { items: await source.open() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const line = message.split("\n")[0]!;
    return { items: [], gap: line.startsWith(`${source.system}:`) ? line : `${source.system}: ${line}` };
  }
}

export async function collectNeeds(sources: readonly QueueSource[], { personal = false }: { personal?: boolean } = {}): Promise<NeedsList> {
  const reads = await Promise.all(sources.map(readSource));
  const open = reads.flatMap((read) => read.items).filter((item) => personal || !item.personal);
  const counts: Record<string, number> = {};
  for (const item of open) counts[item.sources[0]!.system] = (counts[item.sources[0]!.system] ?? 0) + 1;
  return {
    items: mergeByKeys(open),
    counts,
    overlaps: overlapReport(open),
    gaps: reads.flatMap((read) => (read.gap === undefined ? [] : [read.gap])),
  };
}

function countsLine(list: NeedsList, brokerItems: readonly OwnerItem[]): string {
  const n = (system: string): number => list.counts[system] ?? 0;
  const broker = `${n("agent-chat")} broker items (${tally(brokerItems.map((item) => item.kind))})`;
  return `${n("hitl")} gates, ${n("morning")} Morning items, ${n("active-work")} tasks, ${broker}`;
}

const sourceName = (item: OwnerItem): string => item.sources.map((source) => `${source.system} ${source.ref}`).join(" + ");

function silenceText(onSilence: OwnerItem["onSilence"]): string {
  if (onSilence === undefined) return "unset";
  return onSilence.action === "wait" ? "wait" : `${onSilence.action} after ${onSilence.afterHours}h`;
}

const cardLintOf = (item: OwnerItem): string[] => (item.lint ?? []).filter((rule) => rule.startsWith("card:"));

/** Only an item that carries a card, or was linted against one, gets card lines, so items with neither stay one line each. */
function cardLines(item: OwnerItem): string[] {
  const lint = cardLintOf(item);
  if (item.class === undefined && item.onSilence === undefined && item.irreversible === undefined && lint.length === 0) return [];
  const head = `    class ${item.class ?? "unset"} · ${item.door} · on silence: ${silenceText(item.onSilence)}`;
  const irreversible = item.irreversible === undefined ? [] : [`    irreversible: ${item.irreversible}`];
  const options = (item.options ?? []).flatMap((option) => (option.consequence === undefined ? [] : [`    - ${option.id}: ${option.consequence}`]));
  const missing = lint.length === 0 ? [] : [`    card lint: ${lint.join(", ")}`];
  return [head, ...irreversible, ...options, ...missing];
}

function itemLines(item: OwnerItem): string[] {
  const line = `- ${item.kind}, ${item.door}: ${item.summary} [${item.sources[0]!.system}]`;
  const merged = item.sources.length > 1 ? [`    ${item.sources.length} items merged into 1: ${sourceName(item)}`] : [];
  return [line, ...merged, ...cardLines(item)];
}

export function renderNeeds(list: NeedsList): string {
  const broker = list.items.filter((item) => item.sources.some((source) => source.system === "agent-chat"));
  return [countsLine(list, broker), renderOverlapReport(list.overlaps), ...list.items.flatMap(itemLines)].join("\n");
}
