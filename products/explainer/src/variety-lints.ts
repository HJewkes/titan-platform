import type { L0Check, L0Result } from "./eval-l0.js";
import { isStillMotion } from "./resolve-beat.js";
import type { VisualLayer } from "./resolve-tables.js";
import type { ScriptBeat } from "./script-schema.js";

/** One variety lint's verdict on one video. `beats` are the beats a fix would change; `hint` names them. */
export interface VarietyRow {
  id: string;
  value: number;
  threshold: number;
  pass: boolean;
  beats: string[];
  hint: string;
}

/** Limits no profile field carries, from the contact-sheet research's lint table (§4.1) and the profiles plan. */
export const VARIETY_LIMITS = {
  connectorMaxShare: 0.3,
  componentMaxRun: 2,
  // Taste rule 20 as the profiles plan words it for framings: never the same framing twice in a row.
  framingMaxRun: 1,
  cueActionsMin: 2,
} as const;

/** The profile fields the resolved rows read: `layers.componentMaxShare`, `layers.templateMaxShare`, `variety.minFramings`. */
export interface ProfileLimits {
  componentMaxShare: number;
  templateMaxShare: number;
  minFramings: number;
}

/** The fields of a resolved beat the lints read, a subset of the `explainer.resolved/v1` beat. */
export interface ResolvedVarietyBeat {
  id: string;
  beat: string;
  component: { name?: string | undefined };
  framing: string;
  layer: VisualLayer;
  key: { job: string };
}

type ScriptVarietyBeat = Pick<ScriptBeat, "id" | "spoken" | "visual">;

interface Keyed {
  id: string;
  key: string | undefined;
}

// The review's stock opening: "what can <repo> crib from <other repo>".
const HOOK_FORMULA = /\bwhat\s+(?:can|should)\s+(?:\S+\s+){1,3}?crib\s+from\b/i;
const CONNECTOR_STARTS = new Set(["so", "but", "then", "and", "now"]);
const MAP_OPS = ["camera", "reveal", "edges", "focus", "message_in_flight", "cards", "annotations", "pins"] as const;

const named = (ids: readonly string[]): string => ids.join(", ");
const percent = (share: number): string => `${Math.round(share * 100)} %`;
const firstWord = (spoken: string): string => (spoken.trim().split(/\s+/)[0] ?? "").toLowerCase().replace(/[^a-z]/g, "");

/** The longest run of consecutive beats sharing a key; a beat with no key breaks a run. */
function longestRun(seq: readonly Keyed[]): Keyed[] {
  let best: Keyed[] = [];
  let run: Keyed[] = [];
  for (const item of seq) {
    if (item.key === undefined) run = [];
    else run = run[0]?.key === item.key ? [...run, item] : [item];
    if (run.length > best.length) best = run;
  }
  return best;
}

function runRow(id: string, seq: readonly Keyed[], maxRun: number, what: string): VarietyRow {
  const run = longestRun(seq);
  const pass = run.length <= maxRun;
  const ids = run.map((item) => item.id);
  const hint = run.length === 0 ? `no ${what} to compare` : `${run.length} beats in a row share ${what} ${run[0]!.key}: ${named(ids)}`;
  return { id, value: run.length, threshold: maxRun, pass, beats: pass ? [] : ids, hint };
}

function topShareRow(id: string, seq: readonly Keyed[], maxShare: number, what: string): VarietyRow {
  const counts = new Map<string, string[]>();
  for (const { id: beat, key } of seq) if (key !== undefined) counts.set(key, [...(counts.get(key) ?? []), beat]);
  const [top, ids] = [...counts].sort(([, a], [, b]) => b.length - a.length)[0] ?? ["none", []];
  const share = seq.length === 0 ? 0 : ids.length / seq.length;
  const pass = share <= maxShare;
  const hint = `${what} ${top} on ${ids.length} of ${seq.length} beats (${percent(share)}, at most ${percent(maxShare)}): ${named(ids)}`;
  return { id, value: share, threshold: maxShare, pass, beats: pass ? [] : ids, hint };
}

/** The first beat opens on the review's stock hook formula. */
export function hookFormulaRow(beats: readonly ScriptVarietyBeat[]): VarietyRow {
  const first = beats[0]!;
  const hit = HOOK_FORMULA.test(first.spoken);
  const hint = hit ? `${first.id} opens on the stock "what can X crib from" hook` : `${first.id} opens on its own hook`;
  return { id: "variety:hook-formula", value: hit ? 1 : 0, threshold: 0, pass: !hit, beats: hit ? [first.id] : [], hint };
}

/** The share of beats whose first spoken word is a stock connector. */
export function connectorShareRow(beats: readonly ScriptVarietyBeat[]): VarietyRow {
  const max = VARIETY_LIMITS.connectorMaxShare;
  const ids = beats.filter((beat) => CONNECTOR_STARTS.has(firstWord(beat.spoken))).map((beat) => beat.id);
  const share = ids.length / beats.length;
  const pass = share <= max;
  const hint = `${ids.length} of ${beats.length} beats (${percent(share)}, at most ${percent(max)}) open on so, but, then, and or now${ids.length ? `: ${named(ids)}` : ""}`;
  return { id: "variety:connector-share", value: share, threshold: max, pass, beats: pass ? [] : ids, hint };
}

