import { mergeByKeys, type OwnerItem, type QueueSource } from "@titan-design/owner-queue";
import type { Caller } from "../caller.js";
import type { AgentAllowList } from "./agent-allow-list.js";
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

/** Who the list is for. The caller is required, so no reader gets a view by default. */
export interface NeedsView {
  caller: Caller;
  /** The owner's own inbox lens: charter-personal initiatives too. */
  personal?: boolean;
  /** Read only for an agent; absent or unreadable, every initiative-tagged item is withheld. */
  allowed?: AgentAllowList;
}

interface Visibility {
  shows: (item: OwnerItem) => boolean;
  gap?: string;
}

const firstLine = (error: unknown): string => (error instanceof Error ? error.message : String(error)).split("\n")[0]!;

async function readSource(source: QueueSource): Promise<{ items: OwnerItem[]; gap?: string }> {
  try {
    return { items: await source.open() };
  } catch (error) {
    const line = firstLine(error);
    return { items: [], gap: line.startsWith(`${source.system}:`) ? line : `${source.system}: ${line}` };
  }
}

/** Owner: everything. Agent: untagged items, and tagged ones only from an initiative the allow list names, whatever the source. */
async function visibilityOf({ caller, allowed }: NeedsView): Promise<Visibility> {
  if (caller === "owner") return { shows: () => true };
  const shownFrom = (names: ReadonlySet<string>) => (item: OwnerItem) => item.initiative === undefined || names.has(item.initiative);
  if (allowed === undefined) return { shows: shownFrom(new Set()) };
  try {
    return { shows: shownFrom(await allowed()) };
  } catch (error) {
    return { shows: shownFrom(new Set()), gap: `active-work inventory: ${firstLine(error)}; initiative items withheld` };
  }
}

export async function collectNeeds(sources: readonly QueueSource[], view: NeedsView): Promise<NeedsList> {
  const [reads, visibility] = await Promise.all([Promise.all(sources.map(readSource)), visibilityOf(view)]);
  const open = reads.flatMap((read) => read.items).filter((item) => (view.personal === true || !item.personal) && visibility.shows(item));
  const counts: Record<string, number> = {};
  for (const item of open) counts[item.sources[0]!.system] = (counts[item.sources[0]!.system] ?? 0) + 1;
  return {
    items: mergeByKeys(open),
    counts,
    overlaps: overlapReport(open),
    gaps: [...reads, visibility].flatMap((read) => (read.gap === undefined ? [] : [read.gap])),
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
