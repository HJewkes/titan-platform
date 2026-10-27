import { z } from "zod";

const FALLBACK_SUFFIX = "@fallback";
const PRONUNCIATION_MARKUP = /\[([^\]]+)\]\(([^)]*)\)/g;
const KINDS: Readonly<Record<string, string>> = {
  HookBeat: "hook",
  StatBeat: "stat",
  ListBeat: "list",
  ScorecardTable: "scorecard",
  StationMap: "station-map",
  SplitMapBeat: "split-map",
  StepRailBeat: "step-rail",
  LadderBeat: "ladder",
  CompareBeat: "compare",
  OutroBeat: "outro",
  RecipeRunBeat: "recipe-run",
};

export const AUDIO_SPEC_VOICE = {
  provider: "kokoro",
  model: "Kokoro-82M",
  voice: "af_heart",
  lang: "a",
} as const;

// Only the fields the gen spec reads. `ScriptSchema` is strict and rejects the frozen spike scripts' `band`,
// `origin` and `visual.render`, and widening it would loosen every script/v1 check.
const Id = z.string().min(1);
export const AudioSpecScriptSchema = z.object({
  chapters: z.array(z.object({ id: Id, label: z.string(), question: z.string() })),
  beats: z.array(
    z.object({
      id: Id,
      chapter: Id,
      band: z.string(),
      plannedS: z.number(),
      spoken: z.string(),
      origin: z.enum(["v2", "v4"]),
      visual: z.object({ render: z.string() }),
      contested: z.object({ fallback: z.string() }).optional(),
    }),
  ),
});

/** What the v2 gen spec contributes: the `repo` block and the `kind` of each v2-origin beat. */
export const BaseSpecSchema = z.object({
  repo: z.unknown().optional(),
  beats: z.array(z.object({ id: Id, kind: z.string() })),
});

const SpecBeatSchema = z.object({
  id: Id,
  chapter: Id,
  kind: z.string(),
  band: z.string(),
  plannedS: z.number(),
  spoken: z.string(),
});

export const AudioSpecSchema = z.object({
  title: z.string(),
  voice: z.object({
    provider: z.string(),
    model: z.string(),
    voice: z.string(),
    lang: z.string(),
  }),
  repo: z.unknown(),
  chapters: z.array(
    z.object({
      id: Id,
      n: z.number(),
      title: z.string(),
      question: z.string(),
      plannedS: z.number(),
      station: z.null(),
    }),
  ),
  beats: z.array(SpecBeatSchema),
});

export type AudioSpecScript = z.infer<typeof AudioSpecScriptSchema>;
export type BaseSpec = z.infer<typeof BaseSpecSchema>;
export type AudioSpec = z.infer<typeof AudioSpecSchema>;
type SpecBeat = z.infer<typeof SpecBeatSchema>;

/** The line with its pronunciation markup (`[word](/phonemes/)`, `[word](=reading)`) removed. */
export function stripPronunciationMarkup(spoken: string): string {
  return spoken.replace(PRONUNCIATION_MARKUP, (_match, word: string) => word);
}

function specBeat(beat: AudioSpecScript["beats"][number], baseKinds: ReadonlyMap<string, string>): SpecBeat {
  const kind = beat.origin === "v2" ? baseKinds.get(beat.id) : KINDS[beat.visual.render];
  if (kind === undefined) throw new Error(`no kind for beat ${beat.id}`);
  return {
    id: beat.id,
    chapter: beat.chapter,
    kind,
    band: beat.band,
    plannedS: beat.plannedS,
    spoken: beat.spoken,
  };
}

function synthBeats(script: AudioSpecScript, beats: SpecBeat[]): SpecBeat[] {
  const fresh = script.beats.flatMap((source, i) => {
    const beat = beats[i];
    return source.origin === "v4" && beat ? [{ source, beat }] : [];
  });
  const fallbacks = fresh.flatMap(({ source, beat }) =>
    source.contested
      ? [
          {
            ...beat,
            id: beat.id + FALLBACK_SUFFIX,
            spoken: source.contested.fallback,
          },
        ]
      : [],
  );
  return [...fresh.map((f) => f.beat), ...fallbacks];
}

function specChapters(script: AudioSpecScript): AudioSpec["chapters"] {
  return script.chapters.map((c, i) => ({
    id: c.id,
    n: i + 1,
    title: c.label,
    question: c.question,
    plannedS: 0,
    station: null,
  }));
}

/**
 * Port of make_sample.py (the addendum copy; its title constant is an argument here, as the v4 copy differs): the full gen spec (all beats, markup stripped, which the page and its gates read) and
 * the synth spec (v4 beats plus each contested beat's `<id>@fallback`, markup kept for the voicing step).
 */
export function buildAudioSpecs(scriptJson: unknown, baseJson: unknown, title: string): { full: AudioSpec; synth: AudioSpec } {
  const script = AudioSpecScriptSchema.parse(scriptJson);
  const base = BaseSpecSchema.parse(baseJson);
  const baseKinds = new Map(base.beats.map((b) => [b.id, b.kind]));
  const head = {
    title,
    voice: { ...AUDIO_SPEC_VOICE },
    repo: base.repo ?? null,
    chapters: specChapters(script),
  };
  const beats = script.beats.map((b) => specBeat(b, baseKinds));
  const plain = beats.map((b) => ({
    ...b,
    spoken: stripPronunciationMarkup(b.spoken),
  }));
  return {
    full: AudioSpecSchema.parse({ ...head, beats: plain }),
    synth: AudioSpecSchema.parse({ ...head, beats: synthBeats(script, beats) }),
  };
}