const beatActions = ({ visual }: ScriptVarietyBeat): string[] => {
  const state = visual.map_state as Record<string, unknown> | undefined;
  const ops = MAP_OPS.filter((op) => (Array.isArray(state?.[op]) ? (state[op] as unknown[]).length > 0 : state?.[op] !== undefined));
  return [...visual.cues.map((cue) => cue.action), ...ops.map((op) => `map:${op}`)];
};

/** Every cue of the script, map ops included, uses one motion: the review's "one motion grammar". */
export function cueActionRow(beats: readonly ScriptVarietyBeat[]): VarietyRow {
  const min = VARIETY_LIMITS.cueActionsMin;
  const cued = beats.map((beat) => ({ id: beat.id, actions: beatActions(beat) })).filter(({ actions }) => actions.length > 0);
  const distinct = [...new Set(cued.flatMap(({ actions }) => actions))];
  const pass = cued.length === 0 || distinct.length >= min;
  const ids = cued.map(({ id }) => id);
  const hint = cued.length === 0 ? "no cues" : `${distinct.length} cue action${distinct.length === 1 ? "" : "s"} (${distinct.join(", ")}) across ${named(ids)}`;
  return { id: "variety:cue-action", value: distinct.length, threshold: min, pass, beats: pass ? [] : ids, hint };
}

/** The longest run of one authored `visual.framing`; a beat that authors none breaks the run. */
export const scriptFramingRunRow = (beats: readonly ScriptVarietyBeat[]): VarietyRow =>
  runRow("variety:framing-run", beats.map((beat) => ({ id: beat.id, key: beat.visual.framing })), VARIETY_LIMITS.framingMaxRun, "framing");

/** The script-only rows (L0): no render, no series. Framing runs only when a beat authors `visual.framing`. */
export function scriptVarietyRows(beats: readonly ScriptVarietyBeat[]): VarietyRow[] {
  const framed = beats.some((beat) => beat.visual.framing !== undefined);
  return [hookFormulaRow(beats), connectorShareRow(beats), cueActionRow(beats), ...(framed ? [scriptFramingRunRow(beats)] : [])];
}

const componentOf = (beat: ResolvedVarietyBeat): string => beat.component.name ?? `spec:${beat.beat}`;

function minFramingsRow(beats: readonly ResolvedVarietyBeat[], min: number): VarietyRow {
  const framings = [...new Set(beats.map((beat) => beat.framing))];
  const pass = framings.length >= min;
  const ids = beats.map((beat) => beat.id);
  const hint = `${framings.length} framing${framings.length === 1 ? "" : "s"} (${framings.join(", ")}) across ${named(ids)}; at least ${min}`;
  return { id: "variety:min-framings", value: framings.length, threshold: min, pass, beats: pass ? [] : ids, hint };
}

/** Cast-in-motion beats on a still layer: the E-RESOLVE-STILL-MOTION refusals, counted so the variety report is whole. */
function castInMotionRow(beats: readonly ResolvedVarietyBeat[]): VarietyRow {
  const ids = beats.filter((beat) => isStillMotion(beat.key.job, beat.layer)).map((beat) => beat.id);
  const hint = ids.length === 0 ? "no cast-in-motion beat on a still layer" : `E-RESOLVE-STILL-MOTION on ${named(ids)}`;
  return { id: "variety:cast-in-motion", value: ids.length, threshold: 0, pass: ids.length === 0, beats: ids, hint };
}

/** The rows over the resolver's choices (`checks:resolve`), held to the profile's own limits. */
export function resolvedVarietyRows(beats: readonly ResolvedVarietyBeat[], limits: ProfileLimits): VarietyRow[] {
  const components = beats.map((beat) => ({ id: beat.id, key: componentOf(beat) }));
  const layers = beats.map((beat) => ({ id: beat.id, key: beat.layer === "template" ? "template" : undefined }));
  return [
    topShareRow("variety:top-component", components, limits.componentMaxShare, "component"),
    runRow("variety:component-run", components, VARIETY_LIMITS.componentMaxRun, "component"),
    topShareRow("variety:template-share", layers, limits.templateMaxShare, "layer"),
    runRow("variety:framing-run", beats.map((beat) => ({ id: beat.id, key: beat.framing })), VARIETY_LIMITS.framingMaxRun, "framing"),
    minFramingsRow(beats, limits.minFramings),
    castInMotionRow(beats),
  ];
}

const l0Row = (row: VarietyRow): L0Result => ({
  check_id: row.id, mode: "heuristic", severity: "warning", value: row.value, threshold: row.threshold, pass: row.pass, detail_beats: row.beats,
});

/** The script-only variety lints at L0 (TP-4019). Every row is a warning, so it reports sameness and never fails a script. */
export const varietyScriptCheck: L0Check = ({ script }) => scriptVarietyRows(script.beats).map(l0Row);
