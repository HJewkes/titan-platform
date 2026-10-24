import type { BeatSpec, SpeechBand } from "./beat-schema.js";
import { VisualSchema } from "./map-state.js";
import type { ScriptBeat } from "./script-schema.js";
import { FRAMING_ANCHORS, matchRow, RESOLVE_ROWS, type ContentShape, type Framing, type ResolveKey, type ResolveRow, type VisualLayer } from "./resolve-tables.js";
import { findVisualType, type VisualRouter } from "./visual-router.js";

type ResolveCode = "E-RESOLVE-JOB-UNSET" | "E-RESOLVE-NO-ROW" | "E-RESOLVE-UNKNOWN-BEAT" | "E-RESOLVE-STILL-MOTION" | "E-RESOLVE-CITATION";

export interface ResolveRefusal {
  beat: string;
  code: ResolveCode;
  detail: string;
}

/** Thrown when any beat is refused; it lists every refusal, so one run reports them all. */
export class ResolveError extends Error {
  constructor(readonly refusals: readonly ResolveRefusal[]) {
    super(`resolve refused ${refusals.length} beat${refusals.length === 1 ? "" : "s"}: ${refusals.map((r) => `${r.beat} ${r.code} (${r.detail})`).join("; ")}`);
    this.name = "ResolveError";
  }
}

/** What one beat resolved to: the row that chose it, and the script's own fields laid over the row's choice. */
export interface ResolvedBeat {
  id: string;
  chapter: string;
  key: ResolveKey;
  row: string;
  beat: string;
  component: BeatSpec["component"];
  band: SpeechBand;
  framing: Framing;
  layer: VisualLayer;
  anchors: string[];
}

type Beat = Pick<ScriptBeat, "id" | "chapter" | "function" | "kind" | "visual">;

function contentShape(visual: ScriptBeat["visual"]): ContentShape {
  if (visual.code) return "code";
  if (visual.map_state) return "map";
  if (visual.labels.length > 0 || visual.chips.length > 0) return "items";
  return "statement";
}

/** The beat's resolver key, or a refusal when its job is still the writer's placeholder, not a visual job. */
function resolveKey(beat: Beat, router: VisualRouter): ResolveKey | ResolveRefusal {
  const job = VisualSchema.shape.job.safeParse(beat.visual.job);
  if (!job.success) return { beat: beat.id, code: "E-RESOLVE-JOB-UNSET", detail: "visual.job is not authored yet" };
  const route = beat.kind !== undefined && findVisualType(router, beat.kind) ? beat.kind : "none";
  return { function: beat.function, job: job.data, content: contentShape(beat.visual), route };
}

const keyText = (key: ResolveKey): string => `function ${key.function}, job ${key.job}, content ${key.content}, route ${key.route}`;

function chosen(beat: Beat, key: ResolveKey, row: ResolveRow, spec: BeatSpec): ResolvedBeat | ResolveRefusal {
  const { visual } = beat;
  const framing = visual.framing ?? row.then.framing;
  const layer = visual.layer ?? row.then.layer;
  if (key.job === "cast-in-motion" && layer !== "custom") return { beat: beat.id, code: "E-RESOLVE-STILL-MOTION", detail: "a cast-in-motion beat must resolve to a moving (custom) layer" };
  const anchors = visual.anchors ?? [...FRAMING_ANCHORS[framing]];
  return { id: beat.id, chapter: beat.chapter, key, row: row.id, beat: spec.type, component: spec.component, band: spec.speech.band, framing, layer, anchors };
}

/** One beat through the tables; an authored `visual.beat`, `framing`, `layer` or `anchors` overrides the row's choice. */
export function resolveBeat(beat: Beat, specs: ReadonlyMap<string, BeatSpec>, router: VisualRouter, rows: readonly ResolveRow[] = RESOLVE_ROWS): ResolvedBeat | ResolveRefusal {
  const key = resolveKey(beat, router);
  if ("code" in key) return key;
  const row = matchRow(key, rows);
  if (!row) return { beat: beat.id, code: "E-RESOLVE-NO-ROW", detail: `no resolver row matches ${keyText(key)}` };
  const type = beat.visual.beat ?? row.then.beat;
  const spec = specs.get(type);
  if (!spec) return { beat: beat.id, code: "E-RESOLVE-UNKNOWN-BEAT", detail: `beat spec ${type} (row ${row.id}) is not in the registry` };
  return chosen(beat, key, row, spec);
}

const isRefusal = (found: ResolvedBeat | ResolveRefusal): found is ResolveRefusal => "code" in found;

/** Every beat resolved, or a ResolveError listing every beat that was refused. */
export function resolveBeats(beats: readonly Beat[], specs: ReadonlyMap<string, BeatSpec>, router: VisualRouter, rows: readonly ResolveRow[] = RESOLVE_ROWS): ResolvedBeat[] {
  const found = beats.map((beat) => resolveBeat(beat, specs, router, rows));
  const refused = found.filter(isRefusal);
  if (refused.length > 0) throw new ResolveError(refused);
  return found.filter((beat): beat is ResolvedBeat => !isRefusal(beat));
}
