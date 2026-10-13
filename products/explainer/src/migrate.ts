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
// revises; a kind with no confident visual job gets a TODO for L0 to report.
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
 * rebuilt from the probe's last shot per beat. Fields the spike never had are `TODO:` strings, so
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
