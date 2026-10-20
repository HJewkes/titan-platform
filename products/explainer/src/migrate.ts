import { z } from "zod";
import type { MapState } from "./map-state.js";
import { CHIP_KINDS, ScriptSchema, type ScriptBeat, type ScriptChapter, type ScriptV1 } from "./script-schema.js";

const TourV0Schema = z.object({
  title: z.string(),
  chapters: z.array(
    z.object({ id: z.string(), title: z.string(), question: z.string(), station: z.string().nullable().optional() }),
  ),
  beats: z.array(
    z.object({
      id: z.string(),
      chapter: z.string(),
      kind: z.string(),
      plannedS: z.number(),
      heldS: z.number().optional(),
      spoken: z.string(),
    }),
  ),
});

const ProbeSchema = z.object({
  page: z.string().optional(),
  beats: z.array(
    z.object({
      id: z.string(),
      shots: z.array(z.object({ texts: z.array(z.object({ text: z.string(), cls: z.string() })) })),
    }),
  ),
});

export type TourV0 = z.infer<typeof TourV0Schema>;
export type TourProbe = z.infer<typeof ProbeSchema>;

type Row = Pick<ScriptBeat, "function" | "mode"> & { job: ScriptBeat["visual"]["job"] };
const TODO_JOB = "TODO: pick the beat's visual job";
const row = (fn: Row["function"], job: string = TODO_JOB, mode: Row["mode"] = "explain"): Row => ({ function: fn, job, mode });

// The spike's component kinds carry no rhetorical role, so this table is a best guess the writer
// revises; a kind with no confident visual job gets a placeholder for L0 to report.
const BY_KIND: Readonly<Record<string, Row>> = {
  hook: row("HOOK"),
  title: row("PROMISE"),
  "scorecard-preview": row("VERDICT", "numbers"),
  "chapter-open": row("LEARNER_Q"),
  "station-map": row("WHAT", "map"),
  "arch-map": row("HOW", "map"),
  stat: row("WHAT", "numbers"),
  terminal: row("HOW", "code-proof", "demo"),
  "step-rail": row("HOW", "cast-in-motion"),
  list: row("WHAT"),
  "code-walk": row("HOW", "code-proof"),
  compare: row("WHAT", "alternatives-vs-ours"),
  scorecard: row("VERDICT", "numbers", "ref"),
  outro: row("CLOSE"),
};

const HEADLINE = new Set(["ex-headline", "beat-title"]);
const LABEL = new Set(["ex-map-label", "ex-list-text", "ex-hook-label", "beat-stat-label", "beat-compare-title"]);

type Texts = TourProbe["beats"][number]["shots"][number]["texts"];

function chipKind(text: string): ScriptBeat["visual"]["chips"][number]["kind"] | undefined {
  const head = text.toLowerCase();
  if (head.startsWith("docs")) return "docs-claim";
  if (head.startsWith("our framing")) return "our-framing";
  return CHIP_KINDS.find((kind) => head.startsWith(kind));
}

function mapStateOf(texts: Texts): MapState | undefined {
  const stations = texts.filter((t) => t.cls === "ex-map-step").map((t) => `S${t.text.trim()}`);
  return stations.length ? { level: "containers", visible: stations } : undefined;
}

function visualOf(kind: string, job: Row["job"], texts: Texts): ScriptBeat["visual"] {
  const eyebrows = texts.filter((t) => t.cls === "beat-eyebrow").map((t) => t.text);
  const chips = eyebrows.flatMap((text) => {
    const k = chipKind(text);
    return k ? [{ kind: k, text }] : [];
  });
  const labels = [...eyebrows.filter((text) => !chipKind(text)), ...texts.filter((t) => LABEL.has(t.cls)).map((t) => t.text)];
  const map_state = job === "map" ? mapStateOf(texts) : undefined;
  const assertion = texts.find((t) => HEADLINE.has(t.cls))?.text ?? `TODO: assertion for this ${kind} beat`;
  return { assertion, job, edge_sources: [], cues: [], chips, labels, ...(map_state ? { map_state } : {}) };
}

function migrateBeat(beat: TourV0["beats"][number], texts: Texts): ScriptBeat {
  const known = BY_KIND[beat.kind];
  if (!known) throw new Error(`${beat.id}: no beat function for spike kind "${beat.kind}"`);
  const { id, chapter, kind, plannedS, heldS, spoken } = beat;
  return {
    ...{ id, chapter, function: known.function, mode: known.mode, kind, plannedS, spoken },
    ...(heldS ? { heldS } : {}),
    fact_ids: [],
    new_terms: [],
    visual: visualOf(kind, known.job, texts),
  };
}

const chapterOf = (c: TourV0["chapters"][number]): ScriptChapter => ({
  id: c.id,
  label: `${c.station ?? c.title} · ${c.question}`,
  question: c.question,
});

function videoTodos(): ScriptV1["video"] {
  return {
    audience: "TODO: audience",
    stake: "TODO: stake",
    promise: "TODO: promise",
    thesis_mechanism: "TODO: thesis mechanism",
    running_example: "TODO: running example",
    simplifications: [],
    non_scope: [],
    glossary: [],
    close_type: "TODO: close type",
  };
}

export interface MigrateOptions {
  id?: string;
  profile?: string;
  factsPack?: string;
}

