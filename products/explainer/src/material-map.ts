import { createHash } from "node:crypto";
import { canonicalJson } from "./eval-store.js";
import { numbersIn, tagFacts, type CueHit, type CueTable } from "./material-cues.js";
import type { FactsFormat, MaterialFact } from "./material-facts.js";
import { SIGNAL_GAPS, SIGNAL_RULES } from "./material-signals.js";
import type { TypeProfile } from "./profile-schema.js";
import { fits, type NarrativeStructure } from "./structure-schema.js";

/** One signal: it holds, it does not, or (`null`) no deterministic rule reads it. */
export interface SignalRow {
  id: string;
  holds: boolean | null;
  rule: string;
  facts: string[];
}

export type FitVerdict = "fits" | "no" | "undecided";

export interface FitRow {
  structure: string;
  version: string;
  /** The profile lists this structure as one its video may take. */
  allowed: boolean;
  fit: FitVerdict;
  reasons: string[];
}

export interface MaterialMap {
  schema: "material-map/v1";
  facts: { sha: string; format: FactsFormat; count: number };
  profile: { type: string; version: string; runtimeS: number };
  structures: { registrySha: string; count: number };
  /** The plan §A.3 material kinds, as cue hits: fact ids and what marked them. */
  material: Record<"claims" | "tensions" | "changes" | "quantities" | "timeSeries" | "mechanisms" | "flows" | "parallel", CueHit[]>;
  metrics: { p1Count: number; maxDeltaVsBaseline: number | null };
  signals: SignalRow[];
  gaps: string[];
  fits: FitRow[];
  /** Structures whose predicate fits and the profile allows: the audition's candidate set. */
  candidates: string[];
}

/** The registry's version: a hash over every structure's parsed content, so any edit is a new version. */
export function registrySha(structures: ReadonlyMap<string, NarrativeStructure>): string {
  return createHash("sha256").update(canonicalJson([...structures.values()].sort((a, b) => a.id.localeCompare(b.id)))).digest("hex");
}

/** The structures a profile's video may take: the fixed macro, or every heuristic row, macro and the fallback. */
export function allowedStructures(profile: TypeProfile): Set<string> {
  const { structure } = profile;
  if (structure.order === "fixed") return new Set([structure.macro]);
  return new Set([...structure.heuristic.map((row) => row.macro), ...Object.keys(structure.macros), structure.fallback]);
}

function material(facts: readonly MaterialFact[], cues: CueTable): MaterialMap["material"] {
  const quantities = facts.filter((fact) => numbersIn(fact.text).length > 0).map((fact) => ({ fact: fact.id, by: numbersIn(fact.text).join(",") }));
  const timeSeries = quantities.filter((q) => cues.dated.some((hit) => hit.fact === q.fact));
  return {
    claims: facts.map((fact) => ({ fact: fact.id, by: fact.kind ? `kind:${fact.kind}` : "fact" })),
    tensions: cues.tension, changes: cues.change, quantities, timeSeries: timeSeries.length >= 3 ? timeSeries : [],
    mechanisms: cues.mechanism, flows: cues.flow, parallel: cues.parallel,
  };
}

/** The largest relative move a change fact states between its first two numbers. */
function maxDelta(facts: readonly MaterialFact[], changes: readonly CueHit[]): number | null {
  const deltas = changes.flatMap((hit) => {
    const [a, b] = numbersIn(facts.find((fact) => fact.id === hit.fact)?.text ?? "");
    return a !== undefined && b !== undefined && a !== 0 ? [Math.abs(b - a) / Math.abs(a)] : [];
  });
  return deltas.length > 0 ? Math.round(Math.max(...deltas) * 1000) / 1000 : null;
}

/** Every vocabulary signal in vocabulary order; one with neither a rule nor a listed gap throws. */
export function signalRows(vocabulary: readonly string[], cues: CueTable, facts: readonly MaterialFact[]): SignalRow[] {
  return vocabulary.map((id) => {
    const gap = SIGNAL_GAPS[id];
    if (gap) return { id, holds: null, rule: `gap: ${gap}`, facts: [] };
    const rule = SIGNAL_RULES[id];
    if (!rule) throw new Error(`signal ${id} is in vocabulary.yaml but has no material-map rule and is not a listed gap`);
    return { id, rule: rule.rule, ...rule.evaluate(cues, facts) };
  });
}

