import type { RefClass, ServedRef, Trigger } from "./blocks.js";
import type { BaseRateCount } from "./labels.js";
import {
  corpusLister,
  indexWrapRecords,
  labelRef,
  OPENED_SECTION_UNAVAILABLE,
  unservedBaseRate,
  wrapRecordFor,
} from "./labels.js";
import type { ServedBlock, ServedSession, Window } from "./session.js";
import { readServedSession } from "./session.js";

/**
 * The served arm (design §1.3): did what we actually rendered get used?
 *
 * One query unit is one rendered block. Every ref in it is labelled, then
 * counted by class, initiative, file and foreignness within its trigger.
 */

export interface Observation extends ServedRef {
  opened: boolean;
  cited: boolean;
}

export interface Tally {
  served: number;
  opened: number;
  cited: number;
}

export interface BaseRate {
  unserved: number;
  opened: number;
}

export interface ClassRow extends Tally {
  trigger: Trigger;
  refClass: RefClass;
  baseRate?: BaseRate;
}

export interface InitiativeRow extends ClassRow {
  initiative: string;
}

export interface FileRow extends Tally {
  trigger: Trigger;
  ref: string;
}

export interface ServedReport {
  window: Window;
  transcriptsScanned: number;
  /** Transcripts with a non-empty rendered block, per trigger. */
  transcriptsServed: Record<Trigger, number>;
  /** Earliest and latest block timestamp per trigger: the window the data actually covers. */
  blockSpan: Partial<Record<Trigger, { first: string; last: string }>>;
  openedSection: string;
  byClass: ClassRow[];
  byInitiative: InitiativeRow[];
  byForeign: (ClassRow & { foreign: boolean })[];
  byFile: FileRow[];
}

export interface ServedInputs {
  observations: Observation[];
  baseRates: (BaseRateCount & { trigger: Trigger })[];
  transcriptsServed: Record<Trigger, number>;
  blockSpan: ServedReport["blockSpan"];
}

export async function collectServed(files: string[], activeRoot: string, window: Window): Promise<ServedInputs> {
  const wrapRecords = indexWrapRecords(activeRoot);
  const listCorpus = corpusLister(activeRoot);
  const inputs: ServedInputs = {
    observations: [],
    baseRates: [],
    transcriptsServed: { bootstrap: 0, spawn: 0 },
    blockSpan: {},
  };
  for (const file of files) {
    const session = await readServedSession(file, window);
    if (session === undefined) continue;
    labelSession(session, await wrapRecordFor(file, wrapRecords), listCorpus, inputs);
  }
  return inputs;
}

function labelSession(
  session: ServedSession,
  wrapRecord: string | undefined,
  listCorpus: Parameters<typeof unservedBaseRate>[1],
  inputs: ServedInputs,
): void {
  for (const block of session.blocks) {
    inputs.transcriptsServed[block.trigger]++;
    widenSpan(inputs.blockSpan, block);
    for (const ref of block.refs) inputs.observations.push({ ...ref, ...labelRef(ref, block, wrapRecord) });
    for (const count of unservedBaseRate(block, listCorpus)) inputs.baseRates.push({ ...count, trigger: block.trigger });
  }
}

function widenSpan(span: ServedReport["blockSpan"], block: ServedBlock): void {
  if (block.timestamp === undefined) return;
  const current = span[block.trigger];
  span[block.trigger] = {
    first: current && current.first < block.timestamp ? current.first : block.timestamp,
    last: current && current.last > block.timestamp ? current.last : block.timestamp,
  };
}

export function buildReport(inputs: ServedInputs, window: Window, transcriptsScanned: number): ServedReport {
  return {
    window,
    transcriptsScanned,
    transcriptsServed: inputs.transcriptsServed,
    blockSpan: inputs.blockSpan,
    openedSection: OPENED_SECTION_UNAVAILABLE,
    byClass: classRows(inputs),
    byInitiative: initiativeRows(inputs),
    byForeign: group(inputs.observations, (o) => [o.trigger, String(o.foreign), o.refClass]).map(([o, tally]) => ({
      trigger: o.trigger,
      refClass: o.refClass,
      foreign: o.foreign,
      ...tally,
    })),
    byFile: group(inputs.observations, (o) => [o.trigger, o.ref])
      .map(([o, tally]) => ({ trigger: o.trigger, ref: o.ref, ...tally }))
      .sort((a, b) => b.served - a.served || a.ref.localeCompare(b.ref)),
  };
}

function classRows({ observations, baseRates }: ServedInputs): ClassRow[] {
  return group(observations, (o) => [o.trigger, o.refClass]).map(([o, tally]) => ({
    trigger: o.trigger,
    refClass: o.refClass,
    ...tally,
    ...baseRateFor(baseRates, (b) => b.trigger === o.trigger && b.refClass === o.refClass),
  }));
}

function initiativeRows({ observations, baseRates }: ServedInputs): InitiativeRow[] {
  return group(observations, (o) => [o.trigger, o.initiative ?? "-", o.refClass]).map(([o, tally]) => ({
    trigger: o.trigger,
    initiative: o.initiative ?? "-",
    refClass: o.refClass,
    ...tally,
    ...baseRateFor(
      baseRates,
      (b) => b.trigger === o.trigger && b.refClass === o.refClass && b.initiative === o.initiative,
    ),
  }));
}

/** Observations grouped by a composite key, each group reduced to its first member and its tally. */
const CLASS_ORDER: RefClass[] = ["source", "note", "task", "session"];

/** Rows in §1.2's order: trigger, then class, then the grouping key. */
function byRow(a: [Observation, string[]], b: [Observation, string[]]): number {
  return (
    a[0].trigger.localeCompare(b[0].trigger) ||
    CLASS_ORDER.indexOf(a[0].refClass) - CLASS_ORDER.indexOf(b[0].refClass) ||
    a[1].join("/").localeCompare(b[1].join("/"))
  );
}

function group(observations: Observation[], keyOf: (o: Observation) => string[]): [Observation, Tally][] {
  const groups = new Map<string, [Observation, Tally, string[]]>();
  for (const o of observations) {
    const parts = keyOf(o);
    const key = parts.join("\u0000");
    const entry = groups.get(key) ?? [o, { served: 0, opened: 0, cited: 0 }, parts];
    entry[1].served++;
    entry[1].opened += Number(o.opened);
    entry[1].cited += Number(o.cited);
    groups.set(key, entry);
  }
  return [...groups.values()]
    .sort((a, b) => byRow([a[0], a[2]], [b[0], b[2]]))
    .map(([o, tally]) => [o, tally]);
}

function baseRateFor(counts: ServedInputs["baseRates"], match: (count: ServedInputs["baseRates"][number]) => boolean) {
  const matching = counts.filter(match);
  if (matching.length === 0) return {};
  const baseRate = matching.reduce((sum, c) => ({ unserved: sum.unserved + c.unserved, opened: sum.opened + c.opened }), {
    unserved: 0,
    opened: 0,
  });
  return { baseRate };
}