/**
 * Migrates a spike tour (`tour-v0.json`) and its render probe to `script/v1`. The visual track is
 * rebuilt from the probe's last shot per beat. Fields the spike never had get placeholder strings, so
 * the L0 lints report them rather than the parser.
 */
export function migrateTourV0(tour: unknown, probe: unknown, options: MigrateOptions = {}): ScriptV1 {
  const t = TourV0Schema.parse(tour);
  const p = ProbeSchema.parse(probe);
  const shots = new Map(p.beats.map((b) => [b.id, b.shots.at(-1)?.texts ?? []]));
  return ScriptSchema.parse({
    schema: "script/v1",
    id: options.id ?? p.page ?? t.title,
    profile: options.profile ?? "repo-tour",
    facts_pack: options.factsPack ?? "TODO: facts pack",
    video: videoTodos(),
    chapters: t.chapters.map(chapterOf),
    beats: t.beats.map((b) => migrateBeat(b, shots.get(b.id) ?? [])),
  });
}

type Json = Record<string, unknown>;
const isJson = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const without = (value: Json, keys: readonly string[]): Json => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
const mapIf = (value: unknown, fn: (item: Json) => Json): unknown => (Array.isArray(value) ? value.map((v) => (isJson(v) ? fn(v) : v)) : value);

// The spike labelled provenance by how a number was got; script/v1 labels it by how far it can be trusted.
const SPIKE_CHIP_KINDS: Record<string, (typeof CHIP_KINDS)[number]> = { measured: "verified", estimated: "inferred", target: "our-framing" };

// Keys the spike writer emits for its own renderer: they carry no claim any L0 check reads, so they are dropped
// rather than admitted to `ScriptSchema`. Any other unknown key still fails the parse.
const SPIKE_ONLY = {
  top: ["facts"],
  video: ["map"],
  beat: ["contested", "simplification", "pivot"],
  visual: ["recipe", "titles"],
  mapState: ["item"],
  cue: ["state"],
} as const;

const migrateChip = (chip: Json): Json => {
  const kind = SPIKE_CHIP_KINDS[String(chip.kind)] ?? chip.kind;
  return { ...(chip.fact_id === null ? without(chip, ["fact_id"]) : chip), kind };
};
const migrateCue = (cue: Json): Json => without(cue, SPIKE_ONLY.cue);

// The spike's "then" is a plain sequence, which script/v1 spells "and".
const migrateConnector = (connector: unknown): Json => (connector === "then" ? { connector_in: "and" } : connector === undefined ? {} : { connector_in: connector });

// A camera that follows an item, or fits a keyword rather than box ids, has no script/v1 form.
const hasCameraForm = (camera: unknown): boolean => isJson(camera) && (Array.isArray(camera.fit) || typeof camera.station === "string");

function migrateMapState(state: Json): Json {
  const rest: Json = { ...without(state, SPIKE_ONLY.mapState), ...(state.annotations ? { annotations: mapIf(state.annotations, (a) => without(a, ["text"])) } : {}) };
  return hasCameraForm(rest.camera) ? rest : without(rest, ["camera"]);
}

// A generic model of more than five slots (the v4 "seven nouns") has no script/v1 form, so it is dropped whole
// rather than truncated into a different claim.
function migrateVideo(video: Json): Json {
  const slots = isJson(video.generic_model) ? video.generic_model.slots : undefined;
  const oversized = Array.isArray(slots) && slots.length > 5;
  return without(video, oversized ? [...SPIKE_ONLY.video, "generic_model"] : SPIKE_ONLY.video);
}

function migrateSpikeVisual(visual: unknown): unknown {
  if (!isJson(visual)) return visual;
  const mapState = isJson(visual.map_state) ? { map_state: migrateMapState(visual.map_state) } : {};
  // "design" marks an edge drawn by hand; the evidence sources are code-derived, so it has none to name.
  const edgeSources = Array.isArray(visual.edge_sources) ? { edge_sources: visual.edge_sources.filter((s) => s !== "design") } : {};
  return { ...without(visual, SPIKE_ONLY.visual), ...mapState, ...edgeSources, chips: mapIf(visual.chips, migrateChip), cues: mapIf(visual.cues, migrateCue) };
}

function migrateSpikeBeat(beat: Json): Json {
  return { ...without(beat, [...SPIKE_ONLY.beat, "connector_in"]), ...migrateConnector(beat.connector_in), new_terms: beat.new_terms ?? [], visual: migrateSpikeVisual(beat.visual) };
}

/**
 * Migrates a Python-emitted spike `script.json` (motion-spike, v4) to `script/v1`. The spike's `band`, `origin`,
 * `render`, `maps` and map_state `map`/`old`/`new` carry over as the optional fields `ScriptSchema` admits; keys
 * only the spike renderer reads are dropped (so are an oversized `generic_model`, "design" edge sources and a camera with no
 * script/v1 form), and chip kinds are mapped onto `CHIP_KINDS` (measured is verified,
 * estimated is inferred, target is our-framing). A spike script has no per-beat `new_terms`, so each gets `[]`.
 */
export function migrateSpike(raw: unknown): ScriptV1 {
  if (!isJson(raw)) throw new Error("expected a spike script object");
  const { video, beats } = raw;
  return ScriptSchema.parse({
    ...without(raw, SPIKE_ONLY.top),
    ...(isJson(video) ? { video: migrateVideo(video) } : {}),
    beats: mapIf(beats, migrateSpikeBeat),
  });
}
