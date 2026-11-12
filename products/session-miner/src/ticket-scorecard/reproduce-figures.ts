import { isoWeek, type ClassLabel, type TaskRow } from "@titan-design/session-analytics";
import type { ExpectedFigure, ExpectedFile } from "./reproduce-spec.js";

/** A figure as the scorecard's rows give it, or why they cannot give it yet. */
export type Measure = { value: number } | { notMeasured: string };

export interface ReproduceInput {
  /** Every task row of an in-memory rebuild. */
  rows: readonly TaskRow[];
  /** The labels file's three-way `class_raw`, keyed `initiative/ID`. */
  rawClass: ReadonlyMap<string, ClassLabel>;
  /** Bare task ids of the hand audit's sample, when one is given. */
  sample: ReadonlySet<string> | null;
}

interface Population {
  rows: readonly TaskRow[];
  rawClass: ReadonlyMap<string, ClassLabel>;
  sample: ReadonlySet<string> | null;
  selfSources: ReadonlySet<string>;
}

const BRIEF_BINARY = "the recorded brief field (F13) is restates or not; pointer and diverges need E1's word-share reading";
const NO_TURN_LEDGER = "coordinator turns are classified by the turn ledger, slice S14, not built yet";
const DAY_H = 24;

/** The rows a population's dispatchers first dispatched inside the window (`from` inclusive, `to` exclusive). */
export function populationRows(rows: readonly TaskRow[], spec: ExpectedFile, population: string): TaskRow[] {
  const seats = spec.populations[population];
  if (seats === undefined) throw new Error(`unknown population ${population}; the expected file names ${Object.keys(spec.populations).join(", ")}`);
  const from = Date.parse(spec.window.from);
  const to = Date.parse(spec.window.to);
  return rows.filter((r) => seats.includes(r.dispatcher) && Date.parse(r.firstDispatchTs) >= from && Date.parse(r.firstDispatchTs) < to);
}

function share(rows: readonly TaskRow[], counted: (r: TaskRow) => boolean | null, empty: string): Measure {
  const known = rows.map(counted).filter((v): v is boolean => v !== null);
  if (known.length === 0) return { notMeasured: empty };
  return { value: (100 * known.filter(Boolean).length) / known.length };
}

function keyOf(row: TaskRow): string {
  return `${row.initiative}/${row.taskId}`;
}

function classShare(p: Population, label: ClassLabel): Measure {
  return share(p.rows, (r) => (p.rawClass.has(keyOf(r)) ? p.rawClass.get(keyOf(r)) === label : null), "no population row has a class_raw label");
}

function fixRoundShare(rows: readonly TaskRow[], counted: (n: number) => boolean): Measure {
  return share(rows.filter((r) => r.prs > 0), (r) => counted(r.fixRounds), "no population task has a registered PR");
}

function reverted(rows: readonly TaskRow[]): Measure {
  if (!rows.some((r) => r.provenance.revertedBy !== undefined)) return { notMeasured: "no input records reverted_by (F14, slice S11)" };
  return { value: rows.filter((r) => r.revertedBy !== null).length };
}

function followUps(rows: readonly TaskRow[], value: (counts: number[]) => number): Measure {
  const counts = rows.map((r) => r.followupsN).filter((n): n is number => n !== null);
  return counts.length === 0 ? { notMeasured: "no population row has follow-up facts" } : { value: value(counts) };
}

function sampleInPopulation(p: Population): Measure {
  if (p.sample === null) return { notMeasured: "no --sample file given" };
  const ids = new Set(p.rows.map((r) => r.taskId));
  return { value: [...p.sample].filter((id) => ids.has(id)).length };
}

function weekMeasure(p: Population, figure: ExpectedFigure & { week: string }): Measure {
  const rows = p.rows.filter((r) => isoWeek(r.firstDispatchTs) === figure.week);
  switch (figure.metric) {
    case "week-picks":
      return { value: rows.length };
    case "week-product-share":
      return share(rows, (r) => (r.classAtDispatch === null ? null : r.classAtDispatch === "product"), `no ${figure.week} pick has a class`);
    case "week-filed-1d-share":
      return share(rows, (r) => (r.ageAtDispatchH === null ? null : r.ageAtDispatchH <= DAY_H), `no ${figure.week} pick has an age`);
    case "week-self-share":
      return share(rows, (r) => (r.sourceAtDispatch === null ? null : p.selfSources.has(r.sourceAtDispatch)), `no ${figure.week} pick has a source`);
    case "week-owner-share":
      return share(rows, (r) => (r.sourceAtDispatch === null ? null : r.sourceAtDispatch === "owner"), `no ${figure.week} pick has a source`);
    default:
      return share(rows, (r) => r.inRuleTopk, `no pool snapshot covers ${figure.week}; snapshots start with the scheduled job (F19)`);
  }
}

function measure(p: Population, figure: ExpectedFigure): Measure {
  if ("week" in figure) return weekMeasure(p, figure);
  if ("class" in figure) return classShare(p, figure.class);
  if ("brief" in figure) return figure.brief === "restates" ? share(p.rows, (r) => r.briefHasDoneWhen, "no input records brief_has_done_when (F13, slice S13)") : { notMeasured: BRIEF_BINARY };
  switch (figure.metric) {
    case "tasks":
      return { value: p.rows.length };
    case "merged-share":
      return share(p.rows, (r) => r.mergedAt !== null, "the population is empty");
    case "fix-rounds-zero-share":
      return fixRoundShare(p.rows, (n) => n === 0);
    case "fix-rounds-3plus-share":
      return fixRoundShare(p.rows, (n) => n >= 3);
    case "reverted":
      return reverted(p.rows);
    case "follow-ups-filed":
      return followUps(p.rows, (counts) => counts.reduce((a, b) => a + b, 0));
    case "follow-up-sources":
      return followUps(p.rows, (counts) => counts.filter((n) => n > 0).length);
    case "sample-in-population":
      return sampleInPopulation(p);
    default:
      return { notMeasured: NO_TURN_LEDGER };
  }
}

/** Each expected figure, measured over the population's rows. */
export function measureFigures(input: ReproduceInput, spec: ExpectedFile, population: string): Measure[] {
  const p: Population = { ...input, rows: populationRows(input.rows, spec, population), selfSources: new Set(spec.selfSources) };
  return spec.figures.map((figure) => measure(p, figure));
}
