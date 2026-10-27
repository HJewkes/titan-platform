import { z } from "zod";
import { loadBeatSpecs } from "../beat-load.js";
import { BEAT_SLOTS } from "../beat-slots.js";
import { cueResolverFromWords, type CueResolver } from "../cues.js";
import { keptBeats, type ResolvedSchema } from "../resolve-stage.js";
import { beatCues, type ScriptBeat, type ScriptV1 } from "../script-schema.js";
import { fillScript, type FilledBeat } from "../template-fill/fill.js";

type Resolved = z.infer<typeof ResolvedSchema>;


/** How long before a beat ends its frame counts as settled: late enough for every reveal, before the next beat's cut. */
export const SETTLE_LEAD_S = 0.3;

export interface SaveBack {
  enabled: boolean;
  reason?: string;
}

interface RenderPath {
  bridged: boolean;
  readsFill: boolean;
}

// TP-2992 S3 moved render in-process onto the template fill, so a saved edit reaches the MP4.
const RENDER_TODAY: RenderPath = { bridged: false, readsFill: true };

/** Save is on only when the render that follows a save draws the edited slots. */
export function saveBackOf(render: RenderPath = RENDER_TODAY): SaveBack {
  return !render.bridged && render.readsFill ? { enabled: true } : { enabled: false, reason: "renders ignore edits until TP-2992 S3" };
}

// Loose: a words.json carries voice, speech and heard fields the props read never needs.
const WordsSpanSchema = z.object({
  beats: z.array(z.object({ id: z.string(), startS: z.number().nonnegative(), durationS: z.number().positive(), words: z.array(z.object({ word: z.string(), start: z.number() })).default([]) })),
});
type WordsSpan = z.infer<typeof WordsSpanSchema>;

/** One template beat as the props panel edits it. */
export interface BeatProps {
  id: string;
  chapter: string;
  spec: string;
  slots: string;
  schema: Record<string, unknown>;
  value: Record<string, unknown>;
  overridden: string[];
  locked: string[];
  startS: number;
  endS: number;
  stillS: number;
  fallback?: FilledBeat["fallback"];
}

interface PropsInput {
  script: ScriptV1;
  resolved: Resolved;
  words: unknown;
  /** The run's generated `slots` artifact, which stands in for the derived layer as it does at resolve. */
  generated?: Readonly<Record<string, unknown>>;
}

const slotSchema = (ref: FilledBeat["ref"]): Record<string, unknown> => z.toJSONSchema(BEAT_SLOTS[ref], { io: "input", unrepresentable: "any" });

/** Cue times in seconds from the beat start; a cue the voice never spoke has no time (the tts gate reports it). */
function cueTimes(beat: ScriptBeat, resolve: CueResolver): number[] {
  return beatCues(beat.visual).flatMap((cue) => {
    try {
      return [resolve(beat.id, cue)];
    } catch {
      return [];
    }
  });
}

interface Span {
  startS: number;
  endS: number;
  stillS: number;
}

/** The beat's span on the render, and its still: the later of the settle point and the last cue, inside the beat. */
function spanOf(beat: ScriptBeat, words: WordsSpan, resolve: CueResolver): Span {
  const voiced = words.beats.find((row) => row.id === beat.id);
  if (voiced === undefined) throw new Error(`the words artifact has no beat ${beat.id}`);
  const endS = voiced.startS + voiced.durationS;
  const lastCue = Math.max(...cueTimes(beat, resolve).map((s) => voiced.startS + s), endS - SETTLE_LEAD_S);
  return { startS: voiced.startS, endS, stillS: Math.max(voiced.startS, Math.min(lastCue, endS)) };
}

function propsOf(beat: ScriptBeat, filled: FilledBeat, words: WordsSpan, resolve: CueResolver): BeatProps {
  return {
    id: beat.id,
    chapter: beat.chapter,
    spec: filled.spec,
    slots: filled.ref,
    schema: slotSchema(filled.ref),
    value: filled.slots,
    overridden: filled.overridden,
    locked: [...new Set(beat.visual.cues.map((cue) => cue.target))],
    ...spanOf(beat, words, resolve),
    ...(filled.fallback === undefined ? {} : { fallback: filled.fallback }),
  };
}

/** Every template beat resolve kept, filled with the owner's overrides, with its slot schema and its place on the render. */
export function beatProps(input: PropsInput): BeatProps[] {
  const script = { ...input.script, beats: keptBeats(input.script.beats, input.resolved) };
  const filled = fillScript(script, input.resolved, { specs: loadBeatSpecs(), ...(input.generated ? { pinned: input.generated } : {}) });
  const words = WordsSpanSchema.parse(input.words);
  const resolve = cueResolverFromWords(Object.fromEntries(words.beats.map((row) => [row.id, row.words.map((w) => ({ word: w.word, startS: w.start }))])));
  const byId = new Map(script.beats.map((beat) => [beat.id, beat]));
  return filled.beats.map((beat) => propsOf(byId.get(beat.id)!, beat, words, resolve));
}