/** Each combination of the gap signals the predicate reads, as the signal sets to try. */
function worlds(held: ReadonlySet<string>, gaps: readonly string[]): Set<string>[] {
  return gaps.reduce<Set<string>[]>((sets, gap) => sets.flatMap((set) => [set, new Set([...set, gap])]), [new Set(held)]);
}

const named = (names: readonly string[]) => names.join(", ");

function reasons(structure: NarrativeStructure, signals: readonly SignalRow[], runtimeS: number): string[] {
  const state = (id: string) => {
    const holds = signals.find((row) => row.id === id)?.holds;
    return `${id} ${holds === null ? "is a gap" : holds ? "holds" : "does not hold"}`;
  };
  const { fit } = structure;
  const terms = [
    ...(fit.all.length ? [`all of [${named(fit.all)}]: ${fit.all.map(state).join("; ")}`] : []),
    ...(fit.any.length ? [`any of [${named(fit.any)}]: ${fit.any.map(state).join("; ")}`] : []),
    ...(fit.none.length ? [`none of [${named(fit.none)}]: ${fit.none.map(state).join("; ")}`] : []),
  ];
  const bounded = fit.minRuntimeS !== undefined || fit.maxRuntimeS !== undefined;
  const inBounds = runtimeS >= (fit.minRuntimeS ?? 0) && runtimeS <= (fit.maxRuntimeS ?? Number.POSITIVE_INFINITY);
  return bounded ? [...terms, `runtime ${runtimeS} s ${inBounds ? "within" : "outside"} [${fit.minRuntimeS ?? 0}, ${fit.maxRuntimeS ?? "∞"}] s`] : terms;
}

/** A predicate that reads a gap signal fits only when it fits whichever way the gap falls; split outcomes are undecided. */
export function fitRow(structure: NarrativeStructure, signals: readonly SignalRow[], runtimeS: number, allowed: ReadonlySet<string>): FitRow {
  const held = new Set(signals.filter((row) => row.holds === true).map((row) => row.id));
  const read = [...structure.fit.all, ...structure.fit.any, ...structure.fit.none];
  const gaps = read.filter((id) => signals.find((row) => row.id === id)?.holds === null);
  const outcomes = new Set(worlds(held, gaps).map((set) => fits(structure, { signals: set, runtimeS })));
  const fit: FitVerdict = outcomes.size > 1 ? "undecided" : outcomes.has(true) ? "fits" : "no";
  return { structure: structure.id, version: structure.version, allowed: allowed.has(structure.id), fit, reasons: reasons(structure, signals, runtimeS) };
}

export interface MapInput {
  factsSha: string;
  format: FactsFormat;
  facts: readonly MaterialFact[];
  profile: TypeProfile;
  structures: ReadonlyMap<string, NarrativeStructure>;
  /** `vocabulary.yaml`'s `signals` list. */
  vocabulary: readonly string[];
}

/** The material map (plan §A.3 step 1): code only, so one facts pack, profile and registry always give the same map. */
export function buildMaterialMap(input: MapInput): MaterialMap {
  const { facts, profile, structures } = input;
  const cues = tagFacts(facts);
  const signals = signalRows(input.vocabulary, cues, facts);
  const runtimeS = profile.runtime.targetS;
  const allowed = allowedStructures(profile);
  const fitRows = [...structures.values()].sort((a, b) => a.id.localeCompare(b.id)).map((s) => fitRow(s, signals, runtimeS, allowed));
  return {
    schema: "material-map/v1",
    facts: { sha: input.factsSha, format: input.format, count: facts.length },
    profile: { type: profile.type, version: profile.version, runtimeS },
    structures: { registrySha: registrySha(structures), count: structures.size },
    material: material(facts, cues),
    metrics: { p1Count: facts.filter((fact) => /^p1$/i.test(fact.priority ?? "")).length, maxDeltaVsBaseline: maxDelta(facts, cues.change) },
    signals,
    gaps: signals.filter((row) => row.holds === null).map((row) => row.id),
    fits: fitRows,
    candidates: fitRows.filter((row) => row.fit === "fits" && row.allowed).map((row) => row.structure),
  };
}
